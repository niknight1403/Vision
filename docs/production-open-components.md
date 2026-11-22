# Offene Komponenten für den produktiven Live-Betrieb

Stand: 2026-11-21  
Repository-Commit: `a50f0ca` plus Sprint-21–30-Evidence-Commits (siehe [thirty-sprint-release-gate.md](thirty-sprint-release-gate.md))  
Aktueller Betriebsmodus: `AUTONOMOUS` mit Read-only-Providerdaten  
Live-Handel: deaktiviert

## Zusammenfassung

Vision kann aktuell echte Providerdaten einlesen, Kandidaten serverseitig analysieren, Vision-Aufgaben über eine durable Queue verarbeiten und Ergebnisse in der Android-App anzeigen. Der isolierte synthetische Staging-Provider ist ausschließlich für Staging freigeschaltet.

Das System ist **nicht produktionsbereit für Käufe, Verkäufe, Zahlungen oder automatische Listings**. Die folgenden Komponenten fehlen oder benötigen noch einen belastbaren Produktionsnachweis.

## Priorität 0: zwingende Live-Blocker

### 1. Konkrete Marketplace-Integrationen

Es fehlt mindestens ein ausgewählter Marketplace mit geprüftem offiziellen API-Vertrag und produktiven Zugangsdaten für:

- Suche und Kandidatenerfassung;
- aktuelle Preis-, Bestands-, Versand- und Gebührenabfrage;
- Sold-/Verkaufsvergleichsdaten für belastbare Marktbewertungen;
- Kauf- bzw. Orderaufgabe;
- Orderstatus, Fills, Storno und Fehlerzustände;
- Listing-Erstellung, Veröffentlichung, Bearbeitung und Rücknahme;
- Auszahlungen, Rückerstattungen und Settlement-Daten.

Der vorhandene REST-Katalogadapter unterstützt nur `PRODUCT_SEARCH`. Der `catalog-staging`-Adapter ist synthetisch, als `simulated: true` markiert und darf niemals für eine Freigabe verwendet werden.

### 2. Execution Service und mutierende Provider-Adapter

Es gibt noch keinen produktiven Execution Service und keine öffentliche Kauf-, Order-, Payment- oder Listing-Route. Benötigt werden:

- persistente Order-Intents mit eindeutiger Client-Order-ID;
- bindende Approval-Snapshots mit Preis, Bestand, Gebühren, Limits und Ablaufzeit;
- unmittelbare Revalidierung vor jedem Provideraufruf;
- idempotente Submission und durable Ausführungsjobs;
- Zustandsübergänge von `DRAFT` bis `FILLED`, `CANCELLED`, `REJECTED` oder `UNKNOWN`;
- getrennte, eng begrenzte Capability-Freigaben je Provider;
- explizite Administratorbestätigung oder eine separat freigegebene, begrenzte Automationsrichtlinie.

Die vorhandene Testnet-Sicherheitslogik ist ein fail-closed Fundament, aber noch kein aktivierter Ausführungsweg.

### 3. Finanzbuchhaltung und Settlement

Wallet-Reservierung und -Freigabe sind als interne Primitive vorhanden. Für Live-Betrieb fehlen der vollständige produktive Geldfluss und die fachliche Bindung an Trades:

- vollständiges Double-Entry-Ledger für Deposit, Reservation, Purchase, Gebühren, Versand, Verkauf, Auszahlung, Refund und Adjustment;
- unveränderliche Trade-/Order-/Ledger-Verknüpfung;
- atomare Kapitalreservierung pro Trade, Kategorie und Provider;
- Settlement-Verarbeitung und Abgleich mit Provider-Auszahlungen;
- Behandlung von Refunds, Teilfüllungen, Gebührenabweichungen und negativen Salden;
- unveränderliche Korrektur- und Audit-Events statt Updates an Finanzfakten.

### 4. Reconciliation und unbekannte Zustände

Der Reconciliation-Datentyp und die Diff-Klassifikation sind vorhanden, aber der produktive Lease-/Watermark-Worker und die Ledger-Anbindung fehlen. Offen sind:

- periodischer Reconciliation-Worker pro Provider-/Account-Scope;
- Abruf von Salden, offenen Orders, historischen Orders, Fills und Gebühren;
- Abgleich externer IDs, Client-IDs, Status, Mengen, Preisen und Gebühren;
- persistente Diff- und Halt-Events;
- sicherer Umgang mit `UNKNOWN` ohne blindes Retry;
- automatische Sperrung des betroffenen Scopes bis zur manuellen Auflösung;
- operative Nachbearbeitung und Beweisführung für jede Abweichung.

