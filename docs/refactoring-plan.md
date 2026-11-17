# Refactoring-Plan: Review-Befunde beheben

**Stand:** 17. November 2026<br>
**Geltungsbereich:** die sechs priorisierten Codebefunde aus dem Review einschließlich npm-Abhängigkeitsschwachstellen.<br>
**Sicherheitsvorgabe:** PAPER bleibt Standard; LIVE-Trading bleibt deaktiviert. Dieser Plan ist keine Freigabe zur Aktivierung realer Käufe.

## Zielbild und Reihenfolge

Die Reihenfolge priorisiert Datenintegrität und finanzielle Sicherheit vor Komfort- und Wartbarkeitsverbesserungen:

1. Regressionstests und Schutzmaßnahmen für Reservierungsfreigaben.
2. Korrekte Task-Retry- und Lease-Endzustände.
3. Verwundbare bzw. nicht reproduzierbar aufgelöste Abhängigkeiten beheben.
4. TypeScript-Workspace-Grenzen reparieren, damit CI die tatsächlichen Projektgrenzen prüft.
5. Polling-Listener-Leak beseitigen.
6. Idempotenzvergleich auf kanonische Nutzdaten umstellen.

Ein Befund gilt erst als geschlossen, wenn der Regressionstest fehlschlägt, wenn die alte Implementierung eingesetzt wird, mit der Korrektur erfolgreich ist und — wo Datenbankverhalten betroffen ist — gegen PostgreSQL läuft. Tests mit selbst nachgebauter Prüf-Logik reichen dafür nicht aus.

---

## 1. Wallet: Freigaben an ihre Ursprungsreservierung binden

**Priorität:** P0 – finanzielle Integrität<br>
**Betroffene Stelle:** `services/api/src/wallet-service.ts`, insbesondere `releaseFunds`; Datenmodell in `services/api/prisma/schema.prisma`.

### Problem und gewünschtes Verhalten

Die aktuelle Freigabe prüft, ob die ursprüngliche Reservierung existiert und ob das Konto insgesamt genügend reservierte Mittel hält. Sie summiert jedoch nicht die bereits für genau diese Reservierung gebuchten Freigaben. Bei mehreren Reservierungen desselben Kontos kann so eine zweite Freigabe für Reservierung A Mittel von Reservierung B abbauen.

Eine Freigabe muss eindeutig auf eine Ursprungsreservierung verweisen. Die Summe aller Freigaben für diese Reservierung darf deren ursprünglichen Betrag nicht überschreiten. Wiederholungen mit derselben Freigabe-Referenz und derselben Nutzlast müssen idempotent sein; dieselbe Referenz mit anderer Nutzlast muss einen Konflikt liefern.

### Umsetzungsschritte

1. Fachregel festlegen: unterstützt das System nur vollständige Freigaben oder auch Teilfreigaben? Die API und Tests müssen diese Entscheidung explizit abbilden. Teilfreigaben sind nur zulässig, wenn der verbleibende Betrag nachvollziehbar berechnet wird. Umgesetzt wird zunächst nur die vollständige Freigabe; Teilfreigaben bleiben fail-closed abgelehnt.
2. Eine explizite Quellbeziehung zwischen Freigabe und Reservierung einführen, beispielsweise ein Feld `reservationReferenceId` mit Index/Fremdschlüssel-ähnlicher Integritätsprüfung oder ein eigenes Reservierungsaggregat. Die existierende eindeutige `referenceId` für einzelne Buchungen beibehalten.
3. Innerhalb derselben Transaktion und unter der Kontosperre die bereits gebuchte Freigabesumme für die Ursprungsreservierung ermitteln. Vor einer neuen Buchung prüfen: `bisherFreigegeben + neueFreigabe <= ursprünglicheReservierung`.
4. Prüfen, dass Referenz, Konto, Typ und Betrag der Ursprungsreservierung zusammenpassen. Fremde oder ungültige Referenzen fail-closed zurückweisen.
5. Idempotenz zuerst anhand der Freigabe-Referenz prüfen; eine identische Wiederholung darf keine zweite Kontobewegung verursachen.
6. Migration mit konsistentem Verhalten für bestehende Ledger-Zeilen definieren. Falls sich vorhandene Freigaben nicht verlässlich einer Reservierung zuordnen lassen, die Migration nicht stillschweigend raten lassen: Datenbestand vor Produktivmigration inventarisieren und manuelle Zuordnung bzw. kontrollierte Backfill-Strategie dokumentieren.
7. Langfristig die in den Release-Gates geforderte Unveränderlichkeit des Ledgers auch auf Datenbankebene absichern (nur INSERT erlauben bzw. Änderungen/Löschungen per DB-Rechten oder Trigger verhindern). Das ist eine angrenzende Härtung, nicht der Ersatz für die Quellreservierungsprüfung.

