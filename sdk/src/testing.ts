// @bothub/sdk/testing: run a plugin's blocks and hooks without a bot.
//
// createTestContext() returns a fake `ctx` that behaves like the real host
// for the calls the bot answers today (shared/sdk-permissions.json,
// "implemented"): storage in memory, messages and log lines recorded, the
// settings read-only. Rejections use the host's keys, in the host's order:
// "sdk.call.unknown" → "sdk.call.not_available" → "sdk.call.denied".
//
//   import { createTestContext, runBlock } from '@bothub/sdk/testing';
//   const ctx = createTestContext({ permissions: ['storage'], config: { greeting: 'Hi {user}' } });
//   const out = await runBlock(plugin, 'greet', ctx, { vars: { 'user.name': 'Ann' } });

import type { BlockInput, BlockResult, InteractionEvent, Message, PluginDefinition } from './index.js';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Error like the host's: .message and .key are the key string. */
export class SdkCallError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(key);
    this.key = key;
    this.name = 'SdkCallError';
  }
}

// Calls the fake answers, with the permission each needs (null = core).
const CALLS: Record<string, string | null> = {
  'logger.debug': null, 'logger.info': null, 'logger.warn': null, 'logger.error': null, 'logger.success': null,
  'storage.get': 'storage', 'storage.set': 'storage', 'storage.has': 'storage', 'storage.delete': 'storage',
  'storage.increment': 'storage', 'storage.decrement': 'storage', 'storage.clear': 'storage',
  'globalStorage.get': 'storage.global', 'globalStorage.set': 'storage.global', 'globalStorage.has': 'storage.global',
  'globalStorage.delete': 'storage.global', 'globalStorage.increment': 'storage.global', 'globalStorage.decrement': 'storage.global',
  'globalStorage.clear': 'storage.global',
  'emoji.list': 'discord.emojis.read', 'emoji.get': 'discord.emojis.read',
  'audit.list': 'discord.audit.read',
  'member.voiceMute': 'discord.voice.mute', 'member.voiceDeafen': 'discord.voice.mute',
  'member.voiceDisconnect': 'discord.voice.move', 'member.voiceMove': 'discord.voice.move',
  'moderation.warn': 'modules.moderation.cases', 'moderation.record': 'modules.moderation.cases', 'moderation.history': 'modules.moderation.cases',
  'moderation.getCase': 'modules.moderation.cases', 'moderation.note': 'modules.moderation.cases', 'moderation.notes': 'modules.moderation.cases',
  'guild.get': 'discord.guilds.read', 'guild.list': 'discord.guilds.read',
  'secrets.get': 'secrets.read', 'secrets.has': 'secrets.read',
  'module.get': 'modules.read', 'module.getId': 'modules.read', 'module.getName': 'modules.read',
  'module.isEnabled': 'modules.read', 'module.getConfig': 'modules.read', 'module.list': 'modules.read',
  'message.send': 'discord.messages.send', 'message.sendFile': 'discord.messages.files',
  'files.list': 'storage.files', 'files.get': 'storage.files', 'files.put': 'storage.files', 'files.delete': 'storage.files', 'files.fromDiscord': 'storage.files',
  'voice.join': 'discord.voice.connect', 'voice.leave': 'discord.voice.connect', 'voice.play': 'discord.voice.speak',
  'voice.stop': 'discord.voice.speak', 'voice.state': 'discord.voice.connect',
  'http.secret': 'secrets.use',
  'http.get': 'http.outbound', 'http.post': 'http.outbound', 'http.put': 'http.outbound', 'http.patch': 'http.outbound', 'http.delete': 'http.outbound',
  'message.dm': 'discord.messages.send',
  'guild.getChannels': 'discord.guilds.read', 'guild.getRoles': 'discord.guilds.read', 'guild.getEmojis': 'discord.guilds.read',
  'guild.getMembers': 'discord.members.read', 'member.get': 'discord.members.read', 'member.list': 'discord.members.read',
  'channel.get': 'discord.channels.read', 'channel.list': 'discord.channels.read',
  'role.get': 'discord.roles.read', 'role.list': 'discord.roles.read',
  'message.get': 'discord.messages.read',
  'message.edit': 'discord.messages.edit', 'message.delete': 'discord.messages.edit', 'message.pin': 'discord.messages.pin',
  'message.unpin': 'discord.messages.pin', 'message.react': 'discord.messages.react',
  'member.addRole': 'discord.roles.assign', 'member.removeRole': 'discord.roles.assign', 'member.timeout': 'discord.members.timeout',
  'member.kick': 'discord.members.kick', 'member.ban': 'discord.members.ban', 'member.unban': 'discord.members.ban', 'member.setNickname': 'discord.members.nicknames',
  'channel.create': 'discord.channels.write', 'channel.edit': 'discord.channels.write', 'channel.delete': 'discord.channels.write', 'channel.setPermissions': 'discord.channels.permissions',
  'role.create': 'discord.roles.write', 'role.edit': 'discord.roles.write', 'role.delete': 'discord.roles.write',
  'role.addToMember': 'discord.roles.assign', 'role.removeFromMember': 'discord.roles.assign',
  'emoji.create': 'discord.emojis.manage', 'emoji.delete': 'discord.emojis.manage',
  'interaction.reply': 'discord.interactions.reply', 'interaction.editReply': 'discord.interactions.reply', 'interaction.deferReply': 'discord.interactions.reply',
  'interaction.followUp': 'discord.interactions.reply', 'interaction.update': 'discord.interactions.reply', 'interaction.showModal': 'discord.modals',
  'economy.get': 'modules.economy.balance.read', 'economy.add': 'modules.economy.balance.write', 'economy.remove': 'modules.economy.balance.write', 'economy.transfer': 'modules.economy.balance.write', 'economy.leaderboard': 'modules.economy.balance.read',
};

