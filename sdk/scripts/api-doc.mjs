// Writes sdk/API.md from shared/sdk-permissions.json: every SDK call, the
// permission it needs and whether the bot answers it today.
// Run: node sdk/scripts/api-doc.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cat = JSON.parse(readFileSync(join(root, 'shared', 'sdk-permissions.json'), 'utf8'));
// Answered in the plugin process itself (bot/src/sdk/host/host.ts).
const local = new Set(['plugin.getInfo', 'plugin.getId', 'plugin.getVersion', 'plugin.getConfig', 'plugin.isEnabled', 'plugin.getPath', 'plugin.getManifest',
  'config.get', 'config.has', 'config.getAll', 'utils.uuid', 'utils.random', 'utils.hash', 'utils.formatDate', 'utils.formatDuration', 'utils.formatNumber']);

const rows = [];
const status = (call, implemented) => (local.has(call) || implemented.includes(call) ? '✅' : '🕓 planned');
for (const call of cat.core.calls) rows.push([call, 'core (always)', '', status(call, cat.core.implemented)]);
// Per-module entries (scope "module") share the module.* calls of modules.read: listed once, below.
for (const p of cat.permissions) if (p.scope !== 'module') for (const call of p.calls) rows.push([call, p.scope ? p.key : p.key === 'modules.read' ? 'modules.read or modules.<module>.read' : p.key, p.risk, status(call, p.implemented)]);

const byArea = new Map();
for (const r of rows) {
  const area = r[0].split('.')[0];
  if (!byArea.has(area)) byArea.set(area, []);
  byArea.get(area).push(r);
}
const done = rows.filter((r) => r[3] === '✅').length;
let md = `# BotHub SDK v1: API\n\nGenerated from \`shared/sdk-permissions.json\` by \`sdk/scripts/api-doc.mjs\`; do not edit by hand.\n\n`;
md += `Call a function as \`ctx.<area>.<name>(...)\`. A call needs its permission declared in \`bothub-plugin.json\` and switched on in the SDK policies (admin). `;
md += `Planned calls exist already and answer \`sdk.call.not_available\`.\n\n**Status:** ${done} of ${rows.length} calls available.\n\n`;
md += `Events (\`discord.events\`, \`bothub.events\`): ${cat.permissions.filter((p) => p.events).map((p) => p.events.join(', ')).join('; ')}.\n\n`;
for (const [area, list] of byArea) {
  md += `## ${area}\n\n| Call | Permission | Risk | Status |\n|---|---|---|---|\n`;
  for (const [call, perm, risk, st] of list) md += `| \`${call}()\` | ${perm} | ${risk} | ${st} |\n`;
  md += '\n';
}
writeFileSync(join(root, 'sdk', 'API.md'), md);
console.log(`API.md: ${done}/${rows.length} available`);
