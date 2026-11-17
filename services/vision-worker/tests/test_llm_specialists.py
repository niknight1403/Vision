import pytest

from vision_worker.hidden_treasure_swarm import ProductBrief, SpecialistRole
from vision_worker.llm_specialists import build_llm_specialists


@pytest.mark.asyncio
async def test_market_specialist_is_skipped_without_real_sold_listing_provider():
    adapters = build_llm_specialists(object(), model="test-model")
    result = await adapters[SpecialistRole.MARKET](ProductBrief(
        candidate_id="market-gap",
        title="Unmarked collectible",
        asking_price_minor=2500,
    ))

    assert result.status == "SKIPPED"
    assert result.comparable_sales == []
    assert "not verified sold comparables" in result.uncertainties[0]
