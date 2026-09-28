# BotHub V3 – Plan

Stand: 2026-09-28 · **Plan vom User freigegeben (2026-09-28)** · Entscheidungen: `context/decisions.md` · Übergabe: `HANDOVER_NEUBAU.md`

Status: `⬜ Offen` · `🔄 In Bearbeitung` · `✅ Fertig` (erst nach „approved“ vom User)

---

## 1. Architektur

### Prozesse (ein AMP-Container, in der Entwicklung docker-compose)

| Dienst | Sprache | Aufgabe | Port |
|---|---|---|---|
| `dashboard` | Go | Web-UI, liefert Seiten aus, leitet `/api/*` an die API weiter | **8080 (einziger öffentlicher Port)** |
| `api` | PHP (FrankenPHP + Slim 4) | REST-API, Auth, Access-Middleware, DB-Migrationen | 9000 (nur intern) |
| `bot` | Node (TypeScript, discord.js v14) | Lädt alle Bots in einem Prozess, führt Commands und Module aus | keiner |
| `redis` | – | Cache, Streams (Events zwischen API und Bot) | 6379 (nur intern) |

Im AMP-Image laufen alle vier unter `supervisord`. In der Entwicklung ist jeder Dienst ein eigener Container. Adressen kommen nur aus ENV (`API_URL`, `REDIS_URL`, `DATA_DIR`), damit beide Varianten ohne Codeänderung laufen.

### Datenordner (ein Mount für AMP)

```
/data
├── bothub.sqlite      # Haupt-DB (WAL-Modus)
├── redis/             # Redis AOF
├── plugins/           # installierte Plugins
├── uploads/           # Bilder, Anhänge
└── logs/
```

### Zustandsänderungen (Frage A)

- **Die API ist der einzige Weg für Konfigurationsänderungen.** Das Dashboard schreibt nie direkt in die DB.
- Die API schreibt die Änderung und das Event **in derselben SQLite-Transaktion** (Tabelle `outbox`).
- Ein Outbox-Relay (PHP-CLI-Prozess) überträgt offene Events in einen **Redis Stream** (`bothub:events`) und markiert sie als gesendet. Fällt Redis aus, bleiben die Events in der `outbox` und werden später nachgeliefert.
- Der Bot liest den Stream als Consumer-Group, lädt betroffene Konfiguration neu und bestätigt das Event (`XACK`).
- Aktionen, die Discord brauchen (z.B. Nachricht senden, Plugin in Bot laden), sind Jobs im Stream `bothub:jobs`. Der Bot meldet das Ergebnis in `bothub:results`, die API liest es.
- Streams statt Pub/Sub, weil Events bei einem Bot-Neustart nicht verloren gehen.
- Der Bot schreibt nur Laufzeitdaten in die DB (Economy-Guthaben, XP, Tickets, Logs), nie Konfiguration.

### Schema und JSON-Spalten

- **Nur die API** führt Migrationen aus. Der Bot startet erst, wenn die Schema-Version passt.
- API und Bot schreiben beide in SQLite. Regeln: `journal_mode=WAL`, `busy_timeout=5000`, Schreib-Transaktionen mit `BEGIN IMMEDIATE` und kurz halten, kein Netzwerk-Aufruf innerhalb einer Transaktion.
- JSON-Spalten sind `TEXT` mit `CHECK (json_valid(...))`. Geparst wird ausschließlich in der Repository-Schicht von API und Bot, nirgends sonst.

### Auth und Zugriff (Frage B)

- Genau ein User. Beim ersten Start zeigt das Dashboard den Setup-Wizard, alternativ ENV `BOTHUB_ADMIN_USER` / `BOTHUB_ADMIN_PASSWORD`.
- Session liegt in der API (Cookie `HttpOnly`, `SameSite=Strict`, Session-Daten in Redis).
- Das Dashboard reicht das Cookie nur weiter und prüft keine Rechte selbst.
- **Eine zentrale Middleware** in der API prüft Login und den Zugriff auf Bot, Guild und Plugin. Kein Check pro Endpoint.
- CSRF-Token für alle ändernden Requests (htmx sendet ihn als Header), neue Session-ID nach dem Login, Rate-Limit für den Login (Zähler in Redis).

### Dashboard-Rendering (Frage C)

Vorschlag: **Go `html/template` + htmx**, ohne SPA.

