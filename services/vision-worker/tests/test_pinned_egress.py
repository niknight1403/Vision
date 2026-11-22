"""Pinned-egress download path: DNS pinning, redirects, framing and limits."""
from __future__ import annotations

import asyncio
import socket
from typing import Any, Callable

import pytest

from vision_worker import vision_identifier
from vision_worker.vision_identifier import (
    MAX_IMAGE_BYTES,
    InspectionError,
    VisionTreasureInspector,
)

HOST = "images.example.org"
URL = f"https://{HOST}/item.jpg?size=large"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 32


class _TestServer:
    """A single-shot HTTP responder on loopback that records what it received."""

    def __init__(self, raw: bytes | Callable[[bytes], bytes]) -> None:
        self._raw = raw
        self.requests: list[bytes] = []
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> int:
        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                request = await reader.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                request = b""
            self.requests.append(request)
            raw = self._raw(request) if callable(self._raw) else self._raw
            writer.write(raw)
            await writer.drain()
            writer.close()

        self._server = await asyncio.start_server(handle, "127.0.0.1", 0)
        return self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()


def _response(status: str = "200 OK", headers: str = "", body: bytes = PNG_BYTES) -> bytes:
    head = f"HTTP/1.1 {status}\r\n{headers}".encode("latin-1")
    return head + b"\r\n" + body


async def _pinned_inspector(
    monkeypatch: pytest.MonkeyPatch,
    raw: bytes | Callable[[bytes], bytes],
    *,
    resolved: list[str] | None = None,
) -> tuple[VisionTreasureInspector, _TestServer, list[tuple[str, str]]]:
    server = _TestServer(raw)
    port = await server.start()
    calls: list[tuple[str, str]] = []
    addresses = resolved or ["127.0.0.1"]

    monkeypatch.setattr(vision_identifier, "_public_addresses", lambda host: list(addresses))

    async def connector(host: str, address: str, *, ssl_context: Any):
        calls.append((host, address))
        return await asyncio.open_connection("127.0.0.1", port)

    inspector = VisionTreasureInspector(
        client=object(), allowed_hosts={HOST}, connector=connector
    )
    return inspector, server, calls


@pytest.mark.asyncio
async def test_download_connects_to_the_resolved_address_and_sets_the_host_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inspector, server, calls = await _pinned_inspector(
        monkeypatch,
        _response(headers=f"Content-Type: image/png\r\nContent-Length: {len(PNG_BYTES)}\r\n"),
    )
    try:
        content_type, content = await inspector.download_image(URL)
    finally:
        await server.stop()

    assert content_type == "image/png"
    assert content == PNG_BYTES
    # The connector receives the validated address, never the hostname, so no
    # second DNS lookup can redirect the connection.
    assert calls == [(HOST, "127.0.0.1")]
    request = server.requests[0].decode("latin-1")
    assert request.startswith("GET /item.jpg?size=large HTTP/1.1\r\n")
    assert f"Host: {HOST}\r\n" in request
    assert "Connection: close\r\n" in request
    assert "Accept-Encoding: identity\r\n" in request


