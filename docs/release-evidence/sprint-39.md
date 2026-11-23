# Sprint 39 — Mobile-Client-Härtung ohne Gerät

**Nachweis:** `apps/mobile/src/api/` (Client-Schicht + 43 Unit-Tests),
`apps/mobile/AutopilotDashboard.tsx` (UI-Verdrahtung), `apps/mobile/vitest.config.ts`.

Alle Zahlen unten stammen aus den Läufen in dieser Sandbox. Es gab **kein** echtes Gerät,
**keinen** Emulator, **keine** iOS-Prüfung und **keinen** E2E-Lauf gegen eine laufende API.
Die Aussagen unten beziehen sich ausschließlich auf TypeScript-Typprüfung, Node-Unit-Tests und
einen Expo-JS-Bundle-Export — nicht auf Laufzeitverhalten auf einem Telefon.

## Ausgangslage

`apps/mobile` hatte vor diesem Sprint **keinen Test und kein Test-Skript** (nur `App.tsx` mit
5 Zeilen und `AutopilotDashboard.tsx` mit 338 Zeilen). Die Dashboard-Datei rief `fetch` direkt auf,
mit festem `setInterval(2000)`, ohne Timeout, ohne Retry, ohne Refresh und ohne explizite
Fehlerzustände. Vorher/Nachher im Gesamtgate:

| Gate | vorher | nachher |
| --- | --- | --- |
| `npm test` (Repo-Root) | 30 Dateien / 155 Tests | 32 Dateien / 198 Tests |
| davon mobile | 0 Dateien / 0 Tests | 2 Dateien / 43 Tests |
| `npm run typecheck` | 3 Workspaces grün | 3 Workspaces grün |

## Was gebaut wurde

Neue, geräteunabhängige Schicht unter `apps/mobile/src/api/` — **kein** Import von `react`,
`react-native` oder `expo`, nur `fetch`/`AbortController`/`setTimeout` als injizierbare Abhängigkeiten:

- **`client.ts`** — `ApiClient` mit injizierbarem `fetch` (`FetchLike`), injizierbarem `Scheduler`
  (Uhr, `sleep`, `setTimeout`), injizierbarer Zufallsquelle und injizierbarer
  Idempotency-Key-Factory. Methoden für die echten Routen aus `services/api/src/app.ts`:
  `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/deals`,
  `POST /v1/deals/:dealId/treasure-analysis`, `GET /v1/treasure-analyses/:taskId`,
  `POST /v1/deals/:dealId/vision-inspection`, `GET /v1/operations/overview`.
- **`errors.ts`** — typisierte Fehler: `NetworkError`, `TimeoutError`, `AbortedError`,
  `UnauthorizedError` (401), `SessionExpiredError`, `RateLimitedError` (429 inkl. `retryAfterMs`),
  `ServerError` (5xx), `ClientError` (sonstige 4xx), `InvalidJsonError`, `InvalidResponseError`,
  `TaskFailedError`. Jeder Fehler hat `kind`, `status?`, `code?`, `retryAfterMs?`, `retryable`.
- **`session.ts`** — `SessionStore` mit Single-Flight-Refresh: parallele 401er teilen sich ein
  Refresh-Promise, statt das Refresh-Token zweimal zu rotieren (die API widerruft rotierte Tokens).
- **`polling.ts`** — `pollTaskStatus()` für `/v1/treasure-analyses/:taskId`: exponentieller Backoff
  mit begrenztem Jitter, Deckel, `stop()`/`AbortSignal`, explizite Zustände.
- **`backoff.ts`** — `computeBackoffDelay`/`computeBackoffBase` (Basis × Faktor^(n−1), gedeckelt,
  Jitter ±`jitterRatio`, Ergebnis nie über dem Deckel).
- **`scheduler.ts`**, **`types.ts`** (Antwortformen der echten Routen), **`index.ts`** (Barrel).
- **`test-support.ts`** — deterministische Test-Doubles (Fake-Scheduler, Fake-Fetch, Response-Builder).

### Fehler- und Zustandsmodell

| Situation | Ergebnis |
| --- | --- |
| Transportfehler | `NetworkError`, `retryable: true` |
| Timeout (AbortController nach `timeoutMs`, Default 15 s) | `TimeoutError`, `retryable: true` |
| 401, Refresh gelingt | Request wird **einmal** mit neuem Token wiederholt |
| 401, Refresh scheitert (4xx) | Session gelöscht, `SessionExpiredError`, **kein** zweiter Refresh |
| 401, Refresh scheitert an Netz/Timeout | Session **bleibt** erhalten, der echte Transportfehler wird geworfen (offline ≠ abgelaufen) |
| 429 | `RateLimitedError` mit `retryAfterMs` (Sekunden oder HTTP-Datum, gedeckelt auf `maxRetryAfterMs`); die Request-Schicht schläft nicht selbst |
| 5xx | begrenzter Retry (Default 2) nur für GET/HEAD, danach `ServerError`; Writes werden nie automatisch wiederholt |
| 2xx mit kaputtem JSON | `InvalidJsonError` |
| 204 / leerer Body | Erfolg mit `undefined` |