- Kein Node-Build für das Dashboard. Templates, CSS und JS werden per `embed` in die Go-Binary gepackt.
- htmx lädt Teilbereiche nach, ohne ganze Seite neu zu laden.
- Nur der Command Builder (Node-Editor) ist eine eigene JS-Insel. Dafür eine kleine Editor-Library ohne Build (z.B. Drawflow).
- Kein Inline-Handler (`onclick=`), nur Event-Listener. Daten für JS kommen über `data-*`-Attribute, die `html/template` automatisch escaped.

### i18n

- Alle UI-Texte sind Keys in `lang/<code>.json`. Englisch ist Default.
- Die API liefert Fehler als Key (`error.bot.not_found`), das Dashboard übersetzt.

---

## 2. Kernidee: Alle Commands im Builder (Frage 3)

- Jeder Command ist ein **Graph** (JSON: Nodes + Verbindungen), gespeichert in der DB.
- Der Bot hat einen **Graph-Interpreter** und führt jeden Command darüber aus. Es gibt keine hardcoded Command-Logik mehr.
- Die eingebauten Commands aus v2 (ca. 75: Moderation, Economy, Music, Giveaways …) werden als **Standard-Graphen** mitgeliefert. Der User kann sie ändern und auf Standard zurücksetzen.
- Die Module (Economy, Leveling, Tickets …) stellen ihre Funktionen als **Builder-Nodes** bereit, z.B. `economy.add_balance` oder `leveling.get_rank`.
- Plugins können eigene Nodes registrieren.
- Node-Definitionen sind JSON-Schemas (wie in v2 `web/functions/builder/nodes/*.json`). Dashboard, API und Bot lesen dieselben Dateien, damit Editor und Interpreter nicht auseinanderlaufen.
- Das Graph-Format hat eine **Schema-Version** und Migrationen für alte Graphen. Ein- und Ausgänge der Nodes sind typisiert, die API prüft Typen beim Speichern.
- Grenzen im Interpreter: keine Zyklen (Schleifen nur über einen eigenen Loop-Node mit Obergrenze), maximale Schrittzahl und Zeitlimit pro Ausführung.
- Das Graph-Format wird festgelegt, **bevor** Editor und Interpreter gebaut werden (Teil von Phase 0).

---

## 3. Plugins (Frage 6)

- Plugins werden **pro Bot** installiert und aktiviert.
- Jedes Plugin deklariert seine **Permissions** (z.B. `discord.send_messages`, `db.own_tables`, `http.outbound`). Der User bestätigt sie pro Bot bei der Installation.
- Isolation: Jedes Plugin läuft als **eigener Child-Prozess** mit dem Node-Permission-Model (`--permission`, Dateizugriff nur auf den eigenen Plugin-Ordner) und einem Speicherlimit. Zugriff auf Discord und DB nur über eine RPC-Schnittstelle, die die Permissions prüft. Ein `worker_thread` reicht nicht, weil er denselben Prozess teilt.
- Der Market ist ein privates GitHub-Repo. Plugins werden aus dem Quellordner hochgeladen, nicht aus dem Installationsordner.
- Der Market-Index enthält einen SHA-256-Hash pro Plugin-Version. Die API prüft ihn vor der Installation. Abhängigkeiten werden per Lockfile gepinnt.
- Versionierung: Patch = `0.0.X`, Bugfix = `0.X.0`, Feature/Update = `X.0.0`.

---

## 4. Module und Status

### Phase 0 – Grundgerüst

| Modul | Status |
|---|---|
| Repo-Struktur, `.gitignore`, `.editorconfig` | 🔄 In Bearbeitung |
| `docker-compose.yml` für die Entwicklung (dashboard, api, bot, redis) | 🔄 In Bearbeitung |
| All-in-One-`Dockerfile` mit `supervisord` (AMP-Ziel) | ⏸ Zurückgestellt mit Phase 5 |
| API-Vertrag `api/openapi.yaml` (Grundlage für Dashboard und API) | 🔄 In Bearbeitung |
| Graph-Format für Commands (`shared/graph.schema.json`, `shared/node-definition.schema.json`, Version 1) | 🔄 In Bearbeitung |

### Phase 1 – Dashboard (Go)

