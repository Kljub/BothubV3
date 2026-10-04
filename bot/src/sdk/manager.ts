// SDK manager: starts the installed plugins (plugin_installs, global) for
// each bot that did not switch them off (bot_plugin_disabled), each in its
// own sandboxed process (process.ts). It is their only way to the database
// and Discord. A plugin gets a call only when the permission is declared in
// its manifest AND switched on in the SDK policies (sdk_policies, global).
// Plugin blocks become node types plugin.<id>.<name>.

import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Db } from '../core/db.js';
import type { Handler, Run } from '../graph/interpreter.js';
import type { GraphNode, NodeDefinition } from '../graph/types.js';
import { SdkError } from './errors.js';
import { mask } from '../core/secrets-global.js';
import { cronMatches, parseCron, type Cron } from '../graph/cron.js';
import { parseDuration } from '../graph/util.js';
import { catalog } from './catalog.js';
import { blockType, readManifest, type Permission } from './manifest.js';
import { PluginProcess, type SdkLimits } from './process.js';
import { PluginStorage, type StorageLimits } from './storage.js';
import { pluginVariables } from './variables.js';
import { ANY_FILE, discordAttachmentUrl, FILE_LIMITS, FILE_NAME, PluginFiles } from './files.js';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { buildComponents, privateAddress, discordApi, interactionEvent, InteractionRegistry, parsePluginCustomId, pluginCode, type DiscordApiDeps, type RawHttp } from './discord-api.js';
import type { Interaction, RepliableInteraction } from 'discord.js';
import { denied, type Permissions } from '../discord/commands.js';

/** What the manager needs from the bot for Discord and the log. */
export interface PluginDeps {
  sendMessage(botId: number, channelId: string, message: unknown, files?: { name: string; data: Buffer }[]): Promise<string>;
  guildInfo(botId: number, guildId: string): Promise<{ id: string; name: string; memberCount: number }>;
  guildList(botId: number): Promise<{ id: string; name: string; memberCount: number }[]>;
  /** A secret of the bot's owner (core/secrets-global.ts), null when unknown. */
  secret?(botId: number, key: string): string | null;
  /** Voice of a running bot (discord/voice.ts); undefined when the bot is not running. */
  voice?(botId: number): VoiceApi | undefined;
  /** HTTP for http.secret; tests pass their own. */
  fetch?: typeof fetch;
  /** Discord, HTTP and economy calls of a running bot (discord-api.ts); undefined when it is not running. */
  discord?(botId: number): DiscordApiDeps | undefined;
  /** Tests: DNS and raw HTTPS of http.outbound. */
  outbound?: { resolve?: (host: string) => Promise<string[]>; raw?: RawHttp; checkRaw?: RawHttp };
  log(botId: number, level: 'info' | 'warning' | 'error', plugin: string, text: string): void;
}

export interface ManagerOptions {
  /** /data/plugins: files at <pluginsDir>/<id>/<version>/. */
  pluginsDir: string;
  limits: SdkLimits & StorageLimits;
  /** Module keys of shared/modules.json (module.* calls). */
  modules: string[];
  /** Permissions switched on in the SDK policies, read at every start. */
  policy: () => ReadonlySet<Permission>;
}

interface Row {
  plugin_id: string;
  version: string;
  config: string;
}

/** A field of a plugin's settings page (dashboard/settings.json; the API checked the shape at install). */
interface SettingsField {
  key: string;
  type: string;
  default?: unknown;
  max?: number;
  min?: number;
  maxLength?: number;
  pattern?: string;
  options?: unknown[];
  /** choices: the plugin sets the options at run time (config.setOptions). */
  dynamic?: boolean;
  group?: boolean;
  item?: SettingsField[];
}

const MAX_OPTIONS = 200;

/** Options of a dynamic choices field: [{value, label}] (label defaults to value), null when malformed. */
export function fieldOptions(v: unknown): { value: string; label: string }[] | null {
  if (!Array.isArray(v) || v.length > MAX_OPTIONS) return null;
  const out = new Map<string, string>();
  for (const o of v) {
    const value = typeof o === 'string' ? o : (o as { value?: unknown })?.value;
    const label = typeof o === 'string' ? o : ((o as { label?: unknown })?.label ?? value);
    if (typeof value !== 'string' || value === '' || value.length > 100 || typeof label !== 'string' || label.length > 100) return null;
    out.set(value, label || value);
  }
  return [...out].map(([value, label]) => ({ value, label }));
}

/** The fields of a plugin's settings page. */
function settingsFields(dir: string): SettingsField[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'dashboard', 'settings.json'), 'utf8'));
  } catch {
    return [];
  }
  const fields = (raw as { fields?: unknown } | null)?.fields;
  return (Array.isArray(fields) ? fields : []).filter((f): f is SettingsField => !!f && typeof f === 'object' && typeof f.key === 'string' && typeof f.type === 'string');
}

/** "permissions" fields of a plugin's settings page: key -> field. */
function permissionFields(dir: string): Map<string, { default?: unknown }> {
  return new Map(settingsFields(dir).filter((f) => f.type === 'permissions').map((f) => [f.key, f]));
}

/** The value of a field nobody saved yet (same defaults as the API, ModuleSettings::value). */
function fieldDefault(f: SettingsField): unknown {
  if (f.default !== undefined) return structuredClone(f.default);
  switch (f.type) {
    case 'choices':
      return [];
    case 'bool':
      return false;
    case 'number':
      return f.min ?? 0;
    case 'select':
      return f.options?.[0] ?? null;
    case 'text':
    case 'color':
    case 'image':
    case 'file':
      return '';
    case 'channel':
    case 'role':
      return null;
    case 'permissions':
      return f.group ? { allowed_roles: [], banned_roles: [], required_permissions: [], banned_channels: [] } : { allowed_roles: [{ id: 'everyone' }], banned_roles: [], required_permissions: [], banned_channels: [] };
    case 'message':
      return {};
    default:
      return [];
  }
}

