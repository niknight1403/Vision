"""Sprint 34: request limits, deadlines, correlation ids, readiness, redaction."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-worker-token-with-at-least-32-characters"
BODY = {"image_url": "https://images.invalid/item.jpg", "hint_title": "Unverifizierter Titel"}
AUTH = {"authorization": "Bearer " + TOKEN}


class _SlowInspector:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.allowed_hosts = {"images.invalid"}

    async def inspect_item_visuals(self, image_url: str, hint_title: str) -> dict[str, object]:
        await asyncio.sleep(self.delay)
        return {"identified": False, "details": "Zeitüberschreitung im Test"}


class _ExplodingInspector:
    allowed_hosts = {"images.invalid"}

    async def inspect_item_visuals(self, image_url: str, hint_title: str) -> dict[str, object]:
        raise RuntimeError(f"upstream rejected https://images.invalid/item.jpg?token=supersecret")


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("VISION_WORKER_TOKEN", TOKEN)
    monkeypatch.setenv("VISION_ALLOWED_IMAGE_HOSTS", "images.invalid")
    from vision_worker import service

    with TestClient(service.app) as test_client:
        yield test_client


def test_oversized_declared_body_is_rejected_before_parsing(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection",
        content=b"{" + b" " * (70 * 1024) + b"}",
        headers={**AUTH, "content-type": "application/json", "content-length": str(70 * 1024)},
    )
    assert response.status_code == 413
    assert response.json()["error"] == "REQUEST_TOO_LARGE"
    assert response.json()["requestId"]


def test_oversized_streamed_body_is_rejected(client: TestClient) -> None:
    def chunks():
        for _ in range(8):
            yield b"{" + b" " * (10 * 1024)

    response = client.post(
        "/v1/visual-inspection",
        content=chunks(),
        headers={**AUTH, "content-type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["error"] == "REQUEST_TOO_LARGE"


def test_valid_request_id_is_echoed(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection", json=BODY, headers={**AUTH, "x-request-id": "corr-12345678"}
    )
    assert response.headers["x-request-id"] == "corr-12345678"


@pytest.mark.parametrize("supplied", ["short", "has space in it", "semi;colon", "x" * 80])
def test_malformed_request_id_is_replaced(client: TestClient, supplied: str) -> None:
    response = client.post(
        "/v1/visual-inspection", json=BODY, headers={**AUTH, "x-request-id": supplied}
    )
    assert response.headers["x-request-id"] != supplied
    assert len(response.headers["x-request-id"]) == 32


def test_request_id_is_generated_when_absent(client: TestClient) -> None:
    response = client.post("/v1/visual-inspection", json=BODY, headers=AUTH)
    assert len(response.headers["x-request-id"]) == 32


def test_error_body_carries_the_request_id(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection", json=BODY, headers={"x-request-id": "corr-87654321"}
    )
    assert response.status_code == 401
    assert response.json()["requestId"] == "corr-87654321"
    assert response.headers["x-request-id"] == "corr-87654321"


def test_analysis_deadline_returns_504(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from vision_worker import service

    service.app.state.inspector = _SlowInspector(delay=0.3)
    service.app.state.analysis_timeout = 0.05
    response = client.post("/v1/visual-inspection", json=BODY, headers=AUTH)
    assert response.status_code == 504
    assert response.json()["error"] == "WORKER_TIMEOUT"


def test_capacity_limit_returns_503(client: TestClient) -> None:
    from vision_worker import service

    service.app.state.max_concurrent = 1
    service.app.state.in_flight = 1
    try:
        response = client.post("/v1/visual-inspection", json=BODY, headers=AUTH)
        assert response.status_code == 503
        assert response.json()["error"] == "WORKER_BUSY"
    finally:
        # Leave no fake in-flight work behind, otherwise the shutdown drain waits.
        service.app.state.in_flight = 0
        service.app.state.max_concurrent = 4


def test_unexpected_failure_is_redacted(client: TestClient) -> None:
    from vision_worker import service

    # A production server answers 500; the test client re-raises unless told not to.
    with TestClient(service.app, raise_server_exceptions=False) as raw_client:
        # Set after startup: entering the context rebuilds the real inspector.
        service.app.state.inspector = _ExplodingInspector()
        response = raw_client.post("/v1/visual-inspection", json=BODY, headers=AUTH)
    assert response.status_code == 500
    payload = response.json()
    assert payload["error"] == "WORKER_INTERNAL_ERROR"
    assert payload["requestId"]
    serialized = response.text
    assert "supersecret" not in serialized
    assert "images.invalid" not in serialized
    assert "RuntimeError" not in serialized


def test_health_and_ready_are_separate_probes(client: TestClient) -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    ready = client.get("/ready")
    assert ready.status_code == 200
    body = ready.json()
    assert body["status"] == "ready"
    assert body["checks"]["tokenConfigured"] is True
    assert body["checks"]["imageHostsConfigured"] is True
    assert body["checks"]["shuttingDown"] is False


def test_ready_reports_shutdown_while_health_stays_green(client: TestClient) -> None:
    from vision_worker import service

    service.app.state.shutting_down = True
    try:
        assert client.get("/health").status_code == 200
        ready = client.get("/ready")
        assert ready.status_code == 503
        assert ready.json()["checks"]["shuttingDown"] is True
        refused = client.post("/v1/visual-inspection", json=BODY, headers=AUTH)
        assert refused.status_code == 503
        assert refused.json()["error"] == "WORKER_SHUTTING_DOWN"
    finally:
        service.app.state.shutting_down = False


def test_unknown_fields_are_still_rejected(client: TestClient) -> None:
    response = client.post(
        "/v1/visual-inspection", json={**BODY, "extra": 1}, headers=AUTH
    )
    assert response.status_code == 422
