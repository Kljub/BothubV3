// Discord, HTTP and economy calls of the SDK (shared/sdk-permissions.json).
// The manager wires them per plugin and bot; the permission check happens
// before (process.ts). Every call checks its arguments here: the plugin is
// untrusted. Rules:
//   - only servers of this bot; snowflakes /^\d{17,20}$/
//   - message.edit only on the bot's own messages
//   - roles only below the bot's highest role, never managed, never with
//     Administrator; members only below the bot's highest role
//   - http.* only https, only hosts of the manifest (services.hosts), no
//     private or local addresses (checked on every redirect hop)
//   - interaction tokens stay here: the plugin gets an opaque handle

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import {
  AuditLogEvent,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type MessageComponentInteraction,
  type RepliableInteraction,
  type Role,
} from 'discord.js';
import { SdkError } from './errors.js';
import type { CaseAction, ModCase } from '../core/repo.js';

type Handler = (q: Record<string, unknown>) => unknown;

const SNOWFLAKE = /^\d{17,20}$/;
const KEY = /^[a-z0-9_]{1,20}$/;
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_BYTES = 1024 * 1024;
const HTTP_PARALLEL = 5;
const HANDLE_TTL_MS = 15 * 60_000;
/** Discord answers a click only within 3 s: after this the bot acknowledges it itself. */
export const AUTO_DEFER_MS = 2500;

/** What the calls need from the running bot. */
export interface DiscordApiDeps {
  client(): Client | undefined;
  /** BotHub message format (Send Message block) -> discord.js payload. */
  render(message: unknown): Record<string, unknown>;
  /** The bot's Moderation module (cases, notes); undefined in tests without it. */
  moderation?: {
    /** Records a case like a module command (DM, log channel, automatic punishments); null when the module is off. */
    record(guild: Guild, input: { userId: string; moderatorId: string | null; action: CaseAction; reason: string; duration: string }): Promise<number | null>;
    cases(guildId: string, userId: string): ModCase[];
    modCase(guildId: string, number: number): ModCase | undefined;
    addNote(guildId: string, userId: string, authorId: string | null, content: string): number;
    notes(guildId: string, userId: string): { id: number; authorId: string | null; content: string; createdAt: string }[];
  };
  economy: {
    balance(guildId: string, userId: string): number;
    change(guildId: string, userId: string, amount: number, mode: 'add' | 'set'): number;
    pay(guildId: string, from: string, to: string, amount: number): boolean;
    leaderboard(guildId: string, limit: number): { userId: string; balance: number }[];
  };
}

// ---------- custom_ids of plugin components ----------

/** Short code of a plugin id: custom_ids may hold 100 characters only. */
export const pluginCode = (pluginId: string): string => createHash('sha256').update(pluginId).digest('hex').slice(0, 8);

/** p:<code>:<key>:<data>; data is free text (max. 64). */
export function pluginCustomId(pluginId: string, key: unknown, data: unknown = ''): string {
  if (typeof key !== 'string' || !KEY.test(key)) throw new SdkError('sdk.component.bad_key');
  const d = data === undefined || data === null ? '' : String(data);
  if (d.length > 64) throw new SdkError('sdk.component.bad_data');
  return `p:${pluginCode(pluginId)}:${key}:${d}`;
}

export function parsePluginCustomId(customId: string): { code: string; key: string; data: string } | null {
  const m = /^p:([0-9a-f]{8}):([a-z0-9_]{1,20}):(.{0,64})$/s.exec(customId);
  return m ? { code: m[1]!, key: m[2]!, data: m[3]! } : null;
}

const STYLES: Record<string, number> = { primary: 1, secondary: 2, success: 3, danger: 4 };

/**
 * Plugin components (message.components): rows of buttons, link buttons and
 * one select per row. Keys route clicks back to the plugin.
 */
export function buildComponents(pluginId: string, rows: unknown): unknown[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 5) throw new SdkError('sdk.component.invalid');
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 5) throw new SdkError('sdk.component.invalid');
    const items = row.map((raw) => {
      const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const label = typeof c.label === 'string' ? c.label.slice(0, 80) : undefined;
      const emoji = typeof c.emoji === 'string' && c.emoji ? (/^\d{17,20}$/.test(c.emoji) ? { id: c.emoji } : { name: c.emoji.slice(0, 32) }) : undefined;
      if (c.type === 'link') {
        if (typeof c.url !== 'string' || !/^https:\/\//.test(c.url) || c.url.length > 512) throw new SdkError('sdk.component.invalid');
        return { type: 2, style: 5, url: c.url, label, emoji, disabled: c.disabled === true };
      }
      if (c.type === 'select') {
        const options = Array.isArray(c.options) ? c.options : [];
        if (options.length < 1 || options.length > 25) throw new SdkError('sdk.component.invalid');
        return {
          type: 3,
          custom_id: pluginCustomId(pluginId, c.key, c.data),
          placeholder: typeof c.placeholder === 'string' ? c.placeholder.slice(0, 150) : undefined,
          min_values: Number.isInteger(c.min) ? Math.max(0, Math.min(25, c.min as number)) : undefined,
          max_values: Number.isInteger(c.max) ? Math.max(1, Math.min(options.length, c.max as number)) : undefined,
          disabled: c.disabled === true,
          options: options.map((o) => {
            const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
            if (typeof x.label !== 'string' || typeof x.value !== 'string') throw new SdkError('sdk.component.invalid');
            return {
              label: x.label.slice(0, 100), value: x.value.slice(0, 100),
              description: typeof x.description === 'string' ? x.description.slice(0, 100) : undefined,
              emoji: typeof x.emoji === 'string' && x.emoji ? { name: x.emoji.slice(0, 32) } : undefined,
              default: x.default === true,
            };
          }),
        };
      }
      if (!label && !emoji) throw new SdkError('sdk.component.invalid');
      return { type: 2, style: STYLES[String(c.style ?? 'secondary')] ?? 2, custom_id: pluginCustomId(pluginId, c.key, c.data), label, emoji, disabled: c.disabled === true };
    });
    if (items.some((i) => i.type === 3) && items.length > 1) throw new SdkError('sdk.component.invalid');
    return { type: 1, components: items };
  });
}