## Priorität 1: Produktionssicherheit und Betrieb

### 5. Persistenter Kill-Switch und Live-Enablement

Der aktuelle Emergency-Stop ist Konfigurationsstatus; ein produktiver, administrierbarer Kill-Switch-Service fehlt. Benötigt werden:

- persistente globale, Provider-, Account- und Strategie-Sperren;
- CAS-Versionierung und Auditierung jeder Zustandsänderung;
- fail-closed Verhalten bei fehlendem oder widersprüchlichem Status;
- getrennte Rollen für Ausführung, Freigabe und Kill-Switch-Aufhebung;
- expliziter Enablement-Workflow für Live statt einer Environment-Variable;
- Testnachweis, dass neue Orders während `TRIGGERED`, `DRAINING` und `HALTED` abgewiesen werden.

### 6. Secret- und Schlüsselmanagement

Secrets dürfen nicht in Mobile-Bundles oder Repository-Dateien liegen. Vor Produktion fehlen der nachgewiesene Betrieb eines Secret Managers sowie:

- Rotation von API-, JWT- und Worker-Schlüsseln ohne Downtime;
- getrennte Secrets je Umgebung und Provider;
- Redaction in Logs, Traces, Fehlern und Support-Artefakten;
- minimale Provider-Scopes und Ablauf-/Widerrufsprozesse;
- kontrolliertes Initialisieren des ersten ADMIN-Kontos;
- Backup- und Recovery-Verfahren für Secrets und Schlüsselmaterial.

### 7. Authentifizierung, RBAC und Abuse Controls

Login, Refresh, Logout und rollenbasierte Prüfung sind implementiert. Für eine öffentliche Produktionsbereitstellung fehlen noch der Betriebsnachweis und zusätzliche Schutzmaßnahmen:

- Reverse-Proxy- oder Gateway-Rate-Limits für Login und sensible Routen;
- MFA oder gleichwertige starke Absicherung für Administratoren;
- Key-Rotation und JWKS-/Issuer-Betriebsverfahren;
- Refresh-Session-Bereinigung und Geräte-/Session-Verwaltung;
- Security-Audit-Events für Login, Rollenänderung, Freigabe, Ausführung und Kill-Switch;
- CSRF-Schutz, falls Cookies statt Bearer-Token verwendet werden;
- formaler Prozess für Rollenvergabe, Deaktivierung und Notfallzugriff.

### 8. Deployment, Netzwerk und Datenbankbetrieb

Die Anwendung ist noch nicht als produktiver Service deployed. Benötigt werden:

- HA-PostgreSQL oder gleichwertiger verwalteter Betrieb;
- getestete Backups, Point-in-Time-Recovery und Restore-Drills;
- Migrationen mit Change-Review und Rollback-/Forward-Plan;
- private Netzwerkanbindung von API, Task-Worker und Python-Vision-Worker;
- TLS, Egress-Allowlist und Blockade privater, Loopback-, Link-Local- und Metadata-Netze;
- Health-, Readiness- und Liveness-Checks einschließlich Worker- und Providerzustand;
- kontrollierte Deployments, Rollbacks und getrennte Staging-/Produktionsumgebungen;
- Nachweis von Build-ID, Git-SHA, Migration-Status und Artefakt-Hash.

## Priorität 2: Fachliche Vollständigkeit

### 9. Markt- und Bewertungsnachweise

Ohne echten Sold-Listing-Provider bleibt die Vision-Bewertung korrekt bei `RESEARCH_REQUIRED`. Für produktive Bewertungsentscheidungen fehlen:

- mindestens ein freigegebener Sold-Data-Provider;
- Aktualitätsfenster und Quellenreferenzen je Vergleichsverkauf;
- Währungs-, Gebühren-, Steuer- und Versandregeln;
- Nachweis gegen manipulierte oder unvollständige Vergleichsdaten;
- Speicherung der Quellen und Rohbefunde für spätere Audits;
- Regeln, wann eine Bewertung trotz Modellkonfidenz nicht entscheidungsfähig ist.

### 10. Vision-Ergebnisse und Auditpersistenz

Die durable Specialist-Analyse ist vorhanden. Die direkte Visual-Inspection-Route liefert aber noch kein persistiertes Ergebnis. Offen sind:

