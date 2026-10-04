import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../core/db.js';
import { loadPolicy, PluginManager, type PluginDeps } from './manager.js';
import { parseManifest, readManifest } from './manifest.js';
import { useCatalog } from './catalog.js';
import type { GraphNode } from '../graph/types.js';

// Tests run from bot/dist/sdk; the repo root is three levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const limits = useCatalog(join(root, 'shared', 'sdk-permissions.json')).raw.limits as Record<string, number> as never as ConstructorParameters<typeof PluginManager>[1]['limits'];

function setup(): { db: Db; pluginsDir: string; logs: string[]; manager: PluginManager } {
  const tmp = mkdtempSync(join(tmpdir(), 'bothub-sdk-'));
  const db = openDb(join(tmp, 'bothub.sqlite'));
  const migrations = join(root, 'api', 'migrations');
  for (const f of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrations, f), 'utf8'));
  db.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 0)").run();
  const pluginsDir = join(tmp, 'plugins');
  mkdirSync(pluginsDir);
  const logs: string[] = [];
  fetched.length = 0;
  const deps: PluginDeps = {
    sendMessage: async () => '1',
    guildInfo: async (_b, id) => ({ id, name: 'Home', memberCount: 3 }),
    guildList: async () => [{ id: '100000000000000001', name: 'Home', memberCount: 3 }],
    voice: () => fakeVoice,
    secret: (key) => ({ WEATHER_URL: 'https://api.example.com/v1', LAN_URL: 'http://192.168.1.10:32400', WEATHER_KEY: 's3cr3t-value', OTHER_KEY: 'other-value' })[key] ?? null,
    fetch: (async (url: URL, init: RequestInit) => {
      fetched.push({ url: String(url), init });
      const body = String(url).includes('/big') ? 'x'.repeat(1024 * 1024 + 10) : JSON.stringify({ ok: true, echo: 'token s3cr3t-value' });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } });
    }) as unknown as typeof fetch,
    log: (_bot, level, plugin, text) => void logs.push(`${level} ${plugin} ${text}`),
  };
  const permissions = JSON.parse(readFileSync(join(root, 'shared', 'sdk-permissions.json'), 'utf8')).permissions;
  const manager = new PluginManager(db, { pluginsDir, limits: { ...limits, callTimeoutMs: 3000, blockTimeoutMs: 1500 }, modules: ['moderation', 'economy'], policy: () => loadPolicy(db, permissions) }, deps);
  return { db, pluginsDir, logs, manager };
}

// Installed globally (plugin_installs); permissions come from the SDK policies.
function register(db: Db, id: string): void {
  db.prepare('INSERT INTO plugins (id, version, sha256, manifest) VALUES (?, ?, ?, ?)').run(id, '1.0.0', 'a'.repeat(64), '{}');
  db.prepare('INSERT INTO plugin_installs (plugin_id, version) VALUES (?, ?)').run(id, '1.0.0');
}

function install(db: Db, pluginsDir: string, id: string, files: Record<string, string>): void {
  const dir = join(pluginsDir, id, '1.0.0');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  register(db, id);
}

// A fake run: enough for plugin block handlers.
function fakeRun(vars: Record<string, string>) {
  const results: Record<string, string> = {};
  const run = {
    vars: new Map(Object.entries(vars)),
    str: (node: GraphNode, key: string) => String(node.config[key] ?? ''),
    setResult: (_node: GraphNode, suffix: string, value: unknown) => void (results[suffix] = String(value)),
  };
  return { run: run as never, results };
}
const fetched: { url: string; init: RequestInit }[] = [];
// Fake voice: one guild state; mimics discord/voice.ts (not_connected, busy).
const voiceState = { channelId: null as string | null, playing: false, label: null as string | null, owner: null as string | null, played: [] as string[] };
const fakeVoice = {
  async join(_g: string, c: string) { voiceState.channelId = c; },
  leave() { Object.assign(voiceState, { channelId: null, playing: false, label: null, owner: null }); },
  play(_g: string, input: string, o: { owner: string; label?: string; volume?: number }) {
    if (!voiceState.channelId) throw Object.assign(new Error('sdk.voice.not_connected'), { key: 'sdk.voice.not_connected' });
    if (voiceState.playing && voiceState.owner !== o.owner) throw Object.assign(new Error('sdk.voice.busy'), { key: 'sdk.voice.busy' });
    Object.assign(voiceState, { playing: true, label: o.label ?? null, owner: o.owner });
    voiceState.played.push(`${input.replace(/\\/g, '/').split('/').slice(-2).join('/')}@${o.volume}`);
  },
  stop() { Object.assign(voiceState, { playing: false, label: null, owner: null }); },
  state() { return { channelId: voiceState.channelId, playing: voiceState.playing, label: voiceState.label, owner: voiceState.owner }; },
};
const node = (type: string, config: Record<string, unknown> = {}): GraphNode => ({ id: 'n1', type, typeVersion: 1, config });

test('manifest checks', () => {
  const ok = { id: 'plugin_counter', name: 'C', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage'] };
  assert.equal(parseManifest(ok).id, 'plugin_counter');
  for (const bad of [{ ...ok, main: '../x.js' }, { ...ok, permissions: ['db.raw'] }, { ...ok, sdk: 2 }, { ...ok, id: 'Bad Id' }]) {
    assert.throws(() => parseManifest(bad), /sdk.manifest.invalid/);
  }
});

test('bothub.json is normalized (sdk, services, nodes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-fmt-'));
  mkdirSync(join(dir, 'nodes'));
  writeFileSync(join(dir, 'nodes', 'hello.json'), JSON.stringify({ category: 'action', labelKey: 'Hello' }));
  writeFileSync(join(dir, 'bothub.json'), JSON.stringify({
    schemaVersion: 1, id: 'plugin_fmt', name: 'Fmt', version: '1.2.3', main: 'index.js',
    sdk: { version: 1, permissions: ['storage', 'scheduler', 'secrets.use', 'discord.events'] },
    events: ['guildMemberAdd'], services: { tasks: [{ name: 'daily', cron: '0 9 * * *' }, { name: 'tick', every: '5m' }], secrets: ['WEATHER_KEY'] }, nodes: ['hello'],
  }));
  const m = readManifest(dir);
  assert.deepEqual([m.permissions, m.events, m.secrets, m.tasks.map((t) => t.name)], [['storage', 'scheduler', 'secrets.use', 'discord.events.messages', 'discord.events.members', 'discord.events.server', 'discord.events.voice', 'discord.events.interactions'], ['guildMemberAdd'], ['WEATHER_KEY'], ['daily', 'tick']]);
  assert.equal((m.blocks[0]!.definition as { labelKey: string }).labelKey, 'Hello');
  writeFileSync(join(dir, 'bothub.json'), JSON.stringify({ id: 'plugin_fmt', name: 'F', version: '1.0.0', main: 'index.js', sdk: { version: 1, permissions: [] }, nodes: ['../x'] }));
  assert.throws(() => readManifest(dir), /sdk.manifest.invalid/);
  writeFileSync(join(dir, 'bothub.json'), JSON.stringify({ id: 'plugin_fmt', name: 'F', version: '1.0.0', main: 'index.js', sdk: { version: 1, permissions: [] }, services: { tasks: [{ name: 'x', every: '5m', cron: '* * * * *' }] } }));
  assert.throws(() => readManifest(dir), /sdk.manifest.invalid/);
});

