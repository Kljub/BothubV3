// Plugin host: runs inside the child process of one plugin for one bot.
// Started by the SDK manager (sdk/process.ts) with node --permission, read
// access only to the plugin folder and this folder, no env, 64 MB heap.
//
// This file imports only node builtins: the permission model lets the
// process read nothing else. It is NOT a security boundary (plugin code runs
// in the same process and could send its own IPC messages); the manager
// checks every call. The steps here remove what Node 24's permission model
// does not cover (network) and give the plugin its ctx.

import { registerHooks } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomInt, randomUUID } from 'node:crypto';

// ---------- lock down before any plugin code runs ----------

// The manager starts the child with an empty env; some systems (Windows)
// still add variables. The plugin sees none.
for (const key of Object.keys(process.env)) delete process.env[key];

// Node 24's permission model has no network switch: remove the network
// globals and refuse the network, process and loader modules.
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try {
    delete (globalThis as Record<string, unknown>)[name];
  } catch {
    // not configurable: ignore
  }
}
const BLOCKED = new Set([
  'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', 'child_process', 'cluster', 'worker_threads',
  'inspector', 'inspector/promises', 'module', 'repl', 'trace_events', 'v8', 'vm', 'wasi', 'sqlite', 'undici',
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (BLOCKED.has(bare)) throw new Error(`BotHub plugins cannot use "${specifier}" (use the SDK ctx instead)`);
    return nextResolve(specifier, context);
  },
});

// ---------- RPC with the manager ----------

type Msg = { id?: number; type: string; [k: string]: unknown };

const send = (msg: Msg): void => {
  process.send?.(msg);
};

let seq = 0;
const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++seq;
  return new Promise((ok, fail) => {
    pending.set(id, { ok, fail });
    send({ id, type: 'call', method, params });
  });
}

interface Init {
  pluginDir: string;
  main: string;
  botId: number;
  config: Record<string, unknown>;
  manifest: { id: string; name: string; version: string; description?: string; author?: string; permissions: string[] };
}

type Hook = (ctx: unknown) => unknown;
type Plugin = {
  onLoad?: Hook;
  onEnable?: Hook;
  onDisable?: Hook;
  onUnload?: Hook;
  onConfigChange?: Hook;
  /** SDK 1.0 name of onEnable. */
  start?: Hook;
  blocks?: Record<string, (ctx: unknown, input: unknown) => unknown>;
};

let plugin: Plugin = {};
let ctx: unknown = {};
/** The init of the loaded plugin; "config" replaces its settings (ctx.config reads them per call). */
let current: Init | null = null;

// Answered here without the manager: facts about the plugin and pure helpers.
function localArea(init: Init): Record<string, Record<string, (...a: unknown[]) => unknown>> {
  const info = Object.freeze({ ...init.manifest, botId: init.botId });
  return {
    plugin: {
      getInfo: () => info,
      getId: () => init.manifest.id,
      getVersion: () => init.manifest.version,
      getConfig: () => ({ ...init.config }),
      isEnabled: () => true,
      getPath: () => init.pluginDir,
      getManifest: () => structuredClone(init.manifest),
    },
    config: {
      get: (key) => init.config[String(key)],
      has: (key) => Object.hasOwn(init.config, String(key)),
      getAll: () => ({ ...init.config }),
    },
    utils: {
      uuid: () => randomUUID(),
      random: (min = 0, max = 1) => {
        const lo = Math.ceil(Number(min));
        const hi = Math.floor(Number(max));
        return hi > lo ? randomInt(lo, hi + 1) : lo;
      },
      hash: (text: unknown, algo = 'sha256') => createHash(String(algo)).update(String(text)).digest('hex'),
      formatNumber: (n: unknown, locale = 'en') => new Intl.NumberFormat(String(locale)).format(Number(n)),
      formatDate: (d: unknown, locale = 'en') => new Intl.DateTimeFormat(String(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d as string)),
      formatDuration: (ms: unknown) => {
        let s = Math.max(0, Math.floor(Number(ms) / 1000));
        const out: string[] = [];
        for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]] as const) {
          if (s >= size) {
            out.push(`${Math.floor(s / size)}${unit}`);
            s %= size;
          }
        }
        if (s || !out.length) out.push(`${s}s`);
        return out.join(' ');
      },
    },
  };
}

