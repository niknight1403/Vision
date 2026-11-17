# Sichere Testnet-Integration mit Kill-Switch und Reconciliation

**Status:** Sicherheitsprimitive und persistentes Datenmodell implementiert; echter Provider-Adapter und mutierende Testnet-Routen bleiben deaktiviert.  
**Geltungsbereich:** ausschließlich Testnet/Sandbox eines ausdrücklich ausgewählten Providers.  
**Bestehender Zustand:** AutonomAgent bleibt PAPER-only; `TRADING_MODE=LIVE` und `LIVE_TRADING_ENABLED=true` werden weiterhin fail-closed abgelehnt.

Diese Architektur beschreibt einen isolierten Testnet-Pfad. Die aktuellen Implementierungsbausteine liegen in `services/api/src/testnet-execution.ts`, die Datenbankmodelle in `services/api/prisma/schema.prisma`; `DisabledTestnetAdapter` verweigert jeden Provideraufruf. Dies ist keine Produktionsfreigabe, keine Börsenintegration und keine Empfehlung, reale Gelder einzusetzen. Ein Testnet schützt typischerweise vor realen Verlusten, aber nicht vor falschen Orders, API-Sperren, Datenschutzproblemen, Rate-Limits, Gebühren in kostenpflichtigen Sandboxen oder einer versehentlichen Verbindung zum Produktionsendpunkt.

## 1. Sicherheitsziele und Nichtziele

Die Integration soll eine einzelne, klar benannte Sandbox-Umgebung ansprechen, jede externe Order eindeutig idempotent ausführen, unbekannte Zustände sicher anhalten und alle finanziellen Fakten unveränderlich protokollieren. Ein Netzwerkfehler darf niemals als Ablehnung oder Erfolg interpretiert werden. Der Dienst muss nach Neustarts, Timeouts, doppelten Events und Provider-Ausfällen deterministisch wieder anlaufen können.

Nichtziel ist ein allgemeiner Multi-Broker-Handelsservice. Nichtziel sind autonome Strategieänderungen, Live-Aktivierung, Hebel-/Margin-Handel, Abhebungen, Transfers, Produktionsschlüssel, öffentliche Self-Service-Konten oder das automatische Aufheben eines Kill-Switches.

## 2. Trust Boundaries

```text
Mobile/Admin UI
      │ authenticated commands only
      ▼
API + RBAC + Approval Service
      │ signed internal command / idempotency key
      ▼
Execution Coordinator ──► Kill-Switch / Risk Gate
      │                         │
      │                         ├─ global stop
      │                         ├─ account stop
      │                         ├─ provider stop
      │                         └─ strategy stop
      ▼
Testnet Adapter ──► Egress Allowlist ──► Provider Sandbox API
      │
      ├─ Order Journal / Outbox
      ├─ Immutable Ledger
      └─ Reconciliation Worker ◄── Provider Order/Balance/Fill Queries
```

Die Mobile-App darf keine Provider-Credentials, Signaturen oder direkten Order-Endpunkte kennen. Nur der serverseitige Adapter darf den Testnet-Endpunkt erreichen. Der Egress muss DNS/Hostname, TLS-Zertifikat, Port und Basis-Pfad prüfen; Redirects und Produktionshosts werden abgelehnt.

## 3. Umgebungs- und Identitätsmodell

Testnet und Produktion benötigen getrennte Deployments, Datenbanken, Secret-Pfade, Providerkonten, API-Basen, Verschlüsselungsschlüssel und Observability-Namensräume. Eine Konfiguration enthält eine unveränderliche `environment = TESTNET`-Markierung sowie den erwarteten Provider-Account-Identifier. Das Starten wird verweigert, wenn der Hostname nicht mit der registrierten Testnet-Allowlist übereinstimmt oder der Provider-Account nicht als Sandboxkonto bestätigt wurde.

Empfohlene serverseitige Secrets:

| Secret | Zweck | Regel |
|---|---|---|
| `TESTNET_API_KEY` | Provider-Authentifizierung | Nur Secret Manager, niemals Logs oder Mobile-App |
| `TESTNET_API_SECRET` | Request-Signatur | Nur serverseitig, rotierbar |
| `AUTH_SIGNING_SECRET` | interne Sessions | getrennt vom Providersecret |
| `LEDGER_ENCRYPTION_KEY` | sensible Ledgerfelder | KMS/HSM-geschützt |