### Tests und Abnahme

- Eine Reservierung vollständig freigeben; Kontostand und reservierter Betrag stimmen.
- Gleiche Freigabe-Referenz und gleicher Inhalt erneut senden; Zustand bleibt unverändert.
- Gleiche Freigabe-Referenz mit anderem Betrag/Konto erneut senden; Konflikt.
- Zwei Reservierungen auf einem Konto anlegen; Reservierung A freigeben und anschließend A mit neuer Referenz nochmals freizugeben versuchen. Die zweite Freigabe muss abgelehnt werden, auch wenn Reservierung B noch genügend Mittel hält.
- Teilfreigaben (falls zugelassen): mehrere Freigaben bis zum Gesamtbetrag erlauben; ein Cent darüber ablehnen.
- Zwei konkurrierende Freigaben für dieselbe Ursprungsreservierung gegen PostgreSQL ausführen; keine Überschreitung darf möglich sein.
- Ledger-Buchungen und Kontosummen nach jedem Fall gegen eine unabhängige Testfunktion abstimmen.

**Abnahmekriterium:** Für jede Reservierung gilt jederzeit `Summe(Freigaben) <= Reservierungsbetrag`; eine andere Reservierung kann nicht versehentlich freigegeben werden. Bestehende Release-Gates für konkurrierende Reservierungen bleiben bestanden.

---

## 2. Agent-Aufgaben: Retries und ausgeschöpfte Leases eindeutig behandeln

**Priorität:** P0 – zuverlässige Verarbeitung und kein dauerhaft falscher Status<br>
**Betroffene Stellen:** `services/api/src/agent-task-service.ts`, `services/api/src/agent-orchestrator.ts`, `services/api/prisma/schema.prisma`.

### Problem und gewünschtes Verhalten

`failAgentTask` markiert jeden Handlerfehler sofort als `FAILED`, selbst wenn noch `maxAttempts` übrig sind. Umgekehrt können Worker-Abstürze die Versuche aufbrauchen, während ein abgelaufener Task im Status `RUNNING` verbleibt und danach nicht mehr übernommen wird. Das ergibt weder einen echten Retry-Ablauf noch einen eindeutigen Terminalzustand.

Jeder Fehler muss nachvollziehbar zu genau einem Ergebnis führen: erneuter Versuch nach einer definierten Verzögerung oder terminales `FAILED`. Abgebrochene/abgelaufene Leases müssen bei ausgeschöpftem Versuchslimit ebenfalls terminalisiert werden.

### Umsetzungsschritte

