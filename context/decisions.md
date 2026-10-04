# Entscheidungen

Stand: 2026-09-28. Quelle: Antworten des Users auf `HANDOVER_NEUBAU.md` Abschnitt 5.

| # | Thema | Entscheidung |
|---|---|---|
| 1 | Stack | Dashboard in **Go**, API in **PHP**, Discord-Bot in **Node** |
| 2 | Datenbank | **SQLite** als Haupt-DB + **Redis** als Cache/Queue |
| 3 | Neue Features | **Alle** Commands (auch die eingebauten) sind im Custom Command Builder editierbar |
| 4 | Umfang v1 | Feature-Umfang von v2 (`github.com/Kljub/bothubv2`, privat) |
| 5 | Bots | Alle Bots laufen in **einem** Node-Prozess. Keine Duplizierung, keine mehreren Instanzen |
| 6 | Plugins | Plugins werden **pro Bot** installiert, gesteuert über Permissions |
| 7 | PC | Windows 11, Docker Desktop installiert. Go und PHP sind lokal nicht installiert, Build nur in Docker |
| 8 | Git | Repo `github.com/Kljub/BothubV3`, privat. Plugin-Market später ebenfalls privat |
| A | Zustandsänderungen | Claude entscheidet (siehe `plan.md`, Architektur) |
| B | Auth | Login und Session liegen in der PHP-API |
| C | Dashboard-Rendering | User unsicher, Claude schlägt vor (siehe `plan.md`) |

Reihenfolge laut User: erst Dashboard, dann API, dann Bot.

## Dashboard-UI (2026-09-28)

- Vorlage ist der Screenshot des Users. Stil 1:1 übernehmen, nichts Neues erfinden.
- Layout: Sidebar mit Logo „BH“, Bot-Auswahl, Suche, einklappbarem ADMIN-Bereich
  (Overview, Plugin Manager, Core Runner, Users & Roles, Logs, SDK Policies, Settings), unten User + Logout.
  Topbar mit Titel, Start Tour, Sprache, Glocke.
- Das vorher gewünschte Admin-Popup ist durch den Screenshot ersetzt (Admin-Bereich direkt in der Sidebar).
- Dashboard: Kacheln „Bots online“, „RAM aktuell“, „Ø RAM (24 h)“, darunter Bot-Kacheln und eine leere Kachel „Bot hinzufügen“.
- Bot-Farben: läuft = grün, offline = rot, Fehler = gelb.
- Bot hinzufügen: Popup nur mit Token. Name und ID holt die API von Discord.
- Keine vollen Reloads: `hx-boost` für Navigation, Änderungen tauschen nur Teile der Seite aus, Kacheln aktualisieren sich per Polling.
- RAM-Diagramm liegt unter Admin → Overview.

## Secrets (2026-09-28)

- User-Vorgabe: Bot-Tokens dürfen über die Webseite niemals sichtbar sein.
- Bot-Tokens werden **verschlüsselt** gespeichert (AES-256-GCM, Schlüssel aus ENV `BOTHUB_SECRET_KEY` oder `/data/secret.key`).
  Hashen geht nicht: Der Bot braucht den Klartext für den Discord-Login.
- Zusätzlich ein Fingerabdruck als HMAC-SHA-256 mit Salt, um doppelte Tokens zu erkennen, ohne zu entschlüsseln.
- Die API gibt Tokens nie zurück (`tokenSet: true`), loggt sie nicht, und sie landen nie in Cookies, HTML oder URLs.
- Das Admin-Passwort wird mit Argon2id gehasht (mit Salt).
- Die Session speichert nur die ID des gewählten Bots, nie den Token.

## Plugin-Market (2026-09-29)

- Market: `github.com/Kljub/bothub_market` (privat), 18 Plugins im v2-Format.
- Entscheidung: **nicht 1:1 übernehmen** (Weg B). Jedes Plugin wird auf V3 umgebaut:
  - Migrationen nach SQLite.
  - Dashboard-Seiten als Templates **nur mit den globalen Klassen** (`dashboard/ui/DESIGN.md`), damit alles einheitlich aussieht.
  - `index.js` gegen das V3-Plugin-SDK (Child-Prozess, RPC, Permissions).
- `manifest.json` bleibt die Grundlage (Name, Version, Icon, Beschreibung, Changelog, `requires`, `moduleGroup`).

## Cores und Nutzer (2026-09-28)

- Cores bleiben weg. Kein „Core Runner“ im UI (Entscheidung 5 gilt weiter).
- Ändert die Vorgabe „genau ein User“: Es dürfen weitere Nutzer angelegt werden (Admin → Users & Roles).
  Der erste Nutzer entsteht weiter über Setup-Wizard oder ENV. Keine Selbstregistrierung.
- Offen: Umfang der Rollen (siehe `context/questions.md`).

## Plugins und SDK (2026-09-30)

- Plugins werden **global** installiert (eine Version für alle Bots), nicht pro Bot. Pro Bot kann ein Plugin nur abgeschaltet werden (Tabelle `bot_plugin_disabled`). Ersetzt Entscheidung 6 („pro Bot installiert").
- **SDK Policies** (Admin): eine Tabelle mit An/Aus pro SDK-Recht, global für alle Bots und Plugins (Tabelle `sdk_policies`). Standard: Risiko niedrig = an, mittel und hoch = aus.
- Ein Plugin nutzt ein Recht nur, wenn es im Manifest steht **und** in den SDK Policies an ist. Keine Bestätigung pro Bot.
- API-Fläche des SDK: Liste des Users (29 Bereiche) plus `module.*` (BotHub-Module lesen, Recht `modules.read`, Risiko mittel, weil Modul-Einstellungen Zugangsschlüssel enthalten können). Katalog: `shared/sdk-permissions.json`, Stand: `sdk/API.md`.
- Plugins haben nie direkten Zugriff auf DB, Bot-Token, Umgebung oder Netzwerk; alles läuft über den SDK-Manager im Bot (RPC mit Prüfung).


## 2026-10-03: Node Editor is no longer a module

The user decided: the "Node Editor" module (custom nodes for the builder) is
removed from the modules. It will come back later as a plugin. Migration 0023
deletes its module rows and its SDK rule (`modules.node-editor.read`).
