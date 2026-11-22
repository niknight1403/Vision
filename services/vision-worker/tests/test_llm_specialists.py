import pytest
from types import SimpleNamespace

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


@pytest.mark.asyncio
async def test_model_cannot_promote_invented_links_or_sales_to_evidence():
    class FakeCompletions:
        async def create(self, **_kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='''{
                "summary": "Possible collectible", "facts": [], "confidence": 0.5,
                "uncertainties": [], "evidence_urls": ["https://made-up.example/item"],
                "comparable_sales": [{"amount_minor": 9000, "currency": "EUR", "sold_at": "2026-11-20T00:00:00Z", "source_url": "https://made-up.example/sale", "item_title": "Fake sale"}]
            }'''))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))
    specialist = build_llm_specialists(client, model="test-model")[SpecialistRole.VISUAL]
    result = await specialist(ProductBrief(candidate_id="a", title="Unknown object", asking_price_minor=1000))
    assert result.status == "SUCCEEDED"
    assert result.evidence_urls == []
    assert result.comparable_sales == []
    assert "discarded" in result.uncertainties[0]
