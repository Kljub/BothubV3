#!/usr/bin/env node
// Checks plugins the way the BotHub install does, plus what only shows at
// runtime: bothub.json schema, SDK permissions, layer files, texts,
// commands, sounds, handlers (scripts/lib/check.mjs).
//   npm run validate                all plugins
//   npm run validate -- plugin_weather   one plugin
import { join } from 'node:path';
import { check } from './lib/check.mjs';
import { pluginIds, pluginsDir } from './lib/plugins.mjs';

let failed = 0;
for (const id of await pluginIds(process.argv.slice(2))) {
  const errors = await check(join(pluginsDir, id));
  if (errors.length) {
    failed++;
    console.error(`✖ ${id}\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  } else console.log(`✔ ${id}`);
}
process.exit(failed ? 1 : 0);