Fehlermeldungen sind feste Tokens (`NETWORK_ERROR`, `SESSION_EXPIRED`, …) plus optional ein
serverseitiger Code, der gegen `^[A-Z][A-Z0-9_]{0,63}$` geprüft wird. URLs, Bearer-Token, Header
und Payloads landen nie in einer Meldung; ein Test prüft, dass ein beliebiger Serverstring nicht
durchgereicht wird.

### Polling-Verhalten

Zustände: `idle | loading | offline | error | expired | success` (plus `stopped: true` bei Abbruch).

- **Backoff** wächst nur bei **aufeinanderfolgenden Fehlern**; ein gesunder, aber noch laufender
  Task behält das Basisintervall (1 s). Ein Fehlversuch setzt den Zähler zurück.
- **Deckel:** `maxDelayMs` (Default 30 s); zusätzlich `maxAttempts` (Default 8) für aufeinanderfolgende
  Fehler. Ein dauerhaft laufender Task wird also weiter abgefragt, ein dauerhaft fehlschlagender
  nicht.
- **429** respektiert `Retry-After` und verbraucht **kein** Fehlerbudget; eigener Zähler
  `maxRateLimitWaits` (Default 5) verhindert eine Endlosschleife.
- **401** → nach dem einmaligen Refresh-Versuch der Client-Schicht `expired`; der Poller hört auf,
  es gibt keinen weiteren Request.
- **Stop/Abort** → Promise löst mit `state: 'idle'`, `stopped: true` auf, kein weiterer Request,
  kein Timer bleibt zurück (Sleep wird über das `AbortSignal` abgebrochen).
- Terminale Task-Zustände: `SUCCEEDED` → `success`; `FAILED`/`CANCELLED` → `error` mit
  `TaskFailedError` (`TASK_FAILED`/`TASK_CANCELLED`) und dem Task im Snapshot.

### UI-Verdrahtung

`AutopilotDashboard.tsx` nutzt jetzt die Schicht statt rohem `fetch`:

- `ApiClient` wird einmal pro App-Instanz erzeugt (`useMemo`, Basis-URL weiterhin
  `EXPO_PUBLIC_API_URL`); Login/Refresh/Logout laufen über `client.login/logout`.
- Pro Task läuft genau ein `pollTaskStatus`-Poller (Map `taskId → handle`), kein `setInterval`
  mehr; Poller werden bei Logout und Unmount gestoppt. „Status erneut prüfen" startet einen neuen
  Versuch für einen endgültig fehlgeschlagenen Poll.
- `pollStates` werden pro Deal gespeichert und angezeigt („OFFLINE …", „POLLING_FEHLER …");
  `session_expired` führt zu einem definierten Logout-Zustand mit Hinweis statt Endlos-Polling.
- Fehlertexte kommen aus `errorText(ApiError)` (kind-basiert), nicht mehr aus rohen
  Exception-Meldungen.
- Das Styling-Block ist **byte-identisch** zum vorherigen Stand (`diff` der `const styles`-Blöcke:
  keine Unterschiede), die UI sieht also unverändert aus.

Die Verdrahtung ist bewusst trotzdem als „nicht gerätegeprüft" markiert: Typecheck und
Bundle-Export beweisen, dass sie kompiliert und sich bündeln lässt, nicht dass sie auf einem
Telefon korrekt rendert.

## Tests (43, alle grün)

`apps/mobile/src/api/client.test.ts` — 27 Tests:

- Auth: Login-Payload und Token-Speicherung; Bearer-Header und `?limit` auf `GET /v1/deals`;
  `SessionExpiredError` ohne Token ohne Request; Logout widerruft und löscht lokal auch bei Fehler.
- Transport: Netzwerkfehler → `NetworkError` ohne URL/Token in der Meldung; hängender Request →
  `TimeoutError` nach `timeoutMs`; bereits abgebrochenes Signal → `AbortedError` ohne `fetch`;
  kaputtes JSON → `InvalidJsonError`; 204 → Erfolg.
- Fehler-Mapping: 404 → `ClientError` mit allow-listed Code; beliebiger Serverstring wird nicht
  gespiegelt; 429 → `RateLimitedError` mit 3000 ms; absurd großes `Retry-After` wird auf 60 s
  gedeckelt; `Retry-After` als Sekunden und als HTTP-Datum.
- 5xx: Retry mit wachsendem Backoff (1000, 2000 ms) und Abbruch am Deckel; Erholung nach einem
  Fehlversuch; Writes werden nicht wiederholt; Idempotency-Key-Header.
- Session: 401 + erfolgreicher Refresh + Replay; 401 + fehlgeschlagener Refresh → `expired`,
  genau 2 Requests, keine Schleife; erneut abgelehnter Refresh-Token → genau 1 Refresh, 3 Requests;
  Single-Flight bei zwei parallelen 401ern (1 Refresh); Transportfehler beim Refresh behält Session;
  Login-401 löst keinen Refresh aus.
