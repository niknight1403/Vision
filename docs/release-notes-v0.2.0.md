# AutonomAgent v0.2.0 — sichere Testnet-Sicherheitsbasis

## Highlights

- Live-PAPER-Simulation mit virtuellen Orderzuständen, Equity-Kurve, Drawdown-Alarmen, Benchmark und reproduzierbaren Checkpoints.
- Fail-closed Testnet-Sicherheitsprimitive für Approval Snapshots, deterministische Client-Order-IDs, Zustandsübergänge und Kill-Switch-Gates.
- Persistentes Prisma-Modell für Testnet-Kill-Switches, Order Intents, Order Events und Reconciliation Runs.
- Reconciliation-Diffklassifizierung für unbekannte interne oder externe Orders, Fill-Abweichungen, Gebührenabweichungen und Statuskonflikte.
- Standardmäßiger `DisabledTestnetAdapter`: Es werden keine Provider- oder mutierenden Testnet-Aufrufe ausgeführt.
- Testnet bleibt mit `testnetEnabled: false` deaktiviert; `PAPER` bleibt der einzige unterstützte Betriebsmodus.
- Workspace- und Android-App-Version auf `0.2.0` angehoben; Android `versionCode` auf `2` gesetzt.

## Verifikation

- Prisma-Schema validiert.
- Alle sieben Migrationen einschließlich `20261117015000_testnet_safety` lokal angewendet.
- API-Build erfolgreich.
- Alle Workspace-Typechecks erfolgreich.
- API: 70 Tests bestanden.
- Trading-Core: 43 Tests bestanden.
- Android-Expo-Bundle erfolgreich exportiert.
- `npm audit --audit-level=high` ohne High- oder Critical-Befund.

## Sicherheits- und Reifehinweis

Dies ist weiterhin ein Quellcode-Release und keine Produktionsfreigabe. Es gibt keinen aktivierten Provideradapter, keine Testnet-Credentials und keine mutierende Testnet-HTTP-Route. Die elf moderaten Expo-Toolchain-Advisories bleiben offen; ihre automatische Behebung würde ein nicht validiertes Expo-/React-Native-Major-Upgrade erfordern und wurde nicht blind durchgeführt. Die Release-Gates in `docs/release-gates.md` bleiben verbindlich.
