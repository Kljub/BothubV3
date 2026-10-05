import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardRenderer, cardVars, renderDesign } from './cards.js';

const shared = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'shared');

test('cards: every template draws to a PNG of its size, placeholders filled', async () => {
  await cardRenderer(shared);
  const { templates } = JSON.parse(readFileSync(join(shared, 'cards', 'templates.json'), 'utf8')) as { templates: Record<string, { width: number; height: number }> };
  for (const [kind, design] of Object.entries(templates)) {
    const png = await renderDesign(design, { 'user.display': 'Kljub', 'user.name': 'kljub', server: 'Srv', 'member.ordinal': '5th', boosts: '3', milestone: '1000', level: '2', rank: '1', xp: '10', 'xp.next': '100', 'level.progress': '10' });
    assert.equal(png.subarray(1, 4).toString(), 'PNG', kind);
    assert.equal(png.readUInt32BE(16), design.width, `${kind} width`);
    assert.equal(png.readUInt32BE(20), design.height, `${kind} height`);
  }
  const r = await cardRenderer(shared);
  const { fill } = r as unknown as { fill: (t: string, v: Record<string, string>) => string };
  assert.equal(fill('{n|short} {n|commas} {x}', { n: '1234567' }), '1.2m 1,234,567 {x}');
});

test('cards: member placeholders and uploaded pictures', async () => {
  const v = cardVars({ guildName: 'Srv', guildId: '1', members: 1203, userId: '2', userName: 'kljub', display: 'Kljub', avatar: '', createdAt: Date.now() - 3 * 86_400_000, joinedAt: null });
  assert.equal(v['member.ordinal'], '1,203rd');
  assert.equal(v['account.days'], '3');
  assert.equal(cardVars({ ...{ guildName: '', guildId: '', userId: '', userName: '', display: '', avatar: '', createdAt: 0, joinedAt: null }, members: 12 })['member.ordinal'], '12th');
  await cardRenderer(shared);
  const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  let asked = 0;
  const out = await renderDesign({ width: 200, height: 100, background: { type: 'image', image: 'asset:7' }, layers: [] }, {}, (id) => { asked = id; return png1; });
  assert.equal(asked, 7);
  assert.equal(out.subarray(1, 4).toString(), 'PNG');
});

test('cards: {card} in a message attaches the made card; the name leaves the text', async () => {
  const { attachCards } = await import('../discord/handlers.js');
  const png = Buffer.from('x');
  const files = new Map([['card-1.png', png], ['card-2.png', png]]);
  const p: Record<string, unknown> = { content: 'Welcome! attachment://card-1.png', embeds: [{ image: { url: 'attachment://card-2.png' } }] };
  attachCards(p, files);
  assert.equal(p.content, 'Welcome!');
  assert.deepEqual((p.files as { name: string }[]).map((f) => f.name), ['card-1.png', 'card-2.png']);
  const q: Record<string, unknown> = { content: 'no card here' };
  attachCards(q, files);
  assert.equal(q.files, undefined);
});
