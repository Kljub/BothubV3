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
import { moduleHandlers } from '../discord/handlers-modules.js';
import { extraHandlers } from '../discord/handlers-extra.js';
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

test('module presets only use blocks the bot runs', () => {
  const handlers = new Map([
    ...coreHandlers({ vars: { get: () => undefined, set: () => undefined, delete: () => undefined }, logError: () => undefined }),
    ...discordHandlers({} as Repo),
    ...moduleHandlers({} as Repo, 1),
  ]);
  const passive = /^(trigger|option|condition|utility)\./;
  for (const p of presets as { module?: string; name: string; graph: Graph }[]) {
    for (const n of p.graph.nodes) {
      if (passive.test(n.type) || n.type === 'action.note') continue;
      assert.ok(handlers.has(n.type), `${p.module}/${p.name}: ${n.type} has no handler`);
    }
  }
});

// Modules whose command copies are still empty (trigger and options only). Shrinks to [].
const PRESETS_WITHOUT_LOGIC = new Set(['polls', 'giveaways', 'ticket-system', 'modmail', 'free-games', 'music']);

test('every module command copy has logic in the builder', () => {
  for (const p of presets as unknown as { module: string; name: string; graph: Graph }[]) {
    const logic = p.graph.nodes.some((n) => /^(action|condition)\./.test(n.type));
    if (PRESETS_WITHOUT_LOGIC.has(p.module)) continue;
    assert.ok(logic, `${p.module}/${p.name} has no blocks after the trigger`);
    assert.ok(p.graph.edges.some((e) => e.from.node === 'trigger' && e.from.port === 'next'), `${p.module}/${p.name}: trigger is not connected`);
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

test('subcommands win over a plain command of the same name, in any order', () => {
  const slash = (name: string, id: number) => asRow({ name, description: name, graph: { schemaVersion: 1, nodes: [{ id: 't', type: 'trigger.slash', typeVersion: 1, config: { command_name: name, description: name } }], edges: [] } as unknown as Graph }, id);
  for (const rows of [[slash('emoji-menu', 1), slash('emoji-menu show', 2), slash('emoji-menu add', 3)], [slash('emoji-menu show', 2), slash('emoji-menu', 1), slash('emoji-menu add', 3)]]) {
    const body = buildCommands(rows);
    assert.equal(body.length, 1);
    assert.deepEqual((body[0]!.options as { name: string; type: number }[]).map((o) => [o.name, o.type]), [['show', 1], ['add', 1]]);
  }
});

test('every command preset becomes a valid application command', () => {
  const body = buildCommands(presets.map(asRow));
  const names = body.map((c) => c.name as string);
  assert.equal(new Set(names).size, names.length, 'top-level names are unique');
  for (const c of body) {
    // Context menu commands (type 2, 3) have a free name of 1-32 characters and no description.
    if (c.type === 2 || c.type === 3) {
      assert.ok((c.name as string).length >= 1 && (c.name as string).length <= 32);
      continue;
    }
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
  // DM Commands module: every command is offered in DMs too.
  assert.ok(body.every((c) => JSON.stringify(c.contexts) === '[0]'), 'presets: servers only');
  assert.ok(buildCommands(presets.map(asRow), undefined, true).every((c) => JSON.stringify(c.contexts) === '[0,1]'), 'module on: DMs too');
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

  // A currency that allows debts: removing goes below 0, paying still needs the money.
  repo.syncCurrencies(botId, [{ key: 'coins', name: 'Coins', emoji: '' }, { key: 'karma', name: 'Karma', emoji: '', allowNegative: true }]);
  assert.equal(repo.changeBalance(botId, 'g', 'a', -40, 'add', 'karma'), -40, 'below zero allowed');
  assert.equal(repo.changeBalance(botId, 'g', 'a', -5, 'set', 'karma'), -5);
  assert.equal(repo.pay(botId, 'g', 'a', 'b', 1, 'karma'), false, 'no paying with debts');
  assert.equal(repo.changeBalance(botId, 'g', 'a', -500, 'add', 'coins'), 0, 'other currency still stops at 0');

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

test('a secret placeholder ([NULL]) has no value', async () => {
  const { secretValue } = await import('./secrets-global.js');
  const repo = (blob: Uint8Array | undefined) => ({ db: { prepare: () => ({ get: () => (blob ? { value_enc: blob } : undefined) }) } }) as never;
  const key = () => { throw new Error('no decrypt for a placeholder'); };
  assert.equal(secretValue(repo(new Uint8Array()), key, 1, 'PLEX_KEY'), null);
  assert.equal(secretValue(repo(undefined), key, 1, 'NOPE'), null);
});

test('closed invites: null while open, else the allowed servers', () => {
  const { repo } = migratedDb();
  repo.db.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 0)").run();
  assert.equal(repo.guildAccess(1), null);
  repo.db.prepare('UPDATE bots SET invites_closed = 1 WHERE id = 1').run();
  repo.db.prepare("INSERT INTO bot_allowed_guilds (bot_id, guild_id) VALUES (1, '100000000000000001')").run();
  assert.deepEqual([...repo.guildAccess(1)!], ['100000000000000001']);
});

test('stats: counted in memory, written per hour, active users once, old hours purged', async () => {
  const { StatsCollector, hourOf } = await import('./stats.js');
  const { repo } = migratedDb();
  repo.db.exec("INSERT INTO bots (id, name) VALUES (1, 'Bot')");
  const s = new StatsCollector(repo.db);
  const t = Date.parse('2026-10-04T12:30:00Z');
  s.add(1, 'G', 'messages', 1, t);
  s.add(1, 'G', 'messages', 2, t);
  s.add(1, null, 'messages', 5, t);
  s.active(1, 'G', 'U', t);
  s.active(1, 'G', 'U', t);
  s.flush(t);
  s.add(1, 'G', 'messages', 1, t);
  s.flush(t);
  assert.equal((repo.db.prepare("SELECT value FROM bot_stats WHERE metric = 'messages'").get() as { value: number }).value, 4);
  assert.equal(hourOf(t), '2026-10-04T12');
  assert.equal((repo.db.prepare('SELECT COUNT(*) AS n FROM bot_stat_users').get() as { n: number }).n, 1);
  // 40 days later the old hour is gone.
  s.add(1, 'G', 'joins', 1, t + 40 * 86_400_000);
  s.flush(t + 40 * 86_400_000 + 7_200_000);
  assert.equal((repo.db.prepare("SELECT COUNT(*) AS n FROM bot_stats WHERE metric = 'messages'").get() as { n: number }).n, 0);
});

test('economy commands offer the currencies of the settings as choices', () => {
  const pay = presets.find((p) => p.name === 'economy-add')!;
  const sources = { currencies: [{ name: '🪙 Coins', value: 'coins' }, { name: 'Social Credit', value: 'socialcredit' }] };
  const body = buildCommands([asRow(pay, 1)], undefined, false, sources);
  const cur = (body[0]!.options as { name: string; required: boolean; choices?: { name: string; value: string }[] }[]).find((o) => o.name === 'currency')!;
  assert.equal(cur.required, false, 'empty: the default currency');
  assert.deepEqual(cur.choices?.map((c) => c.value), ['coins', 'socialcredit']);
});

test('role limits: owner limits from the role, admins have none, activity is tracked', () => {
  const { repo } = migratedDb();
  const db = repo.db;
  db.prepare("UPDATE roles SET limits = ? WHERE key = 'member'").run(JSON.stringify({ maxRunning: 2, idleStopHours: 24, junk: 'x' }));
  db.prepare("UPDATE roles SET limits = ? WHERE key = 'admin'").run(JSON.stringify({ maxRunning: 0 }));
  const role = (key: string) => (db.prepare('SELECT id FROM roles WHERE key = ?').get(key) as { id: number }).id;
  db.prepare("INSERT INTO users (id, username, password_hash, role_id) VALUES (1, 'admin', 'x', ?), (2, 'ann', 'x', ?)").run(role('admin'), role('member'));
  assert.deepEqual(repo.ownerLimits(1), { maxRunning: null, idleStopHours: null }, 'admins have no limits');
  assert.deepEqual(repo.ownerLimits(2), { maxRunning: 2, idleStopHours: 24 });
  assert.deepEqual(repo.ownerLimits(99), { maxRunning: null, idleStopHours: null });
  db.exec("INSERT INTO bots (id, name, owner_id) VALUES (5, 'Bot', 2)");
  assert.equal(repo.bot(5)?.ownerId, 2);
  assert.equal(repo.lastActive(5), 0);
  repo.touchBot(5, Date.parse('2026-10-01T10:00:00Z'));
  repo.touchBot(5, Date.parse('2026-10-01T10:01:00Z')); // throttled
  assert.equal(repo.lastActive(5), Date.parse('2026-10-01T10:00:00Z'));
});

test('playbacks: last 10 runs per command, failed ones kept, a click updates its run', () => {
  const { repo } = migratedDb();
  const db = repo.db;
  db.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 1)").run();
  db.prepare("INSERT INTO commands (bot_id, name, graph) VALUES (1, 'ping', '{\"schemaVersion\":1,\"nodes\":[],\"edges\":[]}')").run();
  const base = { botId: 1, commandId: 1, source: 'slash', userId: '1', userName: 'kljub', guildId: null, guildName: null, channelId: null, channelName: null, errorNode: null, errorKey: null, errorHint: null, errorText: null, startVars: { user: 'kljub' }, steps: [{ node: 't', type: 'trigger.slash', status: 'ok' }], warnings: [] };
  repo.saveTrace({ ...base, runKey: 'bad', ok: false, errorNode: 'n1', errorKey: 'error.run.discord', errorHint: { key: 'discord.50013', text: 'x', fix: 'y', params: {} } });
  for (let i = 0; i < 15; i++) repo.saveTrace({ ...base, runKey: `ok${i}`, ok: true });
  const rows = db.prepare('SELECT run_key, ok FROM run_traces ORDER BY id').all() as { run_key: string; ok: number }[];
  assert.equal(rows.length, 11);
  assert.equal(rows[0]!.run_key, 'bad');
  // A click on the run's button: same row, still failed when the first part failed.
  repo.saveTrace({ ...base, runKey: 'bad', ok: true, source: 'button', steps: [{ node: 't' }, { node: 'b' }] });
  const bad = db.prepare("SELECT ok, source, error_key, json_array_length(steps) AS n FROM run_traces WHERE run_key = 'bad'").get() as { ok: number; source: string; error_key: string; n: number };
  assert.deepEqual({ ...bad }, { ok: 0, source: 'button', error_key: 'error.run.discord', n: 2 });
  assert.equal(repo.errorMuted(1, 'n1', 'error.run.discord'), false);
  db.prepare("INSERT INTO run_error_mutes (command_id, node_id, error_key) VALUES (1, 'n1', 'error.run.discord')").run();
  assert.equal(repo.errorMuted(1, 'n1', 'error.run.discord'), true);
});

test('every block of the palette has a handler in the bot', () => {
  const handlers = new Map([
    ...coreHandlers({ vars: { get: () => undefined, set: () => undefined, delete: () => undefined }, logError: () => undefined }),
    ...discordHandlers({} as Repo),
    ...moduleHandlers({} as Repo, 1),
    ...extraHandlers({ repo: {} as Repo, secret: () => null }),
  ]);
  const passive = /^(trigger|option|condition|utility|component)\./;
  const missing = readdirSync(join(shared, 'nodes'))
    .map((f) => JSON.parse(readFileSync(join(shared, 'nodes', f), 'utf8')) as { type: string; palette?: boolean })
    .filter((d) => d.palette !== false && !passive.test(d.type) && d.type !== 'action.note' && !handlers.has(d.type))
    .map((d) => d.type);
  assert.deepEqual(missing, []);
});

test('usage variables of the bot overview: top active members, voice, commands, plugins', async () => {
  const { usageVar, hourOf } = await import('./stats.js');
  const { repo } = migratedDb();
  const db = repo.db;
  db.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 1)").run();
  const now = Date.UTC(2026, 9, 8, 12);
  const h = (ago: number) => hourOf(now - ago * 3_600_000);
  const addUser = db.prepare('INSERT INTO bot_stat_users (bot_id, guild_id, hour, user_id) VALUES (1, ?, ?, ?)');
  for (let i = 0; i < 3; i++) addUser.run('g1', h(i), '111111111111111111');
  addUser.run('g1', h(0), '222222222222222222');
  addUser.run('g2', h(0), '333333333333333333');
  const add = db.prepare('INSERT INTO bot_stats (bot_id, guild_id, hour, metric, value) VALUES (1, ?, ?, ?, ?)');
  add.run('g1', h(1), 'voice_minutes', 45);
  add.run('g1', h(1), 'commands', 7);
  add.run('g1', h(1), 'cmd:ping', 5);
  add.run('g1', h(1), 'cmd:help', 2);
  add.run('g2', h(1), 'plugin_uses', 4);
  add.run('g1', h(24 * 40), 'voice_minutes', 999); // older than 30 days
  const v = (name: string, g: string | null = 'g1') => usageVar(db, 1, g, name, now);
  assert.equal(v('bot.active_users'), '1. <@111111111111111111> · 3 h\n2. <@222222222222222222> · 1 h');
  assert.equal(v('bot.Active_Users.1'), '<@111111111111111111>');
  assert.equal(v('bot.active_users.2.id'), '222222222222222222');
  assert.equal(v('bot.active_users.5'), '');
  assert.equal(v('bot.active_users.length'), '2');
  assert.equal(v('bot.active_users.count', null), '3');
  assert.equal(v('bot.total_voice_minutes'), '45');
  assert.equal(v('bot.commands_usage'), '7');
  assert.equal(v('bot.commands_usage.top'), '1. /ping · 5\n2. /help · 2');
  assert.equal(v('bot.plugin_usage'), '0');
  assert.equal(v('bot.plugin_usage', null), '4');
  assert.equal(v('bot.nope'), undefined);
});

test('privileged intents from the application flags', async () => {
  const { intentsOf } = await import('../discord/instance.js');
  assert.deepEqual(intentsOf(0), { presence: false, members: false, messageContent: false });
  assert.deepEqual(intentsOf((1 << 13) | (1 << 14) | (1 << 19)), { presence: true, members: true, messageContent: true });
  assert.deepEqual(intentsOf(1 << 15), { presence: false, members: true, messageContent: false });
});

test('redis URL gets the password of KEYS_DIR/redis.pass', async () => {
  const { redisUrlOf } = await import('./config.js');
  const pass = () => 'p@ss';
  assert.equal(redisUrlOf({ REDIS_URL: 'redis://redis:6379', KEYS_DIR: '/keys' }, pass), 'redis://:p%40ss@redis:6379');
  assert.equal(redisUrlOf({ REDIS_URL: 'redis://:x@redis:6379', KEYS_DIR: '/keys' }, pass), 'redis://:x@redis:6379');
  assert.equal(redisUrlOf({ REDIS_URL: 'redis://redis:6379' }, pass), 'redis://redis:6379');
  assert.equal(redisUrlOf({ REDIS_URL: 'redis://redis:6379', KEYS_DIR: '/keys' }, () => null), 'redis://redis:6379');
});
