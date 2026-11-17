# Erweiterte KI-Strategien (Sprints 11–13)

Diese Erweiterung ist eine deterministische PAPER-only-Fachschicht in `packages/trading-core`. „KI“ bezeichnet die erklärbare Auswertung begrenzter Merkmale und kein autonomes Modell mit Zugriff auf Broker, Marktplätze oder Konten.

## Sprint 11: erklärbare Signale

`generateStrategySignal` kombiniert Wertlücke, Nachfrage, Lagerdruck und Volatilität zu einem begrenzten Score. Jede Ausgabe enthält die Faktoren, einen Konfidenzwert und harte Sicherheitskennzeichen. Eingaben werden auf gültige Zeitstempel, positive Preise und Merkmalswerte zwischen 0 und 100 geprüft.

## Sprint 12: Portfolioallokation

`allocatePaperCapital` priorisiert ausschließlich `BUY`-Signale und vergibt PAPER-Kapital deterministisch nach Score. Verfügbares Kapital, maximale Positionsgröße, maximale Portfoliorisiken und die Anzahl der Positionen werden nie überschritten. Die Funktion reserviert kein Geld und erzeugt keine Order.

## Sprint 13: Backtesting

`runPaperBacktest` verarbeitet historische Bars in der gelieferten Reihenfolge. Das Signal wird ausschließlich aus dem aktuellen Bar erzeugt; zukünftige Bars werden nicht gelesen. Das Ergebnis umfasst Kapitalentwicklung, Rendite, Drawdown sowie Gewinn-/Verlusttreffer und trägt immer `liveExecutionEnabled: false`.

Diese Funktionen sind keine Produktionsfreigabe. Echtzeitdaten, Gebühren, Slippage, Markt-Mikrostruktur, Broker-Sandboxen, Modellvalidierung und serverseitige Genehmigung bleiben notwendige separate Release-Gates.
