import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from vision_worker.hidden_treasure_swarm import (
    HiddenTreasureSwarm,
    ProductBrief,
    SpecialistFinding,
    SpecialistRole,
)


def finding(role, **kwargs):
    return SpecialistFinding(
        role=role, status="SUCCEEDED", summary="Evidence checked",
        confidence=0.9, **kwargs,
    )


@pytest.mark.asyncio
async def test_specialists_run_concurrently_and_report_missing_market_evidence():
    active = 0
    peak = 0

    async def adapter(role):
        async def run(_brief):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return finding(role)
        return run

    adapters = {role: await adapter(role) for role in SpecialistRole}
    swarm = HiddenTreasureSwarm(adapters, concurrency=6)
    result = await swarm.analyze(ProductBrief(
        candidate_id="candidate-1", title="Unmarked vintage device",
        asking_price_minor=1500,
    ))

    assert peak > 1
    assert len(result.findings) == 6
    assert result.valuation_status == "RESEARCH_REQUIRED"
    assert result.resale_value_low_minor is None
    assert result.purchase_authorized is False


@pytest.mark.asyncio
async def test_only_recent_https_comparables_in_matching_currency_are_used():
    async def adapter(role):
        async def run(_brief):
            if role == SpecialistRole.MARKET:
                now = datetime.now(timezone.utc)
                return finding(role, comparable_sales=[
                    {
                        "amount_minor": 9000, "currency": "EUR",
                        "sold_at": now - timedelta(days=10),
                        "source_url": "https://market.example/sold/1",
                        "item_title": "Same model, used",
                    },
                    {
                        "amount_minor": 11000, "currency": "EUR",
                        "sold_at": now - timedelta(days=20),
                        "source_url": "https://market.example/sold/2",
                        "item_title": "Same model, used",
                    },
                    {
                        "amount_minor": 999999, "currency": "EUR",
                        "sold_at": now - timedelta(days=500),
                        "source_url": "https://market.example/sold/old",
                        "item_title": "Old listing",
                    },
                    {
                        "amount_minor": 999999, "currency": "USD",
                        "sold_at": now - timedelta(days=2),
                        "source_url": "https://market.example/sold/us",
                        "item_title": "Different currency",
                    },
                ])
            return finding(role)
        return run

    swarm = HiddenTreasureSwarm(
        {role: await adapter(role) for role in SpecialistRole}
    )
    result = await swarm.analyze(ProductBrief(
        candidate_id="candidate-2", title="Marked camera",
        asking_price_minor=3000, known_costs_minor=500,
    ))

    assert result.valuation_status == "EVIDENCE_BACKED"
    assert result.comparable_count == 2
    assert result.resale_value_low_minor == 9000
    assert result.resale_value_high_minor == 11000
    assert result.estimated_net_low_minor == 5500
    assert result.purchase_authorized is False


@pytest.mark.asyncio
async def test_failed_specialist_is_visible_and_never_claims_ready():
    async def broken(_brief):
        raise RuntimeError("secret provider token must not leak")

    async def ok(role):
        async def run(_brief):
            return finding(role)
        return run

    adapters = {role: await ok(role) for role in SpecialistRole}
    adapters[SpecialistRole.RISK] = broken
    swarm = HiddenTreasureSwarm(adapters)
    result = await swarm.analyze(ProductBrief(
        candidate_id="candidate-3", title="Unknown collectible",
        asking_price_minor=1000,
    ))

    failed = next(item for item in result.findings if item.role == SpecialistRole.RISK)
    assert failed.status == "FAILED"
    assert "secret provider token" not in failed.model_dump_json()
    assert result.status == "RESEARCH_REQUIRED"
