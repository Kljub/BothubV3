# Übergabe: BotHub-Neubau (für Claude Code auf dem PC)

> Diese Datei stammt von der Claude-Instanz auf dem Server (Stand 2026-09-28).
> Lies sie komplett, bevor du irgendetwas tust. Arbeite die Abschnitte der Reihe nach ab.

---

## 0. Was du als Erstes tun sollst

1. Diese Datei lesen.
2. **Abschnitt 5 „Offene Fragen“** dem User stellen. Bevor die beantwortet sind, kein Code.
3. Setup aus **Abschnitt 3** prüfen bzw. einrichten (Codex-Bridge, Token-Settings).
4. Danach einen Plan schreiben (`plan.md` im Projekt), mit Status pro Modul (`⬜ Offen` / `🔄 In Bearbeitung` / `✅ Fertig`).
5. Den Plan per `/codex` von ChatGPT reviewen lassen, danach dem User zur Freigabe geben.

---

## 1. Worum es geht

BotHub ist ein selbst gehosteter Discord-Bot-Manager mit Web-Dashboard. Er läuft bisher auf dem Server unter `/mnt/4TBNvme/BotHub`. Der User will ihn **komplett neu bauen**, weil neue Features die bisherige Architektur sprengen würden. Das alte Projekt bleibt nur als Referenz und wird nicht migriert.

### Feste Anforderungen

| Punkt | Entscheidung |
|---|---|
| Ort | Neuer Ordner auf dem **PC des Users** (nicht auf dem Server) |
| Login | **Genau ein User.** Keine Registrierung, keine Rollen, keine Teams, kein „CoWork“. Einrichtung beim ersten Start (Setup-Wizard oder ENV) |
| Entwicklung | Docker (lokal mit docker-compose) |
| Ziel-Deployment | Später **AMP-Template** (CubeCoders) |
| Tokens | Sparsam arbeiten (siehe Abschnitt 3) |

### AMP-Einschränkungen (wichtig für die Architektur)

- Eine AMP-Instanz ist **ein einziger Container**. Kein docker-compose, keine Multi-Container-Stacks.
- Du brauchst also ein **All-in-One-Image**. Alle Prozesse (Web, Bot, Worker, Redis, ggf. DB) laufen darin unter einem Prozess-Manager (`supervisord` oder `s6-overlay`).
- Ein eigenes Image wird im Template über `Meta.SpecificDockerImage` in der `.kvp` gesetzt. Template-Dateien: `.kvp`, `config.json`, `metaconfig.json`, `ports.json`, `updates.json` (Vorbild: GitHub `CubeCoders/AMPTemplates`).
- Alle persistenten Daten müssen in **einem** Datenordner liegen, den AMP mountet. Sonst sind sie beim Update weg.
- **Kein `/var/run/docker.sock`.** Das alte BotHub hat Plugins in eigenen Docker-Containern isoliert. Unter AMP geht das nicht, also Plugins z.B. als Child-Prozesse oder Worker-Threads mit Sandbox.
- Nur wenige Ports (am besten einer für das Web-Dashboard, der Bot braucht keinen eingehenden Port).

Das docker-compose für die Entwicklung soll so gebaut sein, dass das Ergebnis ohne Umbau in ein einzelnes Image passt.

### Speicher

- Der User wollte ursprünglich **nur Redis**. Die Empfehlung vom Server war **SQLite als Haupt-DB + Redis als Cache/Queue**. Gründe: Redis hat keine Abfragen, Joins oder Constraints, bei einem Crash drohen Datenverluste (Economy, Tickets, Levels), und SQLite ist eine einzelne Datei, die sich leicht sichern lässt.
- **Noch nicht entschieden.** Siehe Frage 2 in Abschnitt 5.

---

## 2. Feature-Bestand aus dem alten Projekt (Referenz)

Nicht 1:1 kopieren. Der User entscheidet, was in den Neubau kommt und was neu dazukommt.

**Native Module (alt: `core/src/services/*`):**
achievements, analytics, automod, autoreact, auto-responder, birthday, counting, custom-commands, custom-events, economy, forum-tagger, free-games, github-notifs, giveaway, honeypot, invite-tracker, kick-notifs, leavemer, leveling, message-builder, message-logger, modmail, music, polls, reaction-roles, reddit-notifs, starboard, statistic-channels, sticky-messages, sticky-roles, suggestions, temp-voice, ticket, timed-events, timed-messages, twitch-notifs, twitter-linkfix, verification, warnings, welcommer, youtube-notifs