// Old coarse permission keys and their finer replacements (shared/sdk-permissions.json "replaced"):
// options.permissions may still name an old key, like a manifest.
const REPLACED: Record<string, string[]> = {"discord.members.manage": ["discord.members.nicknames", "discord.roles.assign", "discord.members.timeout", "discord.members.kick", "discord.members.ban"], "discord.messages.manage": ["discord.messages.edit", "discord.messages.pin", "discord.messages.react"], "discord.channels.manage": ["discord.channels.write", "discord.channels.permissions"], "discord.roles.manage": ["discord.roles.write", "discord.roles.assign"], "discord.voice": ["discord.voice.connect", "discord.voice.speak"], "discord.voice.moderate": ["discord.voice.mute", "discord.voice.move"], "economy": ["modules.economy.balance.read", "modules.economy.balance.write"], "discord.interactions": ["discord.interactions.reply", "discord.modals"], "dashboard.ui": ["dashboard.read", "dashboard.settings", "dashboard.pages"], "discord.events": ["discord.events.messages", "discord.events.members", "discord.events.server", "discord.events.voice", "discord.events.interactions"], "economy.read": ["modules.economy.balance.read"], "economy.write": ["modules.economy.balance.write"], "economy.transactions": ["modules.economy.transactions"], "economy.settings": ["modules.economy.settings"], "moderation.cases": ["modules.moderation.cases"]};

// Areas and methods that exist in the SDK but the fake (and the bot) do not
// answer yet: they reject with "sdk.call.not_available".
const PLANNED_AREAS = new Set([
  'collection', 'cache', 'scheduler', 'events', 'commands',
  'permissions', 'plugins', 'dashboard', 'locale', 'rateLimit', 'resources',
]);
const PLANNED_CALLS = new Set([
  'storage.transaction', 'utils.validate', 'interaction.respond',
]);
/** Discord calls the fake answers through options.discord (default: recorded, empty answer). */
const DISCORD_AREAS = new Set(['guild', 'member', 'channel', 'role', 'emoji', 'audit', 'moderation']);