Kein Secret darf in Git, `.env`-Dateien, `EXPO_PUBLIC_*`, Fehlertexten, Traces, URLs oder Provider-Payloads mit Debug-Logging erscheinen. Abhebungs-, Transfer- und Marginrechte müssen beim Providerkonto deaktiviert sein; idealerweise ist nur Spot-Testnet-Handel mit minimalen Sandboxlimits erlaubt.

## 4. Komponenten

### 4.1 Approval Service

Erzeugt einen unveränderlichen Approval Snapshot mit Strategieversion, Instrument, Richtung, Menge, Limitpreis, erwarteten Gebühren, Stop-/Take-Profit-Regeln, Risikoentscheidung, Ablaufzeit, Benutzer, Rolle und `environment=TESTNET`. Ein Approval ist kein Ordererfolg. Jede relevante Änderung an Preis, Menge, Bestand, Gebühren, Risiko oder Ablauf macht den Snapshot ungültig.

### 4.2 Execution Coordinator

Nimmt ausschließlich authentifizierte, autorisierte Commands mit Idempotency-Key an. Vor jedem Provideraufruf prüft er erneut Kill-Switch, Umgebung, Approval, Ablauf, Risiko, Cash-Reserve, Instrument-Allowlist und Providergesundheit. Er schreibt zuerst einen `OrderIntent` und ein Outbox-Event in derselben Transaktion. Erst der Worker führt den Provideraufruf mit einem stabilen Client-Order-Identifier aus.

### 4.3 Testnet Adapter

Der Adapter wird pro Provider und Capability registriert. Minimal erforderliche Capabilities sind `ACCOUNT_READ`, `BALANCE_READ`, `ORDER_SUBMIT`, `ORDER_STATUS`, `OPEN_ORDERS_READ`, `FILLS_READ` und `CANCEL_ORDER`. `WITHDRAWAL`, `TRANSFER`, `MARGIN` und `PRODUCTION_ORDER` müssen explizit nicht unterstützt werden. Jede Antwort wird gegen ein versioniertes Schema validiert; unbekannte Statuswerte führen zu `UNKNOWN`, nicht zu einer optimistischen Interpretation.

### 4.4 Order Journal und Ledger

Das Order Journal speichert externe Identität und Zustandsübergänge. Der doppelte Ledger speichert interne finanzielle Fakten wie Reservation, Submit, Fill, Fee, Release und Reversal. Erwarteter Gewinn ist niemals verfügbarer Cash. Jeder Ledger-Eintrag besitzt `eventId`, `accountId`, `environment`, `orderIntentId`, `externalOrderId` oder eine explizite `externalReference`, Betrag in Integer-Cents, Währung, Zeit, Ursache und Vorgängerreferenz.

### 4.5 Reconciliation Worker

Der Worker liest Providerorders, Fills, offene Orders, Kontostände und gegebenenfalls Gebühren. Er vergleicht diese mit Journal und Ledger, erzeugt nur additive Korrektur-/Reconciliation-Events und setzt bei Widerspruch den betroffenen Scope auf Halt. Er löscht keine Fakten und „repariert“ keine Abweichung durch blindes Neusenden.

## 5. Zustandsautomat

### 5.1 Interner Orderzustand

```text
DRAFT
  └─► APPROVED ─► QUEUED ─► SUBMITTING ─► SUBMITTED
                                      │          │
                                      │          ├─► PARTIALLY_FILLED
                                      │          ├─► FILLED
                                      │          ├─► CANCEL_REQUESTED ─► CANCELLED
                                      │          ├─► REJECTED
                                      │          └─► UNKNOWN
                                      └─► UNKNOWN
```

`UNKNOWN` ist ein sicherer Haltezustand. Er darf nur durch eine erfolgreiche Status-/Fill-Abfrage oder eine manuelle, protokollierte Entscheidung verlassen werden. Ein Timeout nach Submit darf niemals automatisch zu einem zweiten Submit führen.

### 5.2 Kill-Switch-Zustand

```text
ARMED ─► TRIGGERED ─► DRAINING ─► HALTED
  ▲                         │          │
  └──────── manual reset ◄──┴──────────┘
```

`ARMED` bedeutet nur, dass die Schutzlogik aktiv ist, nicht dass Orders zulässig sind. `TRIGGERED` blockiert neue Submits sofort. `DRAINING` darf nur noch bereits bestätigte Cancel-Anfragen und Reconciliation ausführen. `HALTED` blockiert alle mutierenden Provideraktionen. Reset benötigt einen zweiten ADMIN, eine Begründung, frische Gesundheits-/Saldoabfragen und einen neuen Approval Snapshot. Der Reset darf nie automatisch erfolgen.