test('example plugin: block runs in its own process and uses storage', async () => {
  const { db, pluginsDir, manager } = setup();
  const src = join(root, 'sdk', 'examples', 'counter');
  cpSync(src, join(pluginsDir, 'plugin_counter', '1.0.0'), { recursive: true });
  register(db, 'plugin_counter');
  try {
    await manager.startBot(1);
    const handler = manager.blockHandlers(1).get('plugin.plugin_counter.count');
    assert.ok(handler, 'block registered');
    assert.equal(manager.blockDefs(1).get('plugin.plugin_counter.count')?.type, 'plugin.plugin_counter.count');
    for (const expected of ['1', '2']) {
      const { run, results } = fakeRun({ 'server.id': '100000000000000001' });
      await handler!(node('plugin.plugin_counter.count', { counter: 'hits', variable: 'n' }), run);
      assert.equal(results[''], expected);
    }
    const row = db.prepare("SELECT value FROM plugin_storage WHERE bot_id = 1 AND plugin_id = 'plugin_counter'").get() as { value: string };
    assert.equal(row.value, '2');
  } finally {
    manager.stopAll();
  }
});

test('sandbox: no files outside, no network, no env, no processes, no ungranted calls', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'plugin_evil', name: 'Evil', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage'], blocks: [{ name: 'probe', definition: {} }] };
  const code = `
    const tryIt = async (fn) => { try { await fn(); return 'allowed'; } catch (e) { return 'blocked'; } };
    export default { blocks: { async probe(ctx) {
      const fs = await import('node:fs');
      return { results: {
        '.read_outside': await tryIt(() => fs.readFileSync(${JSON.stringify(join(pluginsDir, '..', 'bothub.sqlite'))})),
        '.write_own': await tryIt(() => fs.writeFileSync('x.txt', 'x')),
        '.net': await tryIt(() => import('node:net')),
        '.http': await tryIt(() => import('node:http')),
        '.child': await tryIt(() => import('node:child_process')),
        '.worker': await tryIt(() => import('node:worker_threads')),
        '.sqlite': await tryIt(() => import('node:sqlite')),
        '.fetch': typeof globalThis.fetch === 'function' ? 'allowed' : 'blocked',
        '.eval': await tryIt(() => new Function('return 1')()),
        '.env': Object.keys(process.env).length === 0 ? 'blocked' : 'allowed',
        '.binding': await tryIt(() => process.binding('tcp_wrap')),
        '.dlopen': await tryIt(() => process.dlopen({ exports: {} }, 'x.node')),
        '.module': await tryIt(() => import('node:module')),
        '.require_net': await tryIt(async () => { const m = await import('node:module'); m.createRequire(import.meta.url)('net'); }),
        '.send': await tryIt(() => ctx.message.send('100000000000000001', 'hi')),
        '.guild': await tryIt(() => ctx.guild.get('100000000000000001')),
        '.http': await ctx.http.get('https://example.com').then(() => 'allowed', (e) => e.message),
        '.unknown': await ctx.nope.thing().then(() => 'allowed', (e) => e.message),
        '.local': ctx.plugin.getId() === 'plugin_evil' && ctx.utils.uuid().length === 36 ? 'blocked' : 'allowed',
      } };
    } } };`;
  // Only storage declared (on by default): message.send, guild.get and http.get are not declared.
  install(db, pluginsDir, 'plugin_evil', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.plugin_evil.probe')!(node('plugin.plugin_evil.probe'), run);
    for (const k of ['.read_outside', '.write_own', '.net', '.child', '.worker', '.sqlite', '.fetch', '.eval', '.env', '.binding', '.dlopen', '.module', '.require_net', '.send', '.guild', '.local']) {
      assert.equal(results[k], 'blocked', `${k} must be blocked`);
    }
    assert.equal(results['.http'], 'sdk.call.denied', 'http.outbound is not declared');
    assert.equal(results['.unknown'], 'sdk.call.unknown');
  } finally {
    manager.stopAll();
  }
});

