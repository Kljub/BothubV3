#!/usr/bin/env node
// Runs the tests of every plugin in the market repo (each in its own folder,
// so "#sdk-testing" resolves through the plugin's package.json).
//   npm test                 all plugins
//   npm test -- plugin_weather    one plugin
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginIds, pluginsDir } from './lib/plugins.mjs';

// The plugins' consistency test imports the checker from here.
const env = { ...process.env, BOTHUB_MARKET_CHECK: fileURLToPath(new URL('./lib/check.mjs', import.meta.url)) };
let failed = 0;
for (const id of await pluginIds(process.argv.slice(2))) {
  const dir = join(pluginsDir, id);
  if (!existsSync(join(dir, 'test'))) continue;
  const r = spawnSync(process.execPath, ['--test', 'test/*.test.js'], { cwd: dir, stdio: 'inherit', env });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
