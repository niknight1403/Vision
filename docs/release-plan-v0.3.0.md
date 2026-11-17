# Release-Plan v0.3.0: Testnet-Readiness und kontrollierte Sandbox

**Ausgangsbasis:** v0.2.0 auf Commit `8b0ef6602880952190a5d0eff37378e934b07811`  
**Ziel:** sichere, beobachtbare und zunächst read-only Testnet-Fähigkeit vorbereiten  
**Nichtziel:** Produktionshandel, autonome Echtgeld-Orders, Abhebungen, Transfers, Margin, öffentliche Brokeranbindung oder automatisches Aufheben von Kill-Switches

## 1. Release-These

v0.3.0 soll die Lücke zwischen der vorhandenen PAPER-Simulation und einer späteren, kontrollierten Sandbox-Integration schließen. Das Release liefert einen echten Sicherheits- und Betriebsrahmen: eindeutig gebundene Testnet-Umgebung, serverseitige Konfiguration, read-only Provider-Capabilities, persistente Kill-Switch- und Reconciliation-Services, Audit-/Operator-Flows und Fault-Injection-Tests.

Der Standardmodus bleibt `PAPER`. `testnetEnabled` bleibt standardmäßig `false`. Ein Testnet-Provider darf nur über eine explizite, geprüfte Konfiguration und einen provider-spezifischen Adapter aktiviert werden. Mutierende Testnet-Calls gehören nicht in den v0.3.0-Basispfad; sie sind höchstens ein separat freizugebendes Stufe-2-Experiment nach den beschriebenen Gates.

## 2. Priorisierte Features

| Priorität | Feature | Nutzen | v0.3.0-Ziel |
|---|---|---|---|
| P0 | Testnet-Umgebungs- und Egress-Schutz | verhindert Verwechslung von Sandbox und Produktion | vollständig |
| P0 | Read-only Provider-Adapter | liefert Health, Instrumente, Orders, Fills und Salden ohne Mutation | vollständig |
| P0 | Persistenter Kill-Switch-Service | blockiert neue Aktionen fail-closed und ist revisionssicher | vollständig |
| P0 | Reconciliation-Worker | erkennt unbekannte Orders, Fill-/Gebühren-/Saldoabweichungen | vollständig |
| P0 | Approval-/Intent- und Outbox-Workflow | bereitet sichere Aktionen vor, ohne sie automatisch zu senden | vollständig |
| P1 | Operator-Status- und Audit-Ansichten | macht Zustand, Stopgründe und Reconciliation sichtbar | vollständig, read-only bzw. Admin-Action |
| P1 | Fault Injection und Provider-Contract-Fixtures | testet Timeouts, Webhook-Lücken, doppelte Events und Unknown-Zustände | vollständig |
| P1 | Observability und Incident-Runbook | verkürzt Erkennung und sichere Reaktion | vollständig |
| P2 | Cancel-only-Sandbox-Experiment | kontrollierte mutierende Probe mit minimalem Risiko | optional, separate Freigabe |
| P2 | Expo-/React-Native-Major-Upgrade | behebt moderate Toolchain-Advisories | eigener Folge-Sprint, nicht blind in v0.3.0 |

## 3. Geplante Ergebnis-Sprints 49–60

