#!/usr/bin/env node
// Packs plugins into dist/<id>-<version>.zip and prints the SHA-256.
//   npm run pack                 all plugins
//   npm run pack -- plugin_weather    one plugin
// The zip holds the plugin folder without test/, node_modules and dotfiles.
// Same files -> same bytes, so a version's hash never changes by accident.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distDir, LIMITS, packFiles, pluginIds, pluginsDir, readJson, TEMPLATE, zip } from './lib/plugins.mjs';

await mkdir(distDir, { recursive: true });
let failed = false;
for (const id of (await pluginIds(process.argv.slice(2))).filter((p) => p !== TEMPLATE)) {
  try {
    const dir = join(pluginsDir, id);
    const m = await readJson(join(dir, 'bothub.json'));
    const entries = await packFiles(dir);
    if (entries.length > LIMITS.files) throw new Error(`more than ${LIMITS.files} files`);
    const bytes = await zip(entries);
    if (bytes.length > LIMITS.zipBytes) throw new Error('zip is larger than 5 MB');
    const name = `${m.id}-${m.version}.zip`;
    await writeFile(join(distDir, name), bytes);
    console.log(`${name}  ${entries.length} files  ${bytes.length} bytes  sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
  } catch (err) {
    failed = true;
    console.error(`${id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
