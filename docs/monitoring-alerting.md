# Monitoring und Alerting für v0.3.0

Sprint 51 ergänzt eine lokale, deterministische Monitoring- und Alerting-Schicht. Sie bewertet einen serverseitig erzeugten Sicherheits-Snapshot und meldet Kill-Switch-Zustände, unbekannte Orders, veraltete oder fehlgeschlagene Reconciliation, Provider-Ausfälle und überschrittene Drawdown-Limits.

## Betriebsmodell

`evaluateMonitoringSnapshot` ist rein und führt keinen Netzwerkaufruf aus. Die resultierenden Alerts besitzen einen stabilen Code und Fingerprint. `AlertDeduper` unterdrückt wiederholte Meldungen innerhalb eines konfigurierten Cooldowns. `dispatchMonitoringAlerts` liefert ausschließlich Zähler für gesendet, unterdrückt und fehlgeschlagen zurück; Transportfehler werden nicht als erfolgreicher Versand behandelt.

Alerting ist standardmäßig deaktiviert. Für die Aktivierung müssen `ALERTING_ENABLED=true` und mindestens ein vollständig konfigurierter Kanal vorhanden sein. Telegram benötigt `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID`. Discord benötigt eine HTTPS-Webhook-URL unter `discord.com` oder `discordapp.com` mit dem Pfad `/api/webhooks/`. Query-Parameter, Fragmente, Credentials, fremde Hosts und partielle Konfigurationen werden abgelehnt.

Telegram- und Discord-Transporte verwenden nur strukturierte POST-Anfragen. Die Tests injizieren einen lokalen Fetch-Fake; es werden keine echten Nachrichten versendet und keine Credentials benötigt. Discord-Mentions werden mit `allowed_mentions: { parse: [] }` deaktiviert. Alerttexte enthalten keine Tokens oder Webhook-URLs.

## Sicherheitsgrenzen

Die Monitoring-Schicht aktiviert weder Testnet noch LIVE-Trading und startet keinen Hintergrundprozess selbständig. Ein späterer Worker muss Snapshot-Erzeugung, Frequenz, Authentifizierung, Secret-Manager-Injektion, Retry-/Backoff-Limits und Incident-Eskalation separat festlegen. Kritische Alerts bleiben insbesondere bei Kill-Switch, UNKNOWN-Orders, Providerstatus `UNKNOWN`/`UNAVAILABLE`, fehlgeschlagener Reconciliation und Drawdown-Limit aktiv.


## Rate limiting (Sprint 35)

Sensitive routes are limited in-process per client IP (`/v1/auth/login`, `/v1/auth/refresh`) and per authenticated user (`/v1/deals/scan`, `/v1/deals/:dealId/treasure-analysis`, `/v1/deals/:dealId/vision-inspection`). A refused request returns `429` with `error: RATE_LIMIT_EXCEEDED`, a `Retry-After` header in seconds and `x-ratelimit-remaining: 0` on every response.

Alert on a sustained `429` rate per route: a spike on `/v1/auth/login` usually means credential stuffing, a spike on the analysis routes means a runaway client. The limiter is per process, so with several API instances the effective limit multiplies by the replica count; a shared limiter belongs in the gateway and remains an open item.

## Outbox operations (Sprint 36)

`outboxStatusCounts()` liefert die Verteilung über `PENDING`, `PROCESSING`, `PUBLISHED` und `DEAD_LETTER` und taugt direkt als Metrik-Gauge. Alarme: `DEAD_LETTER > 0` (sofort prüfen), `PROCESSING` älter als die Lease-Dauer (Reaper läuft nicht), wachsender `PENDING`-Rückstand (Handler zu langsam oder Provider-Ausfall).

`reapExpiredLeases({ limit })` gibt abgelaufene Leases explizit in die Queue zurück, setzt `lockedBy`/`leaseUntil` zurück und markiert `lastError = "LEASE_EXPIRED"`. `replayDeadLetter(id, { maxReplays })` ist der einzige Weg zurück aus `DEAD_LETTER`: nur ein Event, das aktuell `DEAD_LETTER` ist und dessen `replayCount` unter dem Limit liegt, wird erneut eingereiht (Versuche zurückgesetzt). Ein Doppelklick oder ein zweiter Operator kann dieselbe Nachricht nicht zweimal wiederbeleben.
