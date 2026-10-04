#!/usr/bin/env node
// Copies the current SDK test kit into test/lib/ of every plugin in the
// market repo (BOTHUB_MARKET_DIR, default ../BothubMarketPlace).
//   npm run sync-sdk                 all plugins
//   npm run sync-sdk -- plugin_weather    one plugin
import { join } from 'node:path';
import { installTestKit, pluginIds, pluginsDir } from './lib/plugins.mjs';

for (const id of await pluginIds(process.argv.slice(2))) {
  await installTestKit(join(pluginsDir, id));
  console.log(`✔ ${id}: test/lib updated`);
}
