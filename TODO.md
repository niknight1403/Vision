# TODO

## Lokale Demo-Produktentdeckung und Katalog
**Status: umgesetzt** – Das mobile Dashboard zeigt nach explizitem Start lokale Produktkandidaten und ihre Beispielwerte.
- Die App muss einen Produktkatalog und eine Produktentdeckung für den sicheren Deutschland/EU-Prototyp mit Demo- oder Mock-Daten anzeigen.
- Demo-Kandidaten müssen als Demo gekennzeichnet sein; das Auslösen der Entdeckung darf keine externen Anbieteraufrufe ausführen.

## Profit- und Risikobewertung
**Status: umgesetzt** – Die Demo nutzt die bestehenden Core-Funktionen und zeigt Ablehnungsgründe.
- Die Demo muss Produktkosten und mögliche Erlöse in ganzzahligen Cent-Werten bewerten und vorhandene Profit-/Risikologik verwenden.
- Nicht freigegebene oder durch Risikoregeln abgelehnte Kandidaten müssen nachvollziehbare Gründe anzeigen.

## Listing-Entwürfe und Freigabewarteschlange
**Status: umgesetzt** – Pro geeignetem Produkt entstehen individuelle Kanalentwürfe; jeder bleibt offen zur menschlichen Prüfung.
- Die Demo muss kanalbezogene Listing-Entwürfe bereitstellen.
- Entwürfe müssen als unveröffentlicht und freigabepflichtig gekennzeichnet sein; es darf keine Kauf- oder Veröffentlichungsaktion geben.
- Jeder vorgeschlagene nächste Schritt muss in einer Freigabe-Warteschlange verbleiben und darf nicht automatisch ausgeführt werden.

## Reichweiten- und Marketingempfehlungen
**Status: umgesetzt** – Kanalideen und illustrative Wochen-Spannen sind sichtbar gekennzeichnet.
- Die Demo muss Reichweiten-/Marketingempfehlungen für generische Kanaltypen darstellen.
- Reichweitenwerte müssen sichtbar als illustrative Demo-Spannen und nicht als gemessene Performance oder Anbieter-Metrik gekennzeichnet sein.

## Sicherheitsgrenzen und Projektstatus
**Status: umgesetzt** – Der Lauf ist explizit, lokal und deterministisch; PAPER bleibt aktiv, LIVE ist deaktiviert und der Backendstatus bleibt sichtbar nicht verbunden.
- Der Autopilot muss eine explizit gestartete, deterministische Demo-Pipeline sein; er darf keine Hintergrundjobs, externen Anbieteraufrufe, Käufe oder Veröffentlichungen starten.
- PAPER/Demo muss Standard bleiben und LIVE-Trading deaktiviert sein.
- Die bestehende UI muss den Backendstatus als nicht verbunden darstellen, bis es eine echte sichere Integration gibt.
