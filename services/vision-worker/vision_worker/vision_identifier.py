from __future__ import annotations

import asyncio
import base64
import ipaddress
import os
import re
import socket
import ssl
from typing import Awaitable, Callable, Literal
from urllib.parse import quote, urlsplit

from openai import AsyncOpenAI
from pydantic import BaseModel, Field, ValidationError


MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ("jpeg", b"\xff\xd8\xff"),
    "image/png": ("png", b"\x89PNG\r\n\x1a\n"),
    "image/webp": ("webp", b"RIFF"),
}


class VisualInspection(BaseModel):
    identified: bool
    exact_model: str = "Unbekannt"
    detected_markings: list[str] = Field(default_factory=list, max_length=30)
    condition_grade: Literal["Neuwertig", "Gut", "Stark Gebraucht", "Defekt", "Unklar"] = "Unklar"
    visual_authenticity_score: float = Field(ge=0.0, le=1.0)
    uncertainty_notes: list[str] = Field(default_factory=list, max_length=20)


Connector = Callable[..., Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


class InspectionError(Exception):
    """A safe, user-displayable inspection failure."""

def _llm_base_url() -> str:
    configured = os.getenv("LLM_BASE_URL")
    if not configured:
        return "http://127.0.0.1:11434/v1"
    parsed = urlsplit(configured)
    allowed = {item.strip().lower().rstrip(".") for item in os.getenv("LLM_ALLOWED_HOSTS", "").split(",") if item.strip()}
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise RuntimeError("LLM_BASE_URL must be an HTTPS endpoint without credentials, query, or fragment")
    if not allowed or parsed.hostname.lower().rstrip(".") not in allowed:
        raise RuntimeError("LLM_BASE_URL host is not in LLM_ALLOWED_HOSTS")
    return configured


def _validate_image_url(image_url: str, allowed_hosts: set[str]) -> str:
    parsed = urlsplit(image_url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise InspectionError("Ungültige Bildquellen-URL.") from exc
    if parsed.scheme != "https" or not parsed.hostname:
        raise InspectionError("Nur HTTPS-Bildquellen sind erlaubt.")
    if parsed.username or parsed.password or port not in (None, 443):
        raise InspectionError("Ungültige Bildquellen-URL.")
    host = parsed.hostname.rstrip(".").lower()
    if host not in allowed_hosts:
        raise InspectionError("Bildquelle ist nicht freigegeben.")
    if parsed.fragment:
        raise InspectionError("URL-Fragmente sind nicht erlaubt.")
    return host


MAX_RESPONSE_HEADER_BYTES = 16 * 1024
PINNED_USER_AGENT = "autonomagent-vision-worker/0.1"
_PINNED_REQUEST_TEMPLATE = (
    "GET {target} HTTP/1.1\r\n"
    "Host: {host}\r\n"
    "Accept: image/jpeg, image/png, image/webp\r\n"
    "Accept-Encoding: identity\r\n"
    "Connection: close\r\n"
    "User-Agent: " + PINNED_USER_AGENT + "\r\n"
    "\r\n"
)
_STATUS_LINE = re.compile(r"^HTTP/1\.[01] (\d{3})(?: .*)?$")


def _public_addresses(host: str) -> list[str]:
    """Resolve the host exactly once and refuse any non-public answer.

    The returned address is the one the TCP connection is made to, so a second
    lookup (which is what a DNS-rebinding attack relies on) never happens.
    """
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise InspectionError("Bildquelle konnte nicht aufgelöst werden.") from exc
    if not records:
        raise InspectionError("Bildquelle konnte nicht aufgelöst werden.")
    addresses: list[str] = []
    for record in records:
        raw_address = str(record[4][0]).split("%")[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise InspectionError("Bildquelle konnte nicht aufgelöst werden.") from exc
        if not address.is_global:
            raise InspectionError("Bildquelle verweist auf eine nicht öffentliche IP-Adresse.")
        addresses.append(str(address))
    if not addresses:
        raise InspectionError("Bildquelle konnte nicht aufgelöst werden.")
    return addresses


async def _reject_private_dns(host: str) -> None:
    """Backwards-compatible wrapper around the pinned resolver."""
    await asyncio.to_thread(_public_addresses, host)


def _default_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def _request_target(image_url: str) -> tuple[str, str]:
    parsed = urlsplit(image_url)
    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    host = (parsed.hostname or "").rstrip(".").lower()
    return host, quote(target, safe="/?=&%:@!$'()*+,;~-._")


async def _connect_pinned(
    host: str, address: str, *, ssl_context: ssl.SSLContext, port: int = 443
):
    """Connect to the already validated address while keeping host verification."""
    return await asyncio.open_connection(
        host=address,
        port=port,
        ssl=ssl_context,
        server_hostname=host,
        limit=MAX_RESPONSE_HEADER_BYTES,
    )


async def _read_response_head(reader: asyncio.StreamReader) -> tuple[int, dict[str, str], bytes]:
    buffer = bytearray()
    while b"\r\n\r\n" not in buffer:
        chunk = await reader.read(4096)
        if not chunk:
            raise InspectionError("Bildquelle lieferte eine unvollständige Antwort.")
        buffer += chunk
        if len(buffer) > MAX_RESPONSE_HEADER_BYTES:
            raise InspectionError("Antwort-Header der Bildquelle überschreiten das Limit.")
    header_blob, remainder = bytes(buffer).split(b"\r\n\r\n", 1)
    lines = header_blob.split(b"\r\n")
    match = _STATUS_LINE.match(lines[0].decode("latin-1"))
    if not match:
        raise InspectionError("Bildquelle lieferte eine ungültige HTTP-Antwort.")
    status = int(match.group(1))
    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, separator, value = line.decode("latin-1").partition(":")
        key = name.strip().lower()
        if not separator or not key:
            raise InspectionError("Bildquelle lieferte ungültige HTTP-Header.")
        headers[key] = f"{headers[key]}, {value.strip()}" if key in headers else value.strip()
    return status, headers, remainder


async def _read_body_with_length(
    reader: asyncio.StreamReader, initial: bytes, expected: int
) -> bytes:
    body = bytearray(initial)
    while len(body) < expected:
        chunk = await reader.read(min(65536, expected - len(body)))
        if not chunk:
            raise InspectionError("Bildquelle lieferte eine unvollständige Antwort.")
        body += chunk
    return bytes(body[:expected])


async def _read_body_until_close(reader: asyncio.StreamReader, initial: bytes) -> bytes:
    body = bytearray(initial)
    if len(body) > MAX_IMAGE_BYTES:
        raise InspectionError("Bild überschreitet das Größenlimit.")
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            return bytes(body)
        body += chunk
        if len(body) > MAX_IMAGE_BYTES:
            raise InspectionError("Bild überschreitet das Größenlimit.")


async def _read_chunked_body(reader: asyncio.StreamReader, initial: bytes) -> bytes:
    buffer = bytearray(initial)
    body = bytearray()

    async def fill(minimum: int) -> None:
        nonlocal buffer
        while len(buffer) < minimum:
            chunk = await reader.read(65536)
            if not chunk:
                raise InspectionError("Bildquelle lieferte eine unvollständige Antwort.")
            buffer += chunk
            if len(buffer) > MAX_IMAGE_BYTES + MAX_RESPONSE_HEADER_BYTES:
                raise InspectionError("Bild überschreitet das Größenlimit.")

    while True:
        while b"\r\n" not in buffer:
            await fill(len(buffer) + 1)
        line, _, rest = bytes(buffer).partition(b"\r\n")
        buffer = bytearray(rest)
        try:
            size = int(line.split(b";")[0].strip(), 16)
        except ValueError as exc:
            raise InspectionError("Bildquelle lieferte eine ungültige Chunk-Kodierung.") from exc
        if size < 0:
            raise InspectionError("Bildquelle lieferte eine ungültige Chunk-Kodierung.")
        if size == 0:
            return bytes(body)
        if len(body) + size > MAX_IMAGE_BYTES:
            raise InspectionError("Bild überschreitet das Größenlimit.")
        await fill(size + 2)
        body += buffer[:size]
        buffer = bytearray(buffer[size + 2:])


async def _read_pinned_body(
    reader: asyncio.StreamReader, initial: bytes, headers: dict[str, str]
) -> bytes:
    if "chunked" in headers.get("transfer-encoding", "").lower():
        return await _read_chunked_body(reader, initial)
    declared = headers.get("content-length")
    if declared is None:
        return await _read_body_until_close(reader, initial)
    try:
        expected = int(declared)
    except ValueError as exc:
        raise InspectionError("Ungültige Bildgrößenangabe.") from exc
    if expected < 0 or expected > MAX_IMAGE_BYTES:
        raise InspectionError("Bild überschreitet das Größenlimit.")
    return await _read_body_with_length(reader, initial, expected)


async def _pinned_https_get(
    image_url: str,
    allowed_hosts: set[str],
    *,
    ssl_context: ssl.SSLContext | None = None,
    connector: "Connector | None" = None,
    port: int = 443,
) -> tuple[dict[str, str], bytes]:
    """Download over a connection pinned to the validated address.

    Redirects are never followed: a 3xx answer is an error, so an allowlisted
    host cannot bounce the worker to an internal target.
    """
    host = _validate_image_url(image_url, allowed_hosts)
    addresses = await asyncio.to_thread(_public_addresses, host)
    pinned_address = addresses[0]
    _, target = _request_target(image_url)
    context = ssl_context if ssl_context is not None else _default_ssl_context()
    if connector is not None:
        connect = connector
    else:
        async def connect(target_host: str, address: str, *, ssl_context: ssl.SSLContext):
            return await _connect_pinned(
                target_host, address, ssl_context=ssl_context, port=port
            )
    try:
        reader, writer = await connect(host, pinned_address, ssl_context=context)
    except ssl.SSLError as exc:
        raise InspectionError("TLS-Verbindung zur Bildquelle fehlgeschlagen.") from exc
    except OSError as exc:
        raise InspectionError("Bild konnte nicht sicher geladen werden.") from exc
    try:
        writer.write(_PINNED_REQUEST_TEMPLATE.format(target=target, host=host).encode("ascii"))
        await writer.drain()
        status, headers, remainder = await _read_response_head(reader)
        if status != 200:
            raise InspectionError("Bildquelle lieferte keinen erfolgreichen Status.")
        body = await _read_pinned_body(reader, remainder, headers)
    except (asyncio.IncompleteReadError, ConnectionError, asyncio.LimitOverrunError) as exc:
        raise InspectionError("Bildquelle lieferte eine unvollständige Antwort.") from exc
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
    return headers, body


class VisionTreasureInspector:
    """Identifies visible product details; it does not certify authenticity."""

    def __init__(
        self,
        *,
        client: AsyncOpenAI | None = None,
        allowed_hosts: set[str] | None = None,
        model: str | None = None,
        connector: "Connector | None" = None,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self.allowed_hosts = {
            item.strip().lower().rstrip(".")
            for item in (allowed_hosts or set())
            if item.strip()
        }
        self.model = model or os.getenv("VISION_MODEL", "qwen2.5-vl:7b")
        self._owns_openai_client = client is None
        self.client = client or AsyncOpenAI(
            api_key=os.getenv("LLM_API_KEY", "ollama"),
            base_url=_llm_base_url(),
            timeout=45.0,
            max_retries=1,
        )
        self.connector = connector
        self.ssl_context = ssl_context

    async def close(self) -> None:
        if self._owns_openai_client:
            await self.client.close()

    async def download_image(self, image_url: str) -> tuple[str, bytes]:
        headers, content = await _pinned_https_get(
            image_url,
            self.allowed_hosts,
            ssl_context=self.ssl_context,
            connector=self.connector,
        )
        content_type = headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type not in ALLOWED_IMAGE_TYPES:
            raise InspectionError("Nicht unterstütztes Bildformat.")
        if len(content) > MAX_IMAGE_BYTES:
            raise InspectionError("Bild überschreitet das Größenlimit.")
        if not content:
            raise InspectionError("Bildquelle lieferte keinen Inhalt.")
        _, signature = ALLOWED_IMAGE_TYPES[content_type]
        if not content.startswith(signature):
            raise InspectionError("Bildinhalt stimmt nicht mit dem Dateiformat überein.")
        if content_type == "image/webp" and content[8:12] != b"WEBP":
            raise InspectionError("Ungültige WebP-Datei.")
        return content_type, content

    async def inspect_item_visuals(
        self, image_url: str, hint_title: str
    ) -> dict[str, object]:
        try:
            mime_type, image_bytes = await self.download_image(image_url)
            encoded = base64.b64encode(image_bytes).decode("ascii")
            prompt = (
                "Analysiere ausschließlich sichtbare Hinweise am Gegenstand. "
                "Erfinde keine Modellnummern, Seriennummern oder Echtheitsmerkmale. "
                "Wenn etwas nicht lesbar ist, kennzeichne es als unbekannt. "
                "Ein Bild allein beweist niemals Echtheit. "
                f"Anzeigentitel als unverifizierter Hinweis: {hint_title[:300]!r}. "
                "Gib identified, exact_model, detected_markings, condition_grade, "
                "visual_authenticity_score und uncertainty_notes als JSON zurück. "
                "Der Score beschreibt nur die visuelle Plausibilität, keine Echtheitsprüfung."
            )
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {
                            "url": f"data:{mime_type};base64,{encoded}"
                        }},
                    ],
                }],
                response_format={"type": "json_object"},
                temperature=0,
            )
            raw = response.choices[0].message.content
            if not raw:
                raise InspectionError("Vision-Modell lieferte keine Analyse.")
            result = VisualInspection.model_validate_json(raw)
            return result.model_dump()
        except (InspectionError, ValidationError) as exc:
            return {"identified": False, "details": str(exc)}
        except Exception:
            # Do not leak provider URLs, credentials, or internal exception details.
            return {"identified": False, "details": "Visuelle Analyse vorübergehend fehlgeschlagen."}
