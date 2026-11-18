import json
from types import SimpleNamespace

import pytest

from vision_worker.hidden_treasure_swarm import ProductBrief, TreasureAssessment
from vision_worker.network_coordinator import review_agent_network


class FakeCompletions:
    def __init__(self, payload=None, error=None):
        self.payload = payload
        self.error = error
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        message = SimpleNamespace(content=json.dumps(self.payload))
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class FakeClient:
    def __init__(self, completions):
        self.chat = SimpleNamespace(completions=completions)


def make_assessment(**overrides):
    values = {
        "candidate_id": "candidate-network-1",
        "status": "RESEARCH_REQUIRED",
        "score": 0,
        "valuation_status": "RESEARCH_REQUIRED",
        "currency": "EUR",
        "confidence": 0.0,
        "findings": [],
        "conflicts": ["Market comparables are missing."],
        "next_actions": ["Retrieve verified sold listings."],
        "purchase_authorized": False,
    }
    values.update(overrides)
    return TreasureAssessment(**values)


@pytest.mark.asyncio
async def test_coordinator_caps_consensus_when_evidence_is_incomplete():
    completions = FakeCompletions({
        "consensus": "HIGH",
        "summary": "Specialists agree that more evidence is needed.",
        "unresolved_conflicts": [],
        "evidence_gaps": [],
        "recommended_next_steps": ["Collect sold comparables."],
        "confidence": 0.95,
    })
    client = FakeClient(completions)
    assessment = make_assessment()

    review = await review_agent_network(
        client,
        model="test-model",
        brief=ProductBrief(
            candidate_id="candidate-network-1",
            title="Vintage camera",
            asking_price_minor=2500,
        ),
        assessment=assessment,
    )

    assert review.status == "REVIEWED"
    assert review.consensus == "LOW"
    assert "Market comparables are missing." in review.unresolved_conflicts
    assert "Retrieve verified sold listings." in review.evidence_gaps
    assert review.confidence == 0
    assert completions.calls[0]["temperature"] == 0
    assert completions.calls[0]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_coordinator_uses_fallback_model_when_primary_fails():
    primary = FakeClient(FakeCompletions(error=RuntimeError("provider unavailable")))
    fallback = FakeClient(FakeCompletions({
        "consensus": "MEDIUM",
        "summary": "The evidence is partial and requires review.",
        "unresolved_conflicts": [],
        "evidence_gaps": ["Market evidence is incomplete."],
        "recommended_next_steps": ["Request manual verification."],
        "confidence": 0.5,
    }))
    assessment = make_assessment(conflicts=[], next_actions=["Verify the item manually"])

    review = await review_agent_network(
        primary,
        model="primary-model",
        fallback_client=fallback,
        fallback_model="fallback-model",
        brief=ProductBrief(
            candidate_id="candidate-network-1",
            title="Vintage camera",
            asking_price_minor=2500,
        ),
        assessment=assessment,
    )

    assert review.status == "REVIEWED"
    assert review.consensus == "MEDIUM"
    assert len(primary.chat.completions.calls) == 1
    assert len(fallback.chat.completions.calls) == 1


@pytest.mark.asyncio
async def test_unavailable_coordinator_fails_closed_without_claiming_consensus():
    client = FakeClient(FakeCompletions(error=RuntimeError("provider unavailable")))
    assessment = make_assessment()

    review = await review_agent_network(
        client,
        model="test-model",
        brief=ProductBrief(
            candidate_id="candidate-network-1",
            title="Vintage camera",
            asking_price_minor=2500,
        ),
        assessment=assessment,
    )

    assert review.status == "COORDINATOR_UNAVAILABLE"
    assert review.consensus == "LOW"
    assert review.confidence == 0
    assert review.unresolved_conflicts == assessment.conflicts