// ctx.<area>.<method>(...args): local when known here, else an RPC call to
// the manager ("storage.get", "message.send", ...). Calls the manager does
// not know or has not built answer sdk.call.unknown / not_available.
function makeCtx(init: Init): unknown {
  const local = localArea(init);
  const areas = new Map<string, unknown>();
  const area = (name: string) =>
    new Proxy(Object.freeze({}), {
      get(_t, fn) {
        if (typeof fn !== 'string') return undefined;
        const own = local[name]?.[fn];
        if (own) return own;
        return (...args: unknown[]) => call(`${name}.${fn}`, { args });
      },
    });
  return new Proxy(Object.freeze({}), {
    get(_t, name) {
      if (name === 'botId') return init.botId;
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (!areas.has(name)) areas.set(name, area(name));
      return areas.get(name);
    },
  });
}

async function load(init: Init): Promise<string[]> {
  const dir = resolve(init.pluginDir);
  const file = resolve(join(dir, init.main));
  if (!file.startsWith(dir + sep)) throw new Error('main must stay inside the plugin folder');
  const mod = (await import(pathToFileURL(file).href)) as { default?: Plugin };
  plugin = mod.default ?? {};
  current = init;
  ctx = makeCtx(init);
  await plugin.onLoad?.(ctx);
  return Object.keys(plugin.blocks ?? {});
}

const errorText = (err: unknown): string => (err instanceof Error ? `${(err as { key?: string }).key ?? err.name}: ${err.message}` : String(err)).slice(0, 500);

process.on('message', (raw: unknown) => {
  const msg = raw as Msg;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'reply' && typeof msg.id === 'number') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (typeof msg.error === 'string') p.fail(Object.assign(new Error(msg.error), { key: msg.error }));
    else p.ok(msg.result);
    return;
  }
  if (msg.type === 'shutdown') {
    // Manager stops the plugin: onDisable, onUnload, then exit.
    void (async () => {
      try {
        await plugin.onDisable?.(ctx);
        await plugin.onUnload?.(ctx);
      } finally {
        process.exit(0);
      }
    })();
    return;
  }
  if (msg.type !== 'invoke' || typeof msg.id !== 'number') return;
  const id = msg.id;
  const done = (result: unknown) => send({ id, type: 'result', result: result ?? null });
  const failed = (err: unknown) => send({ id, type: 'result', error: errorText(err) });
  const params = (msg.params ?? {}) as Record<string, unknown>;
  (async () => {
    switch (msg.method) {
      case 'init':
        return load(params as unknown as Init);
      case 'start':
        return (plugin.onEnable ?? plugin.start)?.(ctx);
      case 'config':
        if (current && params.config && typeof params.config === 'object' && !Array.isArray(params.config)) current.config = params.config as Record<string, unknown>;
        // A dashboard save (not config.set of the plugin itself).
        if (params.changed === true) await plugin.onConfigChange?.(ctx);
        return null;
      case 'event': {
        const fn = (plugin as { events?: Record<string, (c: unknown, p: unknown) => unknown> }).events?.[String(params.name)];
        if (!fn) throw Object.assign(new Error('sdk.event.unknown'), { key: 'sdk.event.unknown' });
        return fn(ctx, params.payload ?? {});
      }
      case 'webhook': {
        const fn = (plugin as { webhooks?: Record<string, (c: unknown, p: unknown) => unknown> }).webhooks?.[String(params.name)];
        if (!fn) throw Object.assign(new Error('sdk.webhook.unknown'), { key: 'sdk.webhook.unknown' });
        return fn(ctx, params.payload ?? {});
      }
      case 'task': {
        const fn = (plugin as { tasks?: Record<string, (c: unknown) => unknown> }).tasks?.[String(params.name)];
        if (!fn) throw Object.assign(new Error('sdk.task.unknown'), { key: 'sdk.task.unknown' });
        return fn(ctx);
      }
      case 'block': {
        const fn = plugin.blocks?.[String(params.name)];
        if (!fn) throw new Error(`unknown block ${String(params.name)}`);
        // interaction: handle of the command/click that runs the graph (ctx.interaction.*), else undefined.
        return fn(ctx, { config: params.config ?? {}, vars: params.vars ?? {}, interaction: typeof params.interaction === 'string' ? params.interaction : undefined });
      }
      case 'component':
      case 'modal': {
        const area = msg.method === 'component' ? 'components' : 'modals';
        const fn = (plugin as Record<string, unknown>)[area] as Record<string, (c: unknown, e: unknown) => unknown> | undefined;
        const handler = fn?.[String(params.key)];
        if (!handler) throw Object.assign(new Error('sdk.component.unknown'), { key: 'sdk.component.unknown' });
        return handler(ctx, params.event ?? {});
      }
      default:
        throw new Error(`unknown method ${String(msg.method)}`);
    }
  })().then(done, failed);
});

process.on('uncaughtException', (err) => {
  send({ type: 'crash', error: errorText(err) });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ type: 'crash', error: errorText(err) });
  process.exit(1);
});
send({ type: 'hello' });