const SETTING_MAX_BYTES = 65_536;
const REF = (v: unknown): v is { id: string; guild: string } =>
  !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && SNOWFLAKE.test((v as { id: string }).id) && typeof (v as { guild?: unknown }).guild === 'string' && SNOWFLAKE.test((v as { guild: string }).guild);

/**
 * config.set: checks a value against its settings field. Access rules
 * (permissions) and messages stay with the dashboard; a plugin cannot
 * change who may use it.
 */
function checkSetting(f: SettingsField, v: unknown, path: string): unknown {
  const bad = (): never => {
    throw new SdkError('sdk.config.bad_value', { key: path });
  };
  switch (f.type) {
    case 'bool':
      return typeof v === 'boolean' ? v : bad();
    case 'number':
      return Number.isInteger(v) && (v as number) >= (f.min ?? -Infinity) && (v as number) <= (f.max ?? Infinity) ? v : bad();
    case 'text':
      if (typeof v !== 'string' || v.length > (f.max ?? 2000)) bad();
      if (f.pattern && v !== '' && !new RegExp(f.pattern, 'u').test(v as string)) bad();
      return v;
    case 'select':
      return f.options?.includes(v) ? v : bad();
    case 'choices':
      return Array.isArray(v) && v.length <= (f.max ?? 100) && v.every((c) => typeof c === 'string' && c !== '' && c.length <= 100 && (f.dynamic === true || !!f.options?.includes(c)))
        ? [...new Set(v as string[])]
        : bad();
    case 'color':
      return v === '' || (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? (v as string).toLowerCase() : bad();
    case 'image':
      return v === '' || (typeof v === 'string' && FILE_NAME.test(v)) ? v : bad();
    case 'file':
      return v === '' || (typeof v === 'string' && /^[0-9a-f]{16}\.(mp3|ogg|wav|webm)$/.test(v)) ? v : bad();
    case 'channel':
    case 'role':
      return v === null || REF(v) ? (v === null ? null : { id: v.id, guild: v.guild }) : bad();
    case 'channels':
    case 'roles':
      return Array.isArray(v) && v.length <= (f.max ?? 100) && v.every(REF) ? v.map((r) => ({ id: r.id, guild: r.guild })) : bad();
    case 'words':
      return Array.isArray(v) && v.length <= (f.max ?? 100) && v.every((w) => typeof w === 'string' && w.trim() !== '' && w.length <= (f.maxLength ?? 100))
        ? [...new Set(v.map((w: string) => w.trim()))]
        : bad();
    case 'list': {
      if (!Array.isArray(v) || v.length > (f.max ?? 50)) bad();
      return (v as unknown[]).map((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) bad();
        const it = item as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const sub of f.item ?? []) out[sub.key] = it[sub.key] === undefined ? fieldDefault(sub) : checkSetting(sub, it[sub.key], `${path}.${i}.${sub.key}`);
        // Stable ID of the entry (the dashboard edits entries by it).
        out._id = typeof it._id === 'string' && /^[a-z0-9]{8,16}$/.test(it._id) ? it._id : randomBytes(6).toString('hex');
        return out;
      });
    }
    default:
      throw new SdkError('sdk.config.not_settable', { key: path });
  }
}

/** File names (plugin files) anywhere in a settings value. */
function fileNames(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    if (ANY_FILE.test(v)) out.add(v);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) fileNames(x, out);
  }
  return out;
}

/** A stored block in the shape denied() reads; no value is open to everyone. */
function permissionsOf(v: unknown): Permissions {
  const b = (v && typeof v === 'object' && !Array.isArray(v) ? v : { allowed_roles: [{ id: 'everyone' }] }) as Record<string, unknown>;
  const refs = (x: unknown) => (Array.isArray(x) ? x.filter((r): r is { id: string; guild?: string } => !!r && typeof r.id === 'string') : []);
  return {
    allowed_roles: refs(b.allowed_roles),
    banned_roles: refs(b.banned_roles),
    required_permissions: Array.isArray(b.required_permissions) ? b.required_permissions.filter((p): p is string => typeof p === 'string') : [],
    banned_channels: refs(b.banned_channels),
    hide_without_permission: false,
  };
}

/** SDK policies: defaults of shared/sdk-permissions.json (risk low = on), overridden by sdk_policies rows. */
export function loadPolicy(db: Db, permissions: { key: string; risk: string }[]): ReadonlySet<Permission> {
  const rows = new Map((db.prepare('SELECT permission, enabled FROM sdk_policies').all() as { permission: string; enabled: number }[]).map((r) => [r.permission, r.enabled === 1]));
  const on = new Set<Permission>();
  for (const p of permissions) {
    if (!catalog().permissionKeys.has(p.key)) continue;
    if (rows.get(p.key) ?? p.risk === 'low') on.add(p.key as Permission);
  }
  return on;
}

const SNOWFLAKE = /^\d{17,20}$/;
/** Secret names (Admin > API / Secrets). */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,39}$/;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SOUND_FILE = /^sounds\/[a-z0-9_-]{1,64}\.(ogg|mp3|wav)$/;
const SOUND_MAX_BYTES = 10 * 1024 * 1024;

/** The part of discord/voice.ts VoiceManager the SDK uses. */
export interface VoiceApi {
  join(guildId: string, channelId: string): Promise<void>;
  leave(guildId: string): void;
  play(guildId: string, input: string | Readable, options: { owner: string; label?: string; volume?: number }): void;
  stop(guildId: string, owner?: string): void;
  state(guildId: string): { channelId: string | null; playing: boolean; label: string | null; owner: string | null };
}
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_BYTES = 1024 * 1024;
const FORBIDDEN_HEADERS = /^(authorization|cookie|host|content-length|connection|transfer-encoding|proxy-.*|x-forwarded-.*|forwarded)$/;
/** Discord messages a plugin may send: 5 per 5 seconds per bot and plugin. */
const SEND_MAX = 5;
const SEND_WINDOW_MS = 5000;
const RESULT_SUFFIX = /^(\.[a-z0-9_]{1,32})?$/;