// ---------- interaction handles ----------

interface Held {
  botId: number;
  pluginId: string;
  interaction: RepliableInteraction;
  expires: number;
  timer?: NodeJS.Timeout;
}

/** Interactions the plugins may answer, by opaque handle (bound to bot + plugin). */
export class InteractionRegistry {
  private readonly held = new Map<string, Held>();

  /** Registers an interaction; when the plugin stays silent the bot acknowledges it after AUTO_DEFER_MS. */
  hold(botId: number, pluginId: string, interaction: RepliableInteraction, autoDefer: boolean): string {
    this.sweep();
    const handle = randomBytes(12).toString('hex');
    const h: Held = { botId, pluginId, interaction, expires: Date.now() + HANDLE_TTL_MS };
    if (autoDefer) {
      h.timer = setTimeout(() => {
        const i = h.interaction;
        if (i.replied || i.deferred) return;
        const p = i.isMessageComponent() ? (i as MessageComponentInteraction).deferUpdate() : i.deferReply({ flags: 64 });
        void p.catch(() => undefined);
      }, AUTO_DEFER_MS);
      h.timer.unref();
    }
    this.held.set(handle, h);
    return handle;
  }

  get(botId: number, pluginId: string, handle: unknown): RepliableInteraction {
    const h = typeof handle === 'string' ? this.held.get(handle) : undefined;
    if (!h || h.botId !== botId || h.pluginId !== pluginId || h.expires < Date.now()) throw new SdkError('sdk.interaction.unknown');
    return h.interaction;
  }

  dropBot(botId: number): void {
    for (const [k, h] of this.held) {
      if (h.botId !== botId) continue;
      clearTimeout(h.timer);
      this.held.delete(k);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, h] of this.held) {
      if (h.expires >= now) continue;
      clearTimeout(h.timer);
      this.held.delete(k);
    }
  }
}

/** What a plugin handler gets for a click, select or modal (plain JSON). */
export function interactionEvent(i: Interaction, handle: string, key: string, data: string): Record<string, unknown> {
  const ev: Record<string, unknown> = {
    handle, key, data,
    user: { id: i.user.id, name: i.user.username, displayName: i.user.globalName ?? i.user.username },
    guildId: i.guildId ?? null,
    channelId: i.channelId ?? null,
  };
  if (i.isMessageComponent()) {
    ev.messageId = i.message.id;
    if (i.isStringSelectMenu()) ev.values = i.values.slice(0, 25);
  }
  if (i.isModalSubmit()) {
    const fields: Record<string, string> = {};
    for (const f of (i as ModalSubmitInteraction).fields.fields.values()) if ('value' in f && typeof f.value === 'string') fields[f.customId.split(':')[2] ?? f.customId] = f.value.slice(0, 4000);
    ev.fields = fields;
    if (i.message) ev.messageId = i.message.id;
  }
  return ev;
}

// ---------- outbound HTTP (http.outbound) ----------

/** Loopback, private, link-local, CGNAT, multicast, reserved (v4 and v6). */
/** Every range a plugin must not reach: loopback, private, link-local, CGNAT, reserved, multicast; v6 incl. embedded v4. */
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) b.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
    ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ] as const) b.addSubnet(net, bits, 'ipv6');
  return b;
})();

/** Loopback, private, link-local, CGNAT, multicast, reserved (v4 and v6, also v4-mapped, NAT64, 6to4). */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return BLOCKED.check(ip, 'ipv4');
  if (v === 6) return BLOCKED.check(ip, 'ipv6');
  return true;
}

export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  text: string;
  /** Binary answers (images, files): the body as base64; text is then "". */
  base64?: string;
}

/** Tests replace the network: (url, init, address) -> answer. */
export type RawHttp = (url: URL, init: { method: string; headers: Record<string, string>; body?: string }, address: string) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

/**
 * DNS lookup for the HTTPS request that always answers with the checked
 * address. Node 20+ asks with { all: true } (happy eyeballs) and then needs a
 * list; a single address there fails with "Invalid IP address: undefined".
 */