- Speicherung von Bildquelle, Modellversion, Prompt-/Schema-Version, Befunden und Unsicherheiten;
- unveränderliche Verknüpfung zum Kandidaten und Correlation ID;
- Retention- und Löschkonzept für Bilder, Prompts und Modellresultate;
- UI für `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED` einschließlich Retry- und Fehlerursache;
- Trennung von Beobachtung, Modellinferenz und verifizierter externer Evidenz.

### 11. Operations-Übersicht und Observability

`GET /v1/operations/overview` ist noch nicht produktiv verfügbar. Benötigt werden:

- Provider-, Queue-, Worker-, DB-, Outbox- und Reconciliation-Status;
- Metriken für Latenz, Fehler, Retries, Dead Letters und Provider-Circuit-Breaker;
- strukturierte Logs ohne Secrets und mit Correlation IDs;
- Alerts für unbekannte Orders, Ledger-Differenzen, Queue-Stau, Worker-Ausfälle und Kill-Switch-Aktivierung;
- Runbooks für Provider-Ausfall, Datenbankausfall, Secret-Leak, Reconciliation-Halt und Rollback;
- On-call-Verantwortung und dokumentierte Eskalationswege.

### 12. Android- und Distribution-Gate

Der Android-Build ist reproduzierbar, aber der Live-Distributionsnachweis fehlt:

- EAS-Projekt und Produktionssignierung mit verifiziertem Konto;
- reale Geräteinstallation und Smoke-Test;
- aufgezeichnete Build-ID, SHA-256 und Versionierung;
- Play-Store-Internal-Test oder vergleichbarer kontrollierter Rollout;
- Privacy Policy, Datenverarbeitung, Berechtigungen und Supportkontakt;
- kein Provider-Secret in `EXPO_PUBLIC_*` oder im Bundle.

## Priorität 3: Validierung und Freigabe

Vor einer Live-Freigabe müssen zusätzlich nachgewiesen werden:

- PostgreSQL-Integrations-, Concurrency- und Recovery-Tests;
- Provider-Sandbox-Tests für jede deklarierte Capability;
- Fault-Injection für Timeout, Redirect, Rate Limit, Doppel-Submission und unbekannten Status;
- Approval-Expiry sowie Preis-/Bestandsdrift invalidieren Ausführungen;
- Kill-Switch- und Reconciliation-Tests gegen einen realen Sandbox-Provider;
- Staging-End-to-End-Lauf mit `catalog-staging`, Vision-Worker und Android-Client;
- Security-Review und Threat Model;
- Datenschutz-/Rechtsprüfung für Marktplatz-, Bild- und Zahlungsdaten;
- sign-off durch einen verantwortlichen Administrator für jede Live-Capability.

## Freigabestatus

| Bereich | Status | Live-Blocker |
|---|---|---:|
| Read-only-Katalogscan | vorhanden, Provider-konfigurationsabhängig | Nein für Analyse, ja für fehlende Providerauswahl |
| Isolierter Staging-Provider | vorhanden und getestet | Nein |
| Vision-/LLM-Analyse | implementiert, Deployment/Secrets offen | Ja für produktiven Betrieb |
| Auth/RBAC | implementierte Basis, Hardening offen | Ja |
| Wallet/Ledger | Primitive vorhanden, vollständiger Live-Geldfluss offen | Ja |
| Kauf-/Orderausführung | nicht implementiert | Ja |
| Listing/Settlement | nicht implementiert | Ja |
| Reconciliation-Worker | Sicherheitsprimitive vorhanden, Runtime offen | Ja |
| Persistenter Kill-Switch | offen | Ja |
| Operations-Overview/Monitoring | offen | Ja |
| Android-Produktionsdistribution | offen | Ja |
| Release-Evidence | teilweise vorhanden | Ja |

**Konsequenz:** Bis mindestens die Prior-0- und Prior-1-Komponenten implementiert, integriert getestet und operativ nachgewiesen sind, muss Live-Handel deaktiviert bleiben. Der aktuelle Commit ist ein Readiness-/Staging-Stand, keine Produktionsfreigabe.

## Sprint-21–30-Nachweis

Die Sprints 21–30 haben die vorhandenen read-only/fail-closed Sicherheitsprimitive und ihre Evidence dokumentiert. Fehlende PostgreSQL-, pytest-, Android- und externe Provider-Infrastruktur wurde nicht simuliert; die offenen Nachweise bleiben harte Gates. Siehe [docs/thirty-sprint-release-gate.md](thirty-sprint-release-gate.md).
