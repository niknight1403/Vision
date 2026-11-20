import socket

import httpcore
import httpx
import pytest

from vision_worker.pinned_http_transport import (
    PinnedAsyncHTTPTransport,
    _PinnedAsyncNetworkBackend,
)
from vision_worker.vision_identifier import (
    InspectionError,
    VisualInspection,
    _resolve_public_ips,
    _validate_image_url,
    VisionTreasureInspector,
)


def test_only_allowlisted_https_hosts_are_accepted():
    assert _validate_image_url(
        "https://images.example.org/item.jpg", {"images.example.org"}
    ) == "images.example.org"


@pytest.mark.parametrize("url", [
    "http://images.example.org/item.jpg",
    "https://127.0.0.1/private.jpg",
    "https://user:pass@images.example.org/item.jpg",
    "https://images.example.org:8443/item.jpg",
    "file:///etc/passwd",
])
def test_unsafe_image_urls_are_rejected(url):
    with pytest.raises(InspectionError):
        _validate_image_url(url, {"images.example.org"})


def test_visual_result_is_bounded_and_explicitly_uncertain():
    result = VisualInspection(
        identified=False,
        exact_model="Unbekannt",
        visual_authenticity_score=0.1,
        condition_grade="Unklar",
        uncertainty_notes=["Typenschild nicht lesbar"],
    )
    assert result.visual_authenticity_score == 0.1
    assert result.identified is False


def test_visual_score_out_of_range_is_rejected():
    with pytest.raises(Exception):
        VisualInspection(
            identified=True,
            visual_authenticity_score=1.2,
        )


@pytest.mark.asyncio
async def test_injected_llm_client_remains_owned_by_the_caller():
    class FakeOpenAIClient:
        closed = False

        async def close(self):
            self.closed = True

    llm = FakeOpenAIClient()
    inspector = VisionTreasureInspector(client=llm)

    await inspector.close()

    assert llm.closed is False


@pytest.mark.asyncio
async def test_dns_resolution_returns_only_deduplicated_public_addresses(monkeypatch):
    answers = [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 0, 0)),
    ]
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: answers)

    result = await _resolve_public_ips("images.example.org")

    assert result == (
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
    )


@pytest.mark.asyncio
async def test_dns_resolution_rejects_mixed_public_and_private_answers(monkeypatch):
    answers = [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 443)),
    ]
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: answers)

    with pytest.raises(InspectionError, match="nicht öffentliche"):
        await _resolve_public_ips("images.example.org")


@pytest.mark.asyncio
async def test_dns_resolution_rejects_empty_answer_set(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [])

    with pytest.raises(InspectionError):
        await _resolve_public_ips("images.example.org")


@pytest.mark.asyncio
async def test_pinned_backend_connects_to_validated_ip_not_url_hostname():
    class FakeStream:
        pass

    class FakeBackend:
        def __init__(self):
            self.targets = []

        async def connect_tcp(self, host, port, **kwargs):
            self.targets.append((host, port))
            return FakeStream()

        async def connect_unix_socket(self, *args, **kwargs):
            raise AssertionError("Unix socket path must not be used")

        async def sleep(self, seconds):
            return None

    backend = _PinnedAsyncNetworkBackend("images.example.org", ["93.184.216.34"])
    fake = FakeBackend()
    backend._backend = fake

    stream = await backend.connect_tcp("images.example.org", 443)

    assert isinstance(stream, FakeStream)
    assert fake.targets == [("93.184.216.34", 443)]


@pytest.mark.asyncio
async def test_pinned_backend_refuses_different_host_and_port():
    class FakeBackend:
        async def connect_tcp(self, *args, **kwargs):
            raise AssertionError("Unexpected network connection")

    backend = _PinnedAsyncNetworkBackend("images.example.org", ["93.184.216.34"])
    backend._backend = FakeBackend()

    with pytest.raises(httpcore.ConnectError):
        await backend.connect_tcp("169.254.169.254", 443)
    with pytest.raises(httpcore.ConnectError):
        await backend.connect_tcp("images.example.org", 80)


@pytest.mark.asyncio
async def test_transport_keeps_original_host_header_and_tls_origin():
    captured = {}

    class EmptyCoreStream(httpcore.AsyncByteStream):
        async def __aiter__(self):
            if False:
                yield b""

        async def aclose(self):
            return None

    transport = PinnedAsyncHTTPTransport("images.example.org", ["93.184.216.34"])

    async def fake_send(core_request):
        captured["host"] = core_request.url.host
        captured["headers"] = dict(core_request.headers)
        return httpcore.Response(
            status=200,
            headers=[(b"content-type", b"image/png")],
            stream=EmptyCoreStream(),
        )

    transport._pool.handle_async_request = fake_send
    request = httpx.Request("GET", "https://images.example.org/item.png")
    response = await transport.handle_async_request(request)

    assert captured["host"] == b"images.example.org"
    assert captured["headers"][b"host"] == b"images.example.org"
    assert response.status_code == 200

    await response.aclose()
    await transport.aclose()
