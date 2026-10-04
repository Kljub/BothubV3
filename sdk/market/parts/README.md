# Plugin template

`scripts/create.mjs` builds a plugin from `base/` plus the chosen folders of
`features/`. Placeholders `__ID__`, `__NAME__`, `__DESCRIPTION__`,
`__DEVELOPER__`, `__URL_SECRET__` and `__KEY_SECRET__` are replaced in every `.js`, `.json` and
`.md` file.

```
base/                       always: bothub.json, lang, services/util.js, test/plugin.test.js
features/<name>/
  feature.json              title, description, needs, permissions,
                            nodes, commands, events, tasks, secrets, settings
  nodes/<n>.json + <n>.js   nodes the feature brings
  events/<event>.js         event handlers
  services/<name>.js        services (helpers, tasks, API, voice)
  commands/<name>.json      command graphs
  lang/en.json, de.json     texts, merged into the plugin's lang files
  test/<name>.test.js       tests with #sdk-testing
  sounds/                   other files are copied as they are
```

From all chosen features `create` writes `bothub.json` (permissions as a
set, nodes/commands/events/secrets as sets, tasks by name),
`dashboard/settings.json` (settings fields by key), `lang/*.json` and
`index.js` (imports of every node, event and the tasks service). Two
features must never bring the same file or the same setting key; the new
plugin is validated right after it is created.

Services other than `tasks.js` are plain modules: nodes and events import
what they need (e.g. `nodes/play_sound.js` imports `services/voice.js`);
`index.js` only imports nodes, events and `services/tasks.js`.

## Add a feature

1. Create `features/<name>/` with the files above.
2. Add `<name>` to `ORDER` in `scripts/create.mjs`.
3. `npm run create -- try_it --features <name> && npm run validate -- plugin_try_it && npm test`,
   then delete the `plugin_try_it` folder in the market repo.
