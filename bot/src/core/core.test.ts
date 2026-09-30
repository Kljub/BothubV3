import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb, schemaVersion, waitForSchema } from './db.js';
import { Repo, type CommandRow } from './repo.js';
import { decrypt, encrypt } from './secrets.js';
import { buildCommands, denied, permissionBit, settingsOf } from '../discord/commands.js';
import { discordHandlers } from '../discord/handlers.js';
import { coreHandlers } from '../graph/handlers-core.js';
import type { Graph } from '../graph/types.js';

// Tests run from bot/dist/core; the repo root is three levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const migrations = join(root, 'api', 'migrations');
const shared = join(root, 'shared');

function migratedDb(): { path: string; repo: Repo } {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-bot-'));
  const path = join(dir, 'bothub.sqlite');
  const db = openDb(path);
  const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
  for (const [i, f] of files.entries()) {
    db.exec('BEGIN');
    db.exec(readFileSync(join(migrations, f), 'utf8'));
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return { path, repo: new Repo(db) };
}

const presets = (JSON.parse(readFileSync(join(shared, 'command-presets.json'), 'utf8')) as { commands: { name: string; description: string; graph: Graph }[] }).commands;
const asRow = (p: { name: string; description: string; graph: Graph }, id: number): CommandRow => ({
  id, kind: 'command', name: p.name, description: p.description, builtin: false, moduleKey: null, eventType: null, graph: p.graph,
});

test('moderation presets only use blocks the bot runs', () => {
  const handlers = new Map([...coreHandlers({ vars: { get: () => undefined, set: () => undefined, delete: () => undefined }, logError: () => undefined }), ...discordHandlers({} as Repo)]);
  const passive = /^(trigger|option|condition|utility)\./;
  for (const p of presets as { module?: string; name: string; graph: Graph }[]) {
    if (p.module !== 'moderation') continue;
    for (const n of p.graph.nodes) {
      if (passive.test(n.type) || n.type === 'action.note') continue;
      assert.ok(handlers.has(n.type), `${p.name}: ${n.type} has no handler`);
    }
  }
});

test('token encryption round trip, tampering fails', () => {
  const key = randomBytes(32);
  const blob = encrypt(key, 'my.bot.token');
  assert.equal(decrypt(key, blob), 'my.bot.token');
  blob[20] = blob[20]! ^ 1;
  assert.throws(() => decrypt(key, blob));
  assert.throws(() => decrypt(randomBytes(32), encrypt(key, 'x')));
});

test('waits for the expected schema version', async () => {
  const { path } = migratedDb();
  const expected = (JSON.parse(readFileSync(join(shared, 'db-schema.json'), 'utf8')) as { version: number }).version;
  const db = await waitForSchema(path, expected);
  assert.equal(schemaVersion(db), expected);
  await assert.rejects(waitForSchema(path, expected - 1), /newer than this bot build/);
});

test('every command preset becomes a valid application command', () => {
  const body = buildCommands(presets.map(asRow));
  const names = body.map((c) => c.name as string);
  assert.equal(new Set(names).size, names.length, 'top-level names are unique');
  for (const c of body) {
    assert.match(c.name as string, /^[a-z0-9_-]{1,32}$/);
    assert.ok((c.description as string).length >= 1 && (c.description as string).length <= 100);
    const opts = (c.options ?? []) as { required?: boolean; type: number }[];
    const firstOptional = opts.findIndex((o) => o.required === false);
    if (firstOptional >= 0) assert.ok(opts.slice(firstOptional).every((o) => o.required === false), `${c.name}: required options first`);
  }
  // "ticket open" style names become subcommands of one command.
  const ticket = body.find((c) => c.name === 'ticket')!;
  const subs = (ticket.options as { name: string; type: number }[]).map((o) => o.name);
  assert.ok(subs.includes('setup') && subs.includes('close') && subs.includes('update-counts'));
  assert.ok((ticket.options as { type: number }[]).every((o) => o.type === 1));
  const role = body.find((c) => c.name === 'role')!;
  const action = (role.options as { name: string; choices?: { value: string }[] }[])[0]!;
  assert.deepEqual(action.choices!.map((x) => x.value), ['add', 'remove']);
});

test('permission names map to Discord bits', () => {
  assert.equal(typeof permissionBit('manage_guild'), 'bigint');
  assert.equal(typeof permissionBit('send_tts_messages'), 'bigint');
  assert.equal(permissionBit('fly'), undefined);
});

test('permissions block denies banned roles, channels and missing roles', () => {
  const member = (roles: string[], perms: bigint[] = []) =>
    ({ guild: { id: '1' }, roles: { cache: new Map(roles.map((r) => [r, {}])) }, permissions: { has: (b: bigint) => perms.includes(b) } }) as never;
  const s = { ...settingsOf(asRow(presets[0]!, 1)).permissions, required_permissions: [], allowed_roles: [{ id: 'everyone' }] };
  assert.equal(denied(s, member([]), '5'), null);
  assert.equal(denied({ ...s, banned_channels: [{ id: '5' }] }, member([]), '5'), 'channel');
  assert.equal(denied({ ...s, banned_roles: [{ id: '9' }] }, member(['9']), '5'), 'banned_role');
  assert.equal(denied({ ...s, allowed_roles: [{ id: '7' }] }, member(['8']), '5'), 'role');
  assert.equal(denied({ ...s, allowed_roles: [{ id: '7', guild: '2' }] }, member(['8']), '5'), null, 'roles of other servers do not count');
  assert.equal(denied({ ...s, required_permissions: ['kick_members'] }, member([]), '5'), 'permission');
  assert.equal(denied({ ...s, required_permissions: ['kick_members'] }, member([], [permissionBit('kick_members')!]), '5'), null);
});

test('repository: commands, variables, economy, warnings, guilds', () => {
  const { repo } = migratedDb();
  const db = repo.db;
  db.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 1)").run();
  const botId = 1;
  const graph = JSON.stringify(presets[0]!.graph);
  db.prepare("INSERT INTO commands (bot_id, name, graph) VALUES (1, 'purge', ?)").run(graph);
  db.prepare("INSERT INTO commands (bot_id, name, graph, enabled) VALUES (1, 'off', ?, 0)").run(graph);
  db.prepare("INSERT INTO commands (bot_id, kind, name, graph, event_type) VALUES (1, 'event', 'Welcome', ?, 'member_join')").run(graph);
  assert.deepEqual(repo.commands(botId, 'command').map((c) => c.name), ['purge']);
  assert.equal(repo.commands(botId, 'event')[0]!.eventType, 'member_join');

  const vars = repo.varStore(botId);
  vars.set('user', '1:2', 'coins', '5');
  vars.set('user', '1:2', 'coins', '6');
  assert.equal(vars.get('user', '1:2', 'coins'), '6');
  vars.delete('user', '1:2', 'coins');
  assert.equal(vars.get('user', '1:2', 'coins'), undefined);

  assert.equal(repo.changeBalance(botId, 'g', 'a', 100, 'add'), 100);
  assert.equal(repo.changeBalance(botId, 'g', 'a', -500, 'add'), 0, 'never below zero');
  repo.changeBalance(botId, 'g', 'a', 50, 'set');
  assert.equal(repo.pay(botId, 'g', 'a', 'b', 80), false, 'not enough');
  assert.equal(repo.pay(botId, 'g', 'a', 'b', 20), true);
  assert.deepEqual(repo.leaderboard(botId, 'g', 5), [{ userId: 'a', balance: 30 }, { userId: 'b', balance: 20 }]);

  repo.addWarning(botId, 'g', 'u', 'mod', 'spam');
  repo.addWarning(botId, 'g', 'u', 'mod', 'caps');
  assert.equal(repo.warnings(botId, 'g', 'u').length, 2);
  assert.equal(repo.clearWarnings(botId, 'g', 'u'), 2);

  repo.syncGuilds(botId, [{ id: '1', name: 'A', iconUrl: null, memberCount: 3 }, { id: '2', name: 'B', iconUrl: null, memberCount: 4 }]);
  repo.syncGuilds(botId, [{ id: '2', name: 'B2', iconUrl: null, memberCount: 5 }]);
  const rows = db.prepare('SELECT guild_id, name, left_at FROM bot_guilds ORDER BY guild_id').all() as { guild_id: string; name: string; left_at: string | null }[];
  assert.equal(rows[0]!.left_at !== null, true, 'guild 1 left');
  assert.deepEqual([rows[1]!.name, rows[1]!.left_at], ['B2', null]);

  repo.setBotStatus(botId, 'error', 'log.code.ERR-1001');
  repo.logCode(botId, 'ERR-1005', { command: 'purge', reason: 'x' });
  repo.logUpdate(botId, 'log.update.bot_started', { name: 'Test' });
  assert.deepEqual((db.prepare('SELECT level FROM logs WHERE bot_id = 1 ORDER BY id').all() as { level: string }[]).map((r) => r.level), ['error', 'update']);
});