**Weitere Kernsysteme (alt):**
- Command Builder (visueller Node-Editor für eigene Commands)
- Plugin-System mit SDK (Capabilities, Access Policies, Dashboard-Extensions, Service-Registry, Voice-SDK)
- Plugin Store (Install/Uninstall über GitHub)
- Mehrere Bots und mehrere Guilds, Modul-Status pro Guild
- i18n (DE/EN/RU u.a., Crowdin), Englisch als Default
- Instanz-Theming

**Plugins (alt, Quelle `createPlugnis/`):**
AIChat, AICommandBuilder, AniSearch, AniworldDownloader, ArcEnCiel, BetterIntegrations, Casino, Criminal, DeadByDaylight, DiscordServerBackup, EasyAPI, Eco, EmojiManager, FarbRoles, GlobalChat, Helldivers, JustWatch, MakeItLicense, MediaChannels, Minesweeper, Plex, QuestionOfTheDay, RPS, SocialLinking, Soundboard, StableDiffusion, TempAttachments, Translation, Weather, WebsiteStatusChecker, Work

### Lehren aus dem alten Projekt (im Neubau vermeiden)

- **Zugriffskontrolle zentral.** Im alten Projekt fehlten bei ~25 Modul-APIs Access-Checks, und es gab eine IDOR-Lücke. Im Neubau: eine Middleware, keine Checks pro Endpoint.
- **Kein roher `JSON.stringify()` in HTML-Attributen** (`onclick="..."`). Das Attribut bricht dann ohne jede Fehlermeldung. Immer escapen, besser Event-Listener statt Inline-Handler.
- **Embed/Payload-Normalizer** dürfen unbekannte Felder nicht still verwerfen (alt: `author` und `messageReference` gingen verloren). Gegen die discord.js-Typen validieren.
- **JSON-Spalten:** mysql2 lieferte JSON teils als String, teils als Objekt. Bei SQLite: klar definieren, wo geparst wird.
- **Status-Desync zwischen Web und Bot** (alt: Plugin-Uninstall lief am Core vorbei). Nur **ein** Weg für Zustandsänderungen, über den Bot-Prozess bzw. einen Service.
- **i18n von Anfang an.** Keine hardcoded UI-Texte, Englisch als Default-Sprache.
- **Plugin-Versionierung beim User:** Patch = `0.0.X`, Bugfix = `0.X.0`, Feature/Update = `X.0.0` (nicht Standard-Semver).

---

## 3. Setup auf dem PC

### 3.1 Token sparen

In `~/.claude/settings.json`:

```json
{
  "effortLevel": "high"
}
```

Arbeitsregeln:
- Keine Subagents starten, außer der User verlangt es.
- Dateien gezielt lesen (Ausschnitte), keine ganzen Ordner dumpen.
- Antworten kurz halten, keine langen Logs ausgeben.
- `node_modules`, `vendor`, Build-Ordner und DB-Dateien nie lesen.

### 3.2 Codex-Bridge (Zusammenarbeit mit ChatGPT)

Codex läuft über den ChatGPT-Login des Users, also sein Abo. **Keine API-Kosten.** Die Codex CLI hat (Stand 0.156.1) keinen MCP-Server-Modus, deshalb läuft die Bridge über den Bash-Aufruf `codex exec`.

Einrichtung:
1. `npm i -g @openai/codex`
2. `codex login` (ChatGPT-Konto wählen)
3. Modell prüfen: In `~/.codex/models_cache.json` stehen die erlaubten Modelle (`"visibility": "list"`). Mit ChatGPT-Login abgelehnt wurden: `gpt-5.4-mini`, `gpt-5.4`, `gpt-5-codex`, `gpt-5.5`. **Funktioniert hat `gpt-5.6-luna`.**
4. `~/.codex/config.toml`:
   ```toml
   model = "gpt-5.6-luna"
   model_reasoning_effort = "low"
   ```
5. Test:
   ```bash
   codex exec -m gpt-5.6-luna --sandbox read-only --ephemeral --skip-git-repo-check -o out.txt "Antworte nur mit: OK"; cat out.txt
   ```
6. Skill anlegen: `~/.claude/skills/codex/SKILL.md` (unter Windows `%USERPROFILE%\.claude\skills\codex\SKILL.md`) mit folgendem Inhalt:

````markdown
---
name: codex
description: Zweitmeinung / Zusammenarbeit mit ChatGPT (OpenAI Codex CLI, ChatGPT-Abo, keine API-Kosten). Nutzen für Plan-Review, Architektur-Kritik, Diff-Review oder wenn User "frag ChatGPT", "codex", "zweite Meinung" sagt. Trigger: /codex
---

# Codex-Bridge (Claude <-> ChatGPT)

Codex läuft über ChatGPT-Login (`auth_mode: chatgpt`) — verbraucht Abo-Kontingent, keine API-Tokens.

