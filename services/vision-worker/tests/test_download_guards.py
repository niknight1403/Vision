"""Guards on the image download path: DNS, size, content type, signature."""
from __future__ import annotations

import socket
from typing import Any

import pytest

from vision_worker import vision_identifier
from vision_worker.vision_identifier import (
    MAX_IMAGE_BYTES,
    InspectionError,
    VisionTreasureInspector,
)

HOST = "images.example.org"
URL = f"https://{HOST}/item.jpg"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def _global_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_getaddrinfo(host: str, port: int, **kwargs: Any):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(vision_identifier.socket, "getaddrinfo", fake_getaddrinfo)


class _FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        body: bytes = PNG_BYTES,
    ) -> None:
        self.status_code = status_code
        self.headers = headers if headers is not None else {"content-type": "image/png"}
        self._body = body

    async def aiter_bytes(self):
        yield self._body


class _FakeStream:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeResponse:
        return self._response

    async def __aexit__(self, *_: object) -> None:
        return None


class _FakeHttpClient:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.requested: list[str] = []

    def stream(self, method: str, url: str) -> _FakeStream:
        self.requested.append(url)
        return _FakeStream(self.response)


def _inspector(http_client: _FakeHttpClient) -> VisionTreasureInspector:
    return VisionTreasureInspector(client=object(), http_client=http_client, allowed_hosts={HOST})


@pytest.mark.asyncio
async def test_public_dns_and_valid_png_are_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)
    http = _FakeHttpClient(_FakeResponse())

    content_type, content = await _inspector(http).download_image(URL)

    assert content_type == "image/png"
    assert content == PNG_BYTES
    assert http.requested == [URL]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.9",
        "192.168.1.10",
        "169.254.169.254",
        "::1",
        "fd00::1",
        "fe80::1",
    ],
)
async def test_non_public_dns_answers_block_the_download(
    monkeypatch: pytest.MonkeyPatch, address: str
) -> None:
    family = socket.AF_INET6 if ":" in address else socket.AF_INET

    def fake_getaddrinfo(host: str, port: int, **kwargs: Any):
        return [(family, socket.SOCK_STREAM, 6, "", (address, port, 0, 0) if family == socket.AF_INET6 else (address, port))]

    monkeypatch.setattr(vision_identifier.socket, "getaddrinfo", fake_getaddrinfo)
    http = _FakeHttpClient(_FakeResponse())

    with pytest.raises(InspectionError, match="nicht öffentliche IP-Adresse"):
        await _inspector(http).download_image(URL)

    assert http.requested == []


@pytest.mark.asyncio
async def test_mixed_public_and_private_answers_block_the_download(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_getaddrinfo(host: str, port: int, **kwargs: Any):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", port)),
        ]

    monkeypatch.setattr(vision_identifier.socket, "getaddrinfo", fake_getaddrinfo)
    http = _FakeHttpClient(_FakeResponse())

    with pytest.raises(InspectionError, match="nicht öffentliche IP-Adresse"):
        await _inspector(http).download_image(URL)

    assert http.requested == []


@pytest.mark.asyncio
async def test_unresolvable_host_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_getaddrinfo(host: str, port: int, **kwargs: Any):
        raise socket.gaierror("name or service not known")

    monkeypatch.setattr(vision_identifier.socket, "getaddrinfo", failing_getaddrinfo)

    with pytest.raises(InspectionError, match="nicht aufgelöst"):
        await _inspector(_FakeHttpClient(_FakeResponse())).download_image(URL)


@pytest.mark.asyncio
async def test_non_200_status_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)

    with pytest.raises(InspectionError, match="keinen erfolgreichen Status"):
        await _inspector(_FakeHttpClient(_FakeResponse(status_code=302))).download_image(URL)


@pytest.mark.asyncio
async def test_unlisted_content_type_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)
    response = _FakeResponse(headers={"content-type": "text/html"})

    with pytest.raises(InspectionError, match="Nicht unterstütztes Bildformat"):
        await _inspector(_FakeHttpClient(response)).download_image(URL)


@pytest.mark.asyncio
async def test_declared_oversize_body_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)
    response = _FakeResponse(
        headers={"content-type": "image/png", "content-length": str(MAX_IMAGE_BYTES + 1)}
    )

    with pytest.raises(InspectionError, match="Größenlimit"):
        await _inspector(_FakeHttpClient(response)).download_image(URL)


@pytest.mark.asyncio
async def test_streamed_body_over_the_limit_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)
    body = b"\x89PNG\r\n\x1a\n" + b"0" * (MAX_IMAGE_BYTES + 1)

    with pytest.raises(InspectionError, match="Größenlimit"):
        await _inspector(_FakeHttpClient(_FakeResponse(body=body))).download_image(URL)


@pytest.mark.asyncio
async def test_signature_mismatch_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)
    response = _FakeResponse(headers={"content-type": "image/jpeg"}, body=b"not-a-jpeg-at-all")

    with pytest.raises(InspectionError, match="stimmt nicht mit dem Dateiformat"):
        await _inspector(_FakeHttpClient(response)).download_image(URL)


@pytest.mark.asyncio
async def test_invalid_webp_container_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _global_dns(monkeypatch)
    body = b"RIFF" + b"\x00" * 4 + b"NOPE" + b"0" * 16
    response = _FakeResponse(headers={"content-type": "image/webp"}, body=body)

    with pytest.raises(InspectionError, match="Ungültige WebP-Datei"):
        await _inspector(_FakeHttpClient(response)).download_image(URL)