1. Zustandsautomat dokumentieren und als Übergangstabelle festhalten: `QUEUED -> RUNNING`, `RUNNING -> CHECKPOINTED`, `RUNNING -> QUEUED` bei retrybarem Fehler, `RUNNING -> FAILED` bei nicht retrybarem oder ausgeschöpftem Fehler, `QUEUED/CHECKPOINTED -> CANCELLED` nach autorisiertem Abbruch und `RUNNING -> SUCCEEDED` bei Erfolg.
2. Die Semantik von `attempt` verbindlich definieren (z. B. bei erfolgreichem Claim inkrementieren) und an einer Stelle erzwingen. `maxAttempts` gilt dann gleichermaßen für Handlerfehler und Worker-Abstürze.
3. Retry-Zustand speichern. Vorzugsweise `availableAt`/`nextAttemptAt` und optional einen Fehlerklassifikator zum Modell hinzufügen; andernfalls den vorhandenen Status so erweitern, dass ein Retry nach Backoff eindeutig geplant werden kann. `finishedAt` nur bei Terminalzuständen setzen.
4. `failAgentTask` in eine atomare Operation umgestalten: unter gültiger Worker-Lease und Fencing-Token entweder Fehler protokollieren und auf einen retryfähigen Status mit Backoff setzen oder terminal `FAILED` markieren. Outbox-Ereignis und Zustandsänderung müssen in derselben Transaktion erfolgen.
5. Ein Recovery-Verfahren für abgelaufene Leases implementieren. Wenn Versuche übrig sind, Task für den nächsten Versuch einplanen; wenn keine Versuche übrig sind, auf `FAILED` setzen, Fehlergrund festhalten und ein Terminalereignis ausgeben.
6. `listClaimableTaskIds` so ändern, dass nur tatsächlich fällige Retry-Tasks geliefert werden und die Grenze `maxAttempts` in der Datenbankabfrage konsistent berücksichtigt wird. Ein Scheduler darf erschöpfte `RUNNING`-Tasks nicht unbegrenzt ignorieren.
7. Handler-Aufrufe mit externen Seiteneffekten müssen eigene Idempotenzschlüssel verwenden; ein Task-Retry allein garantiert keine Exactly-once-Ausführung.
8. Optional eine kleine, explizite Retry-Klassifikation einführen (transient/retryable vs. permanent). Standardverhalten für unbekannte Fehler sicher definieren, nicht stillschweigend unbegrenzt retryen.

### Tests und Abnahme

- Retrybarer Handlerfehler beim ersten Versuch: Task wird erneut eingeplant, erhält Backoff und wird anschließend erfolgreich abgeschlossen.
- Permanenter Fehler: Task wird unmittelbar terminal `FAILED`.
- Fehler beim letzten erlaubten Versuch: terminal `FAILED`; kein weiterer Claim.
- Worker-Absturz vor Erfolg mit gültigen weiteren Versuchen: nach Lease-Ablauf erneut claimbar.
- Worker-Absturz beim letzten Versuch: nach Lease-Ablauf automatisch terminalisiert, nicht dauerhaft `RUNNING`.
- Veralteter Worker kann nach Lease-Verlust weder checkpointen noch abschließen noch den Taskstatus zurücksetzen.
- Konkurrenztest mit mehreren Workern: höchstens ein aktiver Claim pro Task/Fencing-Token.
- Ereignis-Assertions: Start, Retry/Fehler und terminale Zustände werden pro Transaktion konsistent emittiert.

**Abnahmekriterium:** Kein Task bleibt nach Lease-Ablauf und ausgeschöpften Versuchen dauerhaft `RUNNING`; retrybare Fehler nutzen höchstens `maxAttempts`; nicht retrybare Fehler bleiben terminal.

---

## 3. npm-Schwachstellen und reproduzierbare Abhängigkeiten beheben

**Priorität:** P1 – Supply-Chain-Sicherheit<br>
**Betroffene Dateien:** Root- und Workspace-`package.json`; neues Root-`package-lock.json`; CI-Konfiguration, falls vorhanden.

### Ausgangslage

Der Review-Audit des installierten Abhängigkeitsbaums meldete 19 Befunde (12 moderat, 5 hoch, 2 kritisch). Die kritischen Befunde betrafen `vitest`/`tinypool`; hohe Befunde betrafen unter anderem `prisma` und transitive Pakete wie `deepmerge-ts`, `image-size` und `postcss`. Es liegt aktuell kein Lockfile im Repository, daher sind installierte Versionen nicht reproduzierbar fixiert. Die gemeldete Versionsempfehlung des Audits ist ein Ausgangspunkt, keine pauschale Freigabe für ungeprüfte Major-Upgrades.