@pytest.mark.asyncio
async def test_download_uses_the_first_validated_address(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, calls = await _pinned_inspector(
        monkeypatch,
        _response(headers=f"Content-Type: image/png\r\nContent-Length: {len(PNG_BYTES)}\r\n"),
        resolved=["203.0.113.10", "203.0.113.11"],
    )
    try:
        await inspector.download_image(URL)
    finally:
        await server.stop()

    assert calls == [(HOST, "203.0.113.10")]


@pytest.mark.asyncio
async def test_redirect_is_never_followed(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, calls = await _pinned_inspector(
        monkeypatch,
        _response(status="302 Found", headers="Location: https://127.0.0.1/secret\r\n"),
    )
    try:
        with pytest.raises(InspectionError, match="keinen erfolgreichen Status"):
            await inspector.download_image(URL)
    finally:
        await server.stop()

    assert len(server.requests) == 1
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_chunked_body_is_decoded(monkeypatch: pytest.MonkeyPatch) -> None:
    chunked = (
        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"8\r\n\x89PNG\r\n\x1a\n\r\n"
        + hex(len(b"0" * 16))[2:].encode() + b"\r\n" + b"0" * 16 + b"\r\n"
        + b"0\r\n\r\n"
    )
    inspector, server, _ = await _pinned_inspector(monkeypatch, chunked)
    try:
        _, content = await inspector.download_image(URL)
    finally:
        await server.stop()

    assert content == PNG_BYTES[:24]


@pytest.mark.asyncio
async def test_close_delimited_body_is_read_to_eof(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, _response(headers="Content-Type: image/png\r\n")
    )
    try:
        _, content = await inspector.download_image(URL)
    finally:
        await server.stop()

    assert content == PNG_BYTES


@pytest.mark.asyncio
async def test_declared_oversize_body_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, _ = await _pinned_inspector(
        monkeypatch,
        _response(headers=f"Content-Type: image/png\r\nContent-Length: {MAX_IMAGE_BYTES + 1}\r\n"),
    )
    try:
        with pytest.raises(InspectionError, match="Größenlimit"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_streamed_body_over_the_limit_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"\x89PNG\r\n\x1a\n" + b"0" * (MAX_IMAGE_BYTES + 1)
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, _response(headers="Content-Type: image/png\r\n", body=body)
    )
    try:
        with pytest.raises(InspectionError, match="Größenlimit"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_chunked_body_over_the_limit_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    chunk_size = MAX_IMAGE_BYTES
    raw = (
        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n"
        + hex(chunk_size)[2:].encode() + b"\r\n" + b"\x89PNG\r\n\x1a\n" + b"0" * (chunk_size - 8) + b"\r\n"
        + b"10\r\n" + b"0" * 16 + b"\r\n0\r\n\r\n"
    )
    inspector, server, _ = await _pinned_inspector(monkeypatch, raw)
    try:
        with pytest.raises(InspectionError, match="Größenlimit"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_invalid_chunk_framing_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = (
        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"zz\r\n" + PNG_BYTES + b"\r\n0\r\n\r\n"
    )
    inspector, server, _ = await _pinned_inspector(monkeypatch, raw)
    try:
        with pytest.raises(InspectionError, match="Chunk-Kodierung"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_oversized_response_headers_are_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nX-Pad: " + b"a" * (17 * 1024) + b"\r\n\r\n"
    inspector, server, _ = await _pinned_inspector(monkeypatch, raw)
    try:
        with pytest.raises(InspectionError, match="Header"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_malformed_status_line_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, b"NOT-HTTP\r\nContent-Type: image/png\r\n\r\n" + PNG_BYTES
    )
    try:
        with pytest.raises(InspectionError, match="ungültige HTTP-Antwort"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_unlisted_content_type_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, _response(headers="Content-Type: text/html\r\n")
    )
    try:
        with pytest.raises(InspectionError, match="Nicht unterstütztes Bildformat"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_signature_mismatch_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, _response(headers="Content-Type: image/jpeg\r\n", body=b"not-a-jpeg-at-all")
    )
    try:
        with pytest.raises(InspectionError, match="stimmt nicht mit dem Dateiformat"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_invalid_webp_container_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"RIFF" + b"\x00" * 4 + b"NOPE" + b"0" * 16
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, _response(headers="Content-Type: image/webp\r\n", body=body)
    )
    try:
        with pytest.raises(InspectionError, match="Ungültige WebP-Datei"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_empty_body_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    inspector, server, _ = await _pinned_inspector(
        monkeypatch, _response(headers="Content-Type: image/png\r\n", body=b"")
    )
    try:
        with pytest.raises(InspectionError, match="keinen Inhalt"):
            await inspector.download_image(URL)
    finally:
        await server.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.10", "169.254.169.254", "::1", "fd00::1", "fe80::1"],
)
async def test_non_public_dns_answers_block_the_download_before_connecting(
    monkeypatch: pytest.MonkeyPatch, address: str
) -> None:
    family = socket.AF_INET6 if ":" in address else socket.AF_INET

    def fake_getaddrinfo(host: str, port: int, **kwargs: Any):
        entry = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
        return [(family, socket.SOCK_STREAM, 6, "", entry)]

    monkeypatch.setattr(vision_identifier.socket, "getaddrinfo", fake_getaddrinfo)
    calls: list[tuple[str, str]] = []

    async def connector(host: str, pinned: str, *, ssl_context: Any):
        calls.append((host, pinned))
        raise AssertionError("connector must not be reached for a non-public answer")

    inspector = VisionTreasureInspector(
        client=object(), allowed_hosts={HOST}, connector=connector
    )

    with pytest.raises(InspectionError, match="nicht öffentliche IP-Adresse"):
        await inspector.download_image(URL)

    assert calls == []


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
    calls: list[tuple[str, str]] = []

    async def connector(host: str, pinned: str, *, ssl_context: Any):
        calls.append((host, pinned))
        raise AssertionError("connector must not be reached for a mixed answer")

    inspector = VisionTreasureInspector(
        client=object(), allowed_hosts={HOST}, connector=connector
    )

    with pytest.raises(InspectionError, match="nicht öffentliche IP-Adresse"):
        await inspector.download_image(URL)

    assert calls == []


@pytest.mark.asyncio
async def test_unresolvable_host_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_getaddrinfo(host: str, port: int, **kwargs: Any):
        raise socket.gaierror("name or service not known")

    monkeypatch.setattr(vision_identifier.socket, "getaddrinfo", failing_getaddrinfo)
    inspector = VisionTreasureInspector(client=object(), allowed_hosts={HOST})

    with pytest.raises(InspectionError, match="nicht aufgelöst"):
        await inspector.download_image(URL)


@pytest.mark.asyncio
async def test_connection_failure_is_reported_without_leaking_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(vision_identifier, "_public_addresses", lambda host: ["203.0.113.10"])

    async def connector(host: str, pinned: str, *, ssl_context: Any):
        raise OSError("connect to 203.0.113.10:443 failed: internal hostname leak")

    inspector = VisionTreasureInspector(
        client=object(), allowed_hosts={HOST}, connector=connector
    )

    with pytest.raises(InspectionError) as excinfo:
        await inspector.download_image(URL)

    assert "203.0.113.10" not in str(excinfo.value)
    assert "internal hostname leak" not in str(excinfo.value)
