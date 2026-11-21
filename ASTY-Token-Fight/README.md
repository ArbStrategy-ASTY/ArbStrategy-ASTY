# 🥊 ASTY Token Fight – Telegram Bot v0.7.2 (Birdeye)

**Status: private Beta / laufende Tests.** Der Bot wurde in früheren Versionen auf Cloudflare deployed und mit ASTY-vs.-ARBX-Gruppen getestet. Die neuen Menüs, Website-Buttons, Vote-Benachrichtigungen und das Grafikdesign von v0.4.2 sind im GitHub-Code implementiert, aber müssen nach Cloudflare-Deployment noch in Telegram geprüft werden. Alle Änderungen bleiben auf den Ordner `ASTY-Token-Fight/` beschränkt.

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


## Button-Menüs und Projekt-Websites (v0.4.0)

Die private Bot-Startseite (`/start` oder `/menu`) zeigt vollständig bedienbare Inline-Buttons für:
- **New Fight**: eigenes bereits verknüpftes Projekt wählen, dann einen registrierten Gegner wählen, Challenge erstellen; für bereits registrierte Projekte ist keine Mint-Eingabe mehr nötig.
- **My Projects**: verknüpfte Projekte wählen, Webseite ansehen/bearbeiten oder Challenge starten.
- **Active Fights**: Status anschauen und eigene aktive Fights per Bestätigungsbutton beenden.
- **Hall of Fame**: vergangene Kämpfe und deren Details auswählen.
- **Project Websites**: Website für ein Projekt einmalig einfügen (HTTPS) und später per Button bearbeiten oder löschen.
- **Help**: erklärt die Funktionen und listet die verfügbaren Befehle, einschließlich `/link`, `/unlink`, `/stop` und `/withdraw`.

In einer Telegram-Gruppe zeigt `/start` die Buttons **Link Project Token**, **Unlink Project Token**, **Help** und **Open Fight Bot**. Die Verknüpfung über Buttons erfordert nur, dass der Gruppenadmin die unbekannte Solana-Tokenadresse einmalig als Antwort auf die Nachricht des Bots einfügt (Telegram ForceReply). Bereits registrierte Projekte sind danach ohne Texteingabe auswählbar. Manuelle Gruppenbefehle (`/link MINT`) bleiben kompatibel.

### Website-Funktion und Werbung

- Website pro Token dauerhaft in D1-Tabelle `project_websites` gespeichert; alle Rematches greifen auf dieselbe URL zu.
- Die Website des Tokens darf nur ein Telegram-Admin der **zuerst für diesen Token registrierten Gruppe** verwalten. Die Zugehörigkeit wird beim Speichern live über Telegram geprüft. **Dies ist kein kryptografischer Nachweis von Token-Eigentum.**
- Nur öffentliche HTTPS-Domains akzeptieren; IP-Adressen, lokale Hostnamen, fremde Protokolle, URLs mit Zugangsdaten, nicht-HTTPS und zu lange URLs ablehnen. Maximale Länge 160 Zeichen.
- Website-URLs werden nicht im Nachrichtentext wiederholt; sie erscheinen ausschließlich als klickbare Buttons `🌐 $TOKEN Website` unter den Abstimmungsbuttons in Battle-Posts und bei wichtigen Benachrichtigungen. Existiert noch keine Website, wird kein Link erfunden.
- URLs sind **von Gruppenadmins eingereichte Links und nicht von ASTY verifiziert**.
- Bestehende D1-Tabellen und Gruppenverknüpfungen bleiben erhalten: `project_websites` wird bei der nächsten Anfrage bzw. Cron-Ausführung mit `CREATE TABLE IF NOT EXISTS` automatisch angelegt.
- Das Telegram-Befehlsmenü wird nach Deployment einmalig automatisch über `setMyCommands` aktualisiert; es sind keine neuen Secrets notwendig.

### Testfolge für v0.4.0

1. Im Cloudflare-Worker `/health` kontrollieren: `0.4.2`.
2. Privat `/start` öffnen: alle sechs Menüpunkte müssen als Buttons sichtbar sein.
3. `My Projects` oder `Project Websites` wählen; beide Testprojekte ASTY und ARBX sollten auswählbar sein, wenn sie vorher durch denselben Telegram-Admin verknüpft wurden.
4. Für beide Projekte eine Website speichern; anschließend `New Fight` → ASTY → ARBX über Buttons wählen.
5. Challenge per vorhandenem Deep-Link annehmen; beide Gruppen müssen die klickbaren Websites und Voting-Buttons sehen.
6. Updates im 10-Minuten-Abstand, `/help`, Hall of Fame und Stop-Bestätigung prüfen.

