"""Coordinator agent for cross-specialist consensus and evidence-gap review.

The coordinator can summarize and challenge the swarm's findings, but it cannot
change the evidence-backed valuation, authorize purchases, or invent comparables.
"""
from __future__ import annotations

import json
from typing import Literal

from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field

from .hidden_treasure_swarm import ProductBrief, TreasureAssessment


class AgentNetworkReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["REVIEWED", "COORDINATOR_UNAVAILABLE"]
    consensus: Literal["HIGH", "MEDIUM", "LOW"]
    summary: str = Field(max_length=2000)
    unresolved_conflicts: list[str] = Field(default_factory=list, max_length=20)
    evidence_gaps: list[str] = Field(default_factory=list, max_length=20)
    recommended_next_steps: list[str] = Field(default_factory=list, max_length=20)
    confidence: float = Field(ge=0, le=1)


def unavailable_review(assessment: TreasureAssessment) -> AgentNetworkReview:
    """Fail closed: a missing coordinator never upgrades the swarm's conclusions."""
    return AgentNetworkReview(
        status="COORDINATOR_UNAVAILABLE",
        consensus="LOW",
        summary="The specialist swarm completed, but the coordinator could not verify cross-agent consensus.",
        unresolved_conflicts=list(assessment.conflicts)[:20],
        evidence_gaps=list(assessment.next_actions)[:20],
        recommended_next_steps=[
            "Retry coordinator review before treating this result as complete.",
            "Keep the candidate in manual review; no purchase is authorized.",
        ],
        confidence=0,
    )


async def review_agent_network(
    client: AsyncOpenAI,
    *,
    model: str,
    brief: ProductBrief,
    assessment: TreasureAssessment,
    fallback_client: AsyncOpenAI | None = None,
    fallback_model: str | None = None,
) -> AgentNetworkReview:
    """Run a final LLM coordinator over the specialist evidence without changing it."""
    payload = {
        "candidate": brief.model_dump(mode="json"),
        "assessment": assessment.model_dump(mode="json"),
    }
    prompt = (
        "You are the coordinator of a six-agent product research network. "
        "Cross-check the visual, market, collector, technical, restoration, and risk "
        "findings. Identify contradictions, missing evidence, and the safest next "
        "steps. Treat every specialist output as an unverified claim unless it has "
        "source evidence. Never invent sold prices, comparables, URLs, authenticity, "
        "condition, provenance, or facts. Do not calculate or alter valuation, score, "
        "or confidence in the underlying assessment. Do not authorize a purchase. "
        "A missing or failed specialist must lower consensus. If market comparables "
        "are insufficient or the assessment has conflicts, consensus cannot be HIGH. "
        "Return only JSON with keys: status (REVIEWED), consensus (HIGH, MEDIUM, LOW), "
        "summary, unresolved_conflicts (array of strings), evidence_gaps (array of "
        "strings), recommended_next_steps (array of strings), confidence (0..1). "
        "Keep every statement traceable to the supplied payload. Payload: "
        + json.dumps(payload, ensure_ascii=False, default=str)
    )

    async def invoke(target: AsyncOpenAI, target_model: str):
        response = await target.chat.completions.create(
            model=target_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content
        if not raw:
            raise ValueError("Empty coordinator response")
        data = json.loads(raw)
        data["status"] = "REVIEWED"
        return AgentNetworkReview.model_validate(data)

    try:
        review = await invoke(client, model)
    except Exception:
        if fallback_client is None or not fallback_model:
            return unavailable_review(assessment)
        try:
            review = await invoke(fallback_client, fallback_model)
        except Exception:
            return unavailable_review(assessment)

    # Deterministic safety caps override optimistic model self-assessment.
    if assessment.status != "READY_FOR_ADMIN_REVIEW" or assessment.conflicts:
        if review.consensus == "HIGH":
            review.consensus = "MEDIUM" if not assessment.conflicts else "LOW"
    if any(f.status != "SUCCEEDED" for f in assessment.findings):
        review.consensus = "LOW"
    review.unresolved_conflicts = list(dict.fromkeys(
        [*assessment.conflicts, *review.unresolved_conflicts]
    ))[:20]
    review.evidence_gaps = list(dict.fromkeys(
        [*assessment.next_actions, *review.evidence_gaps]
    ))[:20]
    if assessment.status != "READY_FOR_ADMIN_REVIEW":
        review.confidence = min(review.confidence, assessment.confidence)
    return review