// Host limits (shared/sdk-permissions.json "limits").
const STORAGE_KEYS = 1000;
const STORAGE_VALUE_BYTES = 16384;
const STORAGE_TOTAL_BYTES = 1048576;
const GLOBAL_STORAGE_KEYS = 10000;
const GLOBAL_STORAGE_TOTAL_BYTES = 10485760;
const STORAGE_KEY = /^[\x20-\x7e]{1,128}$/;
const SEND_MAX = 5;
const SEND_WINDOW_MS = 5000;
const SNOWFLAKE = /^\d{17,20}$/;
const SOUND_FILE = /^sounds\/[a-z0-9_-]{1,64}\.(ogg|mp3|wav)$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_HEADERS = new Set(['authorization', 'cookie', 'host', 'proxy-authorization']);
const HTTP_BODY_BYTES = 64 * 1024;
const HTTP_RESPONSE_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 10000;
// Plugin files (storage.files).
const FILE_NAME = /^[0-9a-f]{16}\.(png|gif|webp|jpg)$/;
const FILE_NAMES = /[0-9a-f]{16}\.(?:png|gif|webp|jpg)/g;
const FILE_MAX_BYTES = 2 * 1024 * 1024;
const FILE_MAX_COUNT = 100;
const base64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesBase64 = (data: Uint8Array): string => btoa(String.fromCharCode(...data));
function sniff(b: Uint8Array): { mime: string; ext: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return { mime: 'image/png', ext: 'png' };
  if (b.length > 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return { mime: 'image/gif', ext: 'gif' };
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

export interface TestGuild { id: string; name: string; memberCount: number }
export interface TestModule { id: string; name: string; enabled: boolean; config: Record<string, Json> }

export interface TestContextOptions {
  /** Plugin ID (default "test-plugin"). */
  id?: string;
  version?: string;
  botId?: number;
  /** Permissions declared AND allowed by the SDK policies. */
  permissions?: string[];
  /** Saved settings of the plugin's settings page (read-only for the plugin). */
  config?: Record<string, Json>;
  /** Start values of ctx.storage. */
  storage?: Record<string, string>;
  /**
   * Secrets the admin shared with the plugin: name -> value. Like on the bot,
   * a name must also be in the manifest "secrets" (when a manifest is given);
   * any other name answers null.
   */
  secrets?: Record<string, string>;
  /** Start values of ctx.globalStorage (shared by every bot of the instance). */
  globalStorage?: Record<string, string>;
  guilds?: TestGuild[];
  modules?: TestModule[];
  manifest?: Record<string, Json>;
  /** Files of the plugin folder voice.play may use; default: any valid name. */
  sounds?: string[];
  /** Servers where another player (e.g. the music module) plays: voice.play rejects with sdk.voice.busy. */
  busyGuilds?: string[];
  /**
   * Fake Discord answers by call name ("member.get", "role.list",
   * "message.get", …). Calls without a fake are recorded in `actions` and
   * answer undefined (lists: []).
   */
  discord?: Record<string, (...args: any[]) => unknown>;
  /**
   * http.get/post/…: fake servers by host. The host must also be in
   * `hosts` (bothub.json "services.hosts"), like on the bot.
   */
  web?: Record<string, (request: WebRequest) => EndpointReply | Promise<EndpointReply>>;
  /** bothub.json "services.hosts"; default: the hosts of `web`. */
  hosts?: string[];
  /** Start balances of the Economy module: "<guildId>:<userId>" -> coins. */
  balances?: Record<string, number>;
  /**
   * dashboard/settings.json: its "permissions" fields are what
   * config.checkAccess checks; config.set takes only its keys.
   */
  settings?: { fields: Array<{ key: string; type: string; default?: Json; item?: Array<{ key: string; type: string; default?: Json }> }> };
  /** Start content of ctx.files: name ("<16 hex>.png") -> base64. */
  files?: Record<string, string>;
  /** files.fromDiscord: attachment URL -> base64 content. Other URLs fail like a dead link. */
  attachments?: Record<string, string>;
  /**
   * Members for config.checkAccess: user ID -> role IDs and Discord
   * permission names ("manage_messages", …). Users not listed are not on the server.
   */
  members?: Record<string, { roles?: string[]; permissions?: string[] }>;
}

export interface WebRequest { method: string; url: string; query: Record<string, string>; json: Json | undefined; headers: Record<string, string> }
/** An answer of the plugin to a command or click (ctx.interaction.*). */
export interface InteractionAnswer { handle: string; kind: 'reply' | 'editReply' | 'deferReply' | 'followUp' | 'update' | 'showModal'; message?: Message | string; ephemeral?: boolean; modal?: Json }

/** ctx.http.secret request (see the SDK). */
export interface SecretRequestKit {
  url: string;
  path?: string;
  method?: string;
  query?: Record<string, string>;
  json?: Json;
  headers?: Record<string, string>;
  auth?: { secret: string; header?: string; format?: 'bearer' | 'plain' | 'query'; param?: string };
}

export interface EndpointRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  json: Json | undefined;
  headers: Record<string, string>;
}
export interface EndpointReply { status?: number; json?: Json; text?: string; headers?: Record<string, string> }
export interface PlayedSound { guildId: string; channelId: string; file: string; volume: number }

/** A sent message; file: the image of message.sendFile. */
export interface SentMessage { channelId: string; message: Message | string; id: string; file?: string }
export interface LogLine { level: string; text: string }

/** The fake ctx plus what the plugin did, for assertions. */
export interface TestContext {
  readonly botId: number;
  readonly sent: SentMessage[];
  readonly logs: LogLine[];
  /** Current storage content. */
  readonly store: Map<string, string>;
  /** Current global storage content. */
  readonly globalStore: Map<string, string>;
  /** Every call in order, e.g. "storage.increment". */
  readonly calls: string[];
  /** Every voice.play call. */
  readonly played: PlayedSound[];
  /** Every http.secret call, as the fake server got it (secret values included, for checks). */
  readonly requests: WebRequest[];
  /** Every http.get/post/… call. */
  readonly web: WebRequest[];
  /** Discord calls without a fake: name and arguments (e.g. role.addToMember). */
  readonly actions: Array<{ call: string; args: unknown[] }>;
  /** Answers to commands and clicks (ctx.interaction.*), in order. */
  readonly answers: InteractionAnswer[];
  /** Economy balances: "<guildId>:<userId>" -> coins. */
  readonly balances: Map<string, number>;
  /** Current plugin files: name -> base64. */
  readonly fileStore: Map<string, string>;
  /** Current settings (config.set changes them). */
  readonly settingsNow: Record<string, Json>;
  [area: string]: unknown;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const id = options.id ?? 'test-plugin';
  const version = options.version ?? '1.0.0';
  const botId = options.botId ?? 1;
  const permissions = new Set((options.permissions ?? []).flatMap((p) => REPLACED[p] ?? [p]));
  const config = structuredClone(options.config ?? {});
  const store = new Map(Object.entries(options.storage ?? {}));
  const globalStore = new Map(Object.entries(options.globalStorage ?? {}));
  const sent: SentMessage[] = [];
  const logs: LogLine[] = [];
  const calls: string[] = [];
  const sendTimes: number[] = [];
  const played: PlayedSound[] = [];
  const requests: WebRequest[] = [];
  const voice = new Map<string, { channelId: string; playing: boolean; file: string | null }>();
  const webRequests: WebRequest[] = [];
  const actions: Array<{ call: string; args: unknown[] }> = [];
  const answers: InteractionAnswer[] = [];
  const balances = new Map(Object.entries(options.balances ?? {}));
  const fileStore = new Map(Object.entries(options.files ?? {}));
  const fileOf = (name: unknown): { name: string; mime: string; size: number; data: string } | null => {
    if (typeof name !== 'string' || !FILE_NAME.test(name) || !fileStore.has(name)) return null;
    const data = fileStore.get(name)!;
    return { name, mime: sniff(base64Bytes(data))?.mime ?? 'image/png', size: base64Bytes(data).length, data };
  };
  const putFile = async (data: Uint8Array) => {
    if (!data.length || data.length > FILE_MAX_BYTES) throw new SdkCallError('sdk.files.too_big');
    const type = sniff(data);
    if (!type) throw new SdkCallError('sdk.files.bad_type');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
    const name = `${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}.${type.ext}`;
    if (!fileStore.has(name) && fileStore.size >= FILE_MAX_COUNT) throw new SdkCallError('sdk.files.full');
    fileStore.set(name, bytesBase64(data));
    return { name, mime: type.mime, size: data.length };
  };
  const hosts = options.hosts ?? Object.keys(options.web ?? {});
  const manifestSecrets = Array.isArray(options.manifest?.secrets) ? (options.manifest!.secrets as Json[]) : null;
  // Secrets shared with the plugin: name -> value.
  const secretValues = new Map(Object.entries(options.secrets ?? {}));
  const secretOf = (name: string): string | null => {
    if (typeof name !== 'string' || (manifestSecrets && !manifestSecrets.includes(name))) return null;
    return secretValues.get(name) ?? null;
  };
  let nextId = 100000000000000000n;

  const check = (name: string): void => {
    calls.push(name);
    if (!(name in CALLS) || PLANNED_CALLS.has(name)) {
      const area = name.split('.')[0]!;
      throw new SdkCallError(PLANNED_CALLS.has(name) || PLANNED_AREAS.has(area) ? 'sdk.call.not_available' : 'sdk.call.unknown');
    }
    const perm = CALLS[name];
    // module.*: modules.read (every module) or modules.<key>.read (one module, checked in the call).
    const oneModule = perm === 'modules.read' && [...permissions].some((p) => /^modules\.[a-z0-9-]+\.read$/.test(p));
    if (perm && !permissions.has(perm) && !oneModule) throw new SdkCallError('sdk.call.denied');
  };

  const key = (k: unknown): string => {
    if (typeof k !== 'string' || !STORAGE_KEY.test(k)) throw new SdkCallError('sdk.storage.bad_key');
    return k;
  };
  // One key-value space with its quotas, like the host: ctx.storage (per bot) and ctx.globalStorage.
  const space = (map: Map<string, string>, maxKeys: number, maxBytes: number) => {
    const put = (k: unknown, value: unknown): void => {
      const name = key(k);
      if (typeof value !== 'string') throw new SdkCallError('sdk.storage.bad_value');
      const size = bytes(value);
      if (size > STORAGE_VALUE_BYTES) throw new SdkCallError('sdk.storage.value_too_big');
      if (!map.has(name) && map.size >= maxKeys) throw new SdkCallError('sdk.storage.too_many_keys');
      let total = 0;
      for (const [n, v] of map) if (n !== name) total += bytes(v); // host counts values only
      if (total + size > maxBytes) throw new SdkCallError('sdk.storage.full');
      map.set(name, value);
    };
    const add = (k: unknown, by: unknown): number => {
      const step = Number(by);
      if (!Number.isFinite(step)) throw new SdkCallError('sdk.storage.bad_value');
      const current = Number(map.get(key(k)) ?? '0');
      if (!Number.isFinite(current)) throw new SdkCallError('sdk.storage.not_a_number');
      const next = current + step;
      put(k, String(next));
      return next;
    };
    return {
      get: async (k: unknown) => map.get(key(k)) ?? null,
      set: async (k: unknown, v: unknown) => { put(k, v); },
      has: async (k: unknown) => map.has(key(k)),
      delete: async (k: unknown) => { map.delete(key(k)); },
      increment: async (k: unknown, by: unknown = 1) => add(k, by),
      decrement: async (k: unknown, by: unknown = 1) => add(k, -Number(by)),
      clear: async () => { map.clear(); },
    };
  };

  const mayRead = (key: string) => permissions.has('modules.read') || permissions.has(`modules.${key}.read`);
  const readable = (key: string): string => {
    if (!mayRead(key)) throw new SdkCallError('sdk.call.denied');
    return key;
  };
  const impl: Record<string, Record<string, (...args: any[]) => unknown>> = {
    logger: Object.fromEntries(['debug', 'info', 'warn', 'error', 'success'].map((level) =>
      [level, async (text: unknown) => { logs.push({ level, text: String(text) }); }])),
    storage: space(store, STORAGE_KEYS, STORAGE_TOTAL_BYTES),
    globalStorage: space(globalStore, GLOBAL_STORAGE_KEYS, GLOBAL_STORAGE_TOTAL_BYTES),
    guild: {
      get: async (guildId: string) => {
        const g = (options.guilds ?? []).find((x) => x.id === guildId);
        if (!g) throw new SdkCallError('sdk.discord.bad_guild');
        return { ...g };
      },
      list: async () => (options.guilds ?? []).map((g) => ({ ...g })),
    },
    secrets: {
      get: async (name: string) => secretOf(name),
      has: async (name: string) => secretOf(name) !== null,
    },
    module: {
      get: async (key: string) => mod(readable(key)),
      getId: async (key: string) => mod(readable(key)).id,
      getName: async (key: string) => mod(readable(key)).name,
      isEnabled: async (key: string) => mod(readable(key)).enabled,
      getConfig: async (key: string) => structuredClone(mod(readable(key)).config),
      list: async () => (options.modules ?? []).filter((m) => mayRead(m.id)).map((m) => structuredClone(m)),
    },
    voice: {
      join: async (guildId: string, channelId: string) => {
        voiceGuild(guildId);
        if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new SdkCallError('sdk.voice.bad_channel');
        voice.set(guildId, { channelId, playing: false, file: null });
      },
      leave: async (guildId: string) => { voiceGuild(guildId); voice.delete(guildId); },
      play: async (guildId: string, file: string, opts: { volume?: number } = {}) => {
        voiceGuild(guildId);
        if (typeof file !== 'string' || !SOUND_FILE.test(file) || (options.sounds && !options.sounds.includes(file))) {
          throw new SdkCallError('sdk.voice.bad_file');
        }
        const volume = opts.volume ?? 1;
        if (typeof volume !== 'number' || !(volume >= 0 && volume <= 1)) throw new SdkCallError('sdk.voice.bad_volume');
        const state = voice.get(guildId);
        if (!state) throw new SdkCallError('sdk.voice.not_connected');
        if (options.busyGuilds?.includes(guildId)) throw new SdkCallError('sdk.voice.busy');
        Object.assign(state, { playing: true, file });
        played.push({ guildId, channelId: state.channelId, file, volume });
      },
      stop: async (guildId: string) => {
        voiceGuild(guildId);
        const state = voice.get(guildId);
        if (state) Object.assign(state, { playing: false, file: null });
      },
      state: async (guildId: string) => {
        voiceGuild(guildId);
        // Another player (e.g. the music module) is playing: file is null.
        if (options.busyGuilds?.includes(guildId)) return { channelId: voice.get(guildId)?.channelId ?? null, playing: true, file: null };
        const state = voice.get(guildId);
        return state ? { ...state } : { channelId: null, playing: false, file: null };
      },
    },
    http: {
      // Like the bot: url = name of an address secret (+ path) or an https URL of
      // a host of "hosts"; auth puts a secret into a header or URL parameter.
      // The fake server is options.web[<host of the address>].
      secret: async (request: Partial<SecretRequestKit> = {}) => {
        const method = (request.method ?? 'GET').toUpperCase();
        if (!HTTP_METHODS.has(method)) throw new SdkCallError('sdk.http.bad_method');
        let u: URL;
        const name = String(request.url ?? '');
        if (/^[A-Z][A-Z0-9_]{1,39}$/.test(name)) {
          const address = secretOf(name);
          if (!address) throw new SdkCallError('sdk.secret.not_shared');
          const path = request.path ?? '';
          if (typeof path !== 'string' || (path && !path.startsWith('/')) || path.includes('..') || path.includes('//')) throw new SdkCallError('sdk.http.bad_path');
          try {
            u = new URL(address.replace(/\/+$/, '') + path);
          } catch {
            throw new SdkCallError('sdk.secret.not_a_url');
          }
        } else {
          try {
            u = new URL(name);
          } catch {
            throw new SdkCallError('sdk.http.bad_url');
          }
          if (u.protocol !== 'https:') throw new SdkCallError('sdk.http.bad_url');
          if (!hosts.includes(u.hostname)) throw new SdkCallError('sdk.http.host_not_allowed');
        }
        for (const [k, v] of Object.entries(request.query ?? {})) u.searchParams.set(k, String(v));
        const headers: Record<string, string> = {};
        for (const [h, value] of Object.entries(request.headers ?? {})) {
          if (BLOCKED_HEADERS.has(h.toLowerCase())) throw new SdkCallError('sdk.http.bad_header');
          headers[h] = String(value);
        }
        if (request.auth) {
          const key = secretOf(request.auth.secret);
          if (!key) throw new SdkCallError('sdk.secret.not_shared');
          const format = request.auth.format ?? 'bearer';
          if (format === 'query') u.searchParams.set(request.auth.param ?? 'key', key);
          else headers[request.auth.header ?? 'Authorization'] = format === 'bearer' ? `Bearer ${key}` : key;
        }
        if (request.json !== undefined && bytes(JSON.stringify(request.json)) > HTTP_BODY_BYTES) throw new SdkCallError('sdk.http.too_big');
        const server = options.web?.[u.hostname];
        if (!server) throw new SdkCallError('sdk.http.failed');
        const req: WebRequest = { method, url: u.toString(), query: Object.fromEntries(u.searchParams), json: request.json, headers };
        requests.push(structuredClone(req));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SdkCallError('sdk.http.timeout')), HTTP_TIMEOUT_MS);
        });
        const reply = await Promise.race([Promise.resolve().then(() => server(structuredClone(req))), timeout]).finally(() => clearTimeout(timer));
        const hide = [request.auth ? secretOf(request.auth.secret) : null, /^[A-Z][A-Z0-9_]{1,39}$/.test(name) ? secretOf(name) : null].filter((v): v is string => !!v);
        const masked = (t: string) => hide.reduce((acc, v) => (v.length >= 4 ? acc.split(v).join('••••') : acc), t);
        const text = masked(reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : ''));
        if (bytes(text) > HTTP_RESPONSE_BYTES) throw new SdkCallError('sdk.http.too_big');
        let json: Json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        const out: Record<string, string> = {};
        for (const [h, value] of Object.entries(reply.headers ?? {})) {
          if (h.toLowerCase() !== 'set-cookie') out[h.toLowerCase()] = masked(value);
        }
        return { status: reply.status ?? 200, headers: out, json, text };
      },
    },
    files: {
      list: async () => [...fileStore.keys()].map((n) => { const f = fileOf(n)!; return { name: f.name, mime: f.mime, size: f.size }; }),
      get: async (name: string) => fileOf(name),
      put: async (data: string) => {
        if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new SdkCallError('sdk.files.bad_type');
        return putFile(base64Bytes(data));
      },
      delete: async (name: string) => fileStore.delete(String(name)),
      fromDiscord: async (url: string) => {
        let u: URL | null = null;
        try { u = new URL(String(url)); } catch { u = null; }
        if (!u || u.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) || !/^\/(ephemeral-)?attachments\//.test(u.pathname)) throw new SdkCallError('sdk.files.bad_url');
        const data = options.attachments?.[String(url)];
        if (data === undefined) throw new SdkCallError('sdk.http.failed');
        return putFile(base64Bytes(data));
      },
    },
    message: {
      sendFile: async (channelId: string, name: string, message?: Message | string) => {
        const file = fileOf(name);
        if (!file) throw new SdkCallError('sdk.files.unknown');
        if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new SdkCallError('sdk.discord.bad_channel');
        const now = Date.now();
        while (sendTimes.length && now - sendTimes[0]! > SEND_WINDOW_MS) sendTimes.shift();
        if (sendTimes.length >= SEND_MAX) throw new SdkCallError('sdk.discord.rate_limited');
        sendTimes.push(now);
        const msg = structuredClone(message ?? {}) as Message | string;
        if (typeof msg === 'object' && Array.isArray(msg.embeds)) {
          for (const e of msg.embeds as Array<Record<string, unknown>>) {
            for (const k of ['image_url', 'thumbnail_url']) if (e[k] === 'attachment') e[k] = `attachment://${file.name}`;
          }
        }
        const msgId = String(nextId++);
        sent.push({ channelId, message: msg, id: msgId, file: file.name });
        return msgId;
      },
      send: async (channelId: string, message: Message | string) => {
        if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new SdkCallError('sdk.discord.bad_channel');
        const now = Date.now();
        while (sendTimes.length && now - sendTimes[0]! > SEND_WINDOW_MS) sendTimes.shift();
        if (sendTimes.length >= SEND_MAX) throw new SdkCallError('sdk.discord.rate_limited');
        sendTimes.push(now);
        const msgId = String(nextId++);
        sent.push({ channelId, message: structuredClone(message), id: msgId });
        return msgId;
      },
      dm: async (userId: string, message: Message | string) => {
        if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) throw new SdkCallError('sdk.discord.bad_user');
        const msgId = String(nextId++);
        sent.push({ channelId: `dm:${userId}`, message: structuredClone(message), id: msgId });
        return msgId;
      },
    },
    interaction: Object.fromEntries((['reply', 'editReply', 'deferReply', 'followUp', 'update', 'showModal'] as const).map((kind) => [kind, async (handle: unknown, a?: unknown, b?: unknown) => {
      if (typeof handle !== 'string' || !handle) throw new SdkCallError('sdk.interaction.unknown');
      const done = answers.filter((x) => x.handle === handle);
      if (kind === 'showModal' && done.length) throw new SdkCallError('sdk.interaction.too_late');
      if ((kind === 'editReply' || kind === 'followUp') && !done.some((x) => x.kind !== 'showModal')) throw new SdkCallError('sdk.interaction.not_replied');
      const opts = (kind === 'deferReply' ? a : b) as { ephemeral?: boolean } | undefined;
      answers.push({
        handle, kind,
        ...(kind === 'showModal' ? { modal: structuredClone(a) as Json } : kind === 'deferReply' ? {} : { message: structuredClone(a) as Message | string }),
        ...(opts?.ephemeral ? { ephemeral: true } : {}),
      });
    }])),
    economy: {
      get: async (g: string, u: string) => balances.get(`${g}:${u}`) ?? 0,
      add: async (g: string, u: string, n: number) => coins(g, u, n),
      remove: async (g: string, u: string, n: number) => {
        if ((balances.get(`${g}:${u}`) ?? 0) < n) throw new SdkCallError('sdk.economy.not_enough');
        return coins(g, u, -n);
      },
      transfer: async (g: string, from: string, to: string, n: number) => {
        if ((balances.get(`${g}:${from}`) ?? 0) < n) throw new SdkCallError('sdk.economy.not_enough');
        coins(g, from, -n);
        coins(g, to, n);
      },
      leaderboard: async (g: string, limit = 10) =>
        [...balances].filter(([k]) => k.startsWith(`${g}:`)).map(([k, v]) => ({ userId: k.split(':')[1]!, balance: v })).sort((x, y) => y.balance - x.balance).slice(0, limit),
    },
  };
  function coins(g: string, u: string, n: number): number {
    if (typeof n !== 'number' || !Number.isInteger(n)) throw new SdkCallError('sdk.economy.bad_amount');
    const next = (balances.get(`${g}:${u}`) ?? 0) + n;
    balances.set(`${g}:${u}`, next);
    return next;
  }
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    impl.http![method] = async (url: unknown, a?: unknown, b?: unknown) => {
      const opts = ((method === 'get' || method === 'delete' ? a : b) ?? {}) as { query?: Record<string, string>; headers?: Record<string, string> };
      let u: URL;
      try {
        u = new URL(String(url));
      } catch {
        throw new SdkCallError('sdk.http.bad_url');
      }
      if (u.protocol !== 'https:') throw new SdkCallError('sdk.http.bad_url');
      const server = options.web?.[u.hostname];
      if (!hosts.includes(u.hostname) || !server) throw new SdkCallError('sdk.http.host_not_allowed');
      for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, String(v));
      const headers = { ...(opts.headers ?? {}) };
      for (const name of Object.keys(headers)) if (BLOCKED_HEADERS.has(name.toLowerCase())) throw new SdkCallError('sdk.http.bad_header');
      const req: WebRequest = { method: method.toUpperCase(), url: u.toString(), query: Object.fromEntries(u.searchParams), json: method === 'get' || method === 'delete' ? undefined : (a as Json), headers };
      webRequests.push(structuredClone(req));
      const reply = await server(structuredClone(req));
      const text = reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : '');
      if (bytes(text) > HTTP_RESPONSE_BYTES) throw new SdkCallError('sdk.http.too_big');
      let json: Json = null;
      try { json = reply.json !== undefined ? structuredClone(reply.json) : JSON.parse(text); } catch { json = null; }
      return { status: reply.status ?? 200, headers: { ...(reply.headers ?? {}) }, json, text };
    };
  }
  /** Discord calls without an own fake: options.discord, else recorded with an empty answer. */
  const generic = (call: string, args: unknown[]): unknown => {
    const fake = options.discord?.[call];
    if (fake) return fake(...args);
    actions.push({ call, args: structuredClone(args) });
    return /\.(list|get(Channels|Roles|Emojis|Members))$/.test(call) ? [] : undefined;
  };
  function voiceGuild(guildId: string): void {
    if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw new SdkCallError('sdk.voice.bad_guild');
    if (options.guilds && !options.guilds.some((g) => g.id === guildId)) throw new SdkCallError('sdk.voice.bad_guild');
  }
  function mod(key: string): TestModule {
    const m = (options.modules ?? []).find((x) => x.id === key);
    if (!m) throw new SdkCallError('sdk.module.unknown');
    return m;
  }

  // Local parts (no permission, no RPC), like the host.
  const local = {
    plugin: {
      getInfo: () => ({ id, name: String(options.manifest?.name ?? id), version, permissions: [...permissions], botId }),
      getId: () => id,
      getVersion: () => version,
      getConfig: () => structuredClone(config),
      isEnabled: () => true,
      getPath: () => `/plugins/${id}/${version}`,
      getManifest: () => structuredClone(options.manifest ?? { id, version }),
    },
    config: {
      get: (key: string) => (key in config ? structuredClone(config[key]) : undefined),
      has: (key: string) => key in config,
      getAll: () => structuredClone(config),
      // Like the bot: only fields of the settings page; access rules and messages stay with the dashboard.
      set: async (key: string, value: Json) => {
        calls.push('config.set');
        const field = options.settings?.fields.find((f) => f.key === key);
        if (!field) throw new SdkCallError('sdk.config.unknown_key');
        if (['permissions', 'message', 'emojis'].includes(field.type)) throw new SdkCallError('sdk.config.not_settable');
        const before = new Set(JSON.stringify(config).match(FILE_NAMES) ?? []);
        if (field.type === 'image' && value !== '' && !(typeof value === 'string' && FILE_NAME.test(value))) throw new SdkCallError('sdk.config.bad_value');
        if (field.type === 'list') {
          if (!Array.isArray(value)) throw new SdkCallError('sdk.config.bad_value');
          value = value.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SdkCallError('sdk.config.bad_value');
            const out: Record<string, Json> = {};
            for (const sub of field.item ?? []) {
              const v = (item as Record<string, Json>)[sub.key];
              if (sub.type === 'image' && v !== undefined && v !== '' && !(typeof v === 'string' && FILE_NAME.test(v))) throw new SdkCallError('sdk.config.bad_value');
              out[sub.key] = v === undefined ? (sub.default ?? null) : v;
            }
            const itemId = (item as Record<string, Json>)._id;
            out._id = typeof itemId === 'string' && /^[a-z0-9]{8,16}$/.test(itemId) ? itemId : Math.random().toString(36).slice(2, 14).padEnd(8, '0');
            return out;
          });
        }
        config[key] = structuredClone(value);
        const now = new Set(JSON.stringify(config).match(FILE_NAMES) ?? []);
        for (const name of before) if (!now.has(name)) fileStore.delete(name);
      },
      delete: async (key: string) => {
        calls.push('config.delete');
        const field = options.settings?.fields.find((f) => f.key === key);
        if (!field) throw new SdkCallError('sdk.config.unknown_key');
        if (field.default !== undefined) config[key] = structuredClone(field.default);
        else delete config[key];
      },
      // Like the bot: the "permissions" field, checked like a command's permissions block.
      checkAccess: async (key: string, who: Record<string, any>) => {
        const field = options.settings?.fields.find((f) => f.key === key && f.type === 'permissions');
        if (!field) throw new SdkCallError('sdk.config.not_permissions');
        const userId = typeof who?.userId === 'string' ? who.userId : who?.user?.id;
        const guildId = who?.guildId ?? null;
        const channelId = who?.channelId ?? null;
        if (guildId === null) return { allowed: true, reason: null };
        if (typeof userId !== 'string' || !SNOWFLAKE.test(userId) || typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw new SdkCallError('sdk.config.bad_member');
        const m = options.members?.[userId];
        if (!m) return { allowed: false, reason: 'member' };
        const b = ((key in config ? config[key] : field.default) ?? { allowed_roles: [{ id: 'everyone' }] }) as Record<string, any>;
        const inGuild = (r: { guild?: string }) => !r.guild || r.guild === guildId;
        const has = (r: { id: string }) => r.id === 'everyone' || (m.roles ?? []).includes(r.id);
        const deny = (reason: string) => ({ allowed: false, reason });
        if ((b.banned_channels ?? []).some((c: any) => inGuild(c) && c.id === channelId)) return deny('channel');
        if ((b.banned_roles ?? []).some((r: any) => inGuild(r) && r.id !== 'everyone' && has(r))) return deny('banned_role');
        const allowed = (b.allowed_roles ?? []).filter(inGuild);
        if (allowed.length && !allowed.some(has)) return deny('role');
        if ((b.required_permissions ?? []).some((p: string) => !(m.permissions ?? []).includes(p))) return deny('permission');
        return { allowed: true, reason: null };
      },
    },
    utils: {
      uuid: () => crypto.randomUUID(),
      random: (min = 0, max = 1) => min + Math.random() * (max - min),
      hash: (text: string) => { let h = 0; for (const c of String(text)) h = (h * 31 + c.codePointAt(0)!) | 0; return (h >>> 0).toString(16); },
      formatDate: (date: string | number | Date, locale = 'en') => new Date(date).toLocaleString(locale),
      formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
      formatNumber: (n: number, locale = 'en') => n.toLocaleString(locale),
    },
  };

  const areas = new Map<string, unknown>();
  const area = (name: string): unknown => {
    if (!areas.has(name)) {
      areas.set(name, new Proxy({}, {
        get: (_t, method) => {
          if (typeof method !== 'string') return undefined;
          return async (...args: unknown[]) => {
            const call = `${name}.${method}`;
            check(call);
            const own = impl[name]?.[method];
            if (own && !options.discord?.[call]) return own(...args);
            if (DISCORD_AREAS.has(name) || name === 'message') return generic(call, args);
            return own!(...args);
          };
        },
      }));
    }
    return areas.get(name);
  };

  return new Proxy({ botId, sent, logs, store, globalStore, calls, played, requests, web: webRequests, actions, answers, balances, fileStore, settingsNow: config } as TestContext, {
    get: (target, prop) => {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (prop in local) return (local as Record<string, unknown>)[prop];
      if (prop === 'then') return undefined; // not a thenable
      return area(prop);
    },
  });
}