export function checkedLookup(address: string) {
  const family = isIP(address);
  return (_host: string, options: { all?: boolean } | number | undefined, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void): void => {
    if (typeof options === 'object' && options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

const rawHttps: RawHttp = (url, init, address) =>
  new Promise((ok, fail) => {
    const req = httpsRequest(
      {
        host: url.hostname, servername: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: init.method,
        headers: { 'user-agent': 'BotHub-Plugin', ...init.headers },
        // Connect to the address that was checked, not to a fresh DNS answer.
        lookup: checkedLookup(address) as never,
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > HTTP_MAX_BYTES) {
            req.destroy();
            fail(new SdkError('sdk.http.too_big'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
          ok({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', () => fail(new SdkError('sdk.http.failed')));
      },
    );
    req.on('timeout', () => req.destroy(new SdkError('sdk.http.timeout')));
    // Overall deadline: the socket timeout alone lets a server trickle bytes forever.
    const deadline = setTimeout(() => req.destroy(new SdkError('sdk.http.timeout')), HTTP_TIMEOUT_MS);
    deadline.unref();
    req.on('close', () => clearTimeout(deadline));
    req.on('error', (err) => fail(err instanceof SdkError ? err : new SdkError('sdk.http.failed')));
    if (init.body) req.write(init.body);
    req.end();
  });

/** Status only (http.check): connects to the checked address, reads the status line and drops the body. */
const rawStatus: RawHttp = (url, init, address) =>
  new Promise((ok, fail) => {
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = request(
      {
        host: url.hostname, servername: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443), path: url.pathname + url.search, method: init.method,
        headers: { 'user-agent': 'BotHub-StatusCheck', ...init.headers },
        lookup: checkedLookup(address) as never,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
        ok({ status: res.statusCode ?? 0, headers, body: Buffer.alloc(0) });
        req.destroy();
      },
    );
    req.on('error', (err) => fail(err));
    req.end();
  });

export interface CheckAnswer {
  /** Answered with a status below 400. */
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  /** Why there is no status: timeout, dns, private_address, too_many_redirects, failed. */
  error?: string;
}

/**
 * http.check: is a website up? Any public http(s) URL (the user enters it in
 * the plugin settings), at most 3 redirects, never the home network. Answers
 * only status and latency, never the page, so a plugin cannot read sites
 * through it. Network problems are an answer (ok false), not an error.
 */
export async function siteCheck(
  rawUrl: unknown,
  options: unknown,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
  raw: RawHttp = rawStatus,
): Promise<CheckAnswer> {
  const o = (options && typeof options === 'object' && !Array.isArray(options) ? options : {}) as Record<string, unknown>;
  const timeoutMs = Number.isInteger(o.timeoutMs) ? Math.min(10_000, Math.max(1000, o.timeoutMs as number)) : 8000;
  const method = o.method === 'HEAD' ? 'HEAD' : 'GET';
  if (typeof rawUrl !== 'string' || rawUrl.length > 2000) throw new SdkError('sdk.http.bad_url');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SdkError('sdk.http.bad_url');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SdkError('sdk.http.bad_url');
  const start = Date.now();
  const fail = (error: string): CheckAnswer => ({ ok: false, status: null, latencyMs: null, error });
  for (let hop = 0; hop <= 3; hop++) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
    if (!addresses.length) return fail('dns');
    const address = addresses.find((a) => !privateAddress(a));
    if (!address || addresses.some(privateAddress)) return fail('private_address');
    let timer: NodeJS.Timeout | undefined;
    const res = await Promise.race([
      raw(url, { method, headers: {} }, address),
      new Promise<'timeout'>((done) => {
        timer = setTimeout(() => done('timeout'), Math.max(0, start + timeoutMs - Date.now()));
      }),
    ])
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    if (res === 'timeout') return fail('timeout');
    if (!res) return fail('failed');
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        url = new URL(location, url);
      } catch {
        return fail('failed');
      }
      if (!['http:', 'https:'].includes(url.protocol)) return fail('failed');
      continue;
    }
    return { ok: res.status > 0 && res.status < 400, status: res.status, latencyMs: Date.now() - start };
  }
  return fail('too_many_redirects');
}

/** http.check calls per bot and plugin per minute. */
const CHECKS_PER_MINUTE = 60;

const BLOCKED_HEADERS = /^(authorization|cookie|host|content-length|connection|transfer-encoding|proxy-.*|x-forwarded-.*|forwarded)$/;

/** http.get/post/...: https to a host of the manifest, no private addresses, max. 3 redirects. */
export async function outboundHttp(
  hosts: string[],
  method: string,
  rawUrl: unknown,
  options: unknown,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
  raw: RawHttp = rawHttps,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<HttpAnswer> {
  // One deadline for the whole call, redirects included.
  const until = Date.now() + timeoutMs;
  const o = (options && typeof options === 'object' && !Array.isArray(options) ? options : {}) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (o.headers !== undefined) {
    if (!o.headers || typeof o.headers !== 'object' || Object.keys(o.headers).length > 30) throw new SdkError('sdk.http.bad_header');
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== 'string' || v.length > 1000 || /[\r\n]/.test(v) || BLOCKED_HEADERS.test(k.toLowerCase())) throw new SdkError('sdk.http.bad_header');
      headers[k] = v;
    }
  }
  let body: string | undefined;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['content-type'] = 'application/json';
  } else if (typeof o.body === 'string') {
    body = o.body;
  }
  if (body && body.length > 65_536) throw new SdkError('sdk.http.too_big');
  if (typeof rawUrl !== 'string' || rawUrl.length > 2000) throw new SdkError('sdk.http.bad_url');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SdkError('sdk.http.bad_url');
  }
  if (o.query !== undefined) {
    if (!o.query || typeof o.query !== 'object' || Object.keys(o.query).length > 50) throw new SdkError('sdk.http.bad_url');
    for (const [k, v] of Object.entries(o.query as Record<string, unknown>)) url.searchParams.set(k, String(v));
  }
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new SdkError('sdk.http.bad_url');
    const host = url.hostname.toLowerCase();
    if (!hosts.includes(host)) throw new SdkError('sdk.http.host_not_allowed', { host });
    const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
    const address = addresses.find((a) => !privateAddress(a));
    if (!address || addresses.some(privateAddress)) throw new SdkError('sdk.http.private_address', { host });
    let timer: NodeJS.Timeout | undefined;
    const res = await Promise.race([
      raw(url, { method, headers, body }, address),
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new SdkError('sdk.http.timeout')), Math.max(0, until - Date.now()));
      }),
    ]).finally(() => clearTimeout(timer));
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      if (res.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const type = res.headers['content-type'] ?? '';
    const binary = type !== '' && !/json|text|xml|javascript|x-www-form-urlencoded/.test(type);
    const text = binary ? '' : res.body.toString('utf8');
    let json: unknown = null;
    if (type.includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (!/^(set-cookie|www-authenticate)$/.test(k) && Object.keys(out).length < 50) out[k] = v;
    return binary ? { status: res.status, headers: out, json, text, base64: res.body.toString('base64') } : { status: res.status, headers: out, json, text };
  }
  throw new SdkError('sdk.http.too_many_redirects');
}

// ---------- Discord calls ----------

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const sf = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !SNOWFLAKE.test(v)) throw new SdkError(`sdk.discord.bad_${what}`);
  return v;
};
const CASE_ACTIONS = new Set(['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'role_add', 'role_remove', 'voice_mute', 'voice_unmute', 'voice_deafen', 'voice_undeafen', 'voice_kick']);
const reasonOf = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, 400) : undefined);