### Umsetzungsschritte

1. Vor Änderungen aktuellen Stand sichern: `npm ls --all`, `npm audit --json`, Node-/npm-Version und die aufgelösten Versionen der betroffenen Pakete als Review-Artefakt erfassen.
2. Ein Root-`package-lock.json` erzeugen und committen. CI und lokale Anleitungen müssen danach `npm ci` statt einer ungebundenen Neuauflösung verwenden.
3. Für jede kritische/hohe Abhängigkeit den tatsächlichen Pfad mit `npm explain <paket>` feststellen und zuerst direkte Ursachen beheben. `npm audit fix --dry-run` zur Planung verwenden; `npm audit fix --force` nicht als Standardweg einsetzen.
4. `vitest` auf eine vom aktuellen Audit nicht verwundbare Version aktualisieren. Der vorliegende Audit nennt einen Major-Sprung als Fix; deshalb Changelog-/Kompatibilitätsprüfung durchführen und alle Tests nach dem Upgrade ausführen. `tinypool` nicht isoliert erzwingen, wenn es von Vitest verwaltet wird.
5. `prisma` CLI und `@prisma/client` gemeinsam auf zueinander passende gepatchte stabile Versionen aktualisieren. Prisma Client danach neu generieren, Schema validieren, Typprüfung und DB-Integrationstests ausführen.
6. Transitive Expo-/Metro-Abhängigkeiten (u. a. `postcss`, `image-size`, `glob`, `minimatch`) über kompatible direkte Eltern aktualisieren. Expo-SDK-/React-Native-Peer-Abhängigkeiten beachten; nicht einem Audit-Hinweis folgen, der eine inkompatible Expo-Version erzwingt. Nach Paketänderungen `npx expo install --check` bzw. die für das Repository passende Expo-Kompatibilitätsprüfung ausführen.
7. Eine kurze Security-Ausnahme dokumentieren, falls ein moderater Befund technisch nicht kurzfristig behebbar ist: Paket/Pfad, Auswirkung, Grund, kompensierende Maßnahmen, verantwortliche Person und Ablaufdatum. Kritische und hohe Befunde benötigen vor Merge eine genehmigte Ausnahme; Ziel ist, solche offenen Befunde zu vermeiden.
8. CI-Gates ergänzen: `npm ci`, `npm test`, `npm run typecheck`, `npm audit --audit-level=high` sowie Prisma-Validierung. Audit-Schwelle und dokumentierte Ausnahmen so abstimmen, dass neue kritische/hohe Befunde zuverlässig blockieren.

### Tests und Abnahme

- Frische Installation mit `npm ci` auf unterstützter Node-Version reproduzierbar erfolgreich.
- `npm ls` zeigt keine unerwarteten doppelten oder ungültigen Peer-Abhängigkeiten.
- `npm audit` nach Lockfile-Auflösung erneut ausführen; Ziel: 0 kritische und 0 hohe Befunde. Moderates verbleibendes Risiko ist dokumentiert und zeitlich begrenzt.
- Alle API-/Mobile-Tests, Typprüfungen, Prisma-Generierung und Schema-Validierung laufen nach Updates erfolgreich.
- Android-/Expo-Bundling wird mindestens als CI-Build oder reproduzierbarer Smoke-Test geprüft, da Expo-Transitivupdates die Mobile-Buildkette betreffen.

**Abnahmekriterium:** Gepinnte, reproduzierbare Abhängigkeiten; keine offenen kritischen/hohen Auditbefunde ohne ausdrücklich genehmigte, befristete Ausnahme; alle Funktionstests nach Upgrades erfolgreich.

### Ergebnis der durchgeführten npm-Updates (17.11.2026)

