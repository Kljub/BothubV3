import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../core/db.js';
import { loadPolicy, PluginManager, type PluginDeps } from './manager.js';
import { parseManifest } from './manifest.js';
import type { GraphNode } from '../graph/types.js';

// Tests run from bot/dist/sdk; the repo root is three levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const limits = JSON.parse(readFileSync(join(root, 'shared', 'sdk-permissions.json'), 'utf8')).limits;

function setup(): { db: Db; pluginsDir: string; logs: string[]; manager: PluginManager } {
  const tmp = mkdtempSync(join(tmpdir(), 'bothub-sdk-'));
  const db = openDb(join(tmp, 'bothub.sqlite'));
  const migrations = join(root, 'api', 'migrations');
  for (const f of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrations, f), 'utf8'));
  db.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 0)").run();
  const pluginsDir = join(tmp, 'plugins');
  mkdirSync(pluginsDir);
  const logs: string[] = [];
  const deps: PluginDeps = {
    sendMessage: async () => '1',
    guildInfo: async (_b, id) => ({ id, name: 'Home', memberCount: 3 }),
    log: (_bot, level, plugin, text) => void logs.push(`${level} ${plugin} ${text}`),
  };
  const permissions = JSON.parse(readFileSync(join(root, 'shared', 'sdk-permissions.json'), 'utf8')).permissions;
  const manager = new PluginManager(db, { pluginsDir, limits: { ...limits, callTimeoutMs: 3000, blockTimeoutMs: 1500 }, policy: () => loadPolicy(db, permissions) }, deps);
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
const node = (type: string, config: Record<string, unknown> = {}): GraphNode => ({ id: 'n1', type, typeVersion: 1, config });

test('manifest checks', () => {
  const ok = { id: 'counter', name: 'C', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage'] };
  assert.equal(parseManifest(ok).id, 'counter');
  for (const bad of [{ ...ok, main: '../x.js' }, { ...ok, permissions: ['db.raw'] }, { ...ok, sdk: 2 }, { ...ok, id: 'Bad Id' }]) {
    assert.throws(() => parseManifest(bad), /sdk.manifest.invalid/);
  }
});

test('example plugin: block runs in its own process and uses storage', async () => {
  const { db, pluginsDir, manager } = setup();
  const src = join(root, 'sdk', 'examples', 'counter');
  cpSync(src, join(pluginsDir, 'counter', '1.0.0'), { recursive: true });
  register(db, 'counter');
  try {
    await manager.startBot(1);
    const handler = manager.blockHandlers(1).get('plugin.counter.count');
    assert.ok(handler, 'block registered');
    assert.equal(manager.blockDefs(1).get('plugin.counter.count')?.type, 'plugin.counter.count');
    for (const expected of ['1', '2']) {
      const { run, results } = fakeRun({ 'server.id': '100000000000000001' });
      await handler!(node('plugin.counter.count', { counter: 'hits', variable: 'n' }), run);
      assert.equal(results[''], expected);
    }
    const row = db.prepare("SELECT value FROM plugin_storage WHERE bot_id = 1 AND plugin_id = 'counter'").get() as { value: string };
    assert.equal(row.value, '2');
  } finally {
    manager.stopAll();
  }
});

test('sandbox: no files outside, no network, no env, no processes, no ungranted calls', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'evil', name: 'Evil', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['storage', 'discord.send_messages'], blocks: [{ name: 'probe', definition: {} }] };
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
        '.send': await tryIt(() => ctx.discord.sendMessage('100000000000000001', 'hi')),
        '.guild': await tryIt(() => ctx.discord.guildInfo('100000000000000001')),
      } };
    } } };`;
  // storage on (default), discord.send_messages declared but off in the SDK policy, guild_info not declared.
  install(db, pluginsDir, 'evil', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  try {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.evil.probe')!(node('plugin.evil.probe'), run);
    for (const k of ['.read_outside', '.write_own', '.net', '.http', '.child', '.worker', '.sqlite', '.fetch', '.eval', '.env', '.binding', '.dlopen', '.module', '.require_net', '.send', '.guild']) {
      assert.equal(results[k], 'blocked', `${k} must be blocked`);
    }
  } finally {
    manager.stopAll();
  }
});

test('a hanging block times out and the plugin is restarted', async () => {
  const { db, pluginsDir, manager, logs } = setup();
  const manifest = { id: 'hang', name: 'Hang', version: '1.0.0', sdk: 1, main: 'index.js', permissions: [], blocks: [{ name: 'loop', definition: {} }] };
  install(db, pluginsDir, 'hang', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': 'export default { blocks: { loop() { for (;;) {} } } };' });
  try {
    await manager.startBot(1);
    const { run } = fakeRun({});
    await assert.rejects(manager.blockHandlers(1).get('plugin.hang.loop')!(node('plugin.hang.loop'), run) as Promise<unknown>, /sdk.plugin.timeout/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(logs.some((l) => l.includes('sdk.plugin.restart')), 'restart logged');
  } finally {
    manager.stopAll();
  }
});

test('SDK policy and per-bot switch', async () => {
  const { db, pluginsDir, manager } = setup();
  const manifest = { id: 'sender', name: 'Sender', version: '1.0.0', sdk: 1, main: 'index.js', permissions: ['discord.send_messages'], blocks: [{ name: 'send', definition: {} }] };
  const code = `export default { blocks: { async send(ctx) {
    try { return { results: { '': await ctx.discord.sendMessage('100000000000000001', 'hi') } }; } catch (e) { return { results: { '': e.message } }; }
  } } };`;
  install(db, pluginsDir, 'sender', { 'bothub-plugin.json': JSON.stringify(manifest), 'index.js': code });
  const send = async () => {
    await manager.startBot(1);
    const { run, results } = fakeRun({});
    await manager.blockHandlers(1).get('plugin.sender.send')!(node('plugin.sender.send'), run);
    return results[''];
  };
  try {
    assert.equal(await send(), 'sdk.call.denied', 'medium risk is off by default');
    db.prepare("INSERT INTO sdk_policies (permission, enabled) VALUES ('discord.send_messages', 1)").run();
    assert.equal(await send(), '1', 'switched on globally');
    db.prepare("INSERT INTO bot_plugin_disabled (bot_id, plugin_id) VALUES (1, 'sender')").run();
    await manager.startBot(1);
    assert.equal(manager.blockHandlers(1).get('plugin.sender.send'), undefined, 'switched off for this bot');
  } finally {
    manager.stopAll();
  }
});
