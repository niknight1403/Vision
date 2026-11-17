# Implementierungsplan: sicherer Produkt- und Reichweiten-Demoablauf

## Umfang

Für den bestätigten sicheren Standardumfang entsteht ein Deutschland/EU-orientierter Prototyp mit Demo-Daten: Produktkatalog und lokale Demo-Produktentdeckung, Profit- und Risikobewertung, kanalbezogene Listing-Entwürfe sowie Reichweiten-/Marketingempfehlungen. Es gibt keine externen Anbieteraufrufe, keine Käufe und keine Veröffentlichungen. Jeder vorgeschlagene nächste Schritt bleibt als Entwurf in einer Freigabe-Warteschlange; LIVE-Trading bleibt deaktiviert.

„Autopilot“ bedeutet hier eine explizit gestartete, deterministische Demo-Pipeline — Entdeckung → Bewertung → Entwurf → Reichweitenplan → Freigabevorschlag. Sie läuft nicht im Hintergrund, startet keine geplanten Jobs und besitzt keine Anbieter-Zugangsdaten. Reichweitenwerte werden als illustrative Demo-Spannen gekennzeichnet, nicht als gemessene Performance oder Prognose.

## Architektur und Projektstruktur

- `packages/trading-core/src/index.ts`: bestehende reine Geld-/Risikoprimitiven beibehalten und um öffentliche Exporte ergänzen.
- `packages/trading-core/src/autopilot.ts`: Domänentypen, statische Demo-Kandidaten, deterministische Pipeline, deutsche Draft-Erstellung, generische Kanalempfehlungen und sichere Statuskennzeichen. Keine Netzwerk- oder Dateisystemaufrufe.
- `packages/trading-core/src/autopilot.test.ts`: Unit-Tests für Bewertungsregeln, Draft-/Reichweitenausgaben sowie unveränderliche PAPER-/No-Publish-Garantien.
- `apps/mobile/App.tsx`: bestehende Expo-Oberfläche in einem mobil nutzbaren Kontrollzentrum weiterentwickeln; Bereiche für Demo-Kandidaten, Katalog, Listing-Entwürfe, Reichweitenhinweise und Freigabestatus. Bestehende dunkle Gestaltung, Statusanzeige und klare „Demo/PAPER“-Kennzeichnung weiterverwenden.
- `apps/mobile/package.json`: Trading-Core als Workspace-Abhängigkeit deklarieren, damit die App dieselbe reine Fachlogik wie Tests nutzt.
- `packages/trading-core/package.json` und `packages/trading-core/tsconfig.json`: echte Paket-Test- und Typprüfungsbefehle einrichten; bestehende fachfremde API-Importgrenze im Typecheck dadurch nicht vergrößern.
- `services/api/README.md`: deutlich festhalten, dass diese Funktionen lokal/demo sind und weder authentifizierte API-Routen noch echte Anbieterintegrationen bereitstellen.

## Fachregeln und Interaktionen

- Demo-Kandidaten tragen eindeutige IDs und ein sichtbares Demo-Kennzeichen. „Entdecken“ wählt nur vorhandene lokale Demo-Daten aus; es wird kein Provider kontaktiert.
- Profit wird ausschließlich über ganzzahlige Cent-/BigInt-Werte berechnet. Risikoregeln verwenden vorhandene `calculateNetProfit`- und `evaluateRisk`-Funktionen. Unvollständige oder abgelehnte Kandidaten erhalten Gründe statt stillschweigend als profitabel zu gelten.
- Listing-Entwürfe sind lokalisierte Textvorschläge für generische Kanaltypen (Marktplatz, eigener Shop, Social). Sie werden als `DRAFT_ONLY`/`PENDING_APPROVAL` angezeigt. Es existiert kein Publish- oder Buy-Handler.
- Reichweitenhinweise verwenden klar als illustrativ bezeichnete Demo-Spannen und erklären die Kanalpassung; sie behaupten keine tatsächliche Reichweite, Nachfrage oder Anbieter-Metrik.
- Die mobile Oberfläche zeigt getrennt, was Demo-Vorschlag, Entwurf oder ausstehende Freigabe ist. Kein Button darf eine reale Transaktion oder externe Veröffentlichung auslösen.
- Der Backendstatus bleibt „nicht verbunden“; in diesem Umfang werden keine Datenbankmigrationen, Secrets, API-Routen oder Marketplace-Adapter angelegt.

## Liefergrenzen

Die Abgabe ist ein lokal ausführbarer, zurücksetzbarer Demo-Prototyp. Datenspeicherung über App-Neustarts, reale Konten, Echtzeitpreise/Bestände, Ads-/Analytics-API, Auth/RBAC, serverseitige Freigaben und echte Kauf-/Listing-Integration bleiben außerhalb dieses Umfangs und erfordern spätere explizite Produktauswahl und Sicherheitsarbeit. LIVE bleibt aus.
