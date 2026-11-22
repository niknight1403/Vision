# Sprint 34 — Vision-Worker-HTTP-Härtung

**Nachweis:** `services/vision-worker/vision_worker/service.py`, `tests/test_service_hardening.py`, `tests/test_service.py`, `.github/workflows/ci.yml`, `README.md`.

## Umgesetzt

- **Payload-Limit (64 KiB):** `PayloadLimitMiddleware` weist ein zu großes `Content-Length` sofort mit `413 REQUEST_TOO_LARGE` ab und puffert sonst den Body bis zum Limit, um ihn danach an die Anwendung zu übergeben. Ein gestreamter Body ohne Längenangabe kann damit nicht mehr an der Grenze vorbeilaufen; ein Test mit 80 KiB in acht Chunks belegt das.
- **Harte Deadline:** jede Analyse läuft unter `asyncio.wait_for` mit `VISION_ANALYSIS_TIMEOUT_SECONDS` (Default 90) und antwortet bei Überschreitung mit `504 WORKER_TIMEOUT` statt zu hängen.
- **Begrenzte Parallelität:** `VISION_MAX_CONCURRENT_ANALYSES` (Default 4). Der Zähler wird vor dem ersten `await` erhöht, damit Prüfung und Reservierung im Event-Loop nicht verschränken; bei Auslastung antwortet der Worker sofort mit `503 WORKER_BUSY` statt zu queuen. (Der erste Entwurf nutzte `asyncio.wait_for(semaphore.acquire(), timeout=0)`, was durch das sofortige Cancel jede Anfrage abwies; die Tests haben das aufgedeckt.)
- **Korrelation:** `x-request-id` wird übernommen, wenn es dem Muster `[A-Za-z0-9._:-]{8,64}` entspricht, sonst durch eine frische UUID ersetzt; der Wert steht in jeder Antwort im Header und in jedem Fehlerkörper.
- **Redaktion:** unbehandelte Ausnahmen werden zu `500 WORKER_INTERNAL_ERROR` mit Request-ID. Der Test provoziert eine Ausnahme mit Bild-URL und `token=supersecret` im Text und prüft, dass weder URL, Host, Token noch Exception-Klasse im Körper auftauchen.
- **Proben getrennt:** `/health` bleibt als Liveness grün, auch während des Draining; `/ready` meldet Token-, Host- und Shutdown-Zustand und antwortet bei fehlender Bereitschaft mit 503. Neue Anfragen während des Shutdowns werden mit `503 WORKER_SHUTTING_DOWN` abgewiesen, laufende Analysen laufen bis `VISION_SHUTDOWN_GRACE_SECONDS` (Default 20) aus.
- **Einheitlicher Fehlerkörper:** `{ "error": CODE, "requestId": ... }` statt `{ "detail": ... }`. Der API-Adapter (`services/api/src/vision-inspector.ts`) wertet nur den HTTP-Status aus, ist also nicht betroffen; die bestehenden Auth-Tests wurden auf den neuen Körper umgestellt.
- **CI-Erweiterung nicht möglich:** der geplante zusätzliche `/ready`-Check im `worker-auth`-Job ließ sich nicht pushen, weil der verbundene GitHub-Token keinen `workflow`-Scope besitzt (`refusing to allow an OAuth App to create or update workflow`). Die Änderung wurde zurückgenommen; `/ready` ist lokal getestet, der CI-Job prüft weiterhin nur `/health`.

## Checks

`python -m pytest -q` → **68 passed** (vorher 53), keine Skips. Der Lauf dauert 2,2 s.

**Grenze:** Last-, Soak- und Proxy-Tests (echter Uvicorn-Prozess, mehrere Clients) sind nicht Teil dieses Nachweises; gemessen wurde über den ASGI-Testclient.