test('a hanging block times out and the plugin is restarted', async () => {
  const { db, pluginsDir, manager, logs } = setup();
  const manifest = { id: 'plugin_hang', name: 'Hang', version: '1.0.0', sdk: 1, main: 'index.js', permissions: [], blocks: [{ name: 'loop', definition: {} }] };
  install(db, pluginsDir, 'plugin_hang', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': 'export default { blocks: { loop() { for (;;) {} } } };' });
  try {
    await manager.startBot(1);
    const { run } = fakeRun({});
    await assert.rejects(manager.blockHandlers(1).get('plugin.plugin_hang.loop')!(node('plugin.plugin_hang.loop'), run) as Promise<unknown>, /sdk.plugin.timeout/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(logs.some((l) => l.includes('sdk.plugin.restart')), 'restart logged');
  } finally {
    manager.stopAll();
  }
});

test('SDK policy and per-bot switch', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'plugin_sender', name: 'Sender', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['discord.messages.send'], blocks: [{ name: 'send', definition: {} }] };
  const code = `export default { blocks: { async send(ctx) {
    try { return { results: { '': await ctx.message.send('100000000000000001', 'hi') } }; } catch (e) { return { results: { '': e.message } }; }
  } } };`;
  install(db, pluginsDir, 'plugin_sender', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  const send = async () => {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.plugin_sender.send')!(node('plugin.plugin_sender.send'), run);
    return results[''];
  };
  try {
    await manager.startBot(1);
    assert.equal(manager.blockHandlers(1).get('plugin.plugin_sender.send'), undefined, 'medium risk is off by default: the plugin does not start');
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('discord.messages.send', 1)").run();
    assert.equal(await send(), '1', 'switched on globally');
    db.prepare("INSERT INTO bot_plugin_disabled (bot_id, plugin_id) VALUES (1, 'plugin_sender')").run();
    await manager.startBot(1);
    assert.equal(manager.blockHandlers(1).get('plugin.plugin_sender.send'), undefined, 'switched off for this bot');
  } finally {
    manager.stopAll();
  }
});

test('global storage: one space per plugin for every bot, needs storage.global', async () => {
  const { db, pluginsDir, manager } = setup();
  db.prepare("INSERT INTO bots (id, name) VALUES (2, 'Second')").run();
  const manifest = { id: 'plugin_glob', name: 'Glob', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage', 'storage.global'], blocks: [{ name: 'count', definition: {} }] };
  const code = `export default { blocks: { async count(ctx) {
    return { results: { '.global': String(await ctx.globalStorage.increment('hits')), '.bot': String(await ctx.storage.increment('hits')) } };
  } } };`;
  install(db, pluginsDir, 'plugin_glob', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  const run = async (bot: number) => {
    const { run: r, results } = fakeRun({});
    await manager.blockHandlers(bot).get('plugin.plugin_glob.count')!(node('plugin.plugin_glob.count'), r);
    return results;
  };
  try {
    await manager.startBot(1);
    assert.equal(manager.blockHandlers(1).get('plugin.plugin_glob.count'), undefined, 'storage.global is medium risk: off by default');
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('storage.global', 1)").run();
    await manager.startBot(1);
    await manager.startBot(2);
    assert.deepEqual(await run(1), { '.global': '1', '.bot': '1' });
    assert.deepEqual(await run(2), { '.global': '2', '.bot': '1' }, 'global is shared, bot storage is not');
    const row = db.prepare("SELECT value FROM plugin_global_storage WHERE plugin_id = 'plugin_glob' AND key = 'hits'").get() as { value: string };
    assert.equal(row.value, '2');
  } finally {
    manager.stopAll();
  }
});

test('lifecycle hooks run in order', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'plugin_life', name: 'Life', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage'], blocks: [] };
  const code = `const mark = (ctx, s) => ctx.storage.get('log').then((v) => ctx.storage.set('log', (v ?? '') + s));
    export default { onLoad: (ctx) => mark(ctx, 'L'), onEnable: (ctx) => mark(ctx, 'E'), onDisable: (ctx) => mark(ctx, 'D'), onUnload: (ctx) => mark(ctx, 'U') };`;
  install(db, pluginsDir, 'plugin_life', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  await manager.startBot(1);
  manager.stopBot(1);
  await new Promise((r) => setTimeout(r, 500));
  const row = db.prepare("SELECT value FROM plugin_storage WHERE plugin_id = 'plugin_life' AND key = 'log'").get() as { value: string };
  assert.equal(row.value, 'LEDU');
});

test('module calls: read BotHub modules of the bot when switched on', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'plugin_mods', name: 'Mods', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['modules.read'], blocks: [{ name: 'read', definition: {} }] };
  const code = `export default { blocks: { async read(ctx) {
    const r = async (fn) => { try { return JSON.stringify(await fn()); } catch (e) { return e.message; } };
    return { results: { '.get': await r(() => ctx.module.get('moderation')), '.enabled': await r(() => ctx.module.isEnabled('economy')), '.unknown': await r(() => ctx.module.get('nope')) } };
  } } };`;
  install(db, pluginsDir, 'plugin_mods', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  db.prepare("INSERT INTO bot_modules (bot_id, module_key, enabled, config) VALUES (1, 'economy', 0, '{}'), (1, 'moderation', 1, '{\"x\":1}')").run();
  const read = async () => {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.plugin_mods.read')!(node('plugin.plugin_mods.read'), run);
    return results;
  };
  try {
    await manager.startBot(1);
    assert.equal(manager.blockHandlers(1).get('plugin.plugin_mods.read'), undefined, 'modules.read is medium risk: off by default, the plugin does not start');
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('modules.read', 1)").run();
    const res = await read();
    assert.deepEqual(JSON.parse(res['.get']!), { id: 'moderation', name: 'Moderation', enabled: true, config: { x: 1 } });
    assert.equal(res['.enabled'], 'false');
    assert.equal(res['.unknown'], 'sdk.module.unknown');
  } finally {
    manager.stopAll();
  }
});

test('config.checkAccess: a permissions field of the settings page, checked like a command', async () => {
  const { db, pluginsDir, manager } = setup();
  const id = 'plugin_access';
  const manifest = { id, name: 'Access', version: '1.0.0', sdk: 1, main: 'index.js', permissions: [], blocks: [{ name: 'check', definition: {} }] };
  const code = `export default { blocks: { async check(ctx) {
    const r = async (fn) => { try { return JSON.stringify(await fn()); } catch (e) { return e.message; } };
    const at = (userId, channelId) => ({ userId, guildId: '100000000000000001', channelId });
    return { results: {
      '.mod': await r(() => ctx.config.checkAccess('who', at('200000000000000001', '300000000000000001'))),
      '.plain': await r(() => ctx.config.checkAccess('who', at('200000000000000002', '300000000000000001'))),
      '.channel': await r(() => ctx.config.checkAccess('who', { user: { id: '200000000000000001' }, guildId: '100000000000000001', channelId: '300000000000000009' })),
      '.gone': await r(() => ctx.config.checkAccess('who', at('200000000000000003', null))),
      '.dm': await r(() => ctx.config.checkAccess('who', { userId: '200000000000000002', guildId: null })),
      '.open': await r(() => ctx.config.checkAccess('open', at('200000000000000002', null))),
      '.text': await r(() => ctx.config.checkAccess('title', at('200000000000000002', null))),
      '.bad': await r(() => ctx.config.checkAccess('who', { userId: 'x', guildId: '100000000000000001' })),
    } };
  } } };`;
  install(db, pluginsDir, id, { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  const dash = join(pluginsDir, id, '1.0.0', 'dashboard');
  mkdirSync(dash);
  writeFileSync(join(dash, 'settings.json'), JSON.stringify({ fields: [
    { key: 'who', type: 'permissions' },
    { key: 'open', type: 'permissions', default: { allowed_roles: [{ id: 'everyone' }] } },
    { key: 'title', type: 'text' },
  ] }));
  db.prepare('INSERT INTO plugin_settings (bot_id, plugin_id, config) VALUES (1, ?, ?)').run(id, JSON.stringify({
    who: { allowed_roles: [{ id: '400000000000000001', guild: '100000000000000001' }], banned_channels: [{ id: '300000000000000009', guild: '100000000000000001' }] },
  }));
  const member = (roles: string[]) => ({ guild: { id: '100000000000000001' }, roles: { cache: new Map(roles.map((r) => [r, {}])) }, permissions: { has: () => false } });
  const members: Record<string, unknown> = { '200000000000000001': member(['400000000000000001']), '200000000000000002': member([]) };
  const guild = { id: '100000000000000001', members: { fetch: async (u: string) => members[u] ?? Promise.reject(new Error('unknown')) } };
  (manager as unknown as { deps: PluginDeps }).deps.discord = () => ({ client: () => ({ guilds: { cache: new Map([[guild.id, guild]]) } }) }) as never;
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.check`)!(node(`plugin.${id}.check`), run);
    assert.deepEqual(JSON.parse(results['.mod']!), { allowed: true, reason: null });
    assert.deepEqual(JSON.parse(results['.plain']!), { allowed: false, reason: 'role' });
    assert.deepEqual(JSON.parse(results['.channel']!), { allowed: false, reason: 'channel' }, 'interaction events work too');
    assert.deepEqual(JSON.parse(results['.gone']!), { allowed: false, reason: 'member' });
    assert.deepEqual(JSON.parse(results['.dm']!), { allowed: true, reason: null });
    assert.deepEqual(JSON.parse(results['.open']!), { allowed: true, reason: null }, 'no saved value: the field default');
    assert.equal(results['.text'], 'sdk.config.not_permissions');
    assert.equal(results['.bad'], 'sdk.config.bad_member');
  } finally {
    manager.stopAll();
  }
});

test('plugin files, message.sendFile and config.set: images per bot, settings the plugin changes itself', async () => {
  const { db, pluginsDir, manager } = setup();
  const id = 'plugin_files';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const manifest = { id, name: 'Files', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage.files', 'discord.messages.send', 'discord.messages.files'], blocks: [{ name: 'run', definition: {} }, { name: 'read', definition: {} }] };
  const code = `export default { blocks: {
    async run(ctx) {
      const r = async (fn) => { try { return JSON.stringify(await fn()); } catch (e) { return e.message; } };
      const put = await ctx.files.put('${png}');
      const out = {
        '.default': JSON.stringify(ctx.config.get('title')),
        '.saved': JSON.stringify(ctx.config.get('greeting')),
        '.put': JSON.stringify(put),
        '.again': JSON.stringify((await ctx.files.put('${png}')).name === put.name),
        '.bad': await r(() => ctx.files.put(Buffer.from('hello').toString('base64'))),
        '.set': await r(() => ctx.config.set('emojis', [{ name: 'wave', image: put.name }])),
      };
      out['.after'] = JSON.stringify(ctx.config.get('emojis'));
      Object.assign(out, {
        '.unknown': await r(() => ctx.config.set('nope', 1)),
        '.bad_value': await r(() => ctx.config.set('emojis', [{ name: 5 }])),
        '.bad_image': await r(() => ctx.config.set('emojis', [{ name: 'x', image: '../etc/passwd' }])),
        '.perm': await r(() => ctx.config.set('who', { allowed_roles: [] })),
        '.send': await r(() => ctx.message.sendFile('300000000000000001', put.name, { embeds: [{ title: 'hi', image_url: 'attachment' }] })),
        '.missing': await r(() => ctx.message.sendFile('300000000000000001', '0000000000000000.png')),
        '.spoiler': await r(() => ctx.message.sendFile('300000000000000001', put.name, { spoiler: true, embeds: [{ image_url: 'attachment' }] })),
        '.evil': await r(() => ctx.files.fromDiscord('https://evil.example/attachments/1/2/x.png')),
        '.cdn': await r(() => ctx.files.fromDiscord('https://cdn.discordapp.com/attachments/1/2/x.png')),
        '.get': JSON.stringify((await ctx.files.get(put.name)).data === '${png}'),
      });
      await ctx.config.set('emojis', []);
      out['.list'] = JSON.stringify(await ctx.files.list());
      return { results: out };
    },
    async read(ctx) { return { results: { '.greeting': JSON.stringify(ctx.config.get('greeting')) } }; },
  } };`;
  install(db, pluginsDir, id, { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  const dash = join(pluginsDir, id, '1.0.0', 'dashboard');
  mkdirSync(dash);
  writeFileSync(join(dash, 'settings.json'), JSON.stringify({ fields: [
    { key: 'title', type: 'text', default: 'Hi' },
    { key: 'greeting', type: 'text' },
    { key: 'who', type: 'permissions' },
    { key: 'emojis', type: 'list', max: 5, item: [{ key: 'name', type: 'text', max: 32 }, { key: 'image', type: 'image' }] },
  ] }));
  db.prepare('INSERT INTO plugin_settings (bot_id, plugin_id, config) VALUES (1, ?, ?)').run(id, JSON.stringify({ greeting: 'Hello' }));
  for (const perm of ['discord.messages.send', 'discord.messages.files']) db.prepare('INSERT INTO sdk_policies (permission, enabled) VALUES (?, 1)').run(perm);
  const sentFiles: { channelId: string; message: unknown; files?: { name: string; data: Buffer }[] }[] = [];
  (manager as unknown as { deps: PluginDeps }).deps.sendMessage = async (_b, channelId, message, files) => {
    sentFiles.push({ channelId, message, files });
    return '9';
  };
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.run`)!(node(`plugin.${id}.run`), run);
    assert.equal(results['.default'], '"Hi"', 'defaults of the settings page');
    assert.equal(results['.saved'], '"Hello"', 'the bot\'s saved settings (plugin_settings)');
    const put = JSON.parse(results['.put']!);
    assert.match(put.name, /^[0-9a-f]{16}\.png$/);
    assert.equal(put.mime, 'image/png');
    assert.equal(results['.again'], 'true', 'same picture, same name');
    assert.equal(results['.bad'], 'sdk.files.bad_type');
    const after = JSON.parse(results['.after']!);
    assert.equal(after[0].name, 'wave');
    assert.equal(after[0].image, put.name);
    assert.match(after[0]._id, /^[a-z0-9]{8,16}$/, 'list entries get an id');
    assert.equal(results['.unknown'], 'sdk.config.unknown_key');
    assert.equal(results['.bad_value'], 'sdk.config.bad_value');
    assert.equal(results['.bad_image'], 'sdk.config.bad_value');
    assert.equal(results['.perm'], 'sdk.config.not_settable', 'access rules stay with the dashboard');
    assert.equal(results['.send'], '"9"');
    assert.equal(sentFiles.length, 2);
    assert.equal(sentFiles[0]!.files?.[0]?.name, put.name);
    assert.equal((sentFiles[0]!.message as { embeds: { image_url: string }[] }).embeds[0]!.image_url, `attachment://${put.name}`);
    assert.equal(results['.missing'], 'sdk.files.unknown');
    assert.equal(sentFiles[1]!.files?.[0]?.name, `SPOILER_${put.name}`, 'spoiler: blurred until clicked');
    assert.equal((sentFiles[1]!.message as { embeds: { image_url: string }[]; spoiler?: boolean }).embeds[0]!.image_url, `attachment://SPOILER_${put.name}`);
    assert.equal((sentFiles[1]!.message as { spoiler?: boolean }).spoiler, undefined);
    assert.equal(results['.evil'], 'sdk.files.bad_url');
    assert.equal(results['.cdn'], 'sdk.files.bad_type', 'Discord attachment fetched, then checked like an upload');
    assert.equal(results['.get'], 'true');
    assert.deepEqual(JSON.parse(results['.list']!), [], 'images the settings no longer name are deleted');
    const saved = JSON.parse((db.prepare('SELECT config FROM plugin_settings WHERE plugin_id = ?').get(id) as { config: string }).config);
    assert.deepEqual(saved, { greeting: 'Hello', emojis: [] });

    // A dashboard save reaches the running plugin (module.changed plugin:<id>).
    db.prepare('UPDATE plugin_settings SET config = ? WHERE plugin_id = ?').run(JSON.stringify({ greeting: 'Moin' }), id);
    manager.refreshConfig(1, id);
    const second = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.read`)!(node(`plugin.${id}.read`), second.run);
    assert.equal(second.results['.greeting'], '"Moin"');
  } finally {
    manager.stopAll();
  }
});

test('module calls: modules.<key>.read allows that one module only', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'plugin_onemod', name: 'One', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['modules.moderation.read'], blocks: [{ name: 'read', definition: {} }] };
  const code = `export default { blocks: { async read(ctx) {
    const r = async (fn) => { try { return JSON.stringify(await fn()); } catch (e) { return e.message; } };
    return { results: { '.mod': await r(() => ctx.module.isEnabled('moderation')), '.eco': await r(() => ctx.module.isEnabled('economy')), '.list': await r(async () => (await ctx.module.list()).map((m) => m.id)) } };
  } } };`;
  install(db, pluginsDir, 'plugin_onemod', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('modules.moderation.read', 1)").run();
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.plugin_onemod.read')!(node('plugin.plugin_onemod.read'), run);
    assert.equal(results['.mod'], 'true');
    assert.equal(results['.eco'], 'sdk.call.denied');
    assert.equal(results['.list'], '["moderation"]');
  } finally {
    manager.stopAll();
  }
});

test('events and tasks: declared in bothub.json, need discord.events / scheduler', async () => {
  const { db, pluginsDir, manager, logs } = setup();
  const dir = join(pluginsDir, 'plugin_greeter', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bothub.json'), JSON.stringify({
    schemaVersion: 1, id: 'plugin_greeter', name: 'Greeter', version: '1.0.0', main: 'index.js',
    sdk: { version: 1, permissions: ['storage', 'discord.events', 'scheduler'] },
    events: ['guildMemberAdd'], services: { tasks: [{ name: 'daily', cron: '0 9 * * *' }] },
  }));
  writeFileSync(join(dir, 'index.js'), `export default {
    events: { async guildMemberAdd(ctx, p) { await ctx.storage.set('last', p['user.name'] + ':' + p['user.bot']); } },
    tasks: { async daily(ctx) { await ctx.storage.increment('runs'); } },
  };`);
  register(db, 'plugin_greeter');
  const value = (key: string) => (db.prepare("SELECT value FROM plugin_storage WHERE plugin_id = 'plugin_greeter' AND key = ?").get(key) as { value: string } | undefined)?.value;
  try {
    // scheduler (low) is on, discord.events (medium) is off: the plugin does not start.
    await manager.startBot(1);
    manager.dispatchEvent(1, 'guildMemberAdd', { 'user.name': 'Ann', 'user.bot': false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(value('last'), undefined, 'events need discord.events');
    await assert.rejects(manager.runTaskNow(1, 'plugin_greeter', 'daily'), /sdk.task.unknown/, 'not running');
    assert.ok(logs.some((l) => l.includes('sdk.plugin.blocked discord.events')));
    // The old key discord.events stands for the five event permissions: all must be on.
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('discord.events.messages', 1), ('discord.events.members', 1), ('discord.events.server', 1), ('discord.events.voice', 1), ('discord.events.interactions', 1)").run();
    await manager.startBot(1);
    await manager.runTaskNow(1, 'plugin_greeter', 'daily');
    assert.equal(value('runs'), '1', 'task ran');
    manager.dispatchEvent(1, 'guildMemberAdd', { 'user.name': 'Ann', 'user.bot': false });
    manager.dispatchEvent(1, 'messageCreate', { content: 'not listed' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(value('last'), 'Ann:false');
    await assert.rejects(manager.runTaskNow(1, 'plugin_greeter', 'nope'), /sdk.task.unknown/);
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('scheduler', 0)").run();
    await manager.startBot(1);
    await assert.rejects(manager.runTaskNow(1, 'plugin_greeter', 'daily'), /sdk.task.unknown/, 'scheduler off: the plugin is off');
  } finally {
    manager.stopAll();
  }
});

test('secrets.read: only declared and shared names, no listing, masked in logs', async () => {
  const { db, pluginsDir, manager, logs } = setup();
  const id = 'plugin_weather';
  const manifest = { id, name: 'Weather', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['secrets.read'], secrets: ['WEATHER_API_KEY', 'NOT_SHARED'], blocks: [{ name: 'read', definition: {} }] };
  const code = `export default { blocks: { async read(ctx) {
    const r = async (fn) => { try { return JSON.stringify((await fn()) ?? null); } catch (e) { return e.message; } };
    const key = await ctx.secrets.get('WEATHER_API_KEY');
    await ctx.logger.info('key is ' + key);
    return { results: {
      '.key': key,
      '.has': await r(() => ctx.secrets.has('WEATHER_API_KEY')),
      '.unshared': await r(() => ctx.secrets.get('NOT_SHARED')),
      '.undeclared': await r(() => ctx.secrets.get('DISCORD_TOKEN')),
      '.list': await r(() => ctx.secrets.list()),
    } };
  } } };`;
  install(db, pluginsDir, id, { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  // What the API stored at install; a file changed later does not count.
  db.prepare('UPDATE plugins SET manifest = ? WHERE id = ?').run(JSON.stringify({ secrets: ['WEATHER_API_KEY', 'NOT_SHARED'] }), id);
  for (const k of ['WEATHER_API_KEY', 'NOT_SHARED', 'DISCORD_TOKEN']) db.prepare("INSERT INTO secrets (key, value_enc) VALUES (?, x'00')").run(k);
  db.prepare("INSERT INTO secret_plugin_shares (secret_key, plugin_id) VALUES ('WEATHER_API_KEY', ?)").run(id);
  const values: Record<string, string> = { WEATHER_API_KEY: 'owm-1234567890', NOT_SHARED: 'nope-123456', DISCORD_TOKEN: 'tok-123456' };
  (manager as unknown as { deps: PluginDeps }).deps.secret = (k) => values[k] ?? null;
  db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('secrets.read', 1)").run();
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.read`)!(node(`plugin.${id}.read`), run);
    assert.equal(results['.key'], 'owm-1234567890');
    assert.equal(results['.has'], 'true');
    assert.equal(results['.unshared'], 'null', 'declared but not shared by the admin');
    assert.equal(results['.undeclared'], 'null', 'not in the manifest: same answer as missing');
    assert.equal(results['.list'], 'sdk.call.unknown', 'secrets cannot be listed');
    assert.ok(logs.some((l) => l.includes('key is ••••')), 'masked in the log');
    assert.ok(!logs.some((l) => l.includes('owm-1234567890')));

    // A name added to the file after install (manipulation) is not readable, even when shared.
    const fileManifest = { ...manifest, secrets: ['WEATHER_API_KEY', 'NOT_SHARED', 'DISCORD_TOKEN'] };
    writeFileSync(join(pluginsDir, id, '1.0.0', 'bothub-plugin.json'), JSON.stringify(fileManifest));
    writeFileSync(join(pluginsDir, id, '1.0.0', 'index.js'), `export default { blocks: { async read(ctx) { return { results: { '.tok': JSON.stringify((await ctx.secrets.get('DISCORD_TOKEN')) ?? null) } }; } } };`);
    db.prepare("INSERT INTO secret_plugin_shares (secret_key, plugin_id) VALUES ('DISCORD_TOKEN', ?)").run(id);
    await manager.startBot(1);
    const second = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.read`)!(node(`plugin.${id}.read`), second.run);
    assert.equal(second.results['.tok'], 'null', 'only names of the installed (checked) manifest');
  } finally {
    manager.stopAll();
  }
});

test('http.secret: address and key from shared secrets, the plugin never sees them', async () => {
  const { db, pluginsDir, manager } = setup();
  const id = 'plugin_weather';
  const dir = join(pluginsDir, id, '1.0.0');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  const manifest = { schemaVersion: 1, id, name: 'Weather', version: '1.0.0', main: 'index.js',
    sdk: { version: 1, permissions: ['secrets.use', 'http.outbound'] }, services: { secrets: ['WEATHER_URL', 'WEATHER_KEY', 'LAN_URL', 'OTHER_KEY'], hosts: ['api.example.com'] }, nodes: ['probe'] };
  writeFileSync(join(dir, 'bothub.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'nodes', 'probe.json'), '{}');
  writeFileSync(join(dir, 'index.js'), `export default { blocks: { async probe(ctx) {
    const r = async (fn) => { try { return JSON.stringify(await fn()); } catch (e) { return e.message; } };
    return { results: {
      '.ok': await r(() => ctx.http.secret({ url: 'WEATHER_URL', path: '/today', query: { city: 'Berlin' }, headers: { 'X-Trace': '1' }, auth: { secret: 'WEATHER_KEY' } })),
      '.query': await r(() => ctx.http.secret({ url: 'https://api.example.com/x', auth: { secret: 'WEATHER_KEY', format: 'query', param: 'appid' } })),
      '.lan': await r(() => ctx.http.secret({ url: 'LAN_URL', path: '/library', auth: { secret: 'WEATHER_KEY', header: 'X-Plex-Token', format: 'plain' } })),
      '.not_shared': await r(() => ctx.http.secret({ url: 'WEATHER_URL', auth: { secret: 'OTHER_KEY' } })),
      '.undeclared': await r(() => ctx.http.secret({ url: 'DISCORD_URL' })),
      '.host': await r(() => ctx.http.secret({ url: 'https://evil.example.com/x', auth: { secret: 'WEATHER_KEY' } })),
      '.http': await r(() => ctx.http.secret({ url: 'http://api.example.com/x' })),
      '.path': await r(() => ctx.http.secret({ url: 'WEATHER_URL', path: '/../admin' })),
      '.method': await r(() => ctx.http.secret({ url: 'WEATHER_URL', method: 'TRACE' })),
      '.header': await r(() => ctx.http.secret({ url: 'WEATHER_URL', headers: { Authorization: 'x' }, auth: { secret: 'WEATHER_KEY' } })),
      '.big': await r(() => ctx.http.secret({ url: 'WEATHER_URL', path: '/big' })),
      '.read': await r(() => ctx.secrets.get('WEATHER_KEY')),
    } };
  } } };`);
  register(db, id);
  db.prepare('UPDATE plugins SET manifest = ? WHERE id = ?').run(JSON.stringify({ secrets: manifest.services.secrets }), id);
  for (const k of ['WEATHER_URL', 'WEATHER_KEY', 'LAN_URL', 'OTHER_KEY']) db.prepare("INSERT INTO secrets (key, value_enc) VALUES (?, x'00')").run(k);
  for (const k of ['WEATHER_URL', 'WEATHER_KEY', 'LAN_URL']) db.prepare('INSERT INTO secret_plugin_shares (secret_key, plugin_id) VALUES (?, ?)').run(k, id);
  db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('secrets.use', 1), ('http.outbound', 1)").run();
  (manager as unknown as { deps: PluginDeps }).deps.outbound = { resolve: async (h) => (h === 'api.example.com' ? ['93.184.216.34'] : ['10.0.0.1']) };
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.probe`)!(node(`plugin.${id}.probe`), run);
    const ok = JSON.parse(results['.ok']!);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.echo, 'token ••••', 'secret masked in the answer');
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.equal(fetched[0]!.url, 'https://api.example.com/v1/today?city=Berlin');
    assert.equal((fetched[0]!.init.headers as Record<string, string>).Authorization, 'Bearer s3cr3t-value');
    assert.equal(fetched[0]!.init.redirect, 'manual');
    assert.equal(fetched[1]!.url, 'https://api.example.com/x?appid=s3cr3t-value', 'key as URL parameter');
    assert.equal(fetched[2]!.url, 'http://192.168.1.10:32400/library', 'an address from an admin secret may be in the home network');
    assert.equal((fetched[2]!.init.headers as Record<string, string>)['X-Plex-Token'], 's3cr3t-value');
    assert.deepEqual(
      [results['.not_shared'], results['.undeclared'], results['.host'], results['.http'], results['.path'], results['.method'], results['.header'], results['.big'], results['.read']],
      ['sdk.secret.not_shared', 'sdk.secret.not_shared', 'sdk.http.host_not_allowed', 'sdk.http.bad_url', 'sdk.http.bad_path', 'sdk.http.bad_method', 'sdk.http.bad_header', 'sdk.http.too_big', 'sdk.call.denied'],
    );
  } finally {
    manager.stopAll();
  }
});

