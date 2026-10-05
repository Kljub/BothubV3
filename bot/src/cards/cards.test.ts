import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardRenderer, renderDesign } from './cards.js';

const shared = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'shared');

test('cards: every template draws to a PNG of its size, placeholders filled', async () => {
  await cardRenderer(shared);
  const { templates } = JSON.parse(readFileSync(join(shared, 'cards', 'templates.json'), 'utf8')) as { templates: Record<string, { width: number; height: number }> };
  for (const [kind, design] of Object.entries(templates)) {
    const png = await renderDesign(design, { 'user.display': 'Tom', 'user.name': 'tom', server: 'Srv', 'member.ordinal': '5th', boosts: '3', milestone: '1000', level: '2', rank: '1', xp: '10', 'xp.next': '100', 'level.progress': '10' });
    assert.equal(png.subarray(1, 4).toString(), 'PNG', kind);
    assert.equal(png.readUInt32BE(16), design.width, `${kind} width`);
    assert.equal(png.readUInt32BE(20), design.height, `${kind} height`);
  }
  const r = await cardRenderer(shared);
  const { fill } = r as unknown as { fill: (t: string, v: Record<string, string>) => string };
  assert.equal(fill('{n|short} {n|commas} {x}', { n: '1234567' }), '1.2m 1,234,567 {x}');
});
