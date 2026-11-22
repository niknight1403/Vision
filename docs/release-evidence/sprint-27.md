# Sprint 27 — Vision-Worker-Egress

**Nachweis:** `services/vision-worker/vision_worker/vision_identifier.py`, `services/vision-worker/tests/test_vision_identifier.py`, `services/vision-worker/pyproject.toml`.

Konfigurierte externe LLM-Endpunkte erfordern HTTPS, erlaubte Hostnamen sowie URL ohne Credentials, Query oder Fragment. Bildquellen werden über Allowlist geprüft. DNS-Rebinding/private-Netz-Sperren bleiben ausdrücklich Deployment-Netzwerk-Gate und werden nicht fälschlich als Python-Garantie behauptet.

**Checks:** Python-Syntax/statischer Quellcheck; `git diff --check`. **Skip:** pytest, da in der Umgebung nicht installiert.