Das Menü ersetzt weder die einmalige Eingabe einer neuen Mint-Adresse beim ersten Linking noch das einmalige Einfügen einer vom Admin gewählten Website-URL.


## Anzeige-Update v0.4.2 – Nur Buttons für Websites, sichtbare Votes

- **Keine Projekt-Websites im Nachrichtentext.** Keine URL-Zeilen in Battle-Captions, Challenge-Einladungen, Milestone-Nachrichten oder Abschlussmeldungen.
- Stattdessen Website-Buttons `🌐 $TOKEN Website` direkt **unterhalb** der Abstimmungsbuttons. Bei wichtigen Benachrichtigungen ebenfalls Buttons, sofern URLs hinterlegt sind; keine leeren Telegram-Keyboards senden.
- Für Battle-Captions echte Leerzeilen zwischen Überschrift, Tokenpaar, Statistikblock und ASTY-Branding.
- Jede tatsächlich neu gezählte Stimme sendet zusätzlich **eine sichtbare Nachricht nur in die Gruppe, in der abgestimmt wurde**: `🔥 New vote for $TOKEN 🔥`. Mehrfachklicks erzeugen keine weitere öffentliche Meldung. Telegrams Callback-Info bleibt erhalten.
- Grafik vollständig vereinfacht: geteiltes dunkles Design, zwei große Tokenfelder und Logos, ein einziges VS, glatte Vektor-Schriftzüge statt Pixel-Schrift, ruhiges Branding. Die jeweils neu erzeugte Fight-Grafik wird nur **beim nächsten Fight** verwendet, nicht automatisch in laufenden Fights ersetzt.
- Birdeye bleibt die Preisquelle. Für Tokenbilder versucht die Grafik zunächst den Birdeye-Logo-Link, danach bei ASTY das vorhandene ASTY-GitHub-Logo und bei Bedarf einen Bildlink aus öffentlichen DEX-Screener-Metadaten. Nur explizit zugelassene Bild-CDNs, keine beliebigen Hostnamen. Der Fallback bei fehlendem Bild nennt das tatsächliche Token-Ticker-Symbol, statt ein fremdes Logo zu erfinden.
- Die Funktionen sind im Code strukturell getestet; die Live-Darstellung und Tokenlogos auf Telegram müssen weiter überprüft werden.

## Logos zuverlässig in D1 speichern (v0.5.0)

Ein frisches Tokenlogo wird beim Fight-Start nicht länger blind per URL eingebettet. Der Bot prüft beide Logos **vor der Annahme** der Challenge:

1. Ist das Logo bereits in Cloudflare D1 (`project_logos`) gespeichert, wird diese Kopie benutzt – ohne fremden Bilder-Server abzufragen.
2. Andernfalls prüft er zunächst die direkte Birdeye-Logo-URL und für ASTY das GitHub-Logo aus `assets/logo.png`.
3. Falls diese nicht funktionieren, folgen Jupiter-/DEX-Screener-Metadaten für **dieselbe Mint-Adresse**. Damit werden nicht versehentlich Bilder des Gegen-Tokens eines Pools verwendet.
4. Wenn keine gültige PNG-/JPEG-Datei verfügbar ist, wird der Fight **nicht gestartet**. Die Herausforderung bleibt offen und kann nach dem Einreichen des Logos erneut angenommen werden.
5. Projektadmins öffnen **My Projects → Token → Upload Logo** oder **Token Logos**. Die offizielle Logo-Fotodatei wird über Telegram `getFile` entgegengenommen, geprüft und in der bestehenden D1-Datenbank gespeichert. Der einmalige Upload funktioniert direkt im Telegram-Chat ohne weitere Anwendungen. Adminrechte der zuerst verknüpften Projektgruppe sind erforderlich.
6. Nach dem Speichern werden bei Rematches beide Bilder aus D1 geladen, nicht aus Birdeye oder DEX Screener. Logo-Updates werden von Projektadmins bewusst vorgenommen, automatische Metadaten dürfen sie nicht überschreiben.

