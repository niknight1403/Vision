"""Private HTTP entry point for the Hidden Treasure Swarm.

Hardening rules (Sprint 34):
- every request body is bounded (declared and streamed), so a large upload cannot
  exhaust the worker;
- concurrent analyses are bounded and refused with 503 instead of queueing;
- each analysis has a hard deadline and returns 504 instead of hanging;
- every response carries a correlation id, and error bodies never repeat a URL,
  token or internal exception detail;
- /health is a liveness probe that stays green, /ready reports whether the worker
  can actually serve, and shutdown drains in-flight analyses.
"""
from __future__ import annotations

import asyncio
import hmac
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .hidden_treasure_swarm import HiddenTreasureSwarm, ProductBrief
from .llm_specialists import build_llm_specialists
from .vision_identifier import VisionTreasureInspector

MAX_REQUEST_BYTES = 64 * 1024
DEFAULT_MAX_CONCURRENT_ANALYSES = 4
DEFAULT_ANALYSIS_TIMEOUT_SECONDS = 90.0
DEFAULT_SHUTDOWN_GRACE_SECONDS = 20.0
REQUEST_ID_HEADER = "x-request-id"
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,64}$")


def _positive_int(name: str, default: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < 1 or value > maximum:
        raise RuntimeError(f"{name} must be between 1 and {maximum}")
    return value


def _positive_seconds(name: str, default: float, maximum: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a number") from exc
    if value <= 0 or value > maximum:
        raise RuntimeError(f"{name} must be greater than 0 and at most {maximum}")
    return value


def request_id_for(headers: dict[str, str]) -> str:
    """Keep a well-formed caller correlation id, otherwise mint a fresh one."""
    supplied = headers.get(REQUEST_ID_HEADER, "")
    if _REQUEST_ID_PATTERN.match(supplied):
        return supplied
    return uuid.uuid4().hex


class RequestContextMiddleware:
    """Attach a correlation id to the scope and echo it on the response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        request_id = request_id_for(headers)
        scope.setdefault("state", {})["request_id"] = request_id

        async def send_with_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                raw_headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.decode("latin-1").lower() != REQUEST_ID_HEADER
                ]
                raw_headers.append((REQUEST_ID_HEADER.encode("latin-1"), request_id.encode("latin-1")))
                message = {**message, "headers": raw_headers}
            await send(message)

        await self.app(scope, receive, send_with_request_id)


class PayloadLimitMiddleware:
    """Reject oversized bodies, declared or streamed, before they are parsed.

    The body is buffered up to the limit and replayed downstream, so an oversized
    streamed body can be answered with 413 even though the inner application has
    not started parsing yet.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        declared = headers.get("content-length")
        if declared is not None:
            try:
                too_large = int(declared) > self.max_bytes
            except ValueError:
                too_large = True
            if too_large:
                await self._reject(scope, send)
                return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":
                await self._reject(scope, send)
                return
            body += message.get("body", b"")
            if len(body) > self.max_bytes:
                await self._reject(scope, send)
                return
            if not message.get("more_body", False):
                break

        buffered = bytes(body)
        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if replayed:
                return {"type": "http.disconnect"}
            replayed = True
            return {"type": "http.request", "body": buffered, "more_body": False}

        await self.app(scope, replay_receive, send)

    async def _reject(self, scope: Scope, send: Send) -> None:
        response = JSONResponse(
            {"error": "REQUEST_TOO_LARGE", "requestId": scope.get("state", {}).get("request_id")},
            status_code=413,
        )
        await response(scope, _empty_receive, send)


async def _empty_receive() -> Message:
    return {"type": "http.disconnect"}


def _error_body(code: str, request_id: str | None) -> dict[str, Any]:
    return {"error": code, "requestId": request_id}


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=6000)
    image_url: str = Field(min_length=9, max_length=2048)
    asking_price_minor: int = Field(ge=0)
    known_costs_minor: int = Field(default=0, ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)


class VisualInspectionRequest(BaseModel):
    """Visual-only inspection: an image URL plus an unverified listing title."""
    model_config = ConfigDict(extra="forbid")
    image_url: str = Field(min_length=9, max_length=2048)
    hint_title: str = Field(default="", max_length=300)


@asynccontextmanager
async def lifespan(app: FastAPI):
    token = os.getenv("VISION_WORKER_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("VISION_WORKER_TOKEN must contain at least 32 characters")
    hosts = {
        item.strip().lower().rstrip(".")
        for item in os.getenv("VISION_ALLOWED_IMAGE_HOSTS", "").split(",")
        if item.strip()
    }
    if not hosts:
        raise RuntimeError("VISION_ALLOWED_IMAGE_HOSTS must contain exact hostnames")
    inspector = VisionTreasureInspector(allowed_hosts=hosts)
    app.state.inspector = inspector
    app.state.worker_token = token
    app.state.max_concurrent = _positive_int(
        "VISION_MAX_CONCURRENT_ANALYSES", DEFAULT_MAX_CONCURRENT_ANALYSES, 64
    )
    app.state.analysis_timeout = _positive_seconds(
        "VISION_ANALYSIS_TIMEOUT_SECONDS", DEFAULT_ANALYSIS_TIMEOUT_SECONDS, 600.0
    )
    app.state.shutdown_grace = _positive_seconds(
        "VISION_SHUTDOWN_GRACE_SECONDS", DEFAULT_SHUTDOWN_GRACE_SECONDS, 120.0
    )
    app.state.in_flight = 0
    app.state.shutting_down = False
    yield
    app.state.shutting_down = True
    deadline = time.monotonic() + app.state.shutdown_grace
    while app.state.in_flight > 0 and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    await inspector.close()


app = FastAPI(title="AutonomAgent Hidden Treasure Worker", version="0.1.0", lifespan=lifespan)
app.add_middleware(PayloadLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)
app.add_middleware(RequestContextMiddleware)


@app.exception_handler(HTTPException)
async def _http_error(request: Request, exc: HTTPException) -> JSONResponse:
    code = exc.detail if isinstance(exc.detail, str) else "WORKER_REQUEST_REJECTED"
    return JSONResponse(
        _error_body(code, getattr(request.state, "request_id", None)),
        status_code=exc.status_code,
    )


@app.exception_handler(Exception)
async def _unhandled(request: Request, _: Exception) -> JSONResponse:
    # Never echo the exception text: it can contain URLs, tokens or hostnames.
    return JSONResponse(
        _error_body("WORKER_INTERNAL_ERROR", getattr(request.state, "request_id", None)),
        status_code=500,
    )


def _require_bearer(authorization: str | None) -> None:
    expected = "Bearer " + app.state.worker_token
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="WORKER_AUTH_REQUIRED")


async def _guarded(work: Callable[[], Awaitable[Any]]) -> Any:
    """Run one analysis with bounded concurrency and a hard deadline."""
    if app.state.shutting_down:
        raise HTTPException(status_code=503, detail="WORKER_SHUTTING_DOWN")
    # The counter is incremented before the first await, so the check and the
    # reservation cannot interleave inside the event loop.
    if app.state.in_flight >= app.state.max_concurrent:
        raise HTTPException(status_code=503, detail="WORKER_BUSY")
    app.state.in_flight += 1
    try:
        return await asyncio.wait_for(work(), timeout=app.state.analysis_timeout)
    except (asyncio.TimeoutError, TimeoutError) as exc:
        raise HTTPException(status_code=504, detail="WORKER_TIMEOUT") from exc
    finally:
        app.state.in_flight -= 1


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness: the process is up. Stays green during a draining shutdown."""
    return {"status": "ok", "service": "hidden-treasure-worker"}


@app.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: configuration is present and the worker still accepts work."""
    checks = {
        "shuttingDown": bool(app.state.shutting_down),
        "tokenConfigured": len(getattr(app.state, "worker_token", "")) >= 32,
        "imageHostsConfigured": bool(getattr(app.state.inspector, "allowed_hosts", None)),
        "capacityAvailable": app.state.in_flight < app.state.max_concurrent,
    }
    healthy = not checks["shuttingDown"] and checks["tokenConfigured"] and checks["imageHostsConfigured"]
    return JSONResponse(
        {"status": "ready" if healthy else "not-ready", "checks": checks},
        status_code=200 if healthy else 503,
    )


@app.post("/v1/analyze")
async def analyze(
    request: AnalysisRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_bearer(authorization)

    async def work() -> dict[str, Any]:
        inspector: VisionTreasureInspector = app.state.inspector
        visual = await inspector.inspect_item_visuals(request.image_url, request.title)
        observations: list[str] = []
        if visual.get("identified") is True:
            if isinstance(visual.get("exact_model"), str):
                observations.append("Identified model: " + visual["exact_model"])
            markings = visual.get("detected_markings")
            if isinstance(markings, list):
                observations.extend("Visible marking: " + str(item)[:200] for item in markings[:30])
            if isinstance(visual.get("condition_grade"), str):
                observations.append("Visual condition: " + visual["condition_grade"])
        else:
            observations.append("Visual inspection uncertain: " + str(visual.get("details", "unknown"))[:300])

        brief = ProductBrief(
            candidate_id=request.candidate_id,
            title=request.title,
            description=request.description,
            asking_price_minor=request.asking_price_minor,
            known_costs_minor=request.known_costs_minor,
            currency=request.currency.upper(),
            image_observations=observations,
        )
        specialists = build_llm_specialists(inspector.client, model=inspector.model)
        swarm = HiddenTreasureSwarm(specialists, concurrency=6, timeout_seconds=45)
        assessment = await swarm.analyze(brief)
        return {
            "assessment": assessment.model_dump(mode="json"),
            "visual_inspection": visual,
            "purchase_authorized": False,
            "authenticity_verified": False,
        }

    return await _guarded(work)


@app.post("/v1/visual-inspection")
async def visual_inspection(
    request: VisualInspectionRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Visual evidence only; the API route behind it never authorizes a purchase."""
    _require_bearer(authorization)

    async def work() -> dict[str, Any]:
        inspector: VisionTreasureInspector = app.state.inspector
        visual = await inspector.inspect_item_visuals(request.image_url, request.hint_title)
        return {
            "visual_inspection": visual,
            "purchase_authorized": False,
            "authenticity_verified": False,
        }

    return await _guarded(work)