- `vitest` wurde auf 4.1.12 aktualisiert; der Root-Lockfile wurde angelegt und eine frische Installation mit npm 11 (`npm ci`) war erfolgreich.
- Die Overrides für `deepmerge-ts`, `image-size` und `postcss` beseitigten die zuvor gemeldeten kritischen/hohen Befunde; der aktuelle Audit meldet 0 kritische und 0 hohe, aber noch 11 moderate Befunde.
- Die verbliebenen moderaten Advisory-Pfade liegen in der Expo-54-CLI/Toolchain, darunter `glob` und `minimatch`. Der Audit bietet keine SDK-54-kompatible Korrektur für alle Pakete an und schlägt teils inkompatible Expo-Majorversionen vor. Diese wurden nicht erzwungen. Vor einem Produktionsrelease ist die Restliste erneut zu prüfen und mit verantwortlicher Person sowie Ablaufdatum zu triagieren; hier ist keine formelle Risikoausnahme freigegeben.
- `npx expo install --check` identifizierte `react-native@0.81.5` als SDK-54-kompatible Patchversion; das Update wurde in Manifest und Lockfile übernommen.

---

## 4. TypeScript-Workspace-Grenzen sauber definieren

**Priorität:** P1 – Build-/CI-Zuverlässigkeit<br>
**Betroffene Dateien:** `services/api/tsconfig.json`, `services/api/src/wallet-service.test.ts`, `packages/trading-core/package.json`; ergänzend neue Paket-`tsconfig`/Exports.

### Problem und gewünschtes Verhalten

Der API-Typecheck umfasst Tests unter `services/api/src`, aber einer dieser Tests importiert Trading-Core-Quellcode außerhalb des festgelegten `rootDir: "src"`. Der Typecheck scheitert daher mit TS6059. `rootDir` einfach auf den Repository-Stamm auszuweiten würde die Paketgrenze verwischen und kann unerwünschte Verzeichnisstrukturen im Build erzeugen.

### Umsetzungsschritte

1. `packages/trading-core` als tatsächliches TypeScript-Workspace-Paket definieren: eigener Build, Ausgabe nach `dist`, `types`/`exports` auf gebaute Artefakte und passende `files`-/Publish-Einstellung.
2. `services/api` als Workspace-Abhängigkeit zu `@autonomagent/trading-core` deklarieren. Quellcode und Tests importieren anschließend den Paketnamen statt eines relativen Pfads in ein anderes Workspace-Verzeichnis.
3. Build-Reihenfolge festlegen: Trading-Core vor API bauen, vorzugsweise mit TypeScript-Projekt-Referenzen oder expliziten Workspace-Build-Skripten. Root-Skripte in abhängiger Reihenfolge ausführen.
4. Typecheck- und Build-Konfigurationen trennen, falls nötig: Produktionsbuild (`src`, `rootDir: src`, kein Testcode im API-`dist`) und Test-Typecheck mit eigener Konfiguration. Tests dennoch typprüfen; nicht lediglich aus der gesamten Prüfung ausschließen.
5. Im Trading-Core einen echten Testlauf einrichten. Das aktuelle `test`-Skript, das nur „No tests added yet“ ausgibt, durch reale Unit-Tests oder einen zutreffenden, dokumentierten Status ersetzen.

### Tests und Abnahme

- Root-`npm run typecheck` prüft Mobile, Trading-Core, API und Tests erfolgreich.
- API-Build erzeugt keine Dateien aus benachbarten Workspaces im falschen Zielverzeichnis.
- `npm test` enthält echte Tests für Trading-Core; es gibt kein erfolgreiches Schein-Testskript mehr.
- Frische Installation mit `npm ci` plus Workspace-Buildreihenfolge funktioniert ohne vorherige manuelle Prisma- oder TypeScript-Schritte, sofern diese nicht als explizite Build-Schritte dokumentiert sind.

**Abnahmekriterium:** Der gesamte Typecheck ist grün, ohne `rootDir`-Workaround, der die Paketgrenzen aufweicht.

