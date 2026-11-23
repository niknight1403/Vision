# Sprint 38 — Backup-/Restore-Drill

**Nachweis:** `scripts/backup-restore-drill.mjs`, `docs/runbooks/backup-restore.md`, `docs/database-invariants-runbook.md`.

Alle Zahlen unten stammen aus den Läufen in dieser Sandbox (lokale PostgreSQL 15, Datenbank
`autonomagent_test`). Es gibt keine Produktionsdatenbank, keinen Produktions-Restore und keine
Aussage über Produktionsreife.

## Was gebaut wurde

- **`scripts/backup-restore-drill.mjs`** (vorher ungetrackt, jetzt geprüft und korrigiert): `pg_dump`
  im Custom-Format, Anlegen einer Scratch-Datenbank `<db>_restore_drill_<pid>`, `pg_restore`,
  Vergleich von Tabellenliste, Zeilenzahl pro Tabelle und der angewendeten Migrationen aus
  `_prisma_migrations`, Drop der Scratch-Datenbank, JSON-Report, Exit `1` bei Abweichung.
- **Drei echte Fehler im Skript behoben** (siehe „Gefundene und behobene Fehler“).
- **`docs/runbooks/backup-restore.md`**: neuer Betriebsabschnitt „Backup und Restore“ mit Aufruf,
  geprüften Eigenschaften, `DRILL_KEEP=1`, Exit-Codes, dem Ablauf eines echten Restores in eine
  Staging-/Produktionsdatenbank (API und Worker stoppen, `createdb`, `pg_restore --no-owner`,
  `migrate status`/`migrate deploy` prüfen, Rechte, Healthcheck, Smoke-Test, Rollback) und den
  Grenzen.
- **`docs/database-invariants-runbook.md`**: Querverweis auf das neue Runbook.

## Vorgehen

```bash
cd /app/conversations/6b025807a28195ef89c474e7/Vision
bash scripts/local-postgres.sh          # idempotent, Cluster + DB autonomagent_test
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public"
npx prisma migrate deploy --schema services/api/prisma/schema.prisma
# Seed-Zeilen (29 Zeilen in 13 Tabellen, gesamt 38 inkl. _prisma_migrations)
node scripts/backup-restore-drill.mjs
```

`pg_isready -h 127.0.0.1 -p 5432` meldete `accepting connections` (sowohl `/usr/bin` als auch
`/usr/lib/postgresql/15/bin`). `migrate deploy` meldete „9 migrations found“, wandte
`20261122033000_outbox_replay_tracking` an und endete mit „All migrations have been successfully
applied“ (Exit `0`).

**Warum Seed-Zeilen:** `npm run test:db` legt echte Zeilen an, räumt sie aber selbst wieder ab –
nach dem Lauf waren alle Tabellen bis auf `_prisma_migrations` leer (`count(*) = 0`), ein Drill
hätte also nur leere Tabellen verglichen. Deshalb wurden 38 synthetische Zeilen über feste IDs
(`seed_*`) in 13 Tabellen eingefügt (User, RefreshSession, WalletAccount, WalletLedger, OutboxEvent,
IdempotencyKey, AgentTask, DealCandidate, TestnetKillSwitch, ApprovalSnapshot, TestnetOrderIntent,
TestnetOrderEvent, ReconciliationRun). Nach der Evidenzerhebung wurden diese Zeilen wieder
gelöscht; die Datenbank ist auf dem Stand wie vor dem Sprint.

## Positiver Lauf (Drill bestanden)

Aufruf:

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public' \
  node scripts/backup-restore-drill.mjs