async function withTimeout<T>(run: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SdkCallError('sdk.block.timeout')), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Calls an event handler (manifest "events") like the bot does. */
export async function runEvent(
  plugin: PluginDefinition,
  event: string,
  ctx: TestContext,
  payload: Record<string, Json> = {},
  timeoutMs = 10000,
): Promise<void> {
  const handler = plugin.events?.[event];
  if (!handler) throw new SdkCallError('sdk.event.unknown');
  await withTimeout(() => handler(ctx as never, structuredClone(payload)), timeoutMs);
}

/** Runs a task (manifest "tasks") once, like the scheduler of the bot. */
export async function runTask(plugin: PluginDefinition, name: string, ctx: TestContext, timeoutMs = 10000): Promise<void> {
  const handler = plugin.tasks?.[name];
  if (!handler) throw new SdkCallError('sdk.task.unknown');
  await withTimeout(() => handler(ctx as never), timeoutMs);
}

/** Runs one block of a plugin like the bot does, with the block timeout. */
export async function runBlock(
  plugin: PluginDefinition,
  name: string,
  ctx: TestContext,
  input: Partial<BlockInput> = {},
  timeoutMs = 10000,
): Promise<BlockResult> {
  const handler = plugin.blocks?.[name];
  if (!handler) throw new SdkCallError('sdk.block.unknown');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SdkCallError('sdk.block.timeout')), timeoutMs);
  });
  try {
    const out = await Promise.race([
      Promise.resolve(handler(ctx as never, { config: input.config ?? {}, vars: input.vars ?? {}, ...(input.interaction ? { interaction: input.interaction } : {}) })),
      timeout,
    ]);
    return { port: out?.port ?? 'next', results: out?.results ?? {} };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A click/select (components[key]) or modal (modals[key]) like the bot sends
 * it. Returns the handle; ctx.answers holds what the plugin answered.
 */
export async function runComponent(
  plugin: PluginDefinition,
  key: string,
  ctx: TestContext,
  event: Partial<InteractionEvent> = {},
  kind: 'component' | 'modal' = 'component',
  timeoutMs = 10000,
): Promise<string> {
  const handler = (kind === 'modal' ? plugin.modals : plugin.components)?.[key];
  if (!handler) throw new SdkCallError('sdk.component.unknown');
  const handle = event.handle ?? `test-${Math.random().toString(16).slice(2)}`;
  const full: InteractionEvent = {
    handle, key, data: '', user: { id: '100000000000000001', name: 'tester', displayName: 'Tester' },
    guildId: '200000000000000001', channelId: '300000000000000001', ...event,
  };
  await withTimeout(() => handler(ctx as never, structuredClone(full)), timeoutMs);
  return handle;
}

/** A modal answer (modals[key]) with its fields. */
export function runModal(plugin: PluginDefinition, key: string, ctx: TestContext, fields: Record<string, string>, event: Partial<InteractionEvent> = {}): Promise<string> {
  return runComponent(plugin, key, ctx, { ...event, fields }, 'modal');
}

/** Calls an inbound webhook handler (bothub.json services.webhooks) like the bot does. */
export async function runWebhook(plugin: PluginDefinition, name: string, ctx: TestContext, payload: Record<string, Json> = {}, timeoutMs = 10000): Promise<void> {
  const handler = plugin.webhooks?.[name];
  if (!handler) throw new SdkCallError('sdk.webhook.unknown');
  await withTimeout(() => handler(ctx as never, structuredClone(payload)), timeoutMs);
}