---

## 5. Abort-Listener im Orchestrator-Polling korrekt aufräumen

**Priorität:** P2 – Langzeitstabilität<br>
**Betroffene Stelle:** `services/api/src/agent-orchestrator.ts`, Polling-Warteblock in `runAgentOrchestrator`.

### Problem und gewünschtes Verhalten

Für jedes Poll-Intervall wird ein einmaliger `abort`-Listener angehängt. Läuft der Timeout normal ab, bleibt dieser Listener bis zu einem späteren Abbruch registriert. Bei einem dauerhaft leeren Queue-Worker wächst dadurch die Zahl gebundener Listener unnötig an.

### Umsetzungsschritte

1. Den Inline-`Promise`-Block in eine kleine, einzeln testbare Funktion (z. B. `sleepUntilAbort`) auslagern.
2. Die Funktion muss Timeout und Abort sauber konkurrieren lassen, nur einmal auflösen und beim Timeout den Abort-Listener entfernen.
3. Beim Abort den Timeout löschen und ebenfalls den Listener entfernen; bereits abgebrochene Signale vor dem Registrieren korrekt behandeln.
4. Prüfen, dass die Loop nach Abort keine neuen DB-Abfragen mehr startet und aktive Handler weiterhin ihr Signal erhalten.

### Tests und Abnahme

- Normales Timeout löst einmal auf und entfernt den registrierten Listener.
- Abort vor Ablauf beendet die Wartezeit sofort und räumt den Timeout auf.
- Bereits abgebrochenes Signal führt nicht zu einer zusätzlichen Wartezeit.
- Wiederholte Polls erzeugen keine wachsende Listenerzahl; bei Testbarkeit Listener-Registrierung/-Entfernung mit Mock kontrollieren.

**Abnahmekriterium:** Pro Wartezyklus ist die Zahl der aktiven Abort-Listener nach Timeout und nach Abbruch wieder auf dem Ausgangswert.

---

## 6. Idempotenz für Agent-Tasks anhand kanonischer Nutzdaten prüfen

**Priorität:** P2 – korrekte Wiederholungen bei stabilen Idempotency Keys<br>
**Betroffene Stelle:** `services/api/src/agent-task-service.ts`, `createAgentTask`.

### Problem und gewünschtes Verhalten

Der aktuelle Vergleich mit `JSON.stringify` ist von der Einfügereihenfolge der Objektfelder abhängig. Zwei semantisch gleiche JSON-Objekte können mit demselben Idempotency Key fälschlich als Konflikt abgelehnt werden. Umgekehrt muss eine tatsächliche Änderung der fachlich relevanten Nutzlast weiterhin als Konflikt gelten.

### Umsetzungsschritte

1. Definition des Idempotenzvertrags dokumentieren: Owner, Task-Typ, `maxAttempts` und Input bilden die fachliche Anfrage; `correlationId` ist nur Telemetrie und bleibt aus dem Vergleich ausgeschlossen.
2. JSON-Objekte deterministisch kanonisieren: Objekt-Schlüssel rekursiv sortieren, Array-Reihenfolge erhalten, JSON-Typen gemäß Schema behandeln. Keine implizite `JSON.stringify`-Abhängigkeit von Schlüsselreihenfolge lassen.
3. Für den Vergleich einen stabilen kryptografischen Hash aus der kanonischen Repräsentation bilden und diesen entweder mit dem Task speichern oder beim Lesen berechnen. Keine Geheimnisse oder vollständigen Nutzdaten in Logs ausgeben.
4. Bestehende Tasks ohne Hash kompatibel behandeln (bei Vergleich einmalig aus dem gespeicherten JSON ableiten). Neue Tasks speichern den SHA-256-Hash; das Feld bleibt während des Übergangs nullable. Bei einer Formatänderung müssen gespeicherte Werte neu bewertet bzw. migriert werden.
5. Gleichzeitig die Race-Condition bei zwei zeitgleichen `createAgentTask`-Aufrufen mit demselben neuen Schlüssel absichern: Unique-Constraint-Konflikt kontrolliert behandeln, Datensatz erneut lesen und denselben Identitätsvergleich durchführen. Serialization-/Unique-Konflikte nicht als zufälligen generischen Fehler stehen lassen.

