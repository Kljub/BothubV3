#!/usr/bin/env node
// Builds index.json, the market index the BotHub API reads
// (BOTHUB_MARKET_INDEX): every zip in dist/ with id, version, URL and SHA-256.
// The zips are assets of GitHub Releases (tag <id>-<version>) of the market
// repo; index.json is written into the market repo root.
// Old versions stay listed as long as their zip is in dist/.
//   npm run index            write index.json
//   npm run index -- --check fail when index.json is not up to date (CI)
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from './lib/check.mjs';
import { distDir, marketDir, pluginsDir } from './lib/plugins.mjs';

const BASE = process.env.MARKET_BASE_URL ?? 'https://github.com/Kljub/BothubMarketPlace/releases/download';
const ZIP = /^(plugin_[a-z0-9_]{1,57})-(\d{1,4}\.\d{1,4}\.\d{1,6})\.zip$/;

const plugins = [];
for (const file of existsSync(distDir) ? (await readdir(distDir)).sort() : []) {
  const m = ZIP.exec(file);
  if (!m) continue;
  const [, id, version] = m;
  const bytes = await readFile(join(distDir, file));
  const entry = { id, version, url: `${BASE}/${id}-${version}/${file}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  if (existsSync(join(pluginsDir, id, 'bothub.json'))) {
    const { bothub: b, manifest: man } = await normalize(join(pluginsDir, id));
    if (man.version === version) {
      Object.assign(entry, {
        name: man.name, description: man.description, developer: b.developer, license: b.license ?? '',
        icon: b.icon ?? '', category: b.category ?? 'utility',
        sdk: { version: man.sdk, permissions: man.permissions }, ...(man.secrets?.length ? { secrets: man.secrets } : {}),
        layers: {
          commands: man.commands.length, events: man.events.length, services: man.tasks.length + man.secrets.length,
          nodes: man.blocks.length, dashboard: man.settings ? 1 : 0,
        },
        voice: man.permissions.includes('discord.voice.speak'),
      });
    }
  }
  plugins.push(entry);
}
const index = JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + '\n';
const path = join(marketDir, 'index.json');

if (process.argv.includes('--check')) {
  const current = existsSync(path) ? await readFile(path, 'utf8') : '';
  if (current !== index) {
    console.error('index.json is not up to date: run "npm run pack" and "npm run index"');
    process.exit(1);
  }
  console.log(`index.json up to date (${plugins.length} entries)`);
} else {
  await writeFile(path, index);
  console.log(`index.json: ${plugins.length} entries`);
}