function memberJson(m: GuildMember): Record<string, unknown> {
  return {
    id: m.id, name: m.user.username, displayName: m.displayName, bot: m.user.bot, avatar: m.displayAvatarURL(),
    joinedAt: m.joinedAt?.toISOString() ?? null, roles: [...m.roles.cache.keys()].filter((r) => r !== m.guild.id),
    // The voice channel the member is in now (null when none), e.g. for a soundboard.
    voiceChannelId: m.voice?.channelId ?? null,
  };
}
function roleJson(r: Role): Record<string, unknown> {
  return { id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed, mentionable: r.mentionable, hoist: r.hoist, members: r.members.size };
}
function messageJson(m: Message): Record<string, unknown> {
  return {
    id: m.id, channelId: m.channelId, guildId: m.guildId, content: m.content, authorId: m.author.id, authorName: m.author.username, bot: m.author.bot,
    createdAt: m.createdAt.toISOString(), url: m.url, attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType ?? null })),
    embeds: m.embeds.length, stickers: m.stickers.size,
  };
}

/** The SDK calls that need Discord, HTTP or the economy, for one plugin of one bot. */
/** What a plugin sees of a custom emoji: id, name, animated, image URL and the text to use it in a message. */
function emojiJson(e: { id: string; name: string | null; animated: boolean | null; available?: boolean | null; imageURL: () => string }): Record<string, unknown> {
  return { id: e.id, name: e.name, animated: e.animated === true, available: e.available !== false, url: e.imageURL(), mention: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` };
}

export function discordApi(
  botId: number,
  pluginId: string,
  hosts: string[],
  deps: DiscordApiDeps,
  interactions: InteractionRegistry,
  net?: { resolve?: (h: string) => Promise<string[]>; raw?: RawHttp; checkRaw?: RawHttp },
  fileOf?: (name: unknown) => { name: string; filename: string; data: Buffer } | null,
): Record<string, Handler> {
  const a = (q: Record<string, unknown>): unknown[] => (Array.isArray(q.args) ? q.args : []);
  const client = (): Client => {
    const c = deps.client();
    if (!c?.isReady()) throw new SdkError('error.bot.not_running');
    return c;
  };
  const guildOf = (id: unknown): Guild => {
    const g = client().guilds.cache.get(sf(id, 'guild'));
    if (!g) throw new SdkError('sdk.discord.unknown_guild');
    return g;
  };
  const me = (g: Guild): GuildMember => {
    const m = g.members.me;
    if (!m) throw new SdkError('sdk.discord.unknown_guild');
    return m;
  };
  const roleOf = async (g: Guild, id: unknown): Promise<Role> => {
    const r = await g.roles.fetch(sf(id, 'role')).catch(() => null);
    if (!r) throw new SdkError('sdk.discord.unknown_role');
    return r;
  };
  /** A role the bot may give or change: below its highest, not managed, not @everyone, no Administrator. */
  const manageable = (g: Guild, r: Role): Role => {
    if (r.id === g.id || r.managed || r.permissions.has(PermissionFlagsBits.Administrator) || r.position >= me(g).roles.highest.position) throw new SdkError('sdk.discord.role_not_allowed');
    return r;
  };
  const memberOf = async (g: Guild, id: unknown): Promise<GuildMember> => {
    const m = await g.members.fetch(sf(id, 'user')).catch(() => null);
    if (!m) throw new SdkError('sdk.discord.unknown_member');
    return m;
  };
  /** Voice moderation needs the member in a voice channel. */
  const inVoice = (m: GuildMember): GuildMember => {
    if (!m.voice.channelId) throw new SdkError('sdk.voice.not_in_voice');
    return m;
  };
  const mod = () => {
    if (!deps.moderation) throw new SdkError('sdk.call.not_available');
    return deps.moderation;
  };
  // A case the plugin records (DM, log channel and automatic punishments as configured).
  const record = async (guildId: unknown, user: unknown, action: CaseAction, reason: unknown, duration: string, moderator: unknown): Promise<number | null> => {
    const g = guildOf(guildId);
    const userId = sf(user, 'user');
    const moderatorId = moderator === undefined || moderator === null ? null : sf(moderator, 'user');
    return mod().record(g, { userId, moderatorId, action, reason: typeof reason === 'string' ? reason.slice(0, 512) : '', duration });
  };
  /** Members the bot may act on: not the owner, below the bot's highest role. */
  const below = (g: Guild, m: GuildMember): GuildMember => {
    if (m.id === g.ownerId || m.id === client().user!.id || m.roles.highest.position >= me(g).roles.highest.position) throw new SdkError('sdk.discord.member_not_allowed');
    return m;
  };
  const channelOf = async (id: unknown) => {
    const ch = await client().channels.fetch(sf(id, 'channel')).catch(() => null);
    if (!ch || ch.isDMBased() || !client().guilds.cache.has(ch.guildId)) throw new SdkError('sdk.discord.unknown_channel');
    return ch;
  };
  const messageOf = async (channelId: unknown, messageId: unknown): Promise<Message> => {
    const ch = await channelOf(channelId);
    if (!ch.isTextBased()) throw new SdkError('sdk.discord.unknown_channel');
    const m = await ch.messages.fetch(sf(messageId, 'message')).catch(() => null);
    if (!m) throw new SdkError('sdk.discord.unknown_message');
    return m;
  };
  /** BotHub message + plugin components -> payload; mentions off unless asked for users. */
  const payload = (message: unknown): Record<string, unknown> => {
    const msg = typeof message === 'string' ? { mode: 'normal', content: message } : (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
    const p = deps.render(msg);
    const components = buildComponents(pluginId, (msg as Record<string, unknown>).components);
    if (components.length) p.components = components;
    else if ((msg as Record<string, unknown>).components !== undefined) p.components = [];
    p.allowedMentions = (msg as Record<string, unknown>).mentionUsers === true ? { parse: ['users'] } : { parse: [] };
    return p;
  };
  const held = (handle: unknown): RepliableInteraction => interactions.get(botId, pluginId, handle);
  const ephemeralFlag = (opts: unknown): number => (opts && typeof opts === 'object' && (opts as { ephemeral?: unknown }).ephemeral === true ? 64 : 0);
  const PERMS: Record<string, bigint> = Object.fromEntries(Object.entries(PermissionFlagsBits).map(([k, v]) => [k.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(), v]));
  const perms = (list: unknown): bigint => {
    if (list === undefined) return 0n;
    if (!Array.isArray(list) || list.length > 40) throw new SdkError('sdk.discord.bad_permission');
    let bits = 0n;
    for (const p of list) {
      const bit = typeof p === 'string' ? PERMS[p] : undefined;
      if (bit === undefined || bit === PermissionFlagsBits.Administrator) throw new SdkError('sdk.discord.bad_permission');
      bits |= bit;
    }
    return bits;
  };
  // At most HTTP_PARALLEL open requests per plugin and bot: slow servers must not fill the call slots.
  let open = 0;
  const checks: number[] = [];
  // options.file of interaction.reply / followUp: a plugin file as attachment (storage.files).
  const withFile = (options: unknown): { files?: { attachment: Buffer; name: string }[] } => {
    const name = options && typeof options === 'object' ? (options as { file?: unknown }).file : undefined;
    if (name === undefined) return {};
    const f = fileOf?.(name);
    if (!f) throw new SdkError(fileOf ? 'sdk.files.unknown' : 'sdk.call.denied');
    return { files: [{ attachment: f.data, name: f.filename || f.name }] };
  };
  const http = (method: string) => async (q: Record<string, unknown>) => {
    if (open >= HTTP_PARALLEL) throw new SdkError('sdk.http.busy');
    open++;
    try {
      return await outboundHttp(hosts, method, a(q)[0], method === 'GET' || method === 'DELETE' ? a(q)[1] : { ...((a(q)[2] as object) ?? {}), json: a(q)[1] }, net?.resolve, net?.raw);
    } finally {
      open--;
    }
  };
  const econGuild = (g: unknown) => guildOf(g).id;
  const amount = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e12) throw new SdkError('sdk.economy.bad_amount');
    return v;
  };

  return {
    // --- guild ---
    'guild.getChannels': (q) =>
      [...guildOf(a(q)[0]).channels.cache.values()].slice(0, 500).map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], parentId: c.parentId, position: 'position' in c ? c.position : 0 })),
    'guild.getRoles': (q) => [...guildOf(a(q)[0]).roles.cache.values()].sort((x, y) => y.position - x.position).map(roleJson),
    'guild.getEmojis': (q) => [...guildOf(a(q)[0]).emojis.cache.values()].map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL() })),
    'guild.getMembers': async (q) => {
      const g = guildOf(a(q)[0]);
      const limit = Math.max(1, Math.min(1000, Number((a(q)[1] as { limit?: unknown })?.limit ?? 100) || 100));
      const list = await g.members.list({ limit }).catch(() => g.members.cache);
      return [...list.values()].slice(0, limit).map(memberJson);
    },
    // --- channel ---
    'channel.get': async (q) => {
      const c = await channelOf(a(q)[0]);
      return { id: c.id, guildId: c.guildId, name: c.name, type: ChannelType[c.type], parentId: c.parentId, topic: 'topic' in c ? c.topic : null, nsfw: 'nsfw' in c ? c.nsfw === true : false };
    },
    'channel.list': (q) => [...guildOf(a(q)[0]).channels.cache.values()].slice(0, 500).map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], parentId: c.parentId })),
    'channel.create': async (q) => {
      const g = guildOf(a(q)[0]);
      const o = (a(q)[1] && typeof a(q)[1] === 'object' ? a(q)[1] : {}) as Record<string, unknown>;
      const name = str(o.name, 100);
      if (!name) throw new SdkError('sdk.discord.bad_name');
      const types: Record<string, ChannelType> = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory, announcement: ChannelType.GuildAnnouncement, forum: ChannelType.GuildForum, stage: ChannelType.GuildStageVoice };
      const type = types[String(o.type ?? 'text')];
      if (type === undefined) throw new SdkError('sdk.discord.bad_type');
      const ch = await g.channels.create({
        name, type: type as ChannelType.GuildText, topic: str(o.topic, 1024), parent: o.parentId ? sf(o.parentId, 'channel') : undefined,
        nsfw: o.nsfw === true, position: Number.isInteger(o.position) ? (o.position as number) : undefined, reason: reasonOf(o.reason),
      });
      return { id: ch.id, name: ch.name };
    },
    'channel.edit': async (q) => {
      const c = await channelOf(a(q)[0]);
      const o = (a(q)[1] && typeof a(q)[1] === 'object' ? a(q)[1] : {}) as Record<string, unknown>;
      const edit: Record<string, unknown> = { reason: reasonOf(o.reason) };
      if (o.name !== undefined) edit.name = str(o.name, 100) ?? (() => { throw new SdkError('sdk.discord.bad_name'); })();
      if (o.topic !== undefined) edit.topic = str(o.topic, 1024) ?? '';
      if (o.parentId !== undefined) edit.parent = o.parentId === null ? null : sf(o.parentId, 'channel');
      if (Number.isInteger(o.position)) edit.position = o.position;
      if (Number.isInteger(o.slowmode)) edit.rateLimitPerUser = Math.max(0, Math.min(21_600, o.slowmode as number));
      await (c as unknown as { edit(o: unknown): Promise<unknown> }).edit(edit);
    },
    'channel.delete': async (q) => {
      const c = await channelOf(a(q)[0]);
      await c.delete(reasonOf(a(q)[1]));
    },
    'channel.setPermissions': async (q) => {
      const c = await channelOf(a(q)[0]);
      if (!('permissionOverwrites' in c)) throw new SdkError('sdk.discord.bad_type');
      const target = sf(a(q)[1], 'target');
      const o = (a(q)[2] && typeof a(q)[2] === 'object' ? a(q)[2] : {}) as Record<string, unknown>;
      const g = c.guild;
      // A role target must be one the bot may manage (or @everyone); members are fine.
      const role = g.roles.cache.get(target);
      if (role && role.id !== g.id) manageable(g, role);
      await c.permissionOverwrites.edit(target, Object.fromEntries([
        ...[...bitsToNames(perms(o.allow))].map((n) => [n, true]),
        ...[...bitsToNames(perms(o.deny))].map((n) => [n, false]),
      ]), { reason: reasonOf(o.reason) });
    },
    // --- role ---
    'role.get': async (q) => roleJson(await roleOf(guildOf(a(q)[0]), a(q)[1])),
    'role.list': (q) => [...guildOf(a(q)[0]).roles.cache.values()].sort((x, y) => y.position - x.position).map(roleJson),
    'role.create': async (q) => {
      const g = guildOf(a(q)[0]);
      const o = (a(q)[1] && typeof a(q)[1] === 'object' ? a(q)[1] : {}) as Record<string, unknown>;
      const r = await g.roles.create({
        name: str(o.name, 100) ?? 'new role', color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? (o.color as `#${string}`) : undefined,
        hoist: o.hoist === true, mentionable: o.mentionable === true, permissions: perms(o.permissions), reason: reasonOf(o.reason),
      });
      return roleJson(r);
    },
    'role.edit': async (q) => {
      const g = guildOf(a(q)[0]);
      const r = manageable(g, await roleOf(g, a(q)[1]));
      const o = (a(q)[2] && typeof a(q)[2] === 'object' ? a(q)[2] : {}) as Record<string, unknown>;
      const edit: Record<string, unknown> = { reason: reasonOf(o.reason) };
      if (o.name !== undefined) edit.name = str(o.name, 100);
      if (typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color)) edit.color = o.color;
      if (typeof o.hoist === 'boolean') edit.hoist = o.hoist;
      if (typeof o.mentionable === 'boolean') edit.mentionable = o.mentionable;
      if (o.permissions !== undefined) edit.permissions = perms(o.permissions);
      return roleJson(await r.edit(edit));
    },
    'role.delete': async (q) => {
      const g = guildOf(a(q)[0]);
      await manageable(g, await roleOf(g, a(q)[1])).delete(reasonOf(a(q)[2]));
    },
    'role.addToMember': async (q) => {
      const g = guildOf(a(q)[0]);
      const r = manageable(g, await roleOf(g, a(q)[2]));
      await (await memberOf(g, a(q)[1])).roles.add(r, reasonOf(a(q)[3]));
    },
    'role.removeFromMember': async (q) => {
      const g = guildOf(a(q)[0]);
      const r = manageable(g, await roleOf(g, a(q)[2]));
      await (await memberOf(g, a(q)[1])).roles.remove(r, reasonOf(a(q)[3]));
    },
    // --- member ---
    'member.get': async (q) => memberJson(await memberOf(guildOf(a(q)[0]), a(q)[1])),
    'member.list': async (q) => {
      const g = guildOf(a(q)[0]);
      const list = await g.members.list({ limit: Math.max(1, Math.min(1000, Number((a(q)[1] as { limit?: unknown })?.limit ?? 100) || 100)) }).catch(() => g.members.cache);
      return [...list.values()].map(memberJson);
    },
    'member.addRole': async (q) => {
      const g = guildOf(a(q)[0]);
      await (await memberOf(g, a(q)[1])).roles.add(manageable(g, await roleOf(g, a(q)[2])), reasonOf(a(q)[3]));
    },
    'member.removeRole': async (q) => {
      const g = guildOf(a(q)[0]);
      await (await memberOf(g, a(q)[1])).roles.remove(manageable(g, await roleOf(g, a(q)[2])), reasonOf(a(q)[3]));
    },
    'member.timeout': async (q) => {
      const g = guildOf(a(q)[0]);
      const ms = a(q)[2];
      if (ms !== null && (typeof ms !== 'number' || ms < 0 || ms > 28 * 86_400_000)) throw new SdkError('sdk.discord.bad_duration');
      await below(g, await memberOf(g, a(q)[1])).timeout(ms as number | null, reasonOf(a(q)[3]));
    },
    'member.kick': async (q) => {
      const g = guildOf(a(q)[0]);
      await below(g, await memberOf(g, a(q)[1])).kick(reasonOf(a(q)[2]));
    },
    'member.ban': async (q) => {
      const g = guildOf(a(q)[0]);
      const id = sf(a(q)[1], 'user');
      const m = await g.members.fetch(id).catch(() => null);
      if (m) below(g, m);
      await g.bans.create(id, { reason: reasonOf(a(q)[2]) });
    },
    'member.unban': async (q) => {
      await guildOf(a(q)[0]).bans.remove(sf(a(q)[1], 'user'), reasonOf(a(q)[2]));
    },
    // --- voice moderation (discord.voice.moderate) ---
    'member.voiceMute': async (q) => {
      const g = guildOf(a(q)[0]);
      await inVoice(below(g, await memberOf(g, a(q)[1]))).voice.setMute(a(q)[2] !== false, reasonOf(a(q)[3]));
    },
    'member.voiceDeafen': async (q) => {
      const g = guildOf(a(q)[0]);
      await inVoice(below(g, await memberOf(g, a(q)[1]))).voice.setDeaf(a(q)[2] !== false, reasonOf(a(q)[3]));
    },
    'member.voiceDisconnect': async (q) => {
      const g = guildOf(a(q)[0]);
      await inVoice(below(g, await memberOf(g, a(q)[1]))).voice.disconnect(reasonOf(a(q)[2]));
    },
    'member.voiceMove': async (q) => {
      const g = guildOf(a(q)[0]);
      const m = inVoice(below(g, await memberOf(g, a(q)[1])));
      const ch = g.channels.cache.get(sf(a(q)[2], 'channel'));
      if (!ch || (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice)) throw new SdkError('sdk.discord.bad_channel');
      await m.voice.setChannel(ch.id, reasonOf(a(q)[3]));
    },
    // --- audit log (discord.audit.read) ---
    'audit.list': async (q) => {
      const g = guildOf(a(q)[0]);
      const opt = (a(q)[1] && typeof a(q)[1] === 'object' ? a(q)[1] : {}) as Record<string, unknown>;
      const limit = Math.min(100, Math.max(1, Number(opt.limit ?? 50) || 50));
      const fetch: Record<string, unknown> = { limit };
      if (opt.type !== undefined) {
        const type = AuditLogEvent[String(opt.type) as keyof typeof AuditLogEvent];
        if (typeof type !== 'number') throw new SdkError('sdk.audit.bad_type');
        fetch.type = type;
      }
      if (opt.user !== undefined) fetch.user = sf(opt.user, 'user');
      if (opt.before !== undefined) fetch.before = sf(opt.before, 'entry');
      const logs = await g.fetchAuditLogs(fetch as never).catch((err: unknown) => {
        throw new SdkError('sdk.audit.denied', { reason: String((err as Error)?.message ?? err).slice(0, 200) });
      });
      const short = (v: unknown) => (v === undefined || v === null ? null : String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 200));
      return [...logs.entries.values()].map((e) => ({
        id: e.id,
        action: AuditLogEvent[e.action] ?? String(e.action),
        executorId: e.executorId ?? null,
        targetId: e.targetId ?? null,
        targetType: String(e.targetType ?? ''),
        reason: e.reason ?? null,
        changes: (e.changes ?? []).slice(0, 20).map((c) => ({ key: String(c.key), old: short(c.old), new: short(c.new) })),
        createdAt: e.createdAt.toISOString(),
      }));
    },
    // --- moderation cases (moderation.cases): the bot's Moderation module ---
    'moderation.warn': async (q) => record(a(q)[0], a(q)[1], 'warn', a(q)[2], '', a(q)[3]),
    'moderation.record': async (q) => {
      const action = a(q)[2];
      if (typeof action !== 'string' || !CASE_ACTIONS.has(action)) throw new SdkError('sdk.moderation.bad_action');
      const duration = a(q)[4] === undefined || a(q)[4] === null ? '' : str(a(q)[4], 20);
      if (duration === undefined) throw new SdkError('sdk.discord.bad_duration');
      return record(a(q)[0], a(q)[1], action as CaseAction, a(q)[3], duration, a(q)[5]);
    },
    'moderation.history': (q) => mod().cases(guildOf(a(q)[0]).id, sf(a(q)[1], 'user')),
    'moderation.getCase': (q) => {
      const n = a(q)[1];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new SdkError('sdk.moderation.bad_case');
      return mod().modCase(guildOf(a(q)[0]).id, n) ?? null;
    },
    'moderation.note': (q) => {
      const content = str(a(q)[2], 1000);
      if (!content || !content.trim()) throw new SdkError('sdk.moderation.bad_note');
      const author = a(q)[3] === undefined || a(q)[3] === null ? null : sf(a(q)[3], 'user');
      return mod().addNote(guildOf(a(q)[0]).id, sf(a(q)[1], 'user'), author, content);
    },
    'moderation.notes': (q) => mod().notes(guildOf(a(q)[0]).id, sf(a(q)[1], 'user')),
    'member.setNickname': async (q) => {
      const g = guildOf(a(q)[0]);
      const nick = a(q)[2];
      if (nick !== null && str(nick, 32) === undefined) throw new SdkError('sdk.discord.bad_name');
      await below(g, await memberOf(g, a(q)[1])).setNickname(nick as string | null, reasonOf(a(q)[3]));
    },
    // --- message ---
    'message.get': async (q) => messageJson(await messageOf(a(q)[0], a(q)[1])),
    'message.edit': async (q) => {
      const m = await messageOf(a(q)[0], a(q)[1]);
      if (m.author.id !== client().user!.id) throw new SdkError('sdk.discord.not_own_message');
      await m.edit(payload(a(q)[2]) as never);
    },
    'message.delete': async (q) => {
      await (await messageOf(a(q)[0], a(q)[1])).delete();
    },
    'message.pin': async (q) => void (await (await messageOf(a(q)[0], a(q)[1])).pin(reasonOf(a(q)[2]))),
    'message.unpin': async (q) => void (await (await messageOf(a(q)[0], a(q)[1])).unpin(reasonOf(a(q)[2]))),
    'message.react': async (q) => {
      const emoji = str(a(q)[2], 64);
      if (!emoji) throw new SdkError('sdk.discord.bad_emoji');
      await (await messageOf(a(q)[0], a(q)[1])).react(emoji);
    },
    'message.dm': async (q) => {
      const user = await client().users.fetch(sf(a(q)[0], 'user')).catch(() => null);
      if (!user || user.bot) throw new SdkError('sdk.discord.unknown_member');
      const sent = await user.send(payload(a(q)[1]) as never).catch(() => null);
      if (!sent) throw new SdkError('sdk.discord.dm_closed');
      return sent.id;
    },
    // --- emoji ---
    // discord.emojis.read: the server's custom emojis, sorted by name.
    'emoji.list': (q) => [...guildOf(a(q)[0]).emojis.cache.values()].sort((x, y) => String(x.name).localeCompare(String(y.name))).map(emojiJson),
    'emoji.get': (q) => {
      const e = guildOf(a(q)[0]).emojis.cache.get(sf(a(q)[1], 'emoji'));
      if (!e) throw new SdkError('sdk.discord.unknown_emoji');
      return emojiJson(e);
    },
    'emoji.create': async (q) => {
      const g = guildOf(a(q)[0]);
      const name = a(q)[1];
      const image = a(q)[2];
      if (typeof name !== 'string' || !/^[A-Za-z0-9_]{2,32}$/.test(name)) throw new SdkError('sdk.discord.bad_name');
      // base64 (PNG/GIF/WEBP/JPEG, max. 256 KB), e.g. http.get(...).base64.
      if (typeof image !== 'string' || image.length > 350_000) throw new SdkError('sdk.discord.bad_image');
      const attachment = Buffer.from(image.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
      if (!attachment.length || attachment.length > 256 * 1024) throw new SdkError('sdk.discord.bad_image');
      const e = await g.emojis.create({ name, attachment, reason: reasonOf(a(q)[3]) });
      return { id: e.id, name: e.name, animated: e.animated };
    },
    'emoji.delete': async (q) => {
      const g = guildOf(a(q)[0]);
      const e = g.emojis.cache.get(sf(a(q)[1], 'emoji'));
      if (!e) throw new SdkError('sdk.discord.unknown_emoji');
      await e.delete(reasonOf(a(q)[2]));
    },
    // --- interactions (handles from blocks, clicks, selects, modals) ---
    'interaction.reply': async (q) => {
      const i = held(a(q)[0]);
      const p = { ...payload(a(q)[1]), flags: ephemeralFlag(a(q)[2]), ...withFile(a(q)[2]) };
      if (i.replied || i.deferred) await i.followUp(p as never);
      else await i.reply(p as never);
    },
    'interaction.editReply': async (q) => {
      const i = held(a(q)[0]);
      if (!i.replied && !i.deferred) throw new SdkError('sdk.interaction.not_replied');
      await i.editReply(payload(a(q)[1]) as never);
    },
    'interaction.deferReply': async (q) => {
      const i = held(a(q)[0]);
      if (!i.replied && !i.deferred) await i.deferReply({ flags: ephemeralFlag(a(q)[1]) });
    },
    'interaction.followUp': async (q) => {
      const i = held(a(q)[0]);
      if (!i.replied && !i.deferred) throw new SdkError('sdk.interaction.not_replied');
      await i.followUp({ ...payload(a(q)[1]), flags: ephemeralFlag(a(q)[2]), ...withFile(a(q)[2]) } as never);
    },
    /** Updates the message of the clicked button/select (component interactions). */
    'interaction.update': async (q) => {
      const i = held(a(q)[0]);
      if (!i.isMessageComponent()) throw new SdkError('sdk.interaction.not_component');
      if (i.deferred || i.replied) await i.editReply(payload(a(q)[1]) as never);
      else await i.update(payload(a(q)[1]) as never);
    },
    'interaction.showModal': async (q) => {
      const i = held(a(q)[0]);
      if (i.replied || i.deferred || !('showModal' in i)) throw new SdkError('sdk.interaction.too_late');
      const m = (a(q)[1] && typeof a(q)[1] === 'object' ? a(q)[1] : {}) as Record<string, unknown>;
      const fields = Array.isArray(m.fields) ? m.fields : [];
      if (fields.length < 1 || fields.length > 5) throw new SdkError('sdk.component.invalid');
      await (i as unknown as { showModal(m: unknown): Promise<void> }).showModal({
        custom_id: pluginCustomId(pluginId, m.key, m.data),
        title: str(m.title, 45) ?? 'Form',
        components: fields.map((raw) => {
          const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          return {
            type: 1,
            components: [{
              type: 4, custom_id: pluginCustomId(pluginId, f.key), label: str(f.label, 45) ?? String(f.key), style: f.style === 'long' ? 2 : 1,
              required: f.required !== false, value: str(f.value, 4000), placeholder: str(f.placeholder, 100),
              min_length: Number.isInteger(f.min) ? f.min : undefined, max_length: Number.isInteger(f.max) ? f.max : undefined,
            }],
          };
        }),
      });
    },
    // --- http.outbound ---
    'http.get': http('GET'),
    'http.post': http('POST'),
    'http.put': http('PUT'),
    'http.patch': http('PATCH'),
    'http.delete': http('DELETE'),
    // --- http.check: status and latency of any public website ---
    'http.check': async (q) => {
      const now = Date.now();
      checks.splice(0, checks.length, ...checks.filter((t) => now - t < 60_000));
      if (checks.length >= CHECKS_PER_MINUTE) throw new SdkError('sdk.http.busy');
      checks.push(now);
      return siteCheck(a(q)[0], a(q)[1], net?.resolve, net?.checkRaw);
    },
    // --- economy (the bot's Economy module: same balances as /balance) ---
    'economy.get': (q) => deps.economy.balance(econGuild(a(q)[0]), sf(a(q)[1], 'user')),
    'economy.add': (q) => deps.economy.change(econGuild(a(q)[0]), sf(a(q)[1], 'user'), amount(a(q)[2]), 'add'),
    'economy.remove': (q) => {
      const g = econGuild(a(q)[0]);
      const u = sf(a(q)[1], 'user');
      const n = amount(a(q)[2]);
      // Never below 0: a plugin takes what is there at most.
      if (deps.economy.balance(g, u) < n) throw new SdkError('sdk.economy.not_enough');
      return deps.economy.change(g, u, -n, 'add');
    },
    'economy.transfer': (q) => {
      const g = econGuild(a(q)[0]);
      if (!deps.economy.pay(g, sf(a(q)[1], 'user'), sf(a(q)[2], 'user'), amount(a(q)[3]))) throw new SdkError('sdk.economy.not_enough');
    },
    'economy.leaderboard': (q) => deps.economy.leaderboard(econGuild(a(q)[0]), Math.max(1, Math.min(50, Number(a(q)[1]) || 10))),
  };
}

/** Permission bits -> discord.js flag names for permissionOverwrites.edit. */
function bitsToNames(bits: bigint): Set<string> {
  const out = new Set<string>();
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) if (bits & bit) out.add(name);
  return out;
}