## 6. Kill-Switch-Design

Es gibt einen globalen, umgebungsbezogenen, Provider-, Account- und Strategiestop. Die effektive Berechtigung ist die strengste Kombination; ein einziger aktiver Stop blockiert Submit. Der Zustand wird serverseitig in einer transaktionalen, versionierten Tabelle gespeichert und zusätzlich über einen kurzen Cache mit sehr kleinem TTL gelesen. Bei Cachefehler, Datenbankfehler, fehlendem Zustand oder Versionskonflikt gilt `TRIGGERED`.

Auslöser sind mindestens:

| Trigger | Aktion |
|---|---|
| manueller ADMIN-Stop | sofort `TRIGGERED`, neue Submits blockieren |
| Verlust der Provider-Authentifizierung | Provider-Scope stoppen |
| unbekannter Order-/Zahlungsstatus | betroffene Order und Strategie stoppen |
| Saldoabweichung | Account stoppen, Reconciliation priorisieren |
| Drawdown-/Tagesverlustlimit | Strategie und Account stoppen |
| Preis-/Bestandsdrift | Order verwerfen, kein Retry |
| wiederholte 5xx/Timeouts | Circuit Breaker plus Provider-Stop |
| Signatur-/Hostabweichung | globaler Security Stop |
| Clock-Skew außerhalb Toleranz | Submits stoppen, Zeitdienst prüfen |

Der Kill-Switch muss ohne Providerverbindung funktionieren. Ein „Cancel all“ darf nur gestartet werden, wenn der Providerstatus und die Capability verifiziert sind; ein fehlgeschlagenes Cancel bleibt `UNKNOWN` und wird reconciliert.

## 7. Idempotenz und Retry-Regeln

Jeder fachliche Auftrag hat einen stabilen `orderIntentId`. Der Client sendet zusätzlich einen Idempotency-Key; derselbe Key mit anderem Payload-Hash ist ein Konflikt. Der Provider-Client-Identifier wird deterministisch aus Umgebung, Account, Intent und Version gebildet und darf keine Geheimnisse enthalten.

Erlaubte Retries sind nur für nachweisbar nicht gesendete Requests oder idempotente Read-/Cancel-Abfragen. Nach einem Timeout bei einem Submit gilt der externe Zustand als unbekannt: zuerst `ORDER_STATUS` und `FILLS_READ`, niemals blind erneut submitten. Exponential Backoff besitzt eine Obergrenze und wird durch Kill-Switch/Circuit-Breaker unterbrochen. Jede Wiederholung schreibt ein Auditereignis.

## 8. Reconciliation-Verfahren

Reconciliation läuft beim Start, periodisch, nach jedem `UNKNOWN`, nach Webhook-Lücken und vor jeder erneuten mutierenden Aktion. Webhooks sind Hinweise, nicht die alleinige Wahrheit; sie werden mit Polling abgeglichen. Die Reihenfolge lautet:

1. Lease für genau einen Account/Provider-Scope erwerben.
2. Providerzeit und Cursor/Watermark lesen.
3. Orders, Fills, offene Orders und Saldo in einem begrenzten Zeitfenster abrufen.
4. Antworten signatur-, schema- und versionsprüfen.
5. Externe IDs gegen das Journal abgleichen.
6. Fehlende externe Fakten als `UNMATCHED_EXTERNAL_EVENT` markieren.
7. Interne, aber extern unbekannte Pending-Orders auf `UNKNOWN` setzen.
8. Fill-Mengen, Durchschnittspreis, Gebühren und Status monoton zusammenführen.
9. Ledger-Reconciliation-Events append-only schreiben.
10. Differenzen klassifizieren und bei materieller Abweichung Kill-Switch auslösen.
11. Watermark nur nach erfolgreichem Commit speichern.

Reconciliation ist erfolgreich nur, wenn alle relevanten Orders terminal oder nachvollziehbar offen sind, Fill-Summen und Ledger stimmen, der Kontostand innerhalb einer expliziten Toleranz liegt und kein unbekannter Event verbleibt. Eine Toleranz darf Rundung erklären, aber niemals fehlende Gelder, falsche Instrumente oder unbekannte Orders verdecken.

## 9. Datenmodell (Vorschlag)

