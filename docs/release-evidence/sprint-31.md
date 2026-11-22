# Sprint 31 — Python-Testnachweis

**Nachweis:** `services/vision-worker/tests/`, `package.json` (`test:python`).

Die Python-Testabhängigkeiten (`pytest`, `pytest-asyncio`) werden über das Extra `test` installiert und die Suite läuft lokal reproduzierbar aus dem Repo-Wurzelverzeichnis über `npm run test:python` (setzt `PYTHONPATH=services/vision-worker`, keine vorherige Editable-Installation nötig).

Neu abgedeckt wurden bisher ungetestete Sicherheitspfade des Bilddownloads und der Analyse-Route:

- `tests/test_download_guards.py`: öffentliche DNS-Antwort plus gültiges PNG wird akzeptiert; private, Loopback-, Link-Local- und Metadata-Adressen (IPv4 und IPv6) sowie gemischte Antworten blockieren den Download vor jedem HTTP-Aufruf; unauflösbare Hosts, Nicht-200-Status, fremde Content-Types, deklarierte und gestreamte Übergrößen, Signatur-Mismatch und ungültige WebP-Container werden abgelehnt.
- `tests/test_service.py`: `/v1/analyze` verlangt exakt den Bearer-Token (fehlend, falsch, ohne `Bearer`-Präfix → 401), weist unbekannte Felder und negative Preise ab (422), und eine Nicht-HTTPS-Bildquelle wird als unverifizierte Beobachtung mit `purchase_authorized=false` und `authenticity_verified=false` gemeldet.

**Checks:** `python -m pytest -q` → **42 passed** (vorher 19), keine Skips, keine gelöschten Tests. `npm run test:python` aus dem Repo-Wurzelverzeichnis → **42 passed**. `npm run typecheck` und `npm test` bleiben unverändert grün.

**Grenze:** Die Tests belegen das Verhalten der Guards gegen injizierte DNS-/HTTP-Antworten. Eine echte Deployment-Netzwerkpolicy (Egress-Firewall) ist weiterhin nicht nachgewiesen und bleibt ein Live-Blocker; Sprint 33 adressiert zusätzlich das Rebinding-Fenster zwischen Prüfung und Verbindung.
