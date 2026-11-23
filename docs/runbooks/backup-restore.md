# Runbook: Backup und Restore

Dieses Runbook beschreibt den Backup-/Restore-Drill für die AutonomAgent-PostgreSQL-Datenbank
(`scripts/backup-restore-drill.mjs`) und den manuellen Ablauf eines echten Restores in eine
Staging- oder Produktionsdatenbank.

Der Drill ist ein **Nachweis, dass ein Dump vollständig zurückgespielt werden kann**. Er ist
kein Backup-Konzept: es gibt keinen Zeitplan, keinen Offsite-Speicher, keine Aufbewahrung und
keine Verschlüsselung. Siehe [Grenzen](#grenzen).

## Was der Drill macht

1. `pg_dump --format=custom --no-owner --no-privileges` der über `DATABASE_URL` adressierten
   Datenbank in eine temporäre Datei.
2. Anlegen einer Scratch-Datenbank `<db>_restore_drill_<pid>` auf demselben Server.
3. `pg_restore --no-owner --no-privileges --exit-on-error` des Dumps in die Scratch-Datenbank.
4. Vergleich **Quelle gegen Restore**:
   - dieselbe Tabellenliste im Schema `public`,
   - dieselbe Zeilenzahl pro Tabelle (`count(*)`),
   - dieselbe Liste der angewendeten Migrationen aus `_prisma_migrations`
     (`finished_at IS NOT NULL`, sortiert nach `migration_name`),
   - mindestens eine angewendete Migration in der Quelle.
5. Drop der Scratch-Datenbank und Löschen des temporären Verzeichnisses.
6. JSON-Report auf stdout; Exit `1` bei jeder Abweichung.

Der Drill schreibt **nie** in die Quelldatenbank, restored **nie** über eine bestehende
Datenbank und lässt bei Erfolg und bei Fehlschlag keine Scratch-Datenbank zurück.

## Aufruf

```bash
cd /path/to/Vision

# Lokale Instanz (siehe docs/database-invariants-runbook.md)
scripts/local-postgres.sh
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public"

# Schema muss aktuell sein, sonst ist der Migrationsvergleich wertlos
npx prisma migrate deploy --schema services/api/prisma/schema.prisma

# Zeilen für einen aussagekräftigen Vergleich anlegen (Integrationstests räumen hinter
# sich auf; für den Drill eignen sich Seed-Zeilen oder eine Kopie echter Staging-Daten)
npm run test:db --workspace @autonomagent/api

node scripts/backup-restore-drill.mjs
echo "exit=$?"
```

Optionen (nur Umgebungsvariablen):

| Variable | Bedeutung |
| --- | --- |
| `DATABASE_URL` | Pflicht. `postgresql://` oder `postgres://`. Prisma-Zusätze wie `?schema=public` werden entfernt, bevor die libpq-Werkzeuge aufgerufen werden. |
| `PG_BIN` | Verzeichnis mit `pg_dump`, `psql`, `pg_restore`, `createdb`, `dropdb`. Standard: neueste Version unter `/usr/lib/postgresql/<major>/bin`, sonst `PATH`. |
| `DRILL_KEEP=1` | Scratch-Datenbank und Dump-Datei bleiben erhalten. Der Pfad zum Dump wird ausgegeben. |
| `PGCONNECT_TIMEOUT` | Wird intern auf `10` Sekunden gesetzt. |

Der aufrufende PostgreSQL-Roll benötigt `CREATEDB` (Scratch-Datenbank), Lesezugriff auf alle
Tabellen in `public` und `SELECT` auf `_prisma_migrations`.

### `DRILL_KEEP=1`

Für die Fehlersuche: der Drill bricht die Aufräumarbeit ab, die Scratch-Datenbank
`<db>_restore_drill_<pid>` und die Datei `backup.dump` im gemeldeten
`/tmp/autonomagent-restore-drill-*`-Verzeichnis bleiben stehen. Danach manuell aufräumen:

```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS "autonomagent_test_restore_drill_12345"'
rm -rf /tmp/autonomagent-restore-drill-XXXXXX
```

`DRILL_KEEP=1` niemals in einer Pipeline verwenden, die auf einen sauberen Zustand angewiesen
ist: die Scratch-Datenbank bleibt bestehen und belegt Platz.

## Exit-Codes

| Code | Bedeutung |
| --- | --- |
| `0` | Drill bestanden: Tabellen, Zeilenzahlen und Migrationsliste stimmen überein. |
| `1` | Drill fehlgeschlagen: Abweichung, `pg_dump`/`pg_restore`/`psql`-Fehler oder leerer Dump. Der JSON-Report enthält `status: "FAILED"` und `problems`. |
| `2` | Konfigurationsproblem: `DATABASE_URL` fehlt/ungültig, kein `postgresql://`, kein Datenbankname, unsicherer Scratch-Name oder ein Werkzeug ist nicht ausführbar. |

Der Report wird auch im Fehlerfall geschrieben, damit ein fehlgeschlagener Lauf evidence-fähig
ist. Beispiel:

```json
{
  "database": "autonomagent_test",
  "scratchDatabase": "autonomagent_test_restore_drill_1622",
  "dump": { "bytes": 41237, "sha256": "d326356b32858413…" },
  "tables": 14,
  "rows": 38,
  "migrations": 9,
  "restored": { "tables": 14, "rows": 38, "migrations": 9 },
  "status": "PASSED",
  "problems": [],
  "tableCounts": { "User": 3, "WalletLedger": 4, "_prisma_migrations": 9 }
}
```

`rows` ist die Summe über alle Tabellen in `public` und enthält die Zeilen von
`_prisma_migrations`. Die SHA256 ist die Kennung **dieses** Dump-Artefakts; sie ist nicht
reproduzierbar, weil das Custom-Format den Dump-Zeitpunkt im Header trägt (zwei Dumps derselben
Datenbank unterscheiden sich in genau einem Byte im Header).

## Echter Restore in Staging/Produktion

Der Drill beweist nur, dass ein Dump in eine **neue, leere** Datenbank passt. Ein Restore über
eine laufende Datenbank ist ein eigener, riskanter Vorgang:

1. **Entscheidung und Fenster:** Restore nur mit ausdrücklicher Freigabe und angekündigtem
   Wartungsfenster. Ziel-Datenbank und Aufbewahrung des aktuellen Zustands vorher festlegen.
2. **Schreibzugriffe stoppen:** API und Worker herunterfahren, damit keine Verbindung mehr
   schreibt. Bei mehreren Instanzen zuerst den Lastverteiler aus dem Verkehr nehmen.
   ```bash
   # je nach Deployment, z. B.:
   systemctl stop autonomagent-api autonomagent-api-worker
   ```
   Prüfen, dass keine Sitzung der Zieldatenbank mehr aktiv ist:
   ```bash
   psql "$TARGET_URL" -c "SELECT pid, application_name, state FROM pg_stat_activity WHERE datname = current_database()"
   ```
3. **Sicherung des Ist-Zustands** (Rollback-Pfad), bevor irgendetwas ersetzt wird:
   ```bash
   pg_dump --format=custom --no-owner --no-privileges --file rollback-$(date -u +%Y%m%dT%H%M%SZ).dump "$TARGET_URL"
   ```
   Diese Datei außerhalb des Servers ablegen, sonst ist der Rollback vom selben Ausfall betroffen.
4. **Neue Datenbank anlegen** statt über die alte zu restoren. Eine leere Datenbank macht
   Teilstände sichtbar und lässt die alte Datenbank als Rückfall liegen:
   ```bash
   createdb --maintenance-db postgres autonomagent_prod_restore
   ```
5. **Restore ohne Owner- und Rechteübernahme:**
   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname autonomagent_prod_restore backup.dump
   ```
   `--exit-on-error` ist Pflicht: ohne diese Option meldet `pg_restore` Fehler, endet aber mit
   Exit `0`, und ein halber Restore sähe wie ein Erfolg aus.
6. **Migrationen prüfen** (nichts anwenden, was nicht erwartet ist):
   ```bash
   DATABASE_URL="postgresql://…/autonomagent_prod_restore" \
     npx prisma migrate status --schema services/api/prisma/schema.prisma
   ```
   Erwartung: „Database schema is up to date“. Weicht die Liste ab, den Restore wiederholen –
   nicht mit `migrate deploy` über eine unklare Differenz hinweggehen. `prisma migrate reset`
   ist auf dieser Datenbank verboten.
7. **Rollen, Grants, Erweiterungen:** `--no-owner --no-privileges` stellt keine Eigentümer und
   Grants wieder her. Die Anwendungsrolle muss nach dem Restore erneut die nötigen Rechte
   erhalten (`GRANT … ON ALL TABLES/SEQUENCES`), sonst scheitert die API beim ersten Zugriff.
   Erweiterungen müssen auf dem Zielserver installiert sein.
8. **Umschalten:** `DATABASE_URL` der API und des Workers auf die neue Datenbank zeigen lassen,
   Dienste starten, dann Healthcheck:
   ```bash
   curl -fsS "$API_URL/health" && curl -fsS "$API_URL/ready"
   ```
   `/ready` prüft die Datenbankverbindung; erst danach Traffic freigeben.
9. **Fachlicher Smoke-Test:** Login, eine Deal-Scan-Anfrage, eine Vision-Analyse, Outbox-Rückstand
   (`SELECT status, count(*) FROM "OutboxEvent" GROUP BY status`) und der Metrics-Endpunkt.
   Der Outbox-Rückstand ist nach einem Restore erwartbar nicht leer – der Worker arbeitet ihn ab;
   `DEAD_LETTER > 0` ist ein Befund, kein Normalzustand.
10. **Aufräumen:** alte Datenbank erst nach dem vereinbarten Beobachtungsfenster löschen. Bis
    dahin ist sie der Rollback.

Der Drill ersetzt **keines** dieser Schritte und ist kein Produktionsfreigabe-Nachweis.

## Grenzen

- **Kein PITR:** es gibt kein WAL-Archiving und kein Point-in-Time-Recovery. Ein Restore endet
  auf dem Stand des Dumps; alles danach ist verloren.
- **Kein Offsite-Storage, keine Aufbewahrung, kein Zeitplan:** der Drill legt den Dump in einem
  temporären Verzeichnis ab und löscht ihn wieder. Es existiert kein Backup-Rotations- oder
  Aufbewahrungskonzept in diesem Repository.
- **Kein Verschlüsselungsnachweis:** weder Dump-Datei noch Transport sind verschlüsselt; es wird
  nicht geprüft, ob der Speicher verschlüsselt ist.
- **Keine Integritätsprüfung pro Zeile:** verglichen werden Zeilenzahlen, nicht Inhalte. Eine
  vertauschte Zeile mit gleicher Anzahl fällt nicht auf.
- **Nur Schema `public`:** Tabellen in anderen Schemas werden nicht gezählt.
- **Nur ein Dump-Typ:** geprüft wird ausschließlich `pg_dump --format=custom`, keine
  logischen/inkrementellen oder Fremdwerkzeug-Backups.
- **Restore-Dauer wird nicht gemessen:** der Drill protokolliert nur Start- und Endzeitpunkt,
  keine Zielvorgabe (RTO) und keinen Durchsatz.
- **Gleicher Server, gleiche Instanz:** die Scratch-Datenbank liegt auf demselben Cluster. Ein
  Festplatten- oder Clusterausfall ist damit nicht abgedeckt.
- **Keine Aussage über Datenqualität:** der Drill prüft nicht, ob die Quelldaten fachlich
  korrekt sind.
