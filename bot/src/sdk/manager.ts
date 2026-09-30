// SDK manager: starts the installed plugins (plugin_installs, global) for
// each bot that did not switch them off (bot_plugin_disabled), each in its
// own sandboxed process (process.ts). It is their only way to the database
// and Discord. A plugin gets a call only when the permission is declared in
// its manifest AND switched on in the SDK policies (sdk_policies, global).
// Plugin blocks become node types plugin.<id>.<name>.

import { resolve, sep } from 'node:path';
import type { Db } from '../core/db.js';
import type { Handler, Run } from '../graph/interpreter.js';
import type { GraphNode, NodeDefinition } from '../graph/types.js';
import { SdkError } from './errors.js';
import { blockType, readManifest, PERMISSIONS, type Permission } from './manifest.js';
import { PluginProcess, type SdkLimits } from './process.js';
import { PluginStorage, type StorageLimits } from './storage.js';

/** What the manager needs from the bot for Discord and the log. */
export interface PluginDeps {
  sendMessage(botId: number, channelId: string, message: unknown): Promise<string>;
  guildInfo(botId: number, guildId: string): Promise<{ id: string; name: string; memberCount: number }>;
  log(botId: number, level: 'info' | 'warning' | 'error', plugin: string, text: string): void;
}

export interface ManagerOptions {
  /** /data/plugins: files at <pluginsDir>/<id>/<version>/. */
  pluginsDir: string;
  limits: SdkLimits & StorageLimits;
  /** Permissions switched on in the SDK policies, read at every start. */
  policy: () => ReadonlySet<Permission>;
}

interface Row {
  plugin_id: string;
  version: string;
  config: string;
}

/** SDK policies: defaults of shared/sdk-permissions.json (risk low = on), overridden by sdk_policies rows. */
export function loadPolicy(db: Db, permissions: { key: string; risk: string }[]): ReadonlySet<Permission> {
  const rows = new Map((db.prepare('SELECT permission, enabled FROM sdk_policies').all() as { permission: string; enabled: number }[]).map((r) => [r.permission, r.enabled === 1]));
  const on = new Set<Permission>();
  for (const p of permissions) {
    if (!(PERMISSIONS as readonly string[]).includes(p.key)) continue;
    if (rows.get(p.key) ?? p.risk === 'low') on.add(p.key as Permission);
  }
  return on;
}

const SNOWFLAKE = /^\d{17,20}$/;
/** Discord messages a plugin may send: 5 per 5 seconds per bot and plugin. */
const SEND_MAX = 5;
const SEND_WINDOW_MS = 5000;
const RESULT_SUFFIX = /^(\.[a-z0-9_]{1,32})?$/;

export class PluginManager {
  private readonly running = new Map<number, PluginProcess[]>();

  constructor(
    private readonly db: Db,
    private readonly options: ManagerOptions,
    private readonly deps: PluginDeps,
  ) {}

  /** Starts the enabled plugins of a bot; a broken plugin is logged and skipped. */
  async startBot(botId: number): Promise<void> {
    this.stopBot(botId);
    const rows = this.db
      .prepare(
        `SELECT i.plugin_id, i.version, i.config FROM plugin_installs i
         WHERE i.enabled = 1 AND NOT EXISTS (SELECT 1 FROM bot_plugin_disabled d WHERE d.bot_id = ? AND d.plugin_id = i.plugin_id)
         ORDER BY i.plugin_id`,
      )
      .all(botId) as unknown as Row[];
    const policy = this.options.policy();
    const list: PluginProcess[] = [];
    this.running.set(botId, list);
    for (const row of rows) {
      try {
        list.push(await this.startPlugin(botId, row, policy));
      } catch (err) {
        this.deps.log(botId, 'error', row.plugin_id, err instanceof SdkError ? err.key : String(err));
      }
    }
  }

  stopBot(botId: number): void {
    for (const p of this.running.get(botId) ?? []) p.stop();
    this.running.delete(botId);
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stopBot(id);
  }

  /** Node definitions of the bot's plugin blocks (for the interpreter). */
  blockDefs(botId: number): Map<string, NodeDefinition> {
    const out = new Map<string, NodeDefinition>();
    for (const p of this.running.get(botId) ?? []) {
      for (const b of p.manifest.blocks) {
        if (!p.blocks.includes(b.name)) continue;
        const type = blockType(p.manifest.id, b.name);
        out.set(type, { ...(b.definition as object), type, category: 'action' } as unknown as NodeDefinition);
      }
    }
    return out;
  }