| Modul | Status |
|---|---|
| Server, Routing, Templates, statische Dateien per `embed` | ⬜ Offen |
| Layout, Navigation, Theming | ⬜ Offen |
| i18n-Loader, `lang/en.json`, `lang/de.json` | ⬜ Offen |
| Reverse-Proxy `/api/*` zur API | ⬜ Offen |
| Setup-Wizard und Login-Seite | ⬜ Offen |
| Bot-Verwaltung (Liste, Anlegen, Token, Start/Stop) | ⬜ Offen |
| Guild-Übersicht und Modul-Schalter pro Guild | ⬜ Offen |
| Command Builder (Editor-Insel) | ⬜ Offen |
| Modul-Seiten (je Modul eine Seite, siehe Phase 4) | ⬜ Offen |
| Plugin-Verwaltung pro Bot (Installieren, Permissions) | ⬜ Offen |

Bis die API steht, arbeitet das Dashboard gegen einen Mock, der aus `openapi.yaml` erzeugt wird.

### Phase 2 – API (PHP)

| Modul | Status |
|---|---|
| FrankenPHP + Slim 4, Config aus ENV | ⬜ Offen |
| SQLite-Verbindung (WAL), Migrationen, Schema-Version | ⬜ Offen |
| Redis: Cache, Session, Streams | ⬜ Offen |
| Auth, Setup-Wizard, zentrale Access-Middleware | ⬜ Offen |
| Endpoints Bots, Guilds, Modul-Status | ⬜ Offen |
| Endpoints Commands (Graphen speichern, validieren, zurücksetzen) | ⬜ Offen |
| Endpoints Plugins (Market, Installation pro Bot, Permissions) | ⬜ Offen |
| Endpoints je Modul | ⬜ Offen |

### Phase 3 – Bot (Node)

| Modul | Status |
|---|---|
| Bot-Manager: alle Bots in einem Prozess, Start/Stop pro Bot | ⬜ Offen |
| Stream-Consumer (Events, Jobs, Results) | ⬜ Offen |
| Graph-Interpreter für Commands | ⬜ Offen |
| Slash-Command-Registrierung aus den Graphen | ⬜ Offen |
| Embed/Payload-Validierung gegen discord.js-Typen (keine Felder verwerfen) | ⬜ Offen |
| Plugin-Runtime (`worker_threads`, RPC, Permission-Checks) | ⬜ Offen |

### Phase 4 – Module aus v2

Jedes Modul liefert: DB-Tabellen, API-Endpoints, Dashboard-Seite, Builder-Nodes, Standard-Graphen für seine Commands.

| Modul | Status | Modul | Status |
|---|---|---|---|
| achievements | ⬜ | modmail | ⬜ |
| analytics | ⬜ | music | ⬜ |
| automod | ⬜ | polls | ⬜ |
| autoreact | ⬜ | reaction-roles | ⬜ |
| auto-responder | ⬜ | reddit-notifs | ⬜ |
| birthday | ⬜ | starboard | ⬜ |
| counting | ⬜ | statistic-channels | ⬜ |
| custom-events | ⬜ | sticky-messages | ⬜ |
| economy | ⬜ | sticky-roles | ⬜ |
| forum-tagger | ⬜ | suggestions | ⬜ |
| free-games | ⬜ | temp-voice | ⬜ |
| github-notifs | ⬜ | ticket | ⬜ |
| giveaway | ⬜ | timed-events | ⬜ |
| invite-tracker | ⬜ | timed-messages | ⬜ |
| kick-notifs | ⬜ | twitch-notifs | ⬜ |
| leavemer | ⬜ | twitter-linkfix | ⬜ |
| leveling | ⬜ | verification | ⬜ |
| message-builder | ⬜ | warnings | ⬜ |
| message-logger | ⬜ | welcommer | ⬜ |
| moderation (Commands) | ⬜ | youtube-notifs | ⬜ |
| server-management (Commands) | ⬜ | | |

Reihenfolge der Module legt der User fest.

### Phase 5 – AMP-Template

Zurückgestellt (User, 2026-09-28). Die Architektur bleibt trotzdem AMP-tauglich: ein Datenordner, Adressen nur aus ENV, ein öffentlicher Port.

| Modul | Status |
|---|---|
| `.kvp`, `config.json`, `metaconfig.json`, `ports.json`, `updates.json` | ⬜ Offen |
| Test in AMP-Instanz | ⬜ Offen |

---

## 5. Offen

- Codex-Review des Plans erledigt (2026-09-28). Übernommen: Outbox, SQLite-Schreibregeln, Graph-Grenzen, Child-Prozesse für Plugins, CSRF/Rate-Limit, Hash-Prüfung. Verworfen: Plugin-Signaturen (eigenes privates Repo, ein User) und Redis-Betrieb im AMP-Image (Phase 5 zurückgestellt).
- Weitere nicht blockierende Fragen: `context/questions.md`.
