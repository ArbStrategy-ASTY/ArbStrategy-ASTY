# ASTY Token Fight 🥊

Eigenständiger Telegram-Bot für Solana-Projektduelle.

## Sicherheit der Repository-Struktur

Dieser Bot wird **ausschließlich** im Unterordner `ASTY-Token-Fight/` verwaltet. Bestehende ASTY-Dateien, die Website und der gemeinsame Ordner `assets/` bleiben unverändert.

- Telegram: [@ASTY_TokenFightBot](https://t.me/ASTY_TokenFightBot)
- Cloudflare Worker (vorgesehener Name): `asty-token-fight`
- Cloudflare D1-Datenbank: `asty-token-fight`
- Gemeinsames ASTY-Logo: [../assets/logo.png](../assets/logo.png)

## Technischer Stand

Der Bot-Code befindet sich derzeit noch im separaten v0.2-Projektarchiv. **Dieser Repository-Ordner ist zunächst nur der sichere Ablageort; er stellt noch keine laufende Bot-Installation dar.** Als nächstes kommen die Dateien `src/`, `schema.sql`, `wrangler.jsonc`, `package.json` und die Tests in genau diesen Ordner.

Cloudflare muss für den Bot **dieses Unterverzeichnis als Root Directory** verwenden (nicht das Stammverzeichnis der bestehenden Website).

Alle Bot-Zugangsdaten ausschließlich als Cloudflare-Worker-Secrets hinterlegen, niemals im GitHub-Code.

## Geplante Funktionen

- 24-Stunden-Battle mit 50 % Community-Votes und 50 % Kursentwicklung
- Token-Preise aus einer gemeinsamen Preisquelle, ohne Mindestliquidität
- Eigenständige, parallele Battles mit erneuter Teilnahme nach Abschluss
- Telegram-Challenges über Einladungslinks und einmaliges Voting pro Nutzer/Fight
- Getrennte Live-Nachrichten pro Gruppe, Aktualisierung ca. alle 10 Minuten
- Einmalig generierte Battle-Bilder; vorhandenes ASTY-Branding aus `assets/` wiederverwenden
- Battle-Archiv und Hall of Fame

Status: **Vorbereitung; noch nicht live geschaltet.**