Technische Daten: `project_logos(mint,data_uri,source,updated_by,updated_at)`, max. 440 KB Rohbild (D1-String bleibt unter 2 MB). Unterstützt PNG und JPEG. Unsichere externe Logo-Hosts, ungeprüfte Redirects und Bildinhalte ohne PNG-/JPEG-Signatur werden abgelehnt. Keine neue Cloudflare-Komponente und keine zusätzlichen Secrets erforderlich.

**Wichtig:** Automatischer Abruf kann bei fehlenden/defekten Metadaten scheitern. Daher lässt sich nicht garantieren, dass jedes Projekt ohne Mitwirkung ein Logo hat. Für **neu gestartete Fights** erzwingt der Bot aber, dass zwei gespeicherte gültige Logos vorliegen – ansonsten startet er nicht. Bereits laufende Fights behalten ihr einmal veröffentlichtes Telegram-Bild.

### Test: ARBX-Logo
- Nach dem Cloudflare-Deployment muss `/health` die Version `0.5.0` melden.
- Privat `/start` → **My Projects** → **$ARBX** → **Upload Logo**.
- Als Telegram-Foto das echte ARBX-Logo senden. Der Bot bestätigt, dass es gespeichert ist.
- Mit **$ASTY** ebenso vorgehen, falls das Logo noch nicht im D1-Cache liegt (alternativ **Find Logo Automatically**).
- Die ausstehende Herausforderung annehmen oder einen neuen Test-Fight starten. Beide Logos werden direkt aus D1 eingebettet und anschließend in den periodischen Telegram-Fight-Posts kopiert.

## Fixed Fight Video + Reliable Updates (v0.6.0)

The bot now sends one fixed MP4 clip instead of dynamically generated token logos. The original ASTY group registrar, who must still be group administrator, can upload it in private Telegram via Start > Fight Video > Upload Video. Optional Cloudflare secret FIGHT_VIDEO_ADMIN_ID authorizes a specific account instead. A Telegram sendVideo preview confirms the bot can reuse the video. Only the canonical Telegram file ID is stored in the existing D1 worker_settings table, not the video itself. No additional Cloudflare product or API is required.

New fights require a configured video but do not require project logos. Both groups receive the same video with per-fight statistics, voting buttons, and optional website buttons. Existing photo-based fights switch to the fixed video on their next scheduled repost.

Every ten minutes the worker should publish a NEW video message in each group. The scheduled handler is triggered every minute by wrangler.jsonc, and due fights run once every 600 seconds. Price-refresh failures do not block posting: votes and remaining time are still updated; last known price figures are not invented. After Telegram delivery errors, retry after approximately 90 seconds. The fight creator may also use Active Fights > Refresh Now (or /refresh FIGHT_ID) for a rate-limited immediate test.

Health diagnostics: GET /health returns version 0.6.0, cron_last_started, cron_last_completed, and video_configured, without exposing the Telegram file ID or secrets. The Cron timestamp values are UTC ISO strings. If these timestamps are stale, inspect Cloudflare Scheduled Triggers; if they update but group messages fail, inspect the Cloudflare worker logs.

Initial test: confirm /health reports 0.6.0, upload the MP4 in the private bot chat, verify preview and video_configured=true, then tap Refresh Now for an existing active fight. Check new video posts in both Telegram groups and then confirm another update after 10 minutes.

Security: uploading/replacing the global video is restricted to the ASTY project's original group registrar (or FIGHT_VIDEO_ADMIN_ID). Project website links remain button-only. Existing project links, fights, and vote data remain untouched.


## Video-Eigentum dauerhaft auf den ersten zugelassenen Uploader beschränkt (v0.6.1)