## Regeln (Token sparen)
- Nur aufrufen bei: Plan/Architektur-Entscheidung, Review eines fertigen Diffs, festgefahrenem Bug. NICHT für Kleinkram.
- Max 1 Codex-Call pro Thema, max 2 Runden Rückfrage.
- Codex bekommt KEINE ganzen Dateien in den Prompt — nur Pfade. Codex liest selbst (read-only Sandbox, gleicher Ordner).
- Antwort von Codex nur zusammengefasst an User weitergeben, nie roh dumpen.
- Codex schreibt nie Dateien. Umsetzung macht Claude.

## Aufruf

```bash
OUT=$(mktemp); codex exec \
  -m gpt-5.6-luna -c model_reasoning_effort=low \
  --sandbox read-only --ephemeral --skip-git-repo-check \
  -C "<projektordner>" -o "$OUT" "<PROMPT>" >/dev/null 2>&1; cat "$OUT"
```

- `model_reasoning_effort=medium` nur bei Architektur-Fragen.
- Timeout 300000 ms setzen.
- Fehler "model is not supported with ChatGPT account": Modelle in `~/.codex/models_cache.json` prüfen (`visibility: list`).

## Prompt-Vorlage an Codex

```
Rolle: Senior-Reviewer. Du arbeitest mit Claude zusammen, Claude setzt um.
Aufgabe: <Plan-Review | Diff-Review | Bug-Analyse>
Kontext: <2-4 Sätze, was das Ziel ist>
Relevante Dateien: <Pfade>
Claudes Vorschlag: <Kurzfassung>
Antworte auf Deutsch, max 15 Zeilen, nur:
1. Fehler/Risiken (konkret, mit Datei:Zeile)
2. Was du anders machen würdest und warum
3. "OK" wenn nichts Wesentliches
Kein Lob, keine Wiederholung des Vorschlags.
```

## Ablauf
1. Claude formuliert eigenen Vorschlag.
2. Codex reviewt (Vorlage oben).
3. Claude bewertet Einwände selbst — übernimmt nur begründete, sagt User welche verworfen und warum.
````

> Unter Windows ohne WSL: `mktemp` gibt es nicht. Dann eine feste Datei im Temp-Ordner verwenden (z.B. `-o "$env:TEMP\codex-out.txt"` in PowerShell).

---

## 4. Arbeitsweise, die der User erwartet

- Wenn du mit einem Modul anfängst, in `plan.md` den Status auf `🔄 In Bearbeitung` setzen. Sagt der User „approved“, auf `✅ Fertig`.
- Offene Fragen, die dich nicht blockieren, nummeriert in `context/questions.md` schreiben und weiterarbeiten. Unbeantwortete Fragen überspringen.
- Kontext-Notizen zu Features gehören in `context/` im Projekt.
- Neue UI-Texte immer als i18n-Keys, nie hardcoded.
- Plugin-Uploads nach GitHub kommen aus dem Quellordner der Plugins, nicht aus dem Installationsordner.
- Commits und Pushes nur, wenn der User es sagt.

---

## 5. Offene Fragen (zuerst mit dem User klären)

1. **Stack:** Bei der Frage „nur Node/TypeScript oder PHP + Node wie bisher“ hat der User „Alles“ geantwortet. Was ist gemeint? Empfehlung: nur Node/TS, ein Prozess für Bot + Dashboard, weil das am einfachsten in einen AMP-Container passt.
2. **Datenbank:** Nur Redis oder SQLite + Redis-Cache? (Empfehlung: SQLite + Redis, siehe Abschnitt 1.)
3. **Neue Features:** Welche Features „krempeln das Projekt um“? Genaue Liste, weil sie die Architektur bestimmen.
4. **Umfang v1:** Welche Module und Plugins aus Abschnitt 2 kommen in die erste Version?
5. **Mehrere Bots / Guilds:** Bleibt es bei mehreren Bots pro Instanz oder ein Bot pro AMP-Instanz?
6. **Plugins:** Bleibt das Plugin-System mit Store? Wenn ja: welche Isolation ohne Docker-Socket?
7. **Betriebssystem PC:** Windows (mit/ohne WSL), Linux oder macOS? Das betrifft Pfade und Docker Desktop.
8. **Git:** Neues Repo? Öffentlich oder privat, welcher Name?

---

## 6. Status auf dem Server (nur zur Info)

- Das alte BotHub liegt auf dem Server unter `/mnt/4TBNvme/BotHub`. Es hat viele Änderungen, die nicht committet sind. Das Archivieren (Commit + Tag) ist **noch offen** und passiert auf dem Server, nicht auf dem PC.
- Die Codex-Bridge und `effortLevel: high` sind auf dem Server schon eingerichtet und getestet.