  /** Handlers of the bot's plugin blocks: config in, results and port out. */
  blockHandlers(botId: number): Map<string, Handler> {
    const out = new Map<string, Handler>();
    for (const p of this.running.get(botId) ?? []) {
      for (const name of p.blocks) {
        out.set(blockType(p.manifest.id, name), (node, run) => this.runBlock(p, name, node, run));
      }
    }
    return out;
  }

  private async runBlock(p: PluginProcess, name: string, node: GraphNode, run: Run): Promise<string | void> {
    // Placeholders are filled in here; the plugin sees plain values.
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.config)) config[k] = typeof v === 'string' ? run.str(node, k) : v;
    const vars: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of run.vars) {
      if (++n > 200) break;
      vars[k] = v.slice(0, 1000);
    }
    const res = (await p.runBlock(name, config, vars)) as { port?: unknown; results?: unknown } | null;
    if (res && typeof res === 'object') {
      if (res.results && typeof res.results === 'object') {
        for (const [suffix, value] of Object.entries(res.results as Record<string, unknown>)) {
          if (RESULT_SUFFIX.test(suffix)) run.setResult(node, suffix, String(value).slice(0, 4000));
        }
      }
      if (typeof res.port === 'string' && /^[a-z_]{1,32}$/.test(res.port)) return res.port;
    }
  }

  private async startPlugin(botId: number, row: Row, policy: ReadonlySet<Permission>): Promise<PluginProcess> {
    const root = resolve(this.options.pluginsDir);
    const dir = resolve(root, row.plugin_id, row.version);
    if (!dir.startsWith(root + sep)) throw new SdkError('sdk.plugin.bad_path');
    const manifest = readManifest(dir);
    if (manifest.id !== row.plugin_id || manifest.version !== row.version) throw new SdkError('sdk.manifest.mismatch');

    let config: unknown;
    try {
      config = JSON.parse(row.config);
    } catch {
      throw new SdkError('sdk.plugin.bad_row');
    }
    const allowed = new Set<Permission>(manifest.permissions.filter((perm) => policy.has(perm)));
    for (const perm of manifest.permissions) {
      if (!policy.has(perm)) this.deps.log(botId, 'warning', manifest.id, `sdk.policy.off ${perm}`);
    }

    const storage = new PluginStorage(this.db, botId, manifest.id, this.options.limits);
    let sent: number[] = [];
    const handlers = {
      'storage.get': (q: Record<string, unknown>) => storage.get(q.key),
      'storage.set': (q: Record<string, unknown>) => storage.set(q.key, q.value),
      'storage.delete': (q: Record<string, unknown>) => storage.delete(q.key),
      'storage.list': (q: Record<string, unknown>) => storage.list(q.prefix),
      'discord.sendMessage': (q: Record<string, unknown>) => {
        if (typeof q.channelId !== 'string' || !SNOWFLAKE.test(q.channelId)) throw new SdkError('sdk.discord.bad_channel');
        const now = Date.now();
        sent = sent.filter((t) => now - t < SEND_WINDOW_MS);
        if (sent.length >= SEND_MAX) throw new SdkError('sdk.discord.rate_limited');
        sent.push(now);
        const message = typeof q.message === 'string' ? { mode: 'normal', content: q.message } : q.message;
        return this.deps.sendMessage(botId, q.channelId, message);
      },
      'discord.guildInfo': (q: Record<string, unknown>) => {
        if (typeof q.guildId !== 'string' || !SNOWFLAKE.test(q.guildId)) throw new SdkError('sdk.discord.bad_guild');
        return this.deps.guildInfo(botId, q.guildId);
      },
      'log.write': (q: Record<string, unknown>) => {
        const level = q.level === 'error' || q.level === 'warning' ? q.level : 'info';
        this.deps.log(botId, level, manifest.id, String(q.text ?? '').slice(0, 500));
      },
    };
    const proc = new PluginProcess(
      botId,
      manifest,
      dir,
      allowed,
      config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {},
      handlers,
      this.options.limits,
      (level, key, params) => this.deps.log(botId, level, manifest.id, `${key} ${JSON.stringify(params).slice(0, 400)}`),
    );
    await proc.start();
    return proc;
  }
}

