# Live-PAPER-Simulation: Sprints 34–43

Die Live-PAPER-Schicht simuliert einen zeitnahen Datenstrom, ohne eine echte Börsen- oder Marketplace-Verbindung herzustellen. `PaperTick`-Daten müssen geordnet, eindeutig und mit konsistentem Bid/Ask-Quote geliefert werden. Die Engine erzeugt ausschließlich virtuelle Orderjournale.

Die Session verarbeitet BUY- und AVOID-Signale, simuliert Fill-Ratio und Latenzfelder, zieht Bid/Ask-Kosten ein und hält eine konfigurierbare Cash-Reserve zurück. Equity wird pro Tick mark-to-market bewertet. Drawdown-Alarme werden als `WARNING` oder `CRITICAL` protokolliert, ohne automatisch reale Aktionen auszulösen.

Jede Session liefert eine Equity-Kurve, Cash- und Positionswert, Return und Drawdown in Cent bzw. Basispunkten. Ein Marktmittelpunkt-Benchmark ermöglicht die Auswertung des Excess Return. Fingerprints und Checkpoints unterstützen reproduzierbare Replay- und Auditläufe.

Der Begriff „live“ bedeutet hier ausschließlich sequenzielles Replay oder eine später zuführbare Tick-Schnittstelle im PAPER-Modus. Es gibt keinen Netzwerk-Client, keine Broker-Credentials, keine Orderweiterleitung und keine LIVE-Aktivierung. `paperOnly` bleibt `true` und `liveExecutionEnabled` bleibt `false`.