### Tests und Abnahme

- Gleiche JSON-Nutzdaten mit anderer Schlüsselreihenfolge und gleichem Key liefern denselben Task zurück.
- Geänderte Werte, fehlende Felder oder anderer Task-Typ erzeugen einen Idempotenzkonflikt.
- Arrays mit unterschiedlicher Reihenfolge bleiben unterschiedliche Nutzdaten.
- Verschachtelte Objekte werden rekursiv kanonisiert.
- Parallele erstmalige Aufrufe mit demselben Schlüssel erzeugen genau einen Task und einen `agent.task.created`-Outbox-Eintrag.
- Für Schema-ungültige Werte, `undefined` oder Nicht-JSON-Werte ist das Verhalten ausdrücklich abgelehnt bzw. validiert, nicht zufällig.

**Abnahmekriterium:** Gleiche fachliche JSON-Anfrage ist unabhängig von Objekt-Schlüsselreihenfolge idempotent; echte Payload-Abweichungen und parallele Erstaufrufe sind deterministisch behandelt.

**Umsetzung:** Objekt-Schlüssel werden rekursiv lexikografisch sortiert, Array-Reihenfolge bleibt erhalten, nicht JSON-kompatible Werte werden abgelehnt. Der Hash ist SHA-256 über UTF-8-kodiertes `JSON.stringify` der kanonischen Objektform. `maxAttempts` ist Teil der Anfrage, `correlationId` nicht. Der Unique-Constraint bleibt die letzte Race-Schranke; ein Unique-Konflikt führt zum Nachlesen und zum selben fachlichen Vergleich. Bestehende Zeilen ohne Hash werden bei Bedarf gehasht.

---

## Gemeinsame CI- und Release-Abnahme

Nach Umsetzung aller sechs Punkte muss die Pipeline mindestens folgende Schritte in einer frischen, lockfile-basierten Umgebung ausführen:

1. `npm ci`
2. Prisma Client generieren und `prisma validate` mit einer syntaktisch gültigen Test-`DATABASE_URL` ausführen
3. Workspace-Build in definierter Reihenfolge
4. `npm run typecheck`
5. `npm test`
6. PostgreSQL-Integrationstests für Wallet-Konkurrenz, Ledger-Invarianten, Idempotenz und Task-Lease-/Retry-Recovery
7. `npm audit --audit-level=high`
8. Mobile-/Expo-Build- oder Bundling-Smoke-Test

Der Workflow `.github/workflows/ci.yml` setzt die Quellcode-CI-Gates um: frisches `npm ci`, Prisma-Generierung/Validierung/Migration gegen PostgreSQL, API-Build, Workspace-Typechecks, vollständige Tests einschließlich Datenbankintegration, `npm audit --audit-level=high` und Android-Expo-Bundling. Zum Stand dieses Commits bleiben 11 moderate Expo-Toolchain-Advisories; der High/Critical-Schwellenwert blockiert, die Moderates sind jedoch keine formell genehmigte Risikoausnahme. Erneute Audit-Triage ist vor einem Produktionsrelease erforderlich.

Die bestehenden Produktions-Release-Gates in `docs/release-gates.md` bleiben zusätzlich verbindlich. Insbesondere werden Auth/RBAC, doppelte Buchführung, echte Anbieterintegration, Freigaben, Abstimmung unbekannter Kaufzustände und Android-Installationsnachweis nicht durch das Schließen dieser sechs Befunde als erledigt betrachtet. LIVE-Trading bleibt deaktiviert, bis alle relevanten Sicherheits- und Release-Gates separat nachgewiesen sind.