test('events the bot delivers exist in shared/events.json', () => {
  const catalog = JSON.parse(readFileSync(join(shared, 'events.json'), 'utf8')) as { categories: { events: { key: string }[] }[] };
  const known = new Set(catalog.categories.flatMap((c) => c.events.map((e) => e.key)));
  const source = readFileSync(join(root, 'bot', 'src', 'discord', 'events.ts'), 'utf8') + readFileSync(join(root, 'bot', 'src', 'discord', 'instance.ts'), 'utf8');
  const used = [...source.matchAll(/type: (?:after\.\w+ \? )?'([a-z_]+)'(?: : '([a-z_]+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean) as string[];
  const fromHelpers = [...source.matchAll(/(?:reaction|fromMessage)\('([a-z_]+)'/g)].map((m) => m[1]!);
  for (const key of [...used, ...fromHelpers]) assert.ok(known.has(key), `unknown event key ${key}`);
  assert.ok(used.length + fromHelpers.length > 25);
});

test('bot queues: same bot in order, different bots side by side', async () => {
  const { BotManager } = await import('./manager.js');
  const m = new BotManager({} as never, {} as never, () => Buffer.alloc(32));
  const log: string[] = [];
  const slow = (tag: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => (log.push(tag), r()), ms));
  const a1 = m.enqueue(1, slow('bot1-start', 60));
  const a2 = m.enqueue(1, slow('bot1-reload', 1));
  const b1 = m.enqueue(2, slow('bot2-start', 10));
  const failing = m.enqueue(3, () => Promise.reject(new Error('x')));
  const afterFail = m.enqueue(3, slow('bot3-next', 1));
  await Promise.allSettled([a1, a2, b1, failing, afterFail]);
  assert.deepEqual(log, ['bot3-next', 'bot2-start', 'bot1-start', 'bot1-reload']);
});
