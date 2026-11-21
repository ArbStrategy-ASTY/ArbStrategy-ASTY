# 🥊 ASTY Token Fight – MVP v0.2.1 (Birdeye)

**Status: technische Testversion – noch nicht live.**

Der Code baut auf der bereitgestellten v0.1 auf. Er ist **nicht** bei Cloudflare deployt, hat **keinen echten Telegram-/Jupiter-End-to-End-Test** durchlaufen und hat euer bestehendes GitHub-Repository nicht verändert. Die bestehende ASTY-Website bleibt unverändert.

## Was neu ist in 0.2?

- **Mehrere unabhängige Fights gleichzeitig:** Jeder Fight hat eigene ID, Stimmen, Preise, Telegram-Nachrichten und Cron-Zeitpunkte.
- **Ein Token maximal in einem aktiven Fight:** Zwei SQL-Locks pro Fight werden beim Annehmen **atomar** in Cloudflare D1 reserviert. Andere Fights mit demselben Token können erst nach dem Abschluss starten.
- **Keine doppelte offene Paarung:** A gegen B und B gegen A können nicht gleichzeitig als offene Challenges existieren. Ein späteres Rematch ist erlaubt.
- **Erneute Battles ohne erneute Gruppenverknüpfung:** Verknüpfte Gruppen bleiben verknüpft. Freigabe der Token-Locks beim Abschluss oder bei `unresolved`.
- **Hall of Fame:** `/history` sowie `/history TOKENADRESSE` zeigen abgeschlossene Fights. `/fights` listet aktive Kämpfe.
- **Archivierung statt vollständigem Löschen:** Endergebnisse und aggregierte Stimmen werden gespeichert. Die einzelnen Telegram-Voter-IDs abgeschlossener Fights werden nach 30 Tagen entfernt (durch Cron).
- **Offene Einladungen laufen nach sieben Tagen ab.** Ersteller können eigene offene Challenges per `/withdraw FIGHT_ID` zurückziehen.
- **Admin kann Verknüpfung entfernen:** `/unlink TOKENADRESSE` in der Gruppe. Laufende Battle-Messages bleiben bis zum Ende bestehen.
- **Robustere Aktualisierung:** 10-Minuten-Takt pro Fight mit Reservierung des nächsten Update-Zeitpunkts. Ein fehlgeschlagener initialer Gruppenpost wird bei einem späteren Update erneut versucht.
- **Gruppenposts:** Start, Zwischenstände als Bearbeitung der bestehenden Nachricht, gesonderte Hinweise bei ~6h, ~12h und ~1h verbleibend sowie Ergebnis. Keine Nachricht pro Stimme; kein automatisches Anpinnen.
- **Zuverlässigere Abschlussnachrichten:** Einfache persistente Retry-Logik. Bei Netz- oder Datenbankfehlern sind in seltenen Fällen doppelte Hinweise möglich.

## Weiterhin enthalten

- 24-Stunden-Fight: **50 % Community-Voting + 50 % Token-Kursentwicklung (Birdeye USD-Preis)**.
- Ein Vote je Telegram-ID und Fight. Keine Wallet, kein Tokenkauf notwendig.
- **Keine Mindestliquidität.** Token muss aber in Birdeye einen gültigen Preis liefern, sonst startet er nicht. Fehlt ein zeitnaher Endpreis, wird das Ergebnis `unresolved`, **ohne erfundenen Sieger**.
- Automatisch generiertes PNG mit beiden Tokenlogos und ASTY-Branding für den Fightstart (SVG → PNG über `@cf-wasm/resvg`). Für fehlende Logos gibt es Ersatzsymbole. Scheitert das Rendering, geht eine Text-Battle-Anzeige raus.
- Live-Battle-Text wird etwa alle zehn Minuten aktualisiert, das ursprüngliche Bild nicht jedes Mal neu generiert.

## Ablage im bestehenden ASTY-Repository

Dieses Projekt ist für den Unterordner `ASTY-Token-Fight/` in `ArbStrategy-ASTY/ArbStrategy-ASTY` vorbereitet. Andere Dateien bleiben unverändert. Das gemeinsame ASTY-Logo wird unter `../assets/logo.png` wiederverwendet und nicht kopiert; der Worker ruft die Bilddatei beim Erstellen des Startbilds über die unveränderte Raw-GitHub-URL ab. Cloudflare muss das **Root Directory `ASTY-Token-Fight`** verwenden, nicht das Repository-Stammverzeichnis. Bei lokaler Nutzung oder über Wrangler müssen die Befehle **in diesem Unterordner** ausgeführt werden.

