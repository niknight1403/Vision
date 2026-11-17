# Research-Pipeline: Sprints 14–23

Die Pipeline erweitert den Trading-Core um reproduzierbare Forschungsbausteine. Sie verwendet keine externen Modelle, Provider, Broker oder Konten und kann keine Order auslösen.

1. **Versionierte Konfiguration:** `validateStrategyConfig` prüft semantische Versionen, Schwellenwerte sowie Gebühren- und Slippage-Limits.
2. **Signal-Ensemble:** `combinePaperSignals` verbindet gewichtete Stimmen und gibt alle Einzelstimmen unverändert aus.
3. **Kostenmodell:** `applyPaperTradingCosts` berechnet Gebühren und Slippage auf Turnover-Basis in Cent.
4. **Positionsgröße:** `calculatePaperPositionSize` begrenzt Stückzahl gleichzeitig nach Risikobudget, Kapital und Maximalstückzahl.
5. **Exposure:** `checkPaperExposure` meldet Gesamt- und Kategorieüberschreitungen.
6. **Walk-forward:** `createWalkForwardSplits` trennt Training und Test zeitlich und verweigert zu kleine Datensätze.
7. **Benchmark:** `compareToBuyAndHold` berechnet Strategie-, Buy-and-hold- und Excess-Return in Basispunkten.
8. **Fingerprint:** `fingerprintResearchInput` erzeugt einen stabilen Forschungsabdruck zur Reproduzierbarkeit.
9. **Zusammensetzung:** `runPaperResearch` verbindet versionierte Eingaben, Signale und das vorhandene Backtesting.
10. **Regressionen:** Alle neuen Funktionen besitzen Grenzwerttests; die Gesamtpipeline bleibt `PAPER` und `liveExecutionEnabled: false`.

Die Konfiguration ist zunächst eine validierte Forschungsmetadaten-Grenze. Eine spätere echte Modellkalibrierung, Echtzeitdatenversorgung oder Ausführung benötigt separate Sicherheits-, Authentifizierungs-, Provider- und Freigabegates.
