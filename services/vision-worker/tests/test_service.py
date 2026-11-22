"""The private HTTP service: bearer auth on every route and the visual-only route."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-worker-token-with-at-least-32-characters"
BODY = {"image_url": "https://images.invalid/item.jpg", "hint_title": "Unverifizierter Titel"}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("VISION_WORKER_TOKEN", TOKEN)
    monkeypatch.setenv("VISION_ALLOWED_IMAGE_HOSTS", "images.invalid")
    from vision_worker import service

    with TestClient(service.app) as test_client:
        yield test_client


def test_health_is_open(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.parametrize("header", [None, "Bearer wrong-token-wrong-token-wrong-token", TOKEN])
def test_visual_inspection_requires_the_exact_bearer_token(client: TestClient, header: str | None) -> None:
    headers = {} if header is None else {"authorization": header}
    response = client.post("/v1/visual-inspection", json=BODY, headers=headers)
    assert response.status_code == 401
    assert response.json()["detail"] == "WORKER_AUTH_REQUIRED"


def test_visual_inspection_returns_evidence_without_authorizing_anything(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection", json=BODY, headers={"authorization": "Bearer " + TOKEN}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["purchase_authorized"] is False
    assert payload["authenticity_verified"] is False
    # The host is allowlisted but unresolvable, so the inspection reports uncertainty.
    assert payload["visual_inspection"]["identified"] is False
    assert isinstance(payload["visual_inspection"]["details"], str)


def test_visual_inspection_rejects_unknown_fields(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection",
        json={**BODY, "asking_price_minor": 1000},
        headers={"authorization": "Bearer " + TOKEN},
    )
    assert response.status_code == 422


ANALYZE_BODY = {
    "candidate_id": "candidate-1",
    "title": "Unverifizierter Titel",
    "image_url": "https://images.invalid/item.jpg",
    "asking_price_minor": 1000,
}


@pytest.mark.parametrize("header", [None, "Bearer wrong-token-wrong-token-wrong-token", TOKEN])
def test_analyze_requires_the_exact_bearer_token(client: TestClient, header: str | None) -> None:
    headers = {} if header is None else {"authorization": header}
    response = client.post("/v1/analyze", json=ANALYZE_BODY, headers=headers)
    assert response.status_code == 401
    assert response.json()["detail"] == "WORKER_AUTH_REQUIRED"


def test_analyze_rejects_unknown_fields(client: TestClient) -> None:
    response = client.post(
        "/v1/analyze",
        json={**ANALYZE_BODY, "purchase_authorized": True},
        headers={"authorization": "Bearer " + TOKEN},
    )
    assert response.status_code == 422


def test_analyze_rejects_negative_asking_price(client: TestClient) -> None:
    response = client.post(
        "/v1/analyze",
        json={**ANALYZE_BODY, "asking_price_minor": -1},
        headers={"authorization": "Bearer " + TOKEN},
    )
    assert response.status_code == 422


def test_visual_inspection_reports_non_https_sources_as_unverified(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection",
        json={"image_url": "http://images.invalid/item.jpg", "hint_title": "Titel"},
        headers={"authorization": "Bearer " + TOKEN},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["purchase_authorized"] is False
    assert payload["authenticity_verified"] is False
    assert payload["visual_inspection"]["identified"] is False
    assert "HTTPS" in payload["visual_inspection"]["details"]