```

Output (stdout, unverändert):

```json
{
  "database": "autonomagent_test",
  "scratchDatabase": "autonomagent_test_restore_drill_1622",
  "startedAt": "2026-11-23T03:39:32.208Z",
  "dump": {
    "bytes": 41237,
    "sha256": "d326356b3285841350e6c1acafefc1c101e8c4b1cef6569b772c8664162093ef"
  },
  "tables": 14,
  "rows": 38,
  "migrations": 9,
  "restored": {
    "tables": 14,
    "rows": 38,
    "migrations": 9
  },
  "finishedAt": "2026-11-23T03:39:33.050Z",
  "status": "PASSED",
  "problems": [],
  "tableCounts": {
    "AgentTask": 3,
    "ApprovalSnapshot": 1,
    "DealCandidate": 2,
    "IdempotencyKey": 2,
    "OutboxEvent": 3,
    "ReconciliationRun": 2,
    "RefreshSession": 2,
    "TestnetKillSwitch": 2,
    "TestnetOrderEvent": 1,
    "TestnetOrderIntent": 1,
    "User": 3,
    "WalletAccount": 3,
    "WalletLedger": 4,
    "_prisma_migrations": 9
  }
}
backup-restore-drill: PASSED (14 tables, 38 rows, 9 migrations, dump 41237 bytes sha256 d326356b32858413…)
```

| Kennzahl | Wert |
| --- | --- |
| Exit-Code | **0** |
| Dump-Bytes | 41 237 |
| Dump-SHA256 | `d326356b3285841350e6c1acafefc1c101e8c4b1cef6569b772c8664162093ef` |
| Tabellen (Quelle / Restore) | 14 / 14 |
| Zeilen gesamt (Quelle / Restore) | 38 / 38 |
| Angewendete Migrationen (Quelle / Restore) | 9 / 9 |
| Dauer (Start bis Ende) | ≈ 0,84 s (nur Zeitstempel, keine Zielvorgabe) |
| Scratch-Datenbank danach | gelöscht (`SELECT count(*) FROM pg_database WHERE datname LIKE '%restore_drill%'` → 0) |
| Temp-Verzeichnis danach | entfernt |

`rows` ist die Summe über alle Tabellen in `public` und enthält die 9 Zeilen von
`_prisma_migrations`. Alle 14 Tabellen enthielten Zeilen > 0 (13 Anwendungstabellen plus `_prisma_migrations`),
der Vergleich lief also nicht nur über leere Tabellen.

## Negativer Fall (Drill erkennt Abweichung)

Damit belegt ist, dass der Vergleich tatsächlich anschlägt, wurde ein **deterministischer**
Negativ-Fall gebaut: ein `PG_BIN`-Verzeichnis (`/tmp/drill-negative-bin`) mit Symlinks auf die
echten Werkzeuge, in dem nur `pg_restore` durch ein Wrapper-Skript ersetzt ist. Der Wrapper ruft
das echte `pg_restore` auf und löscht danach **eine** Zeile in der wiederhergestellten
Scratch-Datenbank:

```bash
"$real" "$@" || exit $?
psql -h 127.0.0.1 -U postgres -d "$dbname" -c "DELETE FROM \"DealCandidate\" WHERE id = 'seed_deal_2'"
```

Aufruf und Ergebnis:

```bash
PG_BIN=/tmp/drill-negative-bin DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public' \
  node scripts/backup-restore-drill.mjs
```

```json
{
  "dump": { "bytes": 41238, "sha256": "1e9d2cd44299b14682ba8fd3cb4a9892f8ee18e003b413e9062af3119bec4506" },
  "tables": 14,
  "rows": 38,
  "migrations": 9,
  "restored": { "tables": 14, "rows": 37, "migrations": 9 },
  "status": "FAILED",
  "problems": ["row count mismatch on DealCandidate: source 2, restored 1"]
}
backup-restore-drill: FAILED
 - row count mismatch on DealCandidate: source 2, restored 1
```

| Kennzahl | Wert |
| --- | --- |
| Exit-Code | **1** |
| Zeilen Quelle / Restore | 38 / 37 |
| Meldung | `row count mismatch on DealCandidate: source 2, restored 1` |
| Scratch-Datenbank danach | gelöscht (0 Reste), Temp-Verzeichnis entfernt |

Der Fehlerpfad räumt also genauso auf wie der Erfolgspfad.

Zusätzlich geprüft (Konfigurationsfehler, Exit `2`):

| Aufruf | Exit | Meldung |
| --- | --- | --- |
| ohne `DATABASE_URL` | 2 | `DATABASE_URL is required; no restore evidence claimed.` |
| `DATABASE_URL=mysql://x/y` | 2 | `DATABASE_URL must use postgresql:// or postgres://.` |
| `PG_BIN=/tmp/empty-pgbin` (kein `pg_dump`) | 2 | Report mit `cannot run /tmp/empty-pgbin/pg_dump: spawnSync … ENOENT` |

`DRILL_KEEP=1` wurde ebenfalls ausgeführt: der Lauf endete mit Exit `0` und meldete
`kept /tmp/autonomagent-restore-drill-wszKUV/backup.dump and autonomagent_test_restore_drill_1178`;
Dump-Datei (41 240 Bytes) und Scratch-Datenbank waren danach vorhanden und wurden manuell wieder
entfernt.

## Gefundene und behobene Fehler im Skript

1. **`?schema=public` brach `pg_dump` ab.** Der Prisma-Zusatz wurde als Teil der Verbindungs-URI an
   libpq gegeben: `pg_dump: error: invalid URI query parameter: "schema"`, Exit `1`. Jetzt werden
   Host, Port, Benutzer und Passwort aus der URL zerlegt, die Query-Parameter verworfen
   (`?schema=` ist ein reines Prisma-Konzept) und das Passwort ausschließlich über `PGPASSWORD`
   übergeben – es erscheint nie in `argv` oder im Report.
