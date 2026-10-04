---
title: Ein Plugin entwickeln
summary: Aufbau, SDK, Tests und Veröffentlichen im Marketplace.
---
Ein Plugin ist ein Ordner mit Manifest, JavaScript-Code und Texten. Es läuft in einem eigenen Prozess und spricht mit dem Bot nur über das **SDK** (`ctx`).

## Aufbau

```
plugin_meinplugin/
  bothub.json     Manifest: ID, Version, SDK-Rechte, Commands, Nodes, Services
  index.js        verbindet die Schichten: Blöcke, Komponenten, Events, Tasks
  nodes/          Builder-Blöcke: <name>.json (Definition) + <name>.js (Handler)
  commands/       Slash-Commands als Command-Builder-Graphen
  services/       die Logik des Plugins
  dashboard/      settings.json (Einstellungsseite)
  lang/           en.json, de.json
  test/           node:test-Tests mit dem SDK-Testkit
```

## Die Werkzeuge

Im BotHub-Repository, `sdk/market`:

```
npm run create -- meinplugin --features nodes,commands,storage
npm run validate -- plugin_meinplugin
npm test -- plugin_meinplugin
npm run pack -- plugin_meinplugin
npm run index
```

`validate` macht dieselben Prüfungen wie die Installation. `pack` baut das Zip, `index` den Katalog `index.json`.

## Das SDK

`ctx` bietet Speicher, Einstellungen (`ctx.config`, auch Dropdowns, die das Plugin mit `ctx.config.setOptions` füllt), Discord-Aufrufe (Nachrichten, Mitglieder, Rollen, Channels, Interaktionen, Voice), die Economy, Data-Storage-Variablen, Dateien, HTTP an angegebene Hosts und `ctx.http.secret` für Secrets. Jeder Aufruf braucht sein SDK-Recht; die vollständige Liste steht in `sdk/API.md` im BotHub-Repository.

> [!TIP]
> Ein Plugin bekommt nie den Bot-Token, keinen Datenbankzugriff und kein freies Netzwerk. Frag so wenige Rechte wie möglich an: der Admin sieht sie vor dem Installieren.

## Veröffentlichen

1. `version` in `bothub.json` erhöhen, `npm run check` ausführen.
2. `npm run pack` und `npm run index`.
3. GitHub-Release `plugin_x-<version>` mit dem Zip anlegen und `index.json` committen.