test('http.secret with plugin files: multipart upload of a stored image, image answer saved as a file', async () => {
  const { db, pluginsDir, manager } = setup();
  const id = 'plugin_imagegen';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const manifest = { id, name: 'ImageGen', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['secrets.use', 'storage.files'], secrets: ['GEN_KEY'], hosts: ['api.example.com'], blocks: [{ name: 'go', definition: {} }] };
  const code = `export default { blocks: { async go(ctx) {
    const r = async (fn) => { try { return JSON.stringify(await fn()); } catch (e) { return e.message; } };
    const auth = { secret: 'GEN_KEY', header: 'x-api-key', format: 'plain' };
    const src = await ctx.files.put('${png}');
    return { results: {
      '.upload': await r(() => ctx.http.secret({ url: 'https://api.example.com/upload', method: 'POST', auth, file: { name: src.name, field: 'image' }, fields: { kind: 'SOURCE' } }).then((a) => a.json)),
      '.saved': await r(() => ctx.http.secret({ url: 'https://api.example.com/out.png', auth, saveAs: 'file' }).then((a) => a.file)),
      '.error': await r(() => ctx.http.secret({ url: 'https://api.example.com/missing', auth, saveAs: 'file' }).then((a) => a.status)),
      '.text': await r(() => ctx.http.secret({ url: 'https://api.example.com/text.txt', auth, saveAs: 'file' })),
      '.unknown': await r(() => ctx.http.secret({ url: 'https://api.example.com/upload', method: 'POST', auth, file: { name: '0000000000000000.png' } })),
      '.both': await r(() => ctx.http.secret({ url: 'https://api.example.com/upload', method: 'POST', auth, file: { name: src.name }, json: {} })),
    } };
  } } };`;
  install(db, pluginsDir, id, { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  db.prepare('UPDATE plugins SET manifest = ? WHERE id = ?').run(JSON.stringify({ secrets: ['GEN_KEY'] }), id);
  db.prepare("INSERT INTO secrets (key, value_enc) VALUES ('GEN_KEY', x'00')").run();
  db.prepare("INSERT INTO secret_plugin_shares (secret_key, plugin_id) VALUES ('GEN_KEY', ?)").run(id);
  db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('secrets.use', 1)").run();
  const deps = (manager as unknown as { deps: PluginDeps }).deps;
  deps.secret = (k) => (k === 'GEN_KEY' ? 'gen-key-123456' : null);
  deps.outbound = { resolve: async () => ['93.184.216.34'] };
  let form: FormData | null = null;
  let keyHeader = '';
  deps.fetch = (async (url: URL, init: RequestInit) => {
    keyHeader = String((init.headers as Record<string, string>)['x-api-key'] ?? '');
    const path = new URL(url).pathname;
    if (path === '/upload') {
      form = init.body as FormData;
      return new Response(JSON.stringify({ path: 'generator/abc.png' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/out.png') return new Response(Buffer.from(png, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    if (path === '/text.txt') return new Response('not an image', { status: 200 });
    return new Response('{"error":"gone"}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get(`plugin.${id}.go`)!(node(`plugin.${id}.go`), run);
    assert.equal(results['.upload'], '{"path":"generator/abc.png"}');
    assert.equal(keyHeader, 'gen-key-123456', 'the bot adds the key');
    const sent = (form as unknown as FormData).get('image') as File;
    assert.equal(sent.type, 'image/png');
    assert.equal(Buffer.from(await sent.arrayBuffer()).toString('base64'), png, 'the stored image goes as multipart');
    assert.equal((form as unknown as FormData).get('kind'), 'SOURCE');
    const saved = JSON.parse(results['.saved']!);
    assert.match(saved.name, /^[0-9a-f]{16}\.png$/);
    assert.equal(saved.mime, 'image/png');
    assert.equal(results['.error'], '404', 'an error answer is not saved');
    assert.equal(results['.text'], 'sdk.files.bad_type');
    assert.equal(results['.unknown'], 'sdk.files.unknown');
    assert.equal(results['.both'], 'sdk.http.bad_file');
  } finally {
    manager.stopAll();
  }
});

test('voice: files of the plugin folder only, needs discord.voice, keys like the template', async () => {
  const { db, pluginsDir, manager } = setup();
  Object.assign(voiceState, { channelId: null, playing: false, label: null, owner: null, played: [] });
  const dir = join(pluginsDir, 'plugin_sound', '1.0.0');
  mkdirSync(join(dir, 'sounds'), { recursive: true });
  mkdirSync(join(dir, 'nodes'));
  writeFileSync(join(dir, 'sounds', 'beep.ogg'), 'OggS');
  writeFileSync(join(dir, 'nodes', 'probe.json'), '{}');
  writeFileSync(join(dir, 'bothub.json'), JSON.stringify({ schemaVersion: 1, id: 'plugin_sound', name: 'Sound', version: '1.0.0', main: 'index.js', sdk: { version: 1, permissions: ['discord.voice'] }, nodes: ['probe'] }));
  writeFileSync(join(dir, 'index.js'), `export default { blocks: { async probe(ctx) {
    const g = '100000000000000001';
    const r = async (fn) => { try { const v = await fn(); return v == null ? 'ok' : JSON.stringify(v); } catch (e) { return e.message; } };
    return { results: {
      '.early': await r(() => ctx.voice.play(g, 'sounds/beep.ogg')),
      '.join': await r(() => ctx.voice.join(g, '200000000000000002')),
      '.escape': await r(() => ctx.voice.play(g, 'sounds/../../../../bothub.sqlite')),
      '.missing': await r(() => ctx.voice.play(g, 'sounds/nope.ogg')),
      '.url': await r(() => ctx.voice.play(g, 'https://example.com/a.mp3')),
      '.volume': await r(() => ctx.voice.play(g, 'sounds/beep.ogg', { volume: 2 })),
      '.play': await r(() => ctx.voice.play(g, 'sounds/beep.ogg', { volume: 0.5 })),
      '.state': await r(() => ctx.voice.state(g)),
    } };
  } } };`);
  register(db, 'plugin_sound');
  const probe = async () => {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.plugin_sound.probe')!(node('plugin.plugin_sound.probe'), run);
    return results;
  };
  try {
    await manager.startBot(1);
    assert.equal(manager.blockHandlers(1).get('plugin.plugin_sound.probe'), undefined, 'discord.voice is off by default: the plugin does not start');
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('discord.voice.connect', 1), ('discord.voice.speak', 1)").run();
    Object.assign(voiceState, { channelId: null, playing: false, label: null, owner: null, played: [] });
    const res = await probe();
    assert.equal(res['.early'], 'sdk.voice.not_connected');
    assert.equal(res['.join'], 'ok');
    assert.deepEqual([res['.escape'], res['.missing'], res['.url'], res['.volume']], ['sdk.voice.bad_file', 'sdk.voice.bad_file', 'sdk.voice.bad_file', 'sdk.voice.bad_volume']);
    assert.equal(res['.play'], 'ok');
    assert.deepEqual(voiceState.played, ['sounds/beep.ogg@0.5']);
    assert.deepEqual(JSON.parse(res['.state']!), { channelId: '200000000000000002', playing: true, file: 'sounds/beep.ogg' });
    // Music (another owner) is playing: the plugin cannot replace or stop it.
    Object.assign(voiceState, { playing: true, owner: 'music', label: 'song' });
    const res2 = await probe();
    assert.equal(res2['.play'], 'sdk.voice.busy');
    assert.equal(JSON.parse(res2['.state']!).file, null, "another owner's file stays hidden");
  } finally {
    manager.stopAll();
  }
});

// The example plugins of the market repo (next to this repo) start in the sandbox.
// Plugin folders are in the repo root (or plugins/ in older layouts); every folder with a bothub.json counts.
const marketRoot = join(root, '..', 'BothubMarketPlace');
const market = existsSync(join(marketRoot, 'plugins')) ? join(marketRoot, 'plugins') : marketRoot;
const marketAll = existsSync(market) ? readdirSync(market).filter((d) => existsSync(join(market, d, 'bothub.json'))) : [];
const marketId = (d: string) => (JSON.parse(readFileSync(join(market, d, 'bothub.json'), 'utf8')) as { id: string }).id;
// IDs must be plugin_<name>; others are reported, not installed.
const marketPlugins = marketAll.filter((d) => /^plugin_[a-z0-9_]{1,57}$/.test(marketId(d)));
const marketBadIds = marketAll.filter((d) => !marketPlugins.includes(d)).map((d) => `${d}: ${marketId(d)}`);
test('market example plugins start and their blocks run', { skip: marketPlugins.length === 0 && (marketBadIds.length ? `no valid plugin id (${marketBadIds.join(', ')})` : true) }, async (t) => {
  if (marketBadIds.length) t.diagnostic(`skipped, id is not plugin_<name>: ${marketBadIds.join(', ')}`);
  const { db, pluginsDir, manager } = setup();
  // Every SDK permission on: the plugins only start with all they declare.
  db.prepare("INSERT INTO sdk_policies (permission, enabled) SELECT value, 1 FROM json_each(?)").run(JSON.stringify((JSON.parse(readFileSync(join(root, 'shared', 'sdk-permissions.json'), 'utf8')).permissions as { key: string }[]).map((p) => p.key)));
  for (const folder of marketPlugins) {
    const id = (JSON.parse(readFileSync(join(market, folder, 'bothub.json'), 'utf8')) as { id: string }).id;
    const version = (JSON.parse(readFileSync(join(market, folder, 'bothub.json'), 'utf8')) as { version: string }).version;
    cpSync(join(market, folder), join(pluginsDir, id, version), { recursive: true });
    db.prepare('INSERT INTO plugins (id, version, sha256, manifest) VALUES (?, ?, ?, ?)').run(id, version, 'a'.repeat(64), '{}');
    db.prepare('INSERT INTO plugin_installs (plugin_id, version) VALUES (?, ?)').run(id, version);
  }
  try {
    await manager.startBot(1);
    const handlers = manager.blockHandlers(1);
    assert.ok(handlers.size >= 1, `blocks of the plugins: ${[...handlers.keys()].join(', ')}`);
    const hello = [...handlers.entries()].find(([type]) => type.endsWith('.hello'))?.[1];
    if (hello) {
      const { run, results } = fakeRun({ 'user.name': 'Ann', 'user.id': '100000000000000002', 'server.id': '100000000000000001' });
      await hello(node('plugin.starter.hello'), run);
      assert.ok(Object.keys(results).length > 0, 'hello returned results');
    }
  } finally {
    manager.stopAll();
  }
});