| Sprint | Ergebnis | Abnahmekriterium | Abhängigkeit |
|---:|---|---|---|
| 49 | Versionierte `TESTNET`-Runtime-Konfiguration mit exakter Host-, Account- und Environment-Bindung | Produktionshost, URL-Credentials, Wildcards und unvollständige Konfiguration werden abgelehnt; Default bleibt deaktiviert | v0.2.0 |
| 50 | Egress-Allowlist und Provider-Capability-Matrix | Nur HTTPS, erlaubte Hostnames, kein Redirect; read-only Capabilities sind getrennt von Mutation | 49 |
| 51 | Live-Monitoring und dedupliziertes Telegram-/Discord-Alerting | Kill-Switch, UNKNOWN-Orders, Reconciliation, Providerzustand und Drawdown erzeugen sichere Alerts; Kanäle bleiben standardmäßig deaktiviert | 50 |
| 52 | Secret-Manager-Runtime und Credential-Redaction | Secrets kommen ausschließlich aus Server-Runtime; Logs, Traces, Errors und Responses enthalten keine Secrets | 49–51 |
| 53 | Persistenter Kill-Switch-Service mit CAS-Versionierung | globaler, Provider-, Account- und Strategie-Stop; Cache-/DB-Fehler führen zu Blockierung; Reset niemals automatisch | 49, Prisma-Basis |
| 54 | Approval Snapshot und Order-Intent-Service | Payload-Hash, Ablauf, Preis-/Mengenbindung, Idempotency-Key und `UNKNOWN`-Zustand sind transaktional persistiert | 53 |
| 55 | Transactional Outbox und begrenzter Execution Coordinator | Intent wird vor jeder Aktion journalisiert; read-only Worker kann laufen; mutierende Adapter bleiben gesperrt | 54, bestehende Outbox |
| 56 | Reconciliation-Worker mit Lease und Watermark | Start-, periodische und Unknown-Reconciliation; monotone Status-/Fill-Merge; Watermark erst nach Commit | 51, 55 |
| 57 | Reconciliation-Diff- und Ledger-Anbindung | unbekannte externe Orders und kritische Fill-/Saldoabweichungen erzeugen Halt; Korrekturen sind append-only | 56, Wallet/Ledger |
| 58 | Authentifizierter Operator- und Admin-Workflow | `GET status`, `POST reconcile`, Kill-Switch setzen und Zwei-Personen-Reset sind RBAC-, Rate-Limit- und Audit-geschützt | 53–57 |
| 59 | Observability, Fault Injection und Incident-Runbook | Tests decken Timeout nach Submit, Duplicate Event, Webhook-Lücke, Partial Fill, Clock-Skew und Provider-Ausfall ab | 51–58 |
| 60 | v0.3.0-Release-Hardening | CI, PostgreSQL-Konkurrenztests, Migrationen, Build, Audit-Schwelle, Android-Export, Dokumentation und Gate-Evidenz grün | 49–59 |

## 4. Technischer Zuschnitt

### 4.1 Provider-Schicht

Die bestehende Provider-Registry wird um deklarative Testnet-Capabilities erweitert. Der Adapter darf nur die vom Providervertrag geprüften Methoden anbieten. `ORDER_SUBMIT`, `CANCEL_ORDER`, `WITHDRAWAL`, `TRANSFER`, `MARGIN` und Produktionscapabilities bleiben im Basispfad nicht registriert. Für jeden Provider werden Host-Allowlist, Account-Identifier, API-Version, Zeitstempeltoleranz, Rate-Limits und Schema-Version separat konfiguriert.

Die ersten v0.3.0-Adapteroperationen sind `healthCheck`, `getInstruments`, `getBalances`, `getOpenOrders`, `getOrderStatus` und `getFills`. Alle Responses werden normalisiert, mit Provider-ID und Beobachtungszeit versehen und gegen begrenzte Größen- und Wertebereiche validiert.

### 4.2 Kill-Switch und Gate-Auswertung

Der Kill-Switch-Service liest den effektiven Zustand aller relevanten Scopes in einer Datenbanktransaktion oder mit nachweisbarer Versionsprüfung. Ein fehlender Scope, Cachefehler, Datenbankfehler, Versionskonflikt, Security-Fehler oder Clock-Skew blockiert die Aktion. `ARMED` ist nur ein zulässiger Schutzstatus; es aktiviert weder Testnet noch eine Mutation.

Reset benötigt einen frischen Health-/Balance-Check, eine Begründung, einen neuen Approval Snapshot und zwei unabhängige ADMIN-Aktionen. `TRIGGERED`, `DRAINING` und `HALTED` werden nicht von Workern selbständig auf `ARMED` gesetzt.

### 4.3 Reconciliation

Der Worker arbeitet pro Provider-/Account-Scope mit Lease. Er lädt Providerzeit, offene Orders, historische Orders, Fills und Salden in begrenzten Fenstern. Er vergleicht externe IDs, Client-IDs, Status, Fill-Menge, Durchschnittspreis und Gebühren mit Journal und Ledger. Ein unbekannter externer Datensatz oder eine interne nicht-terminale Order ohne externes Gegenstück erzeugt einen kritischen Diff und setzt den Scope auf Halt.