| Tabelle | Wichtige Felder | Invarianten |
|---|---|---|
| `ExecutionEnvironment` | id, name, provider, baseUrlHash, status, version | nur `TESTNET`; Host-Allowlist |
| `RiskKillSwitch` | scope, state, reason, triggeredBy, version, updatedAt | monotone Version, fail-closed |
| `ApprovalSnapshot` | intentId, payloadHash, riskSnapshot, expiresAt, approvedBy | immutable, einmalige Version |
| `OrderIntent` | id, idempotencyKey, payloadHash, environment, status | unique Key + Payload |
| `ExternalOrder` | intentId, providerOrderId, clientOrderId, status | provider ID unique pro Account |
| `OrderEvent` | eventId, intentId, type, payloadHash, observedAt | append-only, dedupliziert |
| `Fill` | providerFillId, externalOrderId, quantity, price, fee | unique Provider-Fill-ID |
| `LedgerEntry` | eventId, account, debit, credit, amountCents | Double-entry, immutable |
| `ReconciliationRun` | scope, watermark, status, diffSummary | lease + monotone Watermark |
| `AuditEvent` | actor, action, reason, correlationId, metadata | kein Secret, append-only |

Alle Geldwerte werden in Integer-Cents oder der vom Provider erforderlichen kleinsten Einheit gespeichert; Providerpräzision und interne Präzision werden explizit getrennt. Zeitstempel werden in UTC gespeichert. Payloads erhalten Hashes; sensible Rohdaten werden verschlüsselt und mit Aufbewahrungsfristen versehen.

## 10. API- und Berechtigungsgrenzen

Die Mobile-App erhält keine direkte Orderroute. Vorgesehene serverseitige Routen sind intern und streng autorisiert:

| Route | Rolle | Regel |
|---|---|---|
| `POST /v1/testnet/intents` | OPERATOR | erstellt nur `DRAFT` |
| `POST /v1/testnet/intents/:id/approve` | ADMIN | neuer Snapshot, Ablaufpflicht |
| `POST /v1/testnet/intents/:id/submit` | OPERATOR + Policy | alle Gates erneut prüfen |
| `POST /v1/testnet/orders/:id/cancel` | OPERATOR | idempotent, bei Unsicherheit reconcile |
| `POST /v1/testnet/kill-switch` | ADMIN | Scope, Grund, Auditpflicht |
| `POST /v1/testnet/kill-switch/reset` | zwei ADMINs | kein automatischer Reset |
| `POST /v1/testnet/reconcile` | ADMIN/Worker | begrenzter Scope, Lease |
| `GET /v1/testnet/status` | VIEWER+ | keine Secrets, sicherheitsrelevante Metriken |

Für jede mutierende Route gelten TLS, RBAC, Request-Schema, Rate-Limit, Idempotency-Key, Audit-Event und serverseitige Revalidierung. Eine UI-Anzeige „approved“ oder „submitted“ darf nicht aus einer Clientannahme stammen, sondern nur aus persistiertem Serverstatus.

## 11. Observability und Incident Response

Korrelations-IDs verbinden Approval, Intent, Outbox, Provider-Request, externe Order, Fill, Ledger und Reconciliation. Logs sind strukturiert und redigieren API-Keys, Signaturen, Tokens und vollständige Providerpayloads. Metriken umfassen Submit-/Fill-/Reject-Zähler, unbekannte Orders, Reconciliation-Dauer, Saldoabweichung, Drawdown, Kill-Switch-Trigger, Retryzahl, Providerlatenz und Clock-Skew.

Alarme müssen mindestens bei jedem `UNKNOWN`, jeder materiellen Saldoabweichung, jedem Security-Stop, wiederholten Signaturfehlern, Reconciliation-Stillstand, fehlender Watermark-Fortschreibung und überschrittenem Risiko-Limit auslösen. Ein Incident-Runbook friert neue Submits ein, exportiert Audit-/Reconciliation-IDs, prüft Providerstatus und hebt den Kill-Switch erst nach unabhängiger Verifikation auf.

## 12. Rollout in Stufen

