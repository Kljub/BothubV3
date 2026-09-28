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
