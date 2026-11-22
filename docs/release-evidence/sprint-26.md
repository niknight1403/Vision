# Sprint 26 — Mobile API-Origin und Polling

**Nachweis:** `apps/mobile`, `docs/mobile-session-security.md`, `services/api/src/vision-inspector.ts`.

Der Mobile-Teil bleibt bei sicherem, taskbezogenem Polling und behauptet keine Orderaktion. Ohne SecureStore-Abhängigkeit wird keine unsichere Session-Recovery aktiviert; Android-Ausführung ist ein offener Nachweis.

**Checks:** Mobile-Typecheck bestanden; `git diff --check` bestanden. **Offen:** kein Android-SDK/echtes Gerät und kein End-to-End-Sessiontest.