**Stufe 0 – Offline:** Adapter-Contract-Tests mit aufgezeichneten, redigierten Fixtures; keine Netzwerkverbindung.  
**Stufe 1 – Read-only Testnet:** Health, Instrumente, Orders, Fills und Salden lesen; keine mutierenden Calls.  
**Stufe 2 – Cancel-only:** Nur zuvor manuell erzeugte Sandboxorders beobachten und canceln; Reconciliation beweisen.  
**Stufe 3 – Kleinstes Testnet-Limit:** Ein Instrument, ein Account, eine Strategie, ein Operator, feste Tages-/Positionslimits, manuelle Freigabe jeder Order.  
**Stufe 4 – Begrenzte Automatisierung:** Nur nach grünen Stufen-3-Evidenzen, weiterhin mit manueller Kill-Switch-Aufsicht.  

Jede Stufe benötigt einen versionierten Change-Plan, Testnachweise, Rollback-/Haltplan, Verantwortlichen und eine explizite Freigabe. Ein Code-Commit, ein grüner CI-Lauf oder ein vorhandener Testnet-Key allein aktiviert keine Stufe.

## 13. Verbindliche Release-Gates

Vor dem ersten mutierenden Testnet-Call müssen alle folgenden Nachweise vorliegen:

- Provider-API-Vertrag, Sandboxhost und Capability-Matrix geprüft.
- Produktionshosts technisch blockiert; Egress-Allowlist getestet.
- Testnetkonto ohne Withdrawal, Transfer und Marginrechte.
- Secret-Manager-Injektion und Rotation getestet; keine Secrets in Logs.
- Authentifizierung, RBAC, Zwei-Personen-Reset und Audit geprüft.
- Approval-Snapshot, Ablauf, Preis-/Bestandsdrift und Idempotenz getestet.
- Kill-Switch aus API, Datenbankfehler, Cachefehler und Providerfehler getestet.
- Unknown-after-submit-Szenario ohne Doppelorder getestet.
- Reconciliation nach Neustart, Timeout, Webhook-Verlust, Partial Fill und Gebührenabweichung getestet.
- Double-entry-Ledger und Cash-Reserve gegen PostgreSQL-Konkurrenz getestet.
- Circuit Breaker, Rate-Limits, Clock-Skew und Retry-Obergrenzen getestet.
- Backups, Wiederanlauf, Migrationsstatus, Build-ID und Artefakt-Hash dokumentiert.
- Manuelle Stoppübung und Incident-Runbook erfolgreich durchgeführt.

Bis jede relevante Evidenz vorliegt, bleibt `TRADING_MODE=PAPER`, der Testnet-Adapter deaktiviert und jede mutierende Route nicht erreichbar.

## 14. Migrationspfad im bestehenden Repository

Die aktuelle `services/api/src/providers/types.ts`-Registry sollte zunächst um deklarative Read-only- und Testnet-Capabilities ergänzt werden, ohne eine Submit-Methode freizuschalten. Danach folgen getrennte Module für `ApprovalSnapshot`, `OrderIntent`, `OrderEvent`, `ExternalOrder`, `Fill`, `ReconciliationRun` und `RiskKillSwitch` sowie Prisma-Migrationen mit PostgreSQL-Integrations- und Konkurrenztests.

Die bestehende `config.ts` bleibt unverändert fail-closed, bis ein separater, bewusst aktivierbarer Testnet-Modus mit exakter Host-/Account-Prüfung, Kill-Switch und vollständigen Release-Gates implementiert und freigegeben ist. Die vorhandene Live-PAPER-Simulation darf weiterhin als Offline-/Replay-Testorakel genutzt werden, aber niemals als Beweis für erfolgreiche externe Testnet-Ausführung.

Sprint 49 ergänzt `services/api/src/testnet-config.ts`. Die Funktion `loadTestnetRuntimeConfig` liest nur die vertrauenswürdige Serverumgebung, verlangt bei Aktivierung `TESTNET_ENVIRONMENT=TESTNET`, eine semantische Konfigurationsversion, Provider-/Account-/API-Identität, HTTPS, exakte Host-Allowlist und eine getrennte Produktionshost-Sperrliste. Die API-Startupkonfiguration weist selbst eine formal valide aktivierte Testnet-Konfiguration in diesem Release weiterhin mit `TESTNET execution is not enabled in this release` zurück.

Sprint 50 ergänzt `services/api/src/testnet-provider-contract.ts` und `testnet-integration.test.ts`. Die Integrationstests verbinden die versionierte Konfiguration mit dem allowlisteten JSON-Client und einem lokalen read-only Fixture-Adapter. Sie prüfen Capability-Implementierungen, falsche Umgebungen, Duplikate, Redirect-/Pfadschutz und die Abwesenheit mutierender Capabilities. Es wird kein externer Testnet-Host kontaktiert.
