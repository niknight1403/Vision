# Sprint 35 — Rate-Limit-Härtung

**Nachweis:** `services/api/src/api-hardening.ts`, `services/api/src/app.ts`, `src/api-hardening.test.ts`, `src/rate-limit.integration.test.ts`, `src/app.integration.test.ts`, `README.md`, `docs/monitoring-alerting.md`.

## Befund

Der bestehende `InProcessRateLimiter` war nirgends verdrahtet und hatte zwei Konstruktionsfehler: die Map wuchs unbegrenzt (jeder neue Key blieb für immer), und `allow()` lieferte nur einen Boolean, was einen korrekten `Retry-After` unmöglich machte.

## Umgesetzt

- **`SlidingWindowRateLimiter`:** gibt `{ allowed, remaining, retryAfterMs }` zurück, verdrängt abgelaufene Treffer, hält die Key-Map hart auf `maxKeys` begrenzt und evakuiert dabei zuerst abgelaufene, dann die am längsten unbenutzten Keys (Map-Reinsertion als LRU-Ordnung).
- **Konfiguration fail-closed:** `rateLimitConfigFromEnv()` liest `AUTH_RATE_LIMIT_MAX`/`_WINDOW_MS`, `SCAN_RATE_LIMIT_MAX`/`_WINDOW_MS`, `ANALYSIS_RATE_LIMIT_MAX`/`_WINDOW_MS` und `RATE_LIMIT_MAX_KEYS` mit harten Grenzen (Fenster 1 s bis 24 h, max. 100 000 Treffer, max. 1 000 000 Keys). Ein ungültiger Wert wirft `RATE_LIMIT_CONFIG_INVALID` beim Start statt still auf einen unsicheren Default zurückzufallen.
- **Verdrahtung:** Login und Refresh sind pro Client-IP begrenzt (Default 10/60 s), Deal-Scan, Treasure-Analyse und Vision-Inspection pro authentifiziertem Nutzer (Default 30 bzw. 20/60 s). Eine Ablehnung antwortet `429 { error: "RATE_LIMIT_EXCEEDED", retryAfterSeconds }` mit `Retry-After` und `x-ratelimit-remaining`; die Header werden auf jeder Antwort gesetzt.
- **Testisolation:** die RBAC-Integrationssuite konfiguriert eigene, großzügige Limits, weil sie viele Logins von derselben Test-IP ausführt; die Limit-Semantik selbst deckt eine eigene Integrationsdatei ab.

## Checks

- `npm run typecheck` grün.
- `npm test` → **106 API-Unit-Tests** (vorher 99) und 43 Trading-Core-Tests grün; die neuen Limiter-Tests decken Burst, exaktes Fensterende, Unabhängigkeit der Principals, Eviktion, Ablauf-Verhalten und Konfigurationsvalidierung ab.
- `npm run test:db` gegen die lokale PostgreSQL-Instanz → **4 Integrationsdateien, 22 Integrationstests, 0 skipped**; darunter: zweiter Login-Versuch → 429 mit `Retry-After: 60`, und ein zweiter Scan desselben Nutzers → 429, während der erste durchgeht.

**Grenze:** Der Limiter lebt im Prozess. Bei mehreren API-Replicas multipliziert sich das effektive Limit; ein geteilter Limiter im Gateway bleibt offen. Lasttests mit echtem Traffic fehlen.
