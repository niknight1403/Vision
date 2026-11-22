# Sprint 25 — Mobile SecureStore-Session

**Nachweis:** `docs/mobile-session-security.md`, `apps/mobile/package.json`.

Expo 58 ist vorhanden, aber `expo-secure-store` ist nicht als sichere Abhängigkeit installiert. Daher wurde korrekt kein AsyncStorage-/Plaintext-Fallback eingeführt; Refresh-Token-Persistenz bleibt fail-closed und der Blocker ist dokumentiert.

**Checks:** Mobile-Typecheck bestanden; `git diff --check` bestanden. **Skip:** SecureStore-/Android-Gerätetest wegen fehlender sicherer Abhängigkeit und SDK.
