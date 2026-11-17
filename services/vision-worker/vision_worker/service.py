"""Private HTTP entry point for the Hidden Treasure Swarm."""
from __future__ import annotations

import asyncio
import hmac
import os
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .hidden_treasure_swarm import HiddenTreasureSwarm, ProductBrief
from .llm_specialists import build_llm_specialists
from .vision_identifier import VisionTreasureInspector


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=6000)
    image_url: str = Field(min_length=9, max_length=2048)
    asking_price_minor: int = Field(ge=0)
    known_costs_minor: int = Field(default=0, ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    checkpoint: dict[str, Any] | None = None
    checkpoint_callback_url: str | None = Field(default=None, min_length=8, max_length=2048)
    worker_id: str | None = Field(default=None, min_length=1, max_length=128)


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
    yield
    await inspector.close()


app = FastAPI(title="AutonomAgent Hidden Treasure Worker", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "hidden-treasure-worker"}


@app.post("/v1/analyze")
async def analyze(
    request: AnalysisRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    expected = "Bearer " + app.state.worker_token
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="WORKER_AUTH_REQUIRED")

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
    specialists = build_llm_specialists(
        inspector.client,
        model=inspector.model,
        fallback_client=inspector.fallback_client,
        fallback_model=inspector.fallback_model,
    )
    swarm = HiddenTreasureSwarm(specialists, concurrency=6, timeout_seconds=45)
    checkpoint = request.checkpoint
    checkpoint_lock = asyncio.Lock()

    async def persist_finding(finding) -> None:
        if not request.checkpoint_callback_url or not request.worker_id:
            raise RuntimeError("CHECKPOINT_CALLBACK_NOT_CONFIGURED")
        parsed = urlsplit(request.checkpoint_callback_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise RuntimeError("CHECKPOINT_CALLBACK_URL_INVALID")
        async with checkpoint_lock:
            current = dict(checkpoint or {"schema_version": 1, "findings": {}})
            findings = dict(current.get("findings", {}))
            findings[finding.role.value] = finding.model_dump(mode="json")
            current = {"schema_version": 1, "findings": findings}
            response = await inspector.http_client.post(
                request.checkpoint_callback_url,
                json={"workerId": request.worker_id, "checkpoint": current},
                headers={"authorization": "Bearer " + app.state.worker_token},
            )
            response.raise_for_status()
            checkpoint = current

    assessment = await swarm.analyze(
        brief,
        checkpoint=checkpoint,
        on_finding=persist_finding if request.checkpoint_callback_url else None,
    )
    return {
        "assessment": assessment.model_dump(mode="json"),
        "visual_inspection": visual,
        "purchase_authorized": False,
        "authenticity_verified": False,
    }
