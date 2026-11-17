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

@pytest.mark.asyncio
async def test_llm_specialist_uses_cloud_fallback_when_primary_fails():
    class FakeCompletions:
        def __init__(self, fail=False):
            self.fail = fail
            self.calls = []

        async def create(self, **kwargs):
            self.calls.append(kwargs)
            if self.fail:
                raise RuntimeError("primary unavailable")
            class Message:
                content = '{"summary":"fallback result","facts":[],"identified_model":null,"evidence_urls":[],"confidence":0.7,"uncertainties":[]}'
            class Choice:
                message = Message()
            class Response:
                choices = [Choice()]
            return Response()

    class FakeClient:
        def __init__(self, fail=False):
            self.chat = type("Chat", (), {"completions": FakeCompletions(fail)})()

    primary = FakeClient(fail=True)
    fallback = FakeClient()
    adapters = build_llm_specialists(
        primary, model="local-model",
        fallback_client=fallback, fallback_model="cloud-model",
    )
    result = await adapters[SpecialistRole.COLLECTOR](ProductBrief(
        candidate_id="fallback-test", title="Vintage camera", asking_price_minor=5000,
    ))

    assert result.status == "SUCCEEDED"
    assert primary.chat.completions.calls[0]["model"] == "local-model"
    assert fallback.chat.completions.calls[0]["model"] == "cloud-model"


@pytest.mark.asyncio
async def test_llm_specialist_does_not_call_cloud_without_configured_fallback():
    class FakeCompletions:
        async def create(self, **kwargs):
            raise RuntimeError("provider unavailable")

    class FakeClient:
        chat = type("Chat", (), {"completions": FakeCompletions()})()

    adapters = build_llm_specialists(FakeClient(), model="local-model")
    with pytest.raises(RuntimeError, match="provider unavailable"):
        await adapters[SpecialistRole.COLLECTOR](ProductBrief(
            candidate_id="no-fallback", title="Vintage camera", asking_price_minor=5000,
        ))

        await adapters[SpecialistRole.COLLECTOR](ProductBrief(
            candidate_id="no-fallback", title="Vintage camera", asking_price_minor=5000,
        ))
