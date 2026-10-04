import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from '../core/db.js';
import { Repo } from '../core/repo.js';
import { Run, definitions, GraphError } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { daysUntil, moduleHandlers, parseBirthday } from './handlers-modules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function repo(): Repo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'bothub-hm-')), 'bothub.sqlite'));
  const dir = join(root, 'api', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.exec("INSERT INTO bots (id, name) VALUES (1, 'Bot')");
  return new Repo(db);
}

const limits = { maxNodes: 500, maxEdges: 2000, maxSteps: 1000, maxLoopIterations: 100, maxRuntimeMs: 10_000, maxDiscordCallsPerRun: 50 };

async function block(r: Repo, type: string, config: Record<string, unknown>, vars: Record<string, string> = {}): Promise<Run> {
  const types = ['trigger.slash', type];
  const defs = definitions(types.map((t) => ({ type: t, category: t.startsWith('trigger') ? 'trigger' : 'action' })));
  const handlers = moduleHandlers(r, 1);
  const nodes: GraphNode[] = [
    { id: 't', type: 'trigger.slash', typeVersion: 1, config: {} },
    { id: 'b', type, typeVersion: 1, config: { variable: 'R', ...config } },
  ];
  const run = new Run({ schemaVersion: 1, nodes, edges: [{ from: { node: 't', port: 'next' }, to: { node: 'b', port: 'in' } }] }, { defs, handlers, limits, match: () => false }, { guild: { id: '900000000000000001' } } as never, { 'user.id': '100000000000000001', ...vars });
  const res = await run.start();
  if (!res.ok) throw new GraphError(res.errorKey ?? 'failed');
  return run;
}

test('birthday dates', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  assert.deepEqual(parseBirthday('24.12.', now), { day: 24, month: 12, year: null });
  assert.deepEqual(parseBirthday('24.12.1990', now), { day: 24, month: 12, year: 1990 });
  assert.deepEqual(parseBirthday('1990-12-24', now), { day: 24, month: 12, year: 1990 });
  assert.deepEqual(parseBirthday('29/02', now), { day: 29, month: 2, year: null });
  for (const bad of ['31.02.', '13.13.', 'tomorrow', '1.1.2030', '29.02.2023']) assert.throws(() => parseBirthday(bad, now), bad);
  assert.equal(daysUntil(9, 30, now), 0);
  assert.equal(daysUntil(10, 2, now), 2);
  assert.equal(daysUntil(9, 29, now), 364);
});

test('leveling and birthday blocks', async () => {
  const r = repo();
  await block(r, 'action.leveling_edit_xp', { xp_mode: 'set', amount: 450 });
  await block(r, 'action.leveling_edit_xp', { user: '100000000000000002', xp_mode: 'add', amount: 900 });
  const rank = await block(r, 'action.leveling_get_rank', {});
  assert.deepEqual([rank.vars.get('R.level'), rank.vars.get('R.xp'), rank.vars.get('R.rank')], ['3', '450', '2']);
  await block(r, 'action.leveling_edit_xp', { xp_mode: 'remove', amount: 1000 });
  assert.equal((await block(r, 'action.leveling_get_rank', {})).vars.get('R.xp'), '0');
  const board = await block(r, 'action.leveling_leaderboard', { limit: 5 });
  assert.match(board.vars.get('R') ?? '', /^\*\*1\.\*\* <@100000000000000002> · Level \d+ · 900 XP/);

  await block(r, 'action.birthday_set', { date: '24.12.' });
  const list = await block(r, 'action.birthday_list', {});
  assert.match(list.vars.get('R') ?? '', /<@100000000000000001> · 24\.12\./);
  await block(r, 'action.birthday_remove', {});
  assert.equal((await block(r, 'action.birthday_list', {})).vars.get('R'), '—');
  await assert.rejects(block(r, 'action.birthday_set', { date: '99.99.' }));
});

test('invite blocks', async () => {
  const r = repo();
  const add = r.db.prepare("INSERT INTO invite_joins (bot_id, guild_id, user_id, inviter_id, fake, left_at) VALUES (1, '900000000000000001', ?, '100000000000000001', ?, ?)");
  add.run('a', 0, null);
  add.run('b', 0, null);
  add.run('c', 1, null);
  add.run('d', 0, '2026-01-01');
  const got = await block(r, 'action.invites_get', {});
  assert.deepEqual([got.vars.get('R.total'), got.vars.get('R.left')], ['2', '1']);
  assert.match((await block(r, 'action.invites_leaderboard', {})).vars.get('R') ?? '', /<@100000000000000001> · 2 invites/);
  await block(r, 'action.invites_reset', {});
  assert.equal((await block(r, 'action.invites_get', {})).vars.get('R.total'), '0');
});

test('economy: give items, stats and cooldowns', async () => {
  const r = repo();
  r.db.prepare("INSERT INTO bot_modules (bot_id, module_key, enabled, config) VALUES (1, 'economy', 1, ?)").run(JSON.stringify({ shop: [{ key: 'gem', name: 'Gem', price: 10, allowMultiple: true, type: 'static' }] }));
  const G = '900000000000000001';
  r.db.prepare("INSERT INTO economy_inventory (bot_id, guild_id, user_id, item, qty) VALUES (1, ?, '100000000000000001', 'gem', 3)").run(G);
  const give = await block(r, 'action.economy_give_item', { from_user: '{user.id}', to_user: '100000000000000002', item: 'Gem', amount: '2' });
  assert.deepEqual([give.vars.get('R'), give.vars.get('R.qty')], ['Gem', '2']);
  await assert.rejects(block(r, 'action.economy_give_item', { from_user: '{user.id}', to_user: '100000000000000002', item: 'gem', amount: '2' }));
  const stats = await block(r, 'action.economy_stats', { user: '100000000000000002' });
  assert.equal(stats.vars.get('R.items'), '2');
  await block(r, 'action.economy_daily', {});
  const cd = await block(r, 'action.economy_cooldowns', {});
  assert.notEqual(cd.vars.get('R.daily'), '0');
  assert.match(cd.vars.get('R') ?? '', /Daily bonus: <t:\d+:R>/);
});