2. **`createdb`, `dropdb` und `pg_restore` bekamen nur einen nackten Datenbanknamen.** Damit
   verbanden sie sich über den Unix-Socket: `connection to server on socket
   "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory`. Ein URI als
   positionelles Argument wurde von `createdb` zusätzlich als Datenbankname interpretiert
   (`unrecognized option '--dbname'`). Jetzt gehen `--host/--port/--username` explizit mit;
   `createdb`/`dropdb` bekommen den Zielnamen positionell und `--maintenance-db <quelle>`.
3. **Fehlerpfad verschluckte Report und Aufräumen.** `run()` rief `process.exit()`, damit liefen
   weder `finally`-Cleanup noch JSON-Report; ein Temp-Verzeichnis blieb liegen
   (`/tmp/autonomagent-restore-drill-U1brk3` aus dem allerersten Lauf). Jetzt wirft `run()` eine
   `DrillFailure` mit Exit-Code, der Report wird immer geschrieben, `cleanup()` läuft immer, und
   Exit `2` bleibt für Konfigurations-/Werkzeugprobleme reserviert.

Ergänzt wurde außerdem `restored: { tables, rows, migrations }` im Report, damit Quelle und
Restore im selben Artefakt vergleichbar sind.

## Beobachtung zur Reproduzierbarkeit der SHA256

Die Dump-SHA256 ist die Kennung **eines** Artefakts, nicht eines Datenbankinhalts. Zwei Dumps
derselben unveränderten Datenbank direkt hintereinander ergaben identische Größe (41 296 Bytes),
aber unterschiedliche Hashes (`6f0883dc…` und `5bfd96e2…`); `cmp -l` zeigte **genau ein**
abweichendes Byte, an Offset 18 – das ist das Sekundenfeld des Dump-Zeitstempels im
Custom-Format-Header. Bei unterschiedlich geseedeten Läufen schwankt zusätzlich die Größe um
wenige Bytes (41 237 / 41 238 / 41 240), weil die Zeilen-Zeitstempel aus `now()` stammen und
dadurch anders komprimieren. Ein Hash-Vergleich über Läufe hinweg ist deshalb kein sinnvoller
Test; verglichen werden Tabellen, Zeilenzahlen und Migrationen.

## Checks

- `npm test --workspace @autonomagent/api` → **112 Unit-Tests, 23 Dateien, Exit 0**.
- `npm run test:db --workspace @autonomagent/api` → **6 Integrationsdateien, 33 Integrationstests,
  37 Tests gesamt, 0 skipped, Exit 0** (`PostgreSQL integration gate passed`).
- Drill positiv → Exit `0`, negativ → Exit `1`, Konfigurationsfehler → Exit `2` (siehe oben).
- Keine Testdatei gelöscht, kein Test geskippt, keine Testkonfiguration geändert.

**Nebenbefund (nicht Sprint 38):** der erste `npm run test:db`-Lauf auf der frisch migrierten
Datenbank hatte einen fehlschlagenden Test (`outbox operations > fails the handler when its lease
was taken over (fencing)`, erwartete `OUTBOX_LEASE_LOST`, bekam `PUBLISHED`). Nach dem Bereinigen
der Datenbank liefen 37/37 grün, mehrfach. Die Outbox-Integrationstests greifen global auf die
älteste verfügbare `PENDING`-Zeile zu; fremde Zeilen in derselben Datenbank – auch die
Drill-Seeds – können sie brechen (ein Seed wurde von `processOneOutboxMessage` tatsächlich
verarbeitet: `attempts` 1, `lastError` gesetzt). Deshalb: Drill-Seeds nach dem Lauf entfernen oder
eine eigene Datenbank für den Drill verwenden. Am API-Code wurde in diesem Sprint nichts geändert.

## Grenzen

- **Kein PITR:** kein WAL-Archiving, kein Point-in-Time-Recovery; der wiederhergestellte Stand ist
  der Stand des Dumps.
- **Kein Offsite-Storage, kein Zeitplan, keine Aufbewahrung:** der Drill legt den Dump in
  `/tmp` ab und löscht ihn wieder. Es existiert kein Backup-Konzept im Repository.
- **Keine Verschlüsselung geprüft:** weder Dump-Datei noch Transport sind verschlüsselt, und es
  wird nicht geprüft, ob der Ablageort verschlüsselt ist.
- **Restore-Dauer nicht gemessen:** nur Start-/End-Zeitstempel, kein RTO, kein Durchsatz, keine
  Messung unter Last oder mit produktionsgroßer Datenbank (38 Zeilen, 41 KB).
- **Nur Zeilenzahlen, keine Inhalte:** eine vertauschte Zeile mit gleicher Anzahl fällt nicht auf.
- **Nur Schema `public`**, nur `pg_dump --format=custom`, gleicher Server/Cluster (kein Ausfall-
  oder Netzwerkszenario).
- **Kein Produktions-/Staging-Restore ausgeführt:** der Ablauf im Runbook ist beschrieben, nicht
  erprobt; Rollen/Grants, Erweiterungen und echtes Umschalten der Dienste sind nicht verifiziert.