- Backoff: Wachstum/Deckel, Jitter-Grenzen (0 → 0,8×, 0,5 → 1,0×, 1 → min(Deckel, 1,2×)),
  Determinismus.

`apps/mobile/src/api/polling.test.ts` — 16 Tests:

- Erfolgspfad bis `SUCCEEDED` inkl. Zwischenzuständen; `FAILED` → `error` + `TASK_FAILED`;
  `CANCELLED` → `TASK_CANCELLED`.
- Netzwerkfehler → `offline` und Erholung; Backoff-Wachstum 1000/2000/4000/8000/8000 mit Deckel
  und Abbruch nach `maxAttempts`; 5xx bis Deckel → `error`; 4xx wird nicht wiederholt;
  Jitter-Grenzen im Poller (800/1600 vs. 1200/2400 ms).
- 429: `Retry-After` 7000 ms wird exakt eingehalten, danach Erfolg, Fehlerbudget unberührt;
  Abbruch nach `maxRateLimitWaits`.
- Abbruch: `stop()` während des Wartens → `idle`/`stopped`, keine weiteren Requests; externes
  `AbortSignal` identisch; bereits abgebrochenes Signal → 0 Requests.
- Gegen den echten `ApiClient`: 401 + fehlgeschlagener Refresh → `expired` mit genau 2 Requests;
  401 + erfolgreicher Refresh → `SUCCEEDED`; Timeout → `offline` und Erholung.

Es wurden **keine Tests gelöscht, übersprungen oder abgeschwächt**; der Mobile-Workspace hatte
vorher keine.

## Kommandoausgaben (Kurzform)

```text
$ npm run typecheck
> @autonomagent/mobile@0.3.0 typecheck   > tsc --noEmit        (keine Ausgabe, Exit 0)
> @autonomagent/api@0.3.0 typecheck      > tsc --noEmit        (keine Ausgabe, Exit 0)
> @autonomagent/trading-core@0.3.0 typecheck > tsc --noEmit    (keine Ausgabe, Exit 0)

$ npm test
apps/mobile        Test Files  2 passed (2)    Tests  43 passed (43)
services/api       Test Files 23 passed (23)   Tests 112 passed (112)
packages/trading-core Test Files 7 passed (7)  Tests  43 passed (43)
→ 32 Dateien / 198 Tests, 0 failed, 0 skipped

$ npm test --workspace @autonomagent/mobile
 ✓ src/api/polling.test.ts (16 tests)
 ✓ src/api/client.test.ts (27 tests)
 Test Files  2 passed (2)   Tests  43 passed (43)

$ npx expo export --platform android --output-dir /tmp/sprint39-export
Android Bundled 6967ms apps/mobile/index.js (603 modules)
› android bundles (1): _expo/static/js/android/index-9f75b0fd78bf009f005000f1ca7150bf.hbc (1.6MB)
Exported: /tmp/sprint39-export

$ DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public \
    npm run test:db --workspace @autonomagent/api
 ✓ 7 Integrationsdateien, 37 Tests, 0 skipped
PostgreSQL integration gate passed: 6 integration files, 33 integration test(s) executed,
37 test(s) total with 0 skipped.
```

Der Bundle-Export belegt, dass die neue Schicht im React-Native-Bundle auflösbar ist (603 Module,
1,6 MB Hermes-Bytecode) — er ersetzt **keinen** Gerätetest.

## Neue Abhängigkeiten

Keine neuen Pakete installiert. `vitest@4.1.12` war bereits im Workspace (API und trading-core)
vorhanden; es wurde nur als `devDependency` von `@autonomagent/mobile` deklariert und der
Lockfile-Eintrag offline erzeugt (`npm install --package-lock-only --offline`, Diff: 1 Zeile).
`npm ls vitest --workspace @autonomagent/mobile` bestätigt `vitest@4.1.12` (dedupliziert).

## Verbleibende Blocker (ausdrücklich)

- **Keine Gerätetests:** kein Emulator, kein echtes Android-Gerät, kein Simulator.
- **Keine echte Expo-Laufzeitprüfung:** die App wurde nicht gestartet (`expo start`/`run:android`),
  nur der JS-Bundle-Export lief.
- **Keine iOS-Prüfung:** weder Build noch Laufzeit.
- **Kein E2E gegen die echte API:** alle Tests laufen gegen injizierte Fakes; Login, Refresh,
  Idempotency und Polling wurden nicht gegen eine laufende `services/api`-Instanz geprüft.
- **Keine Prüfung von Netzwerkwechseln/Hintergrundzuständen** (App in den Hintergrund, Funkloch,
  Reconnect), keine Akku-/Datenverbrauchsmessung.
- **Kein Persistieren der Session** (Token werden nur im Speicher gehalten; ein Neustart der App
  verlangt erneuten Login) — bewusst, um keine neue Abhängigkeit (`expo-secure-store`) einzuführen.
- **Keine Produktionsreife-Aussage:** die Schicht ist typgeprüft und unit-getestet, mehr nicht.
