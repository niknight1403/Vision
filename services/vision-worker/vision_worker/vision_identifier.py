from __future__ import annotations

import asyncio
import base64
import ipaddress
import os
import socket
from typing import Literal
from urllib.parse import urlsplit

import httpx
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, ValidationError

from .pinned_http_transport import PinnedAsyncHTTPTransport


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


class InspectionError(Exception):
    """A safe, user-displayable inspection failure."""


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


async def _resolve_public_ips(host: str) -> tuple[str, ...]:
    """Resolve once, reject the whole answer set if any address is non-public."""
    try:
        records = await asyncio.to_thread(
            socket.getaddrinfo, host, 443, type=socket.SOCK_STREAM
        )
    except OSError as exc:
        raise InspectionError("Bildquelle konnte nicht aufgelöst werden.") from exc
    if not records:
        raise InspectionError("Bildquelle konnte nicht aufgelöst werden.")

    addresses: list[str] = []
    for record in records:
        try:
            address = ipaddress.ip_address(record[4][0])
        except (IndexError, ValueError) as exc:
            raise InspectionError("Bildquelle lieferte eine ungültige IP-Adresse.") from exc
        if not address.is_global:
            raise InspectionError("Bildquelle verweist auf eine nicht öffentliche IP-Adresse.")
        normalized = str(address)
        if normalized not in addresses:
            addresses.append(normalized)

    if not addresses:
        raise InspectionError("Bildquelle konnte nicht aufgelöst werden.")
    return tuple(addresses)


class VisionTreasureInspector:
    """Identifies visible product details; it does not certify authenticity."""

    def __init__(
        self,
        *,
        client: AsyncOpenAI | None = None,
        allowed_hosts: set[str] | None = None,
        model: str | None = None,
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
            base_url=os.getenv("LLM_BASE_URL", "http://127.0.0.1:11434/v1"),
            timeout=45.0,
            max_retries=1,
        )
        self.fallback_model = os.getenv("LLM_FALLBACK_MODEL", "")
        self.fallback_client = None
        self._owns_fallback_client = False
        fallback_url = os.getenv("LLM_FALLBACK_BASE_URL", "").strip()
        fallback_key = os.getenv("LLM_FALLBACK_API_KEY", "").strip()
        if fallback_url and fallback_key:
            self.fallback_client = AsyncOpenAI(api_key=fallback_key, base_url=fallback_url, timeout=60.0, max_retries=1)
            self._owns_fallback_client = True

    async def close(self) -> None:
        if self._owns_openai_client:
            await self.client.close()
        if self._owns_fallback_client and self.fallback_client is not None:
            await self.fallback_client.close()

    async def download_image(self, image_url: str) -> tuple[str, bytes]:
        host = _validate_image_url(image_url, self.allowed_hosts)
        pinned_ips = await _resolve_public_ips(host)
        transport = PinnedAsyncHTTPTransport(host, pinned_ips)
        try:
            async with httpx.AsyncClient(
                transport=transport,
                timeout=httpx.Timeout(10.0),
                follow_redirects=False,
                trust_env=False,
            ) as image_client:
                async with image_client.stream("GET", image_url) as response:
                    if response.status_code != 200:
                        raise InspectionError("Bildquelle lieferte keinen erfolgreichen Status.")
                    content_type = response.headers.get("content-type", "").split(";")[0].lower()
                    if content_type not in ALLOWED_IMAGE_TYPES:
                        raise InspectionError("Nicht unterstütztes Bildformat.")
                    declared_size = response.headers.get("content-length")
                    if declared_size:
                        try:
                            parsed_size = int(declared_size)
                        except ValueError as exc:
                            raise InspectionError("Ungültige Bildgrößenangabe.") from exc
                        if parsed_size < 0 or parsed_size > MAX_IMAGE_BYTES:
                            raise InspectionError("Bild überschreitet das Größenlimit.")
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_IMAGE_BYTES:
                            raise InspectionError("Bild überschreitet das Größenlimit.")
                        chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise InspectionError("Bild konnte nicht sicher geladen werden.") from exc

        content = b"".join(chunks)
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
            messages = [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {
                        "url": f"data:{mime_type};base64,{encoded}"
                    }},
                ],
            }]
            try:
                response = await self.client.chat.completions.create(
                    model=self.model, messages=messages,
                    response_format={"type": "json_object"}, temperature=0,
                )
            except Exception:
                if self.fallback_client is None or not self.fallback_model:
                    raise
                response = await self.fallback_client.chat.completions.create(
                    model=self.fallback_model, messages=messages,
                    response_format={"type": "json_object"}, temperature=0,
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