export class PluginManager {
  private readonly running = new Map<number, PluginProcess[]>();
  /** Task timers of each bot (services.tasks). */
  private readonly timers = new Map<number, NodeJS.Timeout[]>();
  /** Last "busy" log per bot and plugin: once a minute at most. */
  private readonly busyLogged = new Map<string, number>();
  /** Interactions the plugins may answer (opaque handles, 15 min). */
  readonly interactions = new InteractionRegistry();

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
        const proc = await this.startPlugin(botId, row, policy);
        list.push(proc);
        this.scheduleTasks(botId, proc);
      } catch (err) {
        if (err instanceof SdkError && err.key === 'sdk.plugin.blocked') {
          this.deps.log(botId, 'warning', row.plugin_id, `sdk.plugin.blocked ${(err.params.permissions as string[]).join(', ')}`);
        } else {
          this.deps.log(botId, 'error', row.plugin_id, err instanceof SdkError ? err.key : String(err));
        }
      }
    }
  }

  stopBot(botId: number): void {
    this.interactions.dropBot(botId);
    for (const t of this.timers.get(botId) ?? []) clearInterval(t);
    this.timers.delete(botId);
    for (const p of this.running.get(botId) ?? []) p.stop();
    this.running.delete(botId);
  }

  /**
   * A Discord event (catalog name, e.g. guildMemberAdd) for every plugin of
   * the bot that lists it in "events" and has the discord.events.* permission
   * of that event (shared/sdk-permissions.json "events"). Fire and
   * forget: a slow or failing plugin never holds up the bot.
   */
  dispatchEvent(botId: number, name: string, payload: Record<string, unknown>): void {
    for (const p of this.running.get(botId) ?? []) {
      const needs = catalog().eventPermission.get(name);
      if (!p.manifest.events.includes(name) || !needs || !p.permissions.has(needs as Permission)) continue;
      p.runEvent(name, payload).catch((err) => this.logRunError(botId, p, `event ${name}`, err));
    }
  }

  /**
   * A click, select or modal on a plugin component (custom_id p:<code>:<key>:<data>).
   * Returns false when the custom_id is not a plugin's. The plugin answers
   * through ctx.interaction.* with the handle; silent plugins are
   * acknowledged by the registry after 2.5 s.
   */
  dispatchInteraction(botId: number, i: Interaction): boolean {
    if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return false;
    const id = parsePluginCustomId(i.customId);
    if (!id) return false;
    const p = (this.running.get(botId) ?? []).find((x) => pluginCode(x.manifest.id) === id.code);
    const ri = i as RepliableInteraction;
    // Clicks and modals: answering needs discord.interactions.reply or discord.modals (the old key discord.interactions is split into both).
    if (!p || !(p.permissions.has('discord.interactions.reply' as Permission) || p.permissions.has('discord.modals' as Permission))) {
      void ri.reply({ content: 'This button is not available any more.', flags: 64 }).catch(() => undefined);
      return true;
    }
    const handle = this.interactions.hold(botId, p.manifest.id, ri, true);
    p.runInteraction(i.isModalSubmit() ? 'modal' : 'component', id.key, interactionEvent(i, handle, id.key, id.data)).catch((err) => {
      this.logRunError(botId, p, `${i.isModalSubmit() ? 'modal' : 'component'} ${id.key}`, err);
      if (!ri.replied && !ri.deferred) void ri.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => undefined);
    });
    return true;
  }

  /** A call of a plugin webhook (bothub.json services.webhooks; the API checked the URL token). */
  dispatchWebhook(botId: number, pluginId: string, name: string, payload: Record<string, unknown>): void {
    const p = this.running.get(botId)?.find((x) => x.manifest.id === pluginId);
    if (!p || !p.manifest.webhooks.includes(name) || !p.permissions.has('webhooks.inbound')) return;
    p.runWebhook(name, payload).catch((err) => this.logRunError(botId, p, `webhook ${name}`, err));
  }

  /** Runs a task of a plugin at once (tests, "run now" on the dashboard). */
  runTaskNow(botId: number, pluginId: string, task: string): Promise<unknown> {
    const p = this.running.get(botId)?.find((x) => x.manifest.id === pluginId);
    if (!p || !p.manifest.tasks.some((t) => t.name === task)) return Promise.reject(new SdkError('sdk.task.unknown'));
    if (!p.permissions.has('scheduler')) return Promise.reject(new SdkError('sdk.call.denied', { permission: 'scheduler' }));
    return p.runTask(task);
  }

  /** Tasks of a plugin: every <n>[smhd] (min. 1 minute) or a cron (UTC); needs scheduler. */
  private scheduleTasks(botId: number, p: PluginProcess): void {
    if (!p.manifest.tasks.length) return;
    if (!p.permissions.has('scheduler')) {
      this.deps.log(botId, 'warning', p.manifest.id, 'sdk.policy.off scheduler: tasks do not run');
      return;
    }
    const list = this.timers.get(botId) ?? [];
    this.timers.set(botId, list);
    const run = (name: string) => p.runTask(name).catch((err) => this.logRunError(botId, p, `task ${name}`, err));
    const crons: { name: string; cron: Cron }[] = [];
    for (const t of p.manifest.tasks) {
      if (t.every) {
        const ms = Math.max(60_000, parseDuration(t.every));
        const timer = setInterval(() => run(t.name), ms);
        timer.unref();
        list.push(timer);
      } else if (t.cron) {
        try {
          crons.push({ name: t.name, cron: parseCron(t.cron) });
        } catch {
          this.deps.log(botId, 'warning', p.manifest.id, `sdk.task.bad_cron ${t.name}`);
        }
      }
    }
    if (crons.length) {
      let lastMinute = -1;
      const timer = setInterval(() => {
        const now = new Date();
        const minute = Math.floor(now.getTime() / 60_000);
        if (minute === lastMinute) return;
        lastMinute = minute;
        for (const c of crons) if (cronMatches(c.cron, now, 'UTC')) run(c.name);
      }, 15_000);
      timer.unref();
      list.push(timer);
    }
  }

  private logRunError(botId: number, p: PluginProcess, what: string, err: unknown): void {
    const key = err instanceof SdkError ? err.key : String(err);
    if (key === 'sdk.plugin.busy') {
      const id = `${botId}:${p.manifest.id}`;
      const last = this.busyLogged.get(id) ?? 0;
      if (Date.now() - last < 60_000) return;
      this.busyLogged.set(id, Date.now());
    }
    const message = err instanceof SdkError && typeof err.params.message === 'string' ? `: ${err.params.message}` : '';
    this.deps.log(botId, 'warning', p.manifest.id, `${what} ${key}${message}`.slice(0, 500));
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
    // The command/click of the run: the plugin may answer it (ctx.interaction.*) when allowed.
    const interaction = (run.data as { interaction?: RepliableInteraction } | undefined)?.interaction;
    const handle = interaction && (p.permissions.has('discord.interactions.reply' as Permission) || p.permissions.has('discord.modals' as Permission))
      ? this.interactions.hold(p.botId, p.manifest.id, interaction, false)
      : undefined;
    const res = (await p.runBlock(name, config, vars, handle)) as { port?: unknown; results?: unknown } | null;
    if (res && typeof res === 'object') {
      if (res.results && typeof res.results === 'object') {
        for (const [suffix, value] of Object.entries(res.results as Record<string, unknown>)) {
          if (RESULT_SUFFIX.test(suffix)) run.setResult(node, suffix, String(value).slice(0, 4000));
        }
      }
      if (typeof res.port === 'string' && /^[a-z_]{1,32}$/.test(res.port)) return res.port;
    }
  }

  /**
   * http.secret(request): an HTTP request with admin secrets the plugin never
   * sees. request.url is the name of a secret that holds the address (the
   * admin set it, so any address works, also one in the home network), or a
   * full https URL of a host in bothub.json "services.hosts" (public
   * addresses only). request.auth puts a secret into a header or a URL
   * parameter. Only names of "services.secrets" that the admin shared count
   * (secretOf); the values are masked in the answer.
   *
   * With the plugin files (storage.files): request.file sends one stored
   * image as multipart/form-data ({ field, name }, plus text request.fields);
   * request.saveAs 'file' stores a successful answer (an image, max. 2 MB)
   * in the plugin files and answers { status, headers, file }.
   */
  private async callSecret(request: unknown, secretOf: (name: unknown) => string | null, hosts: string[], files: PluginFiles | null = null): Promise<unknown> {
    const r = (request && typeof request === 'object' && !Array.isArray(request) ? request : {}) as Record<string, unknown>;
    const hide: string[] = [];
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : 'GET';
    if (!HTTP_METHODS.includes(method)) throw new SdkError('sdk.http.bad_method');

    let url: URL;
    if (typeof r.url === 'string' && SECRET_NAME.test(r.url)) {
      const address = secretOf(r.url);
      if (!address) throw new SdkError('sdk.secret.not_shared', { name: r.url });
      let base: URL;
      try {
        base = new URL(address.trim());
      } catch {
        throw new SdkError('sdk.secret.not_a_url', { name: r.url });
      }
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new SdkError('sdk.secret.not_a_url', { name: r.url });
      const path = r.path === undefined ? '' : r.path;
      if (typeof path !== 'string' || path.length > 500 || (path && !path.startsWith('/')) || path.includes('..') || path.includes('//') || /[\s\\#?]/.test(path)) {
        throw new SdkError('sdk.http.bad_path');
      }
      url = new URL(base.toString().replace(/\/+$/, '') + path);
      if (url.origin !== base.origin) throw new SdkError('sdk.http.bad_path');
      hide.push(address.trim());
    } else {
      if (typeof r.url !== 'string' || r.url.length > 2000) throw new SdkError('sdk.http.bad_url');
      try {
        url = new URL(r.url);
      } catch {
        throw new SdkError('sdk.http.bad_url');
      }
      if (url.protocol !== 'https:' || url.username || url.password) throw new SdkError('sdk.http.bad_url');
      if (!hosts.includes(url.hostname.toLowerCase())) throw new SdkError('sdk.http.host_not_allowed');
      let ips: string[];
      try {
        ips = await (this.deps.outbound?.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((x) => x.address)))(url.hostname);
      } catch {
        throw new SdkError('sdk.http.failed');
      }
      if (!ips.length || ips.some(privateAddress)) throw new SdkError('sdk.http.private_address');
    }
    if (r.query !== undefined) {
      if (!r.query || typeof r.query !== 'object' || Object.keys(r.query).length > 50) throw new SdkError('sdk.http.bad_path');
      for (const [k, v] of Object.entries(r.query as Record<string, unknown>)) url.searchParams.set(k, String(v));
    }

    const authHeaders: Record<string, string> = {};
    if (r.auth !== undefined) {
      const a = (r.auth && typeof r.auth === 'object' && !Array.isArray(r.auth) ? r.auth : {}) as Record<string, unknown>;
      const value = secretOf(a.secret);
      if (!value) throw new SdkError('sdk.secret.not_shared', { name: typeof a.secret === 'string' ? a.secret.slice(0, 40) : '' });
      hide.push(value);
      const format = a.format === undefined ? 'bearer' : a.format;
      if (format === 'query') {
        const param = a.param ?? 'key';
        if (typeof param !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(param)) throw new SdkError('sdk.http.bad_path');
        url.searchParams.set(param, value);
      } else {
        const header = a.header ?? 'Authorization';
        if (typeof header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(header) || !['bearer', 'plain'].includes(String(format))) throw new SdkError('sdk.http.bad_header');
        authHeaders[header] = format === 'bearer' ? `Bearer ${value}` : value;
      }
    }

    const headers: Record<string, string> = {};
    if (r.headers !== undefined) {
      if (!r.headers || typeof r.headers !== 'object' || Object.keys(r.headers).length > 30) throw new SdkError('sdk.http.bad_header');
      const authNames = Object.keys(authHeaders).map((h) => h.toLowerCase());
      for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== 'string' || v.length > 1000 || /[\r\n]/.test(v) || FORBIDDEN_HEADERS.test(lower) || authNames.includes(lower)) {
          throw new SdkError('sdk.http.bad_header');
        }
        headers[k] = v;
      }
    }
    const needFiles = (): PluginFiles => {
      if (!files) throw new SdkError('sdk.call.denied', { permission: 'storage.files' });
      return files;
    };
    const saveAsFile = r.saveAs !== undefined;
    if (saveAsFile && r.saveAs !== 'file') throw new SdkError('sdk.http.bad_save_as');
    let body: string | FormData | undefined;
    if (r.file !== undefined) {
      // multipart/form-data: one image of the plugin files plus text fields.
      const f = (r.file && typeof r.file === 'object' && !Array.isArray(r.file) ? r.file : {}) as Record<string, unknown>;
      const field = f.field ?? 'file';
      if (typeof field !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(field) || r.json !== undefined) throw new SdkError('sdk.http.bad_file');
      const stored = needFiles().get(f.name);
      if (!stored) throw new SdkError('sdk.files.unknown');
      const form = new FormData();
      if (r.fields !== undefined) {
        if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields) || Object.keys(r.fields).length > 30) throw new SdkError('sdk.http.bad_file');
        for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) {
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k) || String(v).length > 4000) throw new SdkError('sdk.http.bad_file');
          form.append(k, String(v));
        }
      }
      form.append(field, new Blob([new Uint8Array(stored.data)], { type: stored.mime }), stored.name);
      body = form;
      delete headers['content-type'];
    } else if (r.json !== undefined) {
      body = JSON.stringify(r.json);
      if (body.length > 65_536) throw new SdkError('sdk.http.too_big');
      headers['content-type'] = 'application/json';
    }
    if (saveAsFile) needFiles();
    let res: Response;
    try {
      // request.timeoutMs: slow APIs (e.g. AI answers) may take up to 60 s; default 10 s.
      const timeout = Number.isInteger(r.timeoutMs) ? Math.min(60_000, Math.max(1000, r.timeoutMs as number)) : HTTP_TIMEOUT_MS;
      res = await (this.deps.fetch ?? fetch)(url, { method, headers: { ...headers, ...authHeaders }, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new SdkError((err as Error)?.name === 'TimeoutError' ? 'sdk.http.timeout' : 'sdk.http.failed');
    }
    // Read at most 1 MB (an image saved as a file: the file limit).
    const max = saveAsFile && res.ok ? FILE_LIMITS.maxBytes : HTTP_MAX_BYTES;
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new SdkError(saveAsFile && res.ok ? 'sdk.files.too_big' : 'sdk.http.too_big', { max });
      }
      chunks.push(value);
    }
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of res.headers) if (!/^(set-cookie|www-authenticate)$/.test(k) && Object.keys(outHeaders).length < 50) outHeaders[k] = mask(v, hide);
    // The answer is an image: into the plugin files (type checked like an upload).
    if (saveAsFile && res.ok) return { status: res.status, headers: outHeaders, file: needFiles().put(Buffer.concat(chunks), '', true) };
    const text = mask(Buffer.concat(chunks).toString('utf8'), hide);
    let json: unknown = null;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: outHeaders, json, text };
  }

  /**
   * What ctx.config answers: defaults of the settings page, the install
   * config, then the bot's saved settings (plugin_settings).
   */
  private configOf(botId: number, pluginId: string, dir: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of settingsFields(dir)) out[f.key] = fieldDefault(f);
    const row = this.db.prepare('SELECT config FROM plugin_installs WHERE plugin_id = ?').get(pluginId) as { config: string } | undefined;
    try {
      const c = row ? (JSON.parse(row.config) as unknown) : {};
      if (c && typeof c === 'object' && !Array.isArray(c)) Object.assign(out, c);
    } catch {
      // a broken install config adds nothing
    }
    return Object.assign(out, this.pluginSettings(botId, pluginId));
  }

  /** The settings of a plugin changed (dashboard save): the running plugin reads the new ones. */
  refreshConfig(botId: number, pluginId: string): void {
    const p = this.running.get(botId)?.find((x) => x.manifest.id === pluginId);
    if (p) p.setConfig(this.configOf(botId, pluginId, p.pluginDir));
  }

  /** Saved settings of a plugin on a bot (plugin_settings), read per call so a dashboard save counts at once. */
  private pluginSettings(botId: number, pluginId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT config FROM plugin_settings WHERE bot_id = ? AND plugin_id = ?').get(botId, pluginId) as { config: string } | undefined;
    try {
      const c = row ? (JSON.parse(row.config) as unknown) : {};
      return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private moduleInfo(botId: number, key: unknown): { id: string; name: string; enabled: boolean; config: Record<string, unknown> } {
    if (typeof key !== 'string' || !this.options.modules.includes(key)) throw new SdkError('sdk.module.unknown');
    const row = this.db.prepare('SELECT enabled, config FROM bot_modules WHERE bot_id = ? AND module_key = ?').get(botId, key) as { enabled: number; config: string } | undefined;
    let config: Record<string, unknown> = {};
    try {
      config = row ? (JSON.parse(row.config) as Record<string, unknown>) : {};
    } catch {
      config = {};
    }
    const name = key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { id: key, name, enabled: row ? row.enabled === 1 : true, config };
  }

  private async startPlugin(botId: number, row: Row, policy: ReadonlySet<Permission>): Promise<PluginProcess> {
    const root = resolve(this.options.pluginsDir);
    const dir = resolve(root, row.plugin_id, row.version);
    if (!dir.startsWith(root + sep)) throw new SdkError('sdk.plugin.bad_path');
    const manifest = readManifest(dir);
    if (manifest.id !== row.plugin_id || manifest.version !== row.version) throw new SdkError('sdk.manifest.mismatch');

    try {
      JSON.parse(row.config);
    } catch {
      throw new SdkError('sdk.plugin.bad_row');
    }
    const config = this.configOf(botId, manifest.id, dir);
    // A plugin runs only with every SDK permission it declares switched on;
    // a policy change restarts the plugins, so it comes back on its own.
    const missing = manifest.permissions.filter((perm) => !policy.has(perm));
    if (missing.length > 0) throw new SdkError('sdk.plugin.blocked', { permissions: missing });
    const allowed = new Set<Permission>(manifest.permissions);

    const readable = (key: string) => allowed.has('modules.read' as Permission) || allowed.has(`modules.${key}.read` as Permission);
    const mayRead = (key: unknown): unknown => {
      if (typeof key === 'string' && !readable(key)) throw new SdkError('sdk.call.denied', { permission: `modules.${key}.read` });
      return key;
    };
    const storage = new PluginStorage(this.db, botId, manifest.id, this.options.limits);
    const globalStorage = new PluginStorage(this.db, null, manifest.id, this.options.limits);
    const files = new PluginFiles(this.db, botId, manifest.id);
    let proc: PluginProcess | undefined;
    let sent: number[] = [];
    const sendSlot = (channelId: unknown): string => {
      if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new SdkError('sdk.discord.bad_channel');
      const now = Date.now();
      sent = sent.filter((t) => now - t < SEND_WINDOW_MS);
      if (sent.length >= SEND_MAX) throw new SdkError('sdk.discord.rate_limited');
      sent.push(now);
      return channelId;
    };
    const pluginMessage = (message: unknown): Record<string, unknown> => {
      const msg: Record<string, unknown> = typeof message === 'string' ? { mode: 'normal', content: message } : { ...((message && typeof message === 'object' ? message : {}) as Record<string, unknown>) };
      // Buttons/selects route back to this plugin (custom_id p:<code>:…); the plugin cannot set raw custom_ids.
      delete msg._components;
      if (msg.components !== undefined) {
        msg._components = buildComponents(manifest.id, msg.components);
        delete msg.components;
      }
      return msg;
    };
    // config.set / config.delete: the plugin changes its own settings (e.g. a list entry added by command).
    const writeSetting = (key: unknown, value: unknown, remove: boolean): void => {
      const field = settingsFields(dir).find((f) => f.key === key);
      if (!field) throw new SdkError('sdk.config.unknown_key', { key: String(key).slice(0, 40) });
      const clean = remove ? undefined : checkSetting(field, value, field.key);
      if (JSON.stringify(clean ?? null).length > SETTING_MAX_BYTES) throw new SdkError('sdk.config.too_big', { max: SETTING_MAX_BYTES });
      const before = this.pluginSettings(botId, manifest.id);
      const after = { ...before };
      if (remove) delete after[field.key];
      else after[field.key] = clean;
      this.db
        .prepare(
          `INSERT INTO plugin_settings (bot_id, plugin_id, config) VALUES (?, ?, ?)
           ON CONFLICT (bot_id, plugin_id) DO UPDATE SET config = excluded.config, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(botId, manifest.id, JSON.stringify(after));
      // Images the settings no longer name are gone.
      const keep = fileNames(after);
      for (const name of fileNames(before)) if (!keep.has(name)) files.delete(name);
      proc?.setConfig(this.configOf(botId, manifest.id, dir));
    };
    // Calls of the plugin, by name (shared/sdk-permissions.json); arguments
    // arrive as { args: [...] } from ctx.<area>.<method>(...args).
    const a = (q: Record<string, unknown>): unknown[] => (Array.isArray(q.args) ? q.args : []);
    const owner = `plugin:${manifest.id}`;
    const guild = (g: unknown): string => {
      if (typeof g !== 'string' || !SNOWFLAKE.test(g)) throw new SdkError('sdk.voice.bad_guild');
      return g;
    };
    const voice = (): VoiceApi => {
      const v = this.deps.voice?.(botId);
      if (!v) throw new SdkError('error.bot.not_running');
      return v;
    };
    const variables = () => pluginVariables(this.db, botId, manifest.id, manifest.name);
    // Secret values the plugin read are masked in its log lines.
    const readSecrets = new Set<string>();
    const log = (level: 'info' | 'warning' | 'error') => (q: Record<string, unknown>) => {
      this.deps.log(botId, level, manifest.id, mask(String(a(q)[0] ?? ''), [...readSecrets]).slice(0, 500));
    };
    /**
     * secrets.get / secrets.has: only names the manifest declares
     * ("services.secrets") AND the admin shared with this plugin. Any other
     * name answers like a missing secret, so a plugin cannot find out which
     * secrets exist; there is no call that lists them.
     */
    // The names come from the manifest the API checked and stored at install
    // (plugins.manifest), not from files or settings a plugin could change.
    const installedSecrets = ((): string[] => {
      const row = this.db.prepare('SELECT manifest FROM plugins WHERE id = ? AND version = ?').get(manifest.id, manifest.version) as { manifest: string } | undefined;
      try {
        const list = (JSON.parse(row?.manifest ?? '{}') as { secrets?: unknown }).secrets;
        return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && manifest.secrets.includes(k)) : [];
      } catch {
        return [];
      }
    })();
    const secretOf = (key: unknown): string | null => {
      if (typeof key !== 'string' || !installedSecrets.includes(key)) return null;
      // Shared by the bot's owner: every user decides for their own secrets.
      const shared = this.db
        .prepare('SELECT 1 FROM secret_plugin_shares s JOIN bots b ON b.owner_id = s.owner_id WHERE b.id = ? AND s.secret_key = ? AND s.plugin_id = ?')
        .get(botId, key, manifest.id);
      const value = shared ? (this.deps.secret?.(botId, key) ?? null) : null;
      if (value) readSecrets.add(value);
      return value;
    };
    const handlers: Record<string, (q: Record<string, unknown>) => unknown> = {
      'logger.debug': log('info'),
      'logger.info': log('info'),
      'logger.success': log('info'),
      'logger.warn': log('warning'),
      'logger.error': log('error'),
      'storage.get': (q) => storage.get(a(q)[0]),
      'storage.set': (q) => storage.set(a(q)[0], a(q)[1]),
      'storage.has': (q) => storage.has(a(q)[0]),
      'storage.delete': (q) => storage.delete(a(q)[0]),
      'storage.increment': (q) => storage.increment(a(q)[0], a(q)[1] ?? 1),
      'storage.decrement': (q) => storage.increment(a(q)[0], -Number(a(q)[1] ?? 1)),
      'storage.clear': () => storage.clear(),
      // Global storage (storage.global): the same calls, shared by every bot.
      'globalStorage.get': (q) => globalStorage.get(a(q)[0]),
      'globalStorage.set': (q) => globalStorage.set(a(q)[0], a(q)[1]),
      'globalStorage.has': (q) => globalStorage.has(a(q)[0]),
      'globalStorage.delete': (q) => globalStorage.delete(a(q)[0]),
      'globalStorage.increment': (q) => globalStorage.increment(a(q)[0], a(q)[1] ?? 1),
      'globalStorage.decrement': (q) => globalStorage.increment(a(q)[0], -Number(a(q)[1] ?? 1)),
      'globalStorage.clear': () => globalStorage.clear(),
      'message.send': (q) => {
        const [channelId, message] = a(q);
        return this.deps.sendMessage(botId, sendSlot(channelId), pluginMessage(message));
      },
      // An image of the plugin files as an attachment; image "attachment" in an embed shows it there.
      'message.sendFile': (q) => {
        const [channelId, name, message] = a(q);
        const file = files.get(name);
        if (!file) throw new SdkError('sdk.files.unknown');
        const msg = message === undefined || message === null ? {} : pluginMessage(message);
        // spoiler: Discord blurs the image until clicked (file name SPOILER_…).
        const spoiler = msg.spoiler === true;
        delete msg.spoiler;
        const fileName = `${spoiler ? 'SPOILER_' : ''}${file.filename || file.name}`;
        if (Array.isArray(msg.embeds)) {
          msg.embeds = msg.embeds.map((e: unknown) => {
            if (!e || typeof e !== 'object') return e;
            const embed = { ...(e as Record<string, unknown>) };
            for (const k of ['image_url', 'thumbnail_url']) if (embed[k] === 'attachment') embed[k] = `attachment://${fileName}`;
            return embed;
          });
        }
        return this.deps.sendMessage(botId, sendSlot(channelId), msg, [{ name: fileName, data: file.data }]);
      },
      // Data Storage variables the plugin creates (data.variables): {var.<key>} in the builders.
      'variables.create': (q) => variables().create(a(q)[0]),
      'variables.delete': (q) => variables().delete(a(q)[0]),
      'variables.list': () => variables().list(),
      'variables.get': (q) => variables().get(a(q)[0], a(q)[1]),
      'variables.set': (q) => variables().set(a(q)[0], a(q)[1], a(q)[2]),
      'variables.reset': (q) => variables().reset(a(q)[0], a(q)[1]),
      // Plugin files (storage.files): images and other files per bot.
      'files.list': () => files.list(),
      'files.get': (q) => {
        const f = files.get(a(q)[0]);
        return f ? { name: f.name, mime: f.mime, size: f.size, filename: f.filename, data: f.data.toString('base64') } : null;
      },
      // Without a file name only images (as before); with one any file but executables.
      'files.put': (q) => {
        const [data, filename] = a(q);
        if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new SdkError('sdk.files.bad_type');
        return files.put(Buffer.from(data, 'base64'), typeof filename === 'string' ? filename : '', typeof filename !== 'string');
      },
      'files.delete': (q) => files.delete(a(q)[0]),
      'files.fromDiscord': async (q) => {
        const url = discordAttachmentUrl(a(q)[0]);
        if (!url) throw new SdkError('sdk.files.bad_url');
        let res: Response;
        try {
          res = await (this.deps.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        } catch {
          throw new SdkError('sdk.http.failed');
        }
        if (!res.ok) throw new SdkError('sdk.http.failed');
        if (Number(res.headers.get('content-length') ?? 0) > FILE_LIMITS.maxBytes) throw new SdkError('sdk.files.too_big', { max: FILE_LIMITS.maxBytes });
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > FILE_LIMITS.maxBytes) {
            await reader.cancel();
            throw new SdkError('sdk.files.too_big', { max: FILE_LIMITS.maxBytes });
          }
          chunks.push(value);
        }
        // The original name: given, else the last part of the link (…/attachments/1/2/report.pdf).
        const given = a(q)[1];
        const filename = typeof given === 'string' && given.trim() ? given : decodeURIComponent(url.pathname.split('/').pop() ?? '');
        return files.put(Buffer.concat(chunks), filename);
      },
      'config.set': (q) => writeSetting(a(q)[0], a(q)[1], false),
      'config.delete': (q) => writeSetting(a(q)[0], undefined, true),
      // Options of a dynamic "choices" field (e.g. Plex libraries as "Server:Library").
      'config.setOptions': (q) => {
        const [key, options] = a(q);
        const field = settingsFields(dir).find((f) => f.key === key);
        if (!field) throw new SdkError('sdk.config.unknown_key', { key: String(key).slice(0, 40) });
        if (field.type !== 'choices' || field.dynamic !== true) throw new SdkError('sdk.config.not_dynamic', { key: field.key });
        const clean = fieldOptions(options);
        if (!clean) throw new SdkError('sdk.config.bad_options', { max: MAX_OPTIONS });
        this.db
          .prepare(
            `INSERT INTO plugin_field_options (bot_id, plugin_id, field, options) VALUES (?, ?, ?, ?)
             ON CONFLICT (bot_id, plugin_id, field) DO UPDATE SET options = excluded.options, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          )
          .run(botId, manifest.id, field.key, JSON.stringify(clean));
        return clean.length;
      },
      'guild.get': (q) => {
        const guildId = a(q)[0];
        if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw new SdkError('sdk.discord.bad_guild');
        return this.deps.guildInfo(botId, guildId);
      },
      'guild.list': () => this.deps.guildList(botId),
      'http.secret': (q) => this.callSecret(a(q)[0], secretOf, manifest.hosts, allowed.has('storage.files' as Permission) ? files : null),
      'secrets.get': (q) => secretOf(a(q)[0]),
      'secrets.has': (q) => secretOf(a(q)[0]) !== null,
      // Voice: files of the plugin folder only; another owner's play is not replaced.
      'voice.join': (q) => {
        const [guildId, channelId] = a(q);
        if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId) || typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new SdkError('sdk.voice.bad_channel');
        return voice().join(guildId, channelId);
      },
      'voice.leave': (q) => {
        const guildId = guild(a(q)[0]);
        const st = voice().state(guildId);
        if (st.owner && st.owner !== owner) throw new SdkError('sdk.voice.busy');
        voice().leave(guildId);
      },
      'voice.play': (q) => {
        const [g, file, opts] = a(q);
        const guildId = guild(g);
        const volume = opts && typeof opts === 'object' && 'volume' in opts ? (opts as { volume: unknown }).volume : 1;
        if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new SdkError('sdk.voice.bad_volume');
        // A sound of the plugin files (storage.files), e.g. uploaded by a member: mp3, ogg, wav, webm.
        if (typeof file === 'string' && /^[0-9a-f]{16}\.(mp3|ogg|wav|webm)$/.test(file)) {
          if (!allowed.has('storage.files' as Permission)) throw new SdkError('sdk.call.denied');
          const stored = files.get(file);
          if (!stored) throw new SdkError('sdk.voice.bad_file');
          voice().play(guildId, Readable.from(stored.data), { owner, label: stored.filename || file, volume });
          return;
        }
        if (typeof file !== 'string' || !SOUND_FILE.test(file)) throw new SdkError('sdk.voice.bad_file');
        let size = -1;
        try {
          const st = statSync(join(dir, file));
          size = st.isFile() ? st.size : -1;
        } catch {
          size = -1;
        }
        if (size < 0 || size > SOUND_MAX_BYTES) throw new SdkError('sdk.voice.bad_file');
        voice().play(guildId, join(dir, file), { owner, label: file, volume });
      },
      'voice.stop': (q) => voice().stop(guild(a(q)[0]), owner),
      'voice.state': (q) => {
        const st = voice().state(guild(a(q)[0]));
        return { channelId: st.channelId, playing: st.playing, file: st.owner === owner ? st.label : null };
      },
      // BotHub modules of this bot (bot_modules; a missing row means on). Read only.
      // modules.read: every module; modules.<key>.read: that module only.
      'module.list': () => this.options.modules.filter((key) => readable(key)).map((key) => this.moduleInfo(botId, key)),
      'module.get': (q) => this.moduleInfo(botId, mayRead(a(q)[0])),
      'module.getId': (q) => this.moduleInfo(botId, mayRead(a(q)[0])).id,
      'module.getName': (q) => this.moduleInfo(botId, mayRead(a(q)[0])).name,
      'module.isEnabled': (q) => this.moduleInfo(botId, mayRead(a(q)[0])).enabled,
      'module.getConfig': (q) => this.moduleInfo(botId, mayRead(a(q)[0])).config,
      // A "permissions" field of the plugin's settings page: may this member
      // use the feature here? Same check as a command's permissions block.
      'config.checkAccess': async (q) => {
        const [key, who] = a(q);
        const field = permissionFields(dir).get(String(key));
        if (!field) throw new SdkError('sdk.config.not_permissions', { key: String(key) });
        const w = (who && typeof who === 'object' ? who : {}) as Record<string, unknown>;
        const user = typeof w.userId === 'string' ? w.userId : (w.user as { id?: unknown } | undefined)?.id;
        const guildId = w.guildId ?? null;
        const channelId = w.channelId ?? null;
        if (guildId === null) return { allowed: true, reason: null }; // DMs: no roles, no channels
        if (typeof user !== 'string' || !SNOWFLAKE.test(user) || typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)
          || (channelId !== null && (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)))) {
          throw new SdkError('sdk.config.bad_member');
        }
        const g = live().client()?.guilds.cache.get(guildId);
        if (!g) throw new SdkError('sdk.discord.unknown_guild');
        const member = await g.members.fetch(user).catch(() => null);
        if (!member) return { allowed: false, reason: 'member' };
        const saved = this.pluginSettings(botId, manifest.id)[String(key)];
        const reason = denied(permissionsOf(saved ?? field.default), member, channelId as string | null);
        return { allowed: reason === null, reason };
      },
    };
    // Discord, HTTP and economy calls: only while the bot runs (the bot is looked up per call).
    const live = (): DiscordApiDeps => {
      const d = this.deps.discord?.(botId);
      if (!d) throw new SdkError('error.bot.not_running');
      return d;
    };
    const liveDeps: DiscordApiDeps = {
      client: () => this.deps.discord?.(botId)?.client(),
      render: (m) => live().render(m),
      economy: {
        balance: (g, u) => live().economy.balance(g, u),
        change: (g, u, n, mode) => live().economy.change(g, u, n, mode),
        pay: (g, f, t, n) => live().economy.pay(g, f, t, n),
        leaderboard: (g, n) => live().economy.leaderboard(g, n),
      },
    };
    // Interaction answers may carry a plugin file (options.file) when the plugin has storage.files.
    const fileOf = allowed.has('storage.files' as Permission) ? (name: unknown) => files.get(name) : undefined;
    Object.assign(handlers, discordApi(botId, manifest.id, manifest.hosts, liveDeps, this.interactions, this.deps.outbound, fileOf));
    proc = new PluginProcess(
      botId,
      manifest,
      dir,
      allowed,
      config,
      handlers,
      this.options.limits,
      (level, key, params) => this.deps.log(botId, level, manifest.id, `${key} ${JSON.stringify(params).slice(0, 400)}`),
    );
    await proc.start();
    return proc;
  }
}

