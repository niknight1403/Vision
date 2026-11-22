# Sprint 33 — Egress-Pinning gegen DNS-Rebinding

**Nachweis:** `services/vision-worker/vision_worker/vision_identifier.py`, `services/vision-worker/tests/test_pinned_egress.py`, `services/vision-worker/tests/test_pinned_tls.py`, `docs/vision-and-purchase-workflow.md`, `README.md`.

## Vorher

Der Downloader prüfte die DNS-Antworten (`_reject_private_dns`) und übergab die URL anschließend an `httpx`. httpx löste den Hostnamen erneut auf. Zwischen Prüfung und Verbindung lag damit genau das Rebinding-Fenster, das die Prüfung verhindern sollte; Redirects waren nur durch `follow_redirects=False` ausgeschlossen.

## Jetzt

- **Einmalige Auflösung mit Pinning:** `_public_addresses()` liefert die geprüften Adressen, `_pinned_https_get()` verbindet ausschließlich auf die erste davon. Der Hostname wird nie erneut aufgelöst, weil der Socket gegen die IP aufgebaut wird.
- **TLS bleibt intakt:** `asyncio.open_connection(host=ip, ssl=context, server_hostname=host)` mit `check_hostname=True`, `CERT_REQUIRED`, TLS ≥ 1.2. Pinning schwächt die Zertifikatsprüfung nicht.
- **Eigener, begrenzter HTTP-Client statt Fremdclient:** feste Request-Zeile, `Host`, `Connection: close`, `Accept-Encoding: identity`, 16 KiB Header-Limit, explizites Content-Length- und Chunked-Parsing, 8 MiB Body-Limit, keine Redirect-Verfolgung (jede 3xx-Antwort ist ein Fehler).
- **Fehler ohne Leak:** Verbindungs- und TLS-Fehler werden zu generischen `InspectionError`-Meldungen, ohne IP, Host oder interne Details weiterzugeben.

## Tests

- `test_pinned_egress.py` (19 Tests): der Connector erhält die geprüfte Adresse statt des Hostnamens; `Host`-Header, Request-Zeile und Header-Härtung werden geprüft; 3xx wird nicht verfolgt (genau eine Anfrage); Chunked- und Close-Delimited-Bodies werden korrekt gelesen; deklarierte, gestreamte und chunked Übergrößen, ungültige Chunk-Rahmung, übergroße Header, kaputte Statuszeile, fremde Content-Types, Signatur-Mismatch, ungültiges WebP und leerer Body werden abgelehnt; private/loopback/link-local/unique-local/metadata-Adressen (IPv4 und IPv6) sowie gemischte Antworten blockieren **vor** jedem Verbindungsversuch; Verbindungsfehler leaken keine Details.
- `test_pinned_tls.py` (2 Tests, übersprungen ohne `openssl`): echter TLS-Server mit selbstsigniertem Zertifikat für `images.example.org`. Der Verbindungsaufbau geht auf `127.0.0.1`, das SNI enthält aber `images.example.org` und das Zertifikat wird verifiziert; ein nicht vertrauenswürdiges Zertifikat wird abgelehnt.
- Gesamtsuite: **53 passed** (vorher 42), keine Skips in der Sandbox (openssl vorhanden).

**Grenze:** Der Nachweis gilt für die Worker-Anwendung. Eine reale Egress-Firewall/NetworkPolicy im Deployment bleibt zusätzlich erforderlich und ist weiterhin nicht nachgewiesen.
