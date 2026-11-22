"""Real TLS test: the pinned connection still verifies the hostname via SNI.

Skipped when the `openssl` CLI is unavailable, because the test needs a locally
generated certificate. No external network access is required.
"""
from __future__ import annotations

import asyncio
import shutil
import ssl
import subprocess
from pathlib import Path
from typing import Any

import pytest

from vision_worker import vision_identifier
from vision_worker.vision_identifier import (
    InspectionError,
    VisionTreasureInspector,
    _connect_pinned,
)

HOST = "images.example.org"
URL = f"https://{HOST}/item.png"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 32

pytestmark = pytest.mark.skipif(
    shutil.which("openssl") is None, reason="openssl CLI is required to generate a test certificate"
)


def _certificate(directory: Path) -> tuple[Path, Path]:
    key = directory / "key.pem"
    cert = directory / "cert.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "1",
            "-subj", f"/CN={HOST}",
            "-addext", f"subjectAltName=DNS:{HOST}",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


async def _tls_server(cert: Path, key: Path, sni_seen: list[str | None]):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert), keyfile=str(key))
    context.sni_callback = lambda ssl_object, server_name, ctx: sni_seen.append(server_name)

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            pass
        writer.write(
            f"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {len(PNG_BYTES)}\r\n\r\n".encode()
            + PNG_BYTES
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0, ssl=context)
    return server, server.sockets[0].getsockname()[1]


@pytest.mark.asyncio
async def test_pinned_connection_keeps_sni_and_certificate_verification(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cert, key = _certificate(tmp_path)
    sni_seen: list[str | None] = []
    server, port = await _tls_server(cert, key, sni_seen)
    monkeypatch.setattr(vision_identifier, "_public_addresses", lambda host: ["127.0.0.1"])

    client_context = ssl.create_default_context(cafile=str(cert))

    async def connector(host: str, address: str, *, ssl_context: Any):
        return await _connect_pinned(host, address, ssl_context=ssl_context, port=port)

    inspector = VisionTreasureInspector(
        client=object(),
        allowed_hosts={HOST},
        connector=connector,
        ssl_context=client_context,
    )
    try:
        content_type, content = await inspector.download_image(URL)
    finally:
        server.close()
        await server.wait_closed()

    assert content_type == "image/png"
    assert content == PNG_BYTES
    # The TCP connection went to 127.0.0.1, but TLS still announced and verified
    # images.example.org, so pinning does not weaken certificate checks.
    assert sni_seen == [HOST]


@pytest.mark.asyncio
async def test_untrusted_certificate_is_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cert, key = _certificate(tmp_path)
    sni_seen: list[str | None] = []
    server, port = await _tls_server(cert, key, sni_seen)
    monkeypatch.setattr(vision_identifier, "_public_addresses", lambda host: ["127.0.0.1"])

    async def connector(host: str, address: str, *, ssl_context: Any):
        return await _connect_pinned(host, address, ssl_context=ssl_context, port=port)

    # Default trust store: the self-signed certificate must not be accepted.
    inspector = VisionTreasureInspector(
        client=object(),
        allowed_hosts={HOST},
        connector=connector,
        ssl_context=ssl.create_default_context(),
    )
    try:
        with pytest.raises(InspectionError, match="TLS-Verbindung"):
            await inspector.download_image(URL)
    finally:
        server.close()
        await server.wait_closed()
