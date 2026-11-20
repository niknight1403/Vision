from __future__ import annotations

import ssl
from collections.abc import AsyncIterable, Iterable

import certifi
import httpcore
import httpx


class _PinnedAsyncNetworkBackend(httpcore.AsyncNetworkBackend):
    """Route TCP connections only to DNS answers already approved by the caller."""

    def __init__(self, hostname: str, addresses: Iterable[str]) -> None:
        self._hostname = hostname.rstrip(".").lower()
        self._addresses = tuple(dict.fromkeys(addresses))
        self._backend = httpcore.AnyIOBackend()
        if not self._addresses:
            raise ValueError("At least one validated address is required")

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: list[tuple[int, int, int | bytes]] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        normalized_host = host.rstrip(".").lower()
        if normalized_host != self._hostname or port != 443:
            raise httpcore.ConnectError("Pinned transport refused an unexpected origin")

        last_error: Exception | None = None
        for address in self._addresses:
            try:
                return await self._backend.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc

        if last_error is not None:
            raise last_error
        raise httpcore.ConnectError("No validated address could be reached")

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: list[tuple[int, int, int | bytes]] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("Unix sockets are disabled for image fetching")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream: AsyncIterable[bytes]) -> None:
        self._stream = stream

    async def __aiter__(self):
        async for chunk in self._stream:
            yield chunk

    async def aclose(self) -> None:
        close = getattr(self._stream, "aclose", None)
        if close is not None:
            await close()


class PinnedAsyncHTTPTransport(httpx.AsyncBaseTransport):
    """An HTTPX transport pinned to validated IPs for exactly one HTTPS host.

    The request URL remains unchanged. httpcore uses that original hostname
    for Host and TLS SNI/certificate verification; only connect_tcp receives
    the pinned numeric IP. A new transport/client must be created per host
    and per DNS validation.
    """

    def __init__(self, hostname: str, addresses: Iterable[str]) -> None:
        self._hostname = hostname.rstrip(".").lower()
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl.create_default_context(cafile=certifi.where()),
            max_connections=10,
            max_keepalive_connections=0,
            http1=True,
            http2=False,
            network_backend=_PinnedAsyncNetworkBackend(self._hostname, addresses),
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if (
            request.url.scheme != "https"
            or request.url.host.rstrip(".").lower() != self._hostname
            or (request.url.port or 443) != 443
        ):
            raise httpx.ConnectError("Pinned transport refused an unexpected origin", request=request)

        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port or 443,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        try:
            core_response = await self._pool.handle_async_request(core_request)
        except (\n            httpcore.NetworkError,\n            httpcore.ProtocolError,\n            httpcore.TimeoutException,\n            httpcore.ProxyError,\n            httpcore.LocalProtocolError,\n        ) as exc:
            raise httpx.TransportError("Pinned image connection failed", request=request) from exc

        return httpx.Response(
            status_code=core_response.status,
            headers=core_response.headers,
            stream=_ResponseStream(core_response.stream),
            extensions=core_response.extensions,
            request=request,
        )

    async def aclose(self) -> None:
        await self._pool.aclose()
