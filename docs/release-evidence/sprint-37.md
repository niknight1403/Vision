# Sprint 37 — Observability

**Nachweis:** `services/api/src/observability.ts`, `src/app.ts`, `src/observability.test.ts`, `src/observability.integration.test.ts`, `docs/monitoring-alerting.md`, `README.md`.

## Umgesetzt

- **Metrik-Registry ohne Fremdabhängigkeit:** `MetricsRegistry` führt Counter und Gauges, prüft Metriknamen (`[a-z_][a-z0-9_]*`), escapet Label-Werte (`"`, `\`, Zeilenumbruch), sortiert Familien und Serien für stabile Ausgaben und begrenzt sich auf 5 000 Serien (`METRIC_SERIES_LIMIT_REACHED`), damit kein Angreifer den Prozessspeicher über Labels flutet.
- **`GET /metrics` im Prometheus-Textformat** (0.0.4), standardmäßig geschlossen: ohne `METRICS_TOKEN` (≥ 16 Zeichen) `503 METRICS_NOT_CONFIGURED`, ohne gültigen Bearer `401 METRICS_AUTH_REQUIRED`, Vergleich zeitkonstant über `timingSafeEqual`.
- **Kardinalität begrenzt:** das `route`-Label ist das Routen-Template (`request.routeOptions.url`), nie die rohe URL mit IDs oder Query.
- **Familien:** `http_requests_total{route,method,status}`, `http_request_duration_ms_total{route}`, `http_requests_in_flight`, `outbox_events{status}` und `agent_tasks{status}`. Die DB-Gauges werden beim Scrape gesammelt; ein DB-Fehler wird geloggt, blockiert aber nicht die Prozessmetriken.
- **Korrelation:** `onRequest`/`onResponse`-Hooks messen Laufzeit und In-Flight, `onSend` spiegelt `x-request-id` in jede Antwort, dieselbe ID steht in den Fastify-JSON-Logs.
- **Alert-Regeln dokumentiert** (Fehlerrate, mittlere Latenz, `DEAD_LETTER > 0`, wachsender `PENDING`-Rückstand, viele `RUNNING`-Tasks).

## Checks

- `npm run typecheck` grün.
- `npm test` → **112 API-Unit-Tests** (vorher 106) und 43 Core-Tests grün; sechs neue Registry-Tests (Format, Escaping, stabile Reihenfolge, Gauge-Ersetzung, Namens-/Wert-Validierung, Serienlimit).
- `npm run test:db` gegen die lokale PostgreSQL-Instanz → **6 Integrationsdateien, 33 Integrationstests, 0 skipped**. Die vier neuen Tests belegen: geschlossene Route ohne Token, 401 bei falschem Token, Zählung pro Routen-Template inklusive Fehlerstatus, Outbox-/Task-Gauges im Text, kein Leak von Header-Werten, `x-request-id` gespiegelt.

**Grenze:** Es gibt keinen echten Prometheus-Scrape, keine Histogramme (nur Summe und Zähler) und kein Dashboard; die Registry ist pro Prozess, nicht aggregiert.