## 1. Voraussetzungen

1. Telegram-Bot über [@BotFather](https://t.me/BotFather) erstellen, Bot-Username und Bot-Token bereithalten.
2. Cloudflare-Account mit Workers und D1 nutzen.
3. Birdeye-API-Key bereithalten (aktuellen Tarif und Kontingente prüfen; **kostenloser Betrieb ist nicht garantiert**). Im Standard-Free-Tarif ist nur eine Anfrage pro Sekunde erlaubt; deshalb verwendet der Bot einzelne Preisabfragen statt des kostenpflichtigeren Batch-Endpunkts. Bei vielen parallelen Battles müssen wir das global rate-limitieren.
4. Node.js 20+ installieren.

**Zugangsdaten niemals hier im Chat oder in einem öffentlichen GitHub-Repository veröffentlichen.**

## 2. Cloudflare-Datenbank und Worker erstellen

Im Projektverzeichnis:

```bash
npm install
npx wrangler login
```

Die Cloudflare-D1-Datenbank `asty-token-fight` ist bereits erstellt. **Nicht erneut `wrangler d1 create` ausführen.** Die `database_id` und der Bot-Benutzername `ASTY_TokenFightBot` (ohne `@`) sind in `wrangler.jsonc` bereits eingetragen.

**Bestehende D1:** `48d62dc0-a03f-4f2e-aa7a-82fb401fb300`

Die Befehle unten führen das SQL-Schema in dieser vorhandenen Datenbank aus. `schema.sql` ist für die erste Initialisierung einer **leeren** Datenbank gedacht. Falls bereits Tabellen existieren, vorher prüfen, ob die passende Version vorliegt.

Danach die vorhandene Datenbank initialisieren und die Secrets setzen:

```bash
npm run db:remote
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put BIRDEYE_API_KEY
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npm run deploy
```

Für `TELEGRAM_WEBHOOK_SECRET` einen zufälligen Wert mit erlaubten Telegram-Zeichen (`A-Za-z0-9_-`) generieren.

**Hinweis für v0.1-Nutzer:** `schema.sql` ist das Schema für eine **neue, leere v0.2-Datenbank**. Es ist **kein** Upgrade-Skript für eine bereits gefüllte v0.1-Datenbank. Falls v0.1 schon deployed wurde, bitte vor einer Migration ein Backup machen und eine gesonderte D1-Migration durchführen. Die v0.1 war laut Vorgängerversion noch nicht live.

## 3. Telegram-Webhook aktivieren

Nach dem Deployment die echte `workers.dev`-URL kopieren und vom eigenen Rechner den Telegram-Webhook setzen:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://DEINE-WORKER-URL.workers.dev/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Über `GET /health` liefert der Worker einen Status mit `version: 0.2`.

## 4. Erste Kämpfe und Rematches testen

1. Bot als Admin mit Schreib-/Fotorechten in **zwei Testgruppen** hinzufügen.
2. Admin A verknüpft in Gruppe A `/link <TOKEN_A_MINT>`.
3. Admin B verknüpft in Gruppe B `/link <TOKEN_B_MINT>`.
4. Admin A startet den Bot privat und sendet `/new <TOKEN_A_MINT> <TOKEN_B_MINT>`.
5. Admin A sendet den Challenge-Link an Admin B. Dieser öffnet ihn **privat im Bot** und akzeptiert.
6. Der Fight beginnt nur, wenn für beide Tokens gültige Birdeye-Preise vorhanden sind. Beide Gruppen bekommen einen Battle-Post.
7. Über denselben Telegram-Account darf pro Fight nur einmal abgestimmt werden. Nach 24 Stunden wird der Fight abgerechnet oder bei fehlenden Daten auf `unresolved` gesetzt.
8. Nach Beendigung per `/new <TOKEN_A_MINT> <TOKEN_B_MINT>` einen **neuen Fight** starten. Die alte Gruppenverknüpfung muss nicht wiederholt werden.
9. Ein zweites, **unabhängiges** Tokenpaar darf bereits während des ersten Fights antreten. Ein Überschneidungs-Token dagegen nicht.

### Bot-Befehle

**Privat:** `/start`, `/help`, `/new`, `/new EIGENER_MINT GEGNER_MINT`, `/status FIGHT_ID`, `/fights`, `/history`, `/history MINT`, `/withdraw FIGHT_ID`, `/cancel`.

**In der Gruppe (nur Admin):** `/link MINT` und `/unlink MINT`.

## 5. Wertungsregel (noch abstimmbarer Parameter)

- Votes: `votesA / (votesA + votesB)`, bei null Votes je 50 %.
- Preisrendite: `(Endpreis / Startpreis - 1) × 100` für jeden Token.
- Kursanteil A: `clamp(50 + 2,5 × (RenditeA − RenditeB), 0, 100)`.
- Endscore A: `(VotinganteilA + KursanteilA) / 2`, B = 100 − A.

Die **2,5 Punkte je Prozentpunkt Renditeunterschied** sind eine **vorläufige Annahme**, keine abschließend freigegebene Regel. Keine Mindestliquidität. Bei stark illiquiden Token kann der Preis manipuliert werden; das Battle ist ein Community-Spiel, kein Qualitätsurteil oder Investitionssignal.

**Zeitfenster:** Startpreis wird beim Annehmen gespeichert, Endpreis bei einer Cron-Abfrage nach etwa 24 Stunden (nicht exakt auf die Sekunde). Ist die Abschlussabfrage über 180 Sekunden verspätet oder scheitert bis dahin, erfolgt `unresolved`.

## 6. Was noch vor dem öffentlichen Start fehlt

- **Live-Integrationstests** mit Telegram, Jupiter und Cloudflare D1 einschließlich Foto-Upload und `@cf-wasm/resvg`.
- **Projekt-Verifizierung/Moderation:** Adminrechte an einer Telegram-Gruppe **beweisen keine offizielle Zugehörigkeit zum Token**. Öffentliche Battles müssen gegen Fake-Registrierungen abgesichert werden.
- **Anti-Manipulation:** Mehrere Telegram-Accounts, gekaufte Stimmen oder gezielte Kursbewegungen sind nicht sicher auszuschließen.
- **Daten-/Datenschutzhinweise**, Löschkonzept sowie dokumentierte Nutzerrechte für einen öffentlichen Betrieb.
- **Siegerehrungsbild:** Aktuell gibt es beim Abschluss einen Textpost und eine aktualisierte Live-Karte; die automatische Champion-Grafik ist noch nicht implementiert.
- **Skalierung/Monitoring:** Cron bearbeitet begrenzte Batches, damit Free-Tarif und externe API-Limits nicht unkontrolliert belastet werden. Bei sehr vielen parallelen Fights müssen wir das Scheduling und Kapazitäten messen.
- **Preisquellen-Limits:** Verfügbarkeit, historische Genauigkeit und Birdeye-Kontingente und Berechtigungen vor Live-Start verifizieren.

## 7. Tests (offline)

```bash
npm test
python3 -m unittest discover -s tests -p 'sqlite_*.py' -v
```

Die Node-Tests prüfen die Wertung; die Python-SQLite-Tests prüfen die Datenbankinvarianten: parallele Fights, Token-Sperren, atomare Konkurrenzvermeidung, Rematch, Archiv-Snapshot, Freigabe abgelaufener Challenges. Python-Tests benötigen keine Zusatzpakete.

## Birdeye-Umstellung v0.2.1

- Nur Dateien in `ASTY-Token-Fight/` geändert; alle anderen ASTY-Anwendungen bleiben unverändert.
- Tokenname, Ticker und Logo kommen von `GET /defi/token_overview`.
- Der USD-Tokenpreis kommt von `GET /defi/price`, auf Basis der Token-Mint-Adresse, **nicht** einer einzelnen Pooladresse.
- Die zwei Preisabfragen je Fight sind zeitlich mindestens 1,2 Sekunden auseinander; **das verhindert noch keine accountweiten Limits bei gleichzeitig laufenden Fights**.
- Das vorhandene `JUPITER_API_KEY` Secret ist für die neue Version nicht nötig. Benötigt wird `BIRDEYE_API_KEY`, als Cloudflare Secret. Secret niemals in GitHub eintragen.
- Ein API-Live-Test mit dem echten Birdeye-Key steht noch aus. API-Verfügbarkeit und verbleibendes Monatskontingent im Birdeye-Dashboard prüfen.

## Telegram-Webhook automatisch (v0.2.2)

Der Worker registriert seinen Telegram-Webhook automatisch beim nächsten Cron-Lauf (etwa innerhalb einer Minute nach dem Deployment). Dafür müssen in Cloudflare **Settings → Variables and Secrets** diese zwei vertraulichen Werte als **Secrets** hinterlegt sein: `TELEGRAM_BOT_TOKEN` und `TELEGRAM_WEBHOOK_SECRET`. Für die Tokenkurse wird zusätzlich `BIRDEYE_API_KEY` benötigt. **Niemals Zugangsdaten in GitHub-Dateien oder Chat-Nachrichten schreiben.**

Die öffentliche Zieladresse steht ausschließlich als nicht geheimer Wert `WEBHOOK_URL` in `wrangler.jsonc`. Ein SHA-256-Fingerabdruck aus URL und Secrets wird in `worker_settings` gespeichert, damit die Registrierung nicht jede Minute wiederholt wird; Geheimwerte werden nicht in D1 gespeichert. Bei einer Secret-Rotation registriert sich der Bot erneut. Bei vorhandenen v0.2-Datenbanken wird die Tabelle `worker_settings` bei Bedarf automatisch erstellt.

**So testen:** Zuerst `https://asty-token-fight.mail-timothy.workers.dev/health` öffnen und `version: 0.2.2` prüfen. Dann nach 1–2 Minuten in Telegram `@ASTY_TokenFightBot` öffnen und `/start` senden. Sollte keine Antwort kommen, in Cloudflare unter **Workers & Pages → asty-token-fight → Logs** nach `telegram webhook setup` suchen, ohne Secrets offenzulegen.

Der frühere manuelle `curl setWebhook`-Schritt aus Abschnitt 3 ist für v0.2.2 **nicht mehr nötig**. Der Worker steht separat in `ASTY-Token-Fight/`; alle anderen ASTY-Projekte bleiben unberührt.

## Live-Updates v0.2.4

Während eines aktiven Fights **postet der Bot jetzt ungefähr alle 10 Minuten eine neue Battle-Nachricht in beide verknüpften Gruppen**, statt nur die alte Nachricht zu editieren. Er verwendet dafür bei Grafiken Telegrams `copyMessage` mit aktueller Caption und Abstimmungsbuttons, damit das Bild nicht erneut gerendert/hochgeladen werden muss. Der jeweils neueste Message-ID-Eintrag wird in `group_messages` aktualisiert. Falls Telegram das Kopieren ablehnt, wird zur Sicherheit die bisherige Nachricht editiert.

**Hinweis zur Häufigkeit:** Bei 24 Stunden entstehen theoretisch ca. 144 neue Nachrichten pro Gruppe und Fight, zusätzlich zu Milestones und Abschluss. Das ist bewusst für den Test eingestellt; vor einem öffentlichen Rollout sollten wir prüfen, ob ein längeres Posting-Intervall (z. B. stündlich) für Communities angenehmer ist. Alte Posts bleiben in der Gruppe; ältere Abstimmungsbuttons sind nach Abschluss nicht mehr wirksam.

## Card and chat refresh v0.3.0

- All Telegram bot user-facing messages are in English. The fight card and text captions show a single `$` before token symbols.
- Active-fight caption matches `🥊 LIVE TOKEN FIGHT <id>`, `⚡ $TOKEN_A VS $TOKEN_B`, `Votes`, `Price change`, `Score`, `Remaining`, and `🟣 Powered by ASTY - ArbStrategy.net`.
- Token vote confirmation is `🔥 New vote for $TOKEN 🔥`; multiple votes per Telegram user per fight are still disallowed.
- New 1200×680 neon-arena battle card is dynamically generated for any Solana token pair. All text is drawn with SVG vector paths so it remains visible in Cloudflare without installed fonts. Birdeye image-proxy hosts are allowlisted, and unsupported logos fall back to token initials. For ASTY, the repo's existing `assets/logo.png` is used as a fallback.
- The original fight graphic is uploaded only at fight creation. New ten-minute posts reuse Telegram's stored image, so the newly designed graphic will appear **on the next fight**, not retroactively on existing fights.
- The challenge creator can end an active test fight with `/stop FIGHT_ID` in the private bot chat. This marks the fight as `cancelled`, removes both active token locks, disables voting on the latest posts, and sends a stopped notice to linked groups. No winner is declared; the cancelled battle is not added to the Hall of Fame. `/cancel` still only cancels the interactive draft wizard.
- After 30 days, individual votes of stopped fights are also deleted.
- Cloudflare health version: `0.3.0`. Confirm deployment first before attempting `/stop`.
