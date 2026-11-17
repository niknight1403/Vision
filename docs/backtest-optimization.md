# Backtest-Optimierung: Sprints 24–33

Die Optimierungsengine in `packages/trading-core/src/backtest-optimization.ts` erweitert den bestehenden PAPER-Backtest, ohne seine Sicherheitsgrenzen zu verlassen.

- **Ausführungskosten:** Gebühren und Slippage werden auf dem simulierten Turnover in ganzzahligen Cent berechnet.
- **Exit-Regeln:** Stop-Loss, Take-Profit und Bar-Close werden deterministisch ausgewertet.
- **Risikobudget:** Jede simulierte Position erhält ein prozentuales Risiko- und Kapital-Limit.
- **Cooldown:** Nach einem Signal kann eine definierte Zahl von Bars übersprungen werden.
- **Metriken:** Equity-Kurve, Drawdown, Win-Rate, durchschnittlicher Trade, Profit-Factor und Exposure-Zeit.
- **Parameter-Sweeps:** Konfigurationskombinationen werden vollständig und reproduzierbar getestet und gerankt.
- **Robustheit:** Profitabilitätsquote, Median, Best-/Worst-Ergebnis und Stabilitätskennzahl werden zusammengefasst.
- **Out-of-sample:** Walk-forward-Testfenster werden getrennt vom Training bewertet.
- **Regime:** Volatilität wird ausschließlich als beschreibendes Low-/High-Volatility-Regime klassifiziert.

Die Engine verwendet keine Echtzeitdaten, keine externen Modelle und keine Broker- oder Marketplace-Aufrufe. `paperOnly` bleibt `true`, `liveExecutionEnabled` bleibt `false`. Ein gutes Backtest-Ergebnis ist keine Produktions- oder Investitionsempfehlung; Slippage, Liquidität, Steuern und Marktveränderungen können real abweichen.
