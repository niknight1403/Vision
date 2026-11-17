"""Parallel specialist orchestration and evidence-based hidden-treasure scoring.

Provider adapters are injected by the deployment. This module never invents market
comparables and never performs seller contact or purchase actions.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Awaitable, Callable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field


class SpecialistRole(StrEnum):
    VISUAL = "visual_identification"
    MARKET = "market_research"
    COLLECTOR = "collector_rarity"
    TECHNICAL = "technical_parts"
    RESTORATION = "restoration"
    RISK = "risk_authenticity"


class ComparableSale(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount_minor: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    sold_at: datetime
    source_url: str = Field(min_length=8, max_length=2048)
    item_title: str = Field(min_length=2, max_length=300)
    condition: str = Field(default="unknown", max_length=80)


class SpecialistFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: SpecialistRole
    status: str = Field(pattern="^(SUCCEEDED|FAILED|SKIPPED)$")
    summary: str = Field(max_length=4000)
    identified_model: str | None = Field(default=None, max_length=200)
    facts: list[str] = Field(default_factory=list, max_length=30)
    evidence_urls: list[str] = Field(default_factory=list, max_length=30)
    confidence: float = Field(ge=0, le=1)
    uncertainties: list[str] = Field(default_factory=list, max_length=30)
    comparable_sales: list[ComparableSale] = Field(default_factory=list, max_length=30)


class ProductBrief(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=6000)
    asking_price_minor: int = Field(ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    image_observations: list[str] = Field(default_factory=list, max_length=40)
    known_costs_minor: int = Field(default=0, ge=0)


class TreasureAssessment(BaseModel):
    candidate_id: str
    status: str
    score: int = Field(ge=0, le=100)
    valuation_status: str
    resale_value_low_minor: int | None = None
    resale_value_high_minor: int | None = None
    estimated_net_low_minor: int | None = None
    estimated_net_high_minor: int | None = None
    comparable_count: int = 0
    currency: str
    confidence: float = Field(ge=0, le=1)
    findings: list[SpecialistFinding]
    conflicts: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)
    purchase_authorized: bool = False


Specialist = Callable[[ProductBrief], Awaitable[SpecialistFinding]]
REQUIRED_ROLES = tuple(SpecialistRole)


class HiddenTreasureSwarm:
    """Runs configured specialist adapters concurrently and synthesizes evidence."""

    def __init__(
        self,
        specialists: Mapping[SpecialistRole, Specialist],
        *,
        concurrency: int = 6,
        timeout_seconds: float = 45.0,
        comparable_max_age_days: int = 180,
        minimum_comparables: int = 2,
    ) -> None:
        if concurrency < 1 or timeout_seconds <= 0 or minimum_comparables < 1:
            raise ValueError("Invalid swarm execution limits")
        self.specialists = dict(specialists)
        self.semaphore = asyncio.Semaphore(concurrency)
        self.timeout_seconds = timeout_seconds
        self.comparable_max_age_days = comparable_max_age_days
        self.minimum_comparables = minimum_comparables

    async def _run_one(
        self, role: SpecialistRole, brief: ProductBrief
    ) -> SpecialistFinding:
        adapter = self.specialists.get(role)
        if adapter is None:
            return SpecialistFinding(
                role=role, status="SKIPPED",
                summary="No provider adapter configured for this specialist.",
                confidence=0,
                uncertainties=["Specialist adapter is not configured."],
            )
        try:
            async with self.semaphore:
                finding = await asyncio.wait_for(
                    adapter(brief), timeout=self.timeout_seconds
                )
            if finding.role != role:
                raise ValueError("Specialist adapter returned a mismatched role")
            return finding
        except Exception:
            # Keep provider secrets and internal exception details out of results.
            return SpecialistFinding(
                role=role, status="FAILED",
                summary="Specialist analysis failed; retry or manual review required.",
                confidence=0,
                uncertainties=["No verified result was produced."],
            )

    async def analyze(self, brief: ProductBrief) -> TreasureAssessment:
        findings = list(await asyncio.gather(*(
            self._run_one(role, brief) for role in REQUIRED_ROLES
        )))
        return self._synthesize(brief, findings)

    def _synthesize(
        self, brief: ProductBrief, findings: Sequence[SpecialistFinding]
    ) -> TreasureAssessment:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=self.comparable_max_age_days)
        market = next((f for f in findings if f.role == SpecialistRole.MARKET), None)
        sales = [
            sale for sale in (market.comparable_sales if market else [])
            if sale.currency.upper() == brief.currency.upper()
            and sale.sold_at.tzinfo is not None
            and cutoff <= sale.sold_at <= now
            and sale.source_url.startswith("https://")
        ]
        sales.sort(key=lambda sale: sale.amount_minor)
        enough_market_data = len(sales) >= self.minimum_comparables
        low = high = net_low = net_high = None
        if enough_market_data:
            # Use a conservative interquartile-ish band, excluding extreme tails.
            low = sales[max(0, len(sales) // 4)].amount_minor
            high = sales[min(len(sales) - 1, (3 * len(sales)) // 4)].amount_minor
            all_in = brief.asking_price_minor + brief.known_costs_minor
            net_low, net_high = low - all_in, high - all_in

        conflicts: list[str] = []
        identified_models = {
            finding.identified_model.strip().casefold()
            for finding in findings
            if finding.role in (SpecialistRole.VISUAL, SpecialistRole.TECHNICAL)
            and finding.identified_model and finding.identified_model.strip()
        }
        if len(identified_models) > 1:
            conflicts.append("Visual and technical specialists disagree on the identified model.")
        if any(f.status == "FAILED" for f in findings):
            conflicts.append("One or more specialists failed; conclusions are incomplete.")
        if any(f.status == "SKIPPED" for f in findings):
            conflicts.append("One or more specialist adapters are not configured.")
        if not enough_market_data:
            conflicts.append("Insufficient recent, sourced sold comparables for a valuation.")

        successful = [f for f in findings if f.status == "SUCCEEDED"]
        confidence = (
            sum(f.confidence for f in successful) / len(successful)
            if successful else 0.0
        )
        score = 0
        if enough_market_data and net_high is not None:
            margin_ratio = net_high / max(1, brief.asking_price_minor + brief.known_costs_minor)
            score = max(0, min(100, round(50 + margin_ratio * 35)))
            risk = next((f for f in findings if f.role == SpecialistRole.RISK), None)
            if risk and risk.status == "SUCCEEDED" and risk.confidence >= 0.7:
                score = max(0, score - min(40, len(risk.uncertainties) * 10))
            score = round(score * confidence)

        actions = []
        if not enough_market_data:
            actions.append("Retrieve at least two recent sold listings from approved market data sources.")
        if any(f.status != "SUCCEEDED" for f in findings):
            actions.append("Configure or retry missing specialist adapters.")
        if conflicts:
            actions.append("Resolve contradictory or unverified findings before ranking as a confirmed treasure.")
        if not actions:
            actions.append("Send the evidence-backed candidate to ADMIN review; no purchase is authorized.")

        return TreasureAssessment(
            candidate_id=brief.candidate_id,
            status="READY_FOR_ADMIN_REVIEW" if enough_market_data and not conflicts else "RESEARCH_REQUIRED",
            score=score,
            valuation_status="EVIDENCE_BACKED" if enough_market_data else "RESEARCH_REQUIRED",
            resale_value_low_minor=low,
            resale_value_high_minor=high,
            estimated_net_low_minor=net_low,
            estimated_net_high_minor=net_high,
            comparable_count=len(sales),
            currency=brief.currency.upper(),
            confidence=confidence,
            findings=list(findings),
            conflicts=conflicts,
            next_actions=actions,
            purchase_authorized=False,
        )