- Vor dem allerersten Video-Upload gilt weiterhin: entweder `FIGHT_VIDEO_ADMIN_ID` aus der Cloudflare-Umgebung oder, falls nicht gesetzt, der erste ASTY-Projektgruppen-Registrant mit nachweislich aktuellen Telegram-Adminrechten.
- Beim ersten **erfolgreichen** Upload wird die Telegram-User-ID in `worker_settings.fight_video_owner_id` dauerhaft gespeichert. Die Zuordnung wird mit dem Video-Eintrag in einer D1-Transaktion abgesichert.
- Für jeden weiteren Zugriff auf **Upload Video**, **Replace Video** und die Vorschau wird der gespeicherte Besitzer geprüft. Eine später geänderte Umgebungsvariable oder andere Gruppenadministratoren übernehmen die Berechtigung nicht.
- Das Video selbst darf ausschließlich der ursprüngliche, einmal festgelegte Eigentümer ersetzen. Andere Token-/Gruppenadmins können es ansehen, aber nicht ersetzen. Eine Rücksetzung des Eigentümers ist nur durch eine ausdrücklich autorisierte Betreiberaktion außerhalb des Bots möglich.
- Diese Sicherung gilt im Bot ab `0.6.1`; GitHub-Commit allein bedeutet noch nicht, dass Cloudflare bereits auf dieser Version läuft.


## Current rules and fixed official video (v0.7.0)

**This section supersedes earlier scoring and video-management notes elsewhere in this README.**

- The global MP4 video was already uploaded and saved in D1 under `worker_settings.fight_video_file_id`. This version keeps that existing value unchanged. Once set, it is permanently locked for all Telegram users, including the original uploader and other admins. The menu shows only video status and a preview; no Replace or Upload button is available. Server-side upload handlers and the database INSERT OR IGNORE prevent replacement via old/stale Telegram buttons. Only an explicit infrastructure-level operator action outside the bot could alter the D1 record.
- A 24-hour battle uses the same fixed video in both groups, with new posts roughly every 10 minutes and a short group announcement for each successfully counted vote.
- Community vote share contributes 50% of final score; 24-hour relative percentage-point price performance contributes the other 50%.
- **New rule:** each 0.1 percentage point of price-change advantage earns 1 price-category point. For side A: `priceShareA = clamp(50 + 10 * (returnA - returnB), 0, 100)`. Side B receives `100 - priceShareA`. Final A: `(voteShareA + priceShareA) / 2`. No votes yields 50:50 in the vote category. The price category cap is reached at a 5-percentage-point lead.
- Example: ASTY 30 votes / +5.00%, ARBX 20 votes / +3.00%. Vote category: 60:40; price category: 70:30; **final score: ASTY 65.0% vs ARBX 35.0%**.
- At the end of 24h, the bot tries to retrieve valid final prices, updates the latest group posts, sends a **new text result notification** to both groups declaring winner or draw, and saves the result in the Hall of Fame. If prices remain unavailable after a short retry, it closes as unresolved without a fabricated winner. Early stopped fights have no winner.
- In English under `/help` (in a group or private bot chat), users get an overview and interactive sections: How It Works, Scoring Rules, Fight Results and Commands. The full price formula, example, winner announcement, website buttons, one-vote rule, fixed video and ten-minute posts are explained.

Deployment check: after Cloudflare Builds publishes the changes, `/health` must show version `0.7.0`. Do not clear or reupload the stored D1 video.


## Telegram caption and help text v0.7.1

- Live battle caption: `🥊 LIVE TOKEN FIGHT - ID: ...`, blank line, `⚡ $TOKEN_A VS $TOKEN_B ⚡`, blank line, votes/price change/score/countdown on separate lines, blank line, italic `...Stats update every 10 minutes...`, blank line, bold `Powered by ASTY - ArbStrategy.net` with a hyperlink on the domain to `https://arbstrategy.net/`.
- For ended/unresolved/stopped fights the appropriate status heading remains, and the stats-update line is shown **only while active**.
- Removed from both `/help` overview and How It Works: the explanatory video-lock wording, the phrase about websites 'never repeated in the battle text', and the description of 'the same fixed ASTY video'.
- Website buttons stay under the fight message, not in the caption. No changes to the stored MP4, scores, D1 records, or current fights.


## Vote notifications in both fight communities (v0.7.2)

For each successfully counted vote the bot now sends `🔥 New vote for $TOKEN 🔥` **concurrently** to both project groups via `Promise.allSettled`. Group IDs are drawn from currently linked project groups plus the group's recorded fight posts, deduplicated using SQL `UNION`. A second vote by the same Telegram user still produces no notification. The vote acknowledgement in Telegram remains immediate, and failure to post to one group does not prevent delivery to the other group or undo the valid vote. The automatic 10-minute status/video posts remain unchanged.