Reconciliation-Events sind append-only. Eine Rundungstoleranz darf nur explizit für dokumentierte Providerpräzision gelten. Sie darf keine fehlenden Gelder, falsche Instrumente oder unbekannte Orders verdecken.

### 4.4 Operator-Oberfläche

v0.3.0 benötigt keine mobile Orderausführung. Die Oberfläche zeigt Environment, Providergesundheit, letzte Reconciliation, Watermark, Kill-Switch-Zustand, unbekannte Orders, kritische Diffs und Audit-Referenzen. Mutierende Controls sind serverseitig geschützt; die UI darf niemals einen Erfolg aus einem Timeout oder einer lokalen Annahme ableiten.

## 5. Teststrategie

Jeder Sprint erhält Unit-Tests für Grenzwerte und Zustandsübergänge sowie PostgreSQL-Tests für Idempotenz, konkurrierende Leases, CAS-Updates, Outbox und Ledger-Invarianten. Provider-Contract-Tests verwenden redigierte Fixtures und einen deterministischen Fake-Adapter; sie benötigen keine Credentials und keine Netzwerkverbindung.

Die Fault-Injection-Matrix umfasst mindestens:

| Fehler | Erwartetes Verhalten |
|---|---|
| Timeout vor Submit | kein externer Status angenommen; Submit darf nicht blind wiederholt werden |
| Timeout nach Submit | Order wird `UNKNOWN`; Status/Fills zuerst reconciliert |
| Duplicate Webhook/Event | einmalige Journal-/Ledger-Wirkung |
| Unbekannte Provider-Order | kritischer Diff, Scope-Halt |
| Interne Pending-Order ohne Provider-Gegenstück | `UNKNOWN`, kein Resubmit |
| Partial Fill | monotone Fill-Merge, korrekte Gebühren und Ledger-Events |
| Saldoabweichung | Account-Halt und Reconciliation-Alarm |
| Kill-Switch-DB nicht verfügbar | neue Aktion abgelehnt |
| Signatur-/Hostfehler | globaler Security-Stop |
| Clock-Skew | mutierende Aktion abgelehnt, Read-only nur nach Policy |
| Doppelte Idempotency-Key mit anderem Payload | Konflikt, keine zweite Intent-Anlage |

## 6. v0.3.0-Release-Gates

v0.3.0 darf nur veröffentlicht werden, wenn alle P0-Sprints abgeschlossen und nachgewiesen sind. Dazu gehören ein technisch blockierter Produktionshost, ein nicht aktivierbarer Default, Secret-Redaction, RBAC, Kill-Switch-CAS, Reconciliation nach Neustart und Unknown-Zustand, keine Doppelwirkung durch Retries, vollständige Auditkette, PostgreSQL-Konkurrenztests, CI, Android-Export und `npm audit --audit-level=high`.

Der Release darf trotz erfüllter Code-Gates keine mutierende Testnet-Integration aktivieren. Dafür ist ein nachgelagerter Change-Plan mit ausgewähltem Provider, Sandboxkonto, minimalen Limits, Cancel-only-Probe, manueller Freigabe, Runbook und expliziter Administratorentscheidung erforderlich.

## 7. Nicht in v0.3.0 aufnehmen

Nicht in dieses Release gehören Produktionsendpunkte, echte API-Schlüssel im Repository, Abhebungen oder Transfers, Margin/Leverage, autonome Strategie- oder Risikogrenzenänderung, öffentliches Self-Service-Onboarding, unreviewte Provider-SDKs, automatische Kill-Switch-Resets und ein blindes Expo-58-/React-Native-Major-Upgrade. Die elf moderaten Expo-Advisories werden in einem separaten Upgrade-Sprint mit Kompatibilitätsmatrix und Rollback behandelt.

## 8. Empfohlene Reihenfolge

Zuerst werden Umgebung und Egress (49–52) geschlossen, danach Kill-Switch, Approval und Outbox (53–55), anschließend Reconciliation und Ledger (56–57). Erst wenn diese Kette deterministisch funktioniert, kommen Operator-Workflow und Fault Injection (58–59). Sprint 60 ist ausschließlich Release-Hardening und Evidenzsammlung. Kein späterer Sprint darf eine frühere Sicherheitsgrenze umgehen.
