"""OpenAI-compatible LLM adapters for the non-market specialist roles.

Market research is deliberately a separate injected adapter: an LLM cannot create
verified sold listings and this module never treats generated citations as evidence.
"""
from __future__ import annotations

import json
from typing import Awaitable, Callable

from openai import AsyncOpenAI

from .hidden_treasure_swarm import (
    ComparableSale,
    ProductBrief,
    SpecialistFinding,
    SpecialistRole,
)


ROLE_INSTRUCTIONS = {
    SpecialistRole.VISUAL: (
        "Identify the likely object and visible model only from supplied observations. "
        "Do not infer unreadable markings. Return identified_model only when supported."
    ),
    SpecialistRole.COLLECTOR: (
        "Assess potential edition, rarity, age, and collector relevance. "
        "Separate verifiable clues from hypotheses; do not invent provenance or production numbers."
    ),
    SpecialistRole.TECHNICAL: (
        "Assess parts, compatibility, revisions, repairability, and component value. "
        "Return identified_model only if the supplied observations support it."
    ),
    SpecialistRole.RESTORATION: (
        "Assess visible/declared condition, missing parts, repair steps, and cost drivers. "
        "Do not claim damage or completeness that is not in the supplied evidence."
    ),
    SpecialistRole.RISK: (
        "Assess counterfeit indicators, safety/legal concerns, hidden-damage uncertainty, "
        "and reasons to reject or manually inspect. A photo cannot certify authenticity."
    ),
}


MarketResearch = Callable[[ProductBrief], Awaitable[SpecialistFinding]]


def build_llm_specialists(
    client: AsyncOpenAI,
    *,
    model: str,
    market_research: MarketResearch | None = None,
):
    """Build specialist callables; market research stays unavailable without real data."""
    async def llm_adapter(role: SpecialistRole, brief: ProductBrief) -> SpecialistFinding:
        payload = {
            "candidate_id": brief.candidate_id,
            "title": brief.title,
            "description": brief.description,
            "asking_price_minor": brief.asking_price_minor,
            "currency": brief.currency,
            "known_costs_minor": brief.known_costs_minor,
            "image_observations": brief.image_observations,
        }
        prompt = (
            f"Role: {role.value}. {ROLE_INSTRUCTIONS[role]} "
            "Return one JSON object with keys: summary, facts (array of strings), "
            "identified_model (string or null), evidence_urls (empty array; no verified "
            "source URLs are supplied), confidence (0..1), uncertainties (array of strings). "
            "Do not invent sources, prices, URLs, or facts. If evidence is weak, lower "
            "confidence and state what is unknown. Product evidence: "
            + json.dumps(payload, ensure_ascii=False)
        )
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content
        if not raw:
            raise ValueError("Empty specialist response")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Invalid specialist response")
        # ProductBrief contains observations, not authenticated source URLs or
        # sold records. A model's claim of evidence cannot become market evidence.
        unsupported_evidence = bool(data.get("evidence_urls") or data.get("comparable_sales"))
        uncertainties = data.get("uncertainties", [])
        if unsupported_evidence:
            if not isinstance(uncertainties, list):
                uncertainties = []
            uncertainties = [*uncertainties, "Model-supplied source claims were discarded; no verified source was provided."]
        return SpecialistFinding.model_validate({
            **data,
            "role": role,
            "status": "SUCCEEDED",
            "evidence_urls": [],
            "comparable_sales": [],
            "uncertainties": uncertainties,
        })

    async def market_adapter(brief: ProductBrief) -> SpecialistFinding:
        if market_research is None:
            return SpecialistFinding(
                role=SpecialistRole.MARKET,
                status="SKIPPED",
                summary="No approved sold-listing data provider is configured.",
                confidence=0,
                uncertainties=[
                    "Asking prices and LLM estimates are not verified sold comparables."
                ],
            )
        finding = await market_research(brief)
        if finding.role != SpecialistRole.MARKET:
            raise ValueError("Market adapter returned an invalid specialist role")
        # Validate that the adapter returns actual, sourced sold-sale records.
        for sale in finding.comparable_sales:
            if not sale.source_url.startswith("https://"):
                raise ValueError("Market comparables require HTTPS source URLs")
        return finding

    async def visual(brief): return await llm_adapter(SpecialistRole.VISUAL, brief)
    async def collector(brief): return await llm_adapter(SpecialistRole.COLLECTOR, brief)
    async def technical(brief): return await llm_adapter(SpecialistRole.TECHNICAL, brief)
    async def restoration(brief): return await llm_adapter(SpecialistRole.RESTORATION, brief)
    async def risk(brief): return await llm_adapter(SpecialistRole.RISK, brief)

    return {
        SpecialistRole.VISUAL: visual,
        SpecialistRole.MARKET: market_adapter,
        SpecialistRole.COLLECTOR: collector,
        SpecialistRole.TECHNICAL: technical,
        SpecialistRole.RESTORATION: restoration,
        SpecialistRole.RISK: risk,
    }
