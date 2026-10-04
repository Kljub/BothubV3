// @bothub/sdk: what a BotHub plugin can use (SDK v1).
//
// A plugin is an ES module whose default export is definePlugin({...}). It
// runs in its own process under the SDK manager of the bot: no database, no
// bot token, no network, no files outside its folder. Everything goes
// through `ctx`. Every call needs its permission (shared/sdk-permissions.json)
// declared in bothub-plugin.json AND switched on in the SDK policies (admin).
// Calls the bot does not answer yet reject with "sdk.call.not_available";
// the status of each call is in API.md.

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Id = string;
type Async<T> = Promise<T>;

/** A message like the "Send or Edit a Message" block builds it. */
export interface Message {
  mode?: 'normal' | 'v2';
  content?: string;
  embeds?: Array<{
    color?: string;
    title?: string;
    url?: string;
    description?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text?: string; icon_url?: string };
    image_url?: string;
    thumbnail_url?: string;
    timestamp?: boolean;
  }>;
  /**
   * Buttons and selects (max. 5 rows). Clicks come back to the plugin's
   * `components[key]` handler with `data` (max. 64 chars). Link buttons open a URL.
   */
  components?: ComponentRow[];
  /** true: user mentions in the text ping; default: no pings. */
  mentionUsers?: boolean;
}

export type ComponentRow = Array<
  | { type?: 'button'; key: string; data?: string; label?: string; emoji?: string; style?: 'primary' | 'secondary' | 'success' | 'danger'; disabled?: boolean }
  | { type: 'link'; url: string; label?: string; emoji?: string; disabled?: boolean }
  | { type: 'select'; key: string; data?: string; placeholder?: string; min?: number; max?: number; disabled?: boolean; options: Array<{ label: string; value: string; description?: string; emoji?: string; default?: boolean }> }
>;

/** A modal (interaction.showModal); the answer comes to `modals[key]`. */
export interface Modal {
  key: string;
  data?: string;
  title: string;
  fields: Array<{ key: string; label: string; style?: 'short' | 'long'; required?: boolean; value?: string; placeholder?: string; min?: number; max?: number }>;
}

/** A click, select or modal answer for the plugin (components / modals handlers). */
export interface InteractionEvent {
  /** Use with ctx.interaction.* (valid 15 minutes). The bot acknowledges silently after 2.5 s. */
  handle: string;
  key: string;
  data: string;
  user: { id: Id; name: string; displayName: string };
  guildId: Id | null;
  channelId: Id | null;
  messageId?: Id;
  /** Select menus: the chosen values. */
  values?: string[];
  /** Modals: field key → text. */
  fields?: Record<string, string>;
}

/** A request of ctx.http.secret. */
export interface SecretRequest {
  /** Name of the secret with the address (e.g. 'PLEX_URL'), or an https URL of a host in services.hosts. */
  url: string;
  /** With an address secret: the path added to it (starts with /). */
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  json?: Json;
  headers?: Record<string, string>;
  /** The key: secret name, where it goes (default header Authorization, "Bearer <key>"). */
  auth?: { secret: string; header?: string; format?: 'bearer' | 'plain' | 'query'; param?: string };
  /**
   * "storage.files": send one image of the plugin files as
   * multipart/form-data (field name, default "file"), with text `fields`.
   * Not together with `json`.
   */
  file?: { name: string; field?: string };
  fields?: Record<string, string>;
  /**
   * "storage.files": 'file' stores a successful answer (an image: PNG, GIF,
   * WEBP or JPEG, max. 2 MB) in the plugin files; the answer is then
   * { status, headers, file } (see SecretFileAnswer). Error answers come as text.
   */
  saveAs?: 'file';
}

export interface HttpAnswer { status: number; headers: Record<string, string>; json: Json; text: string; base64?: string }
/** ctx.http.secret with saveAs 'file' and a 2xx answer. */
export interface SecretFileAnswer { status: number; headers: Record<string, string>; file: StoredFile }
export interface MemberInfo { id: Id; name: string; displayName: string; bot: boolean; avatar: string; joinedAt: string | null; roles: Id[] }
export interface RoleInfo { id: Id; name: string; color: string; position: number; managed: boolean; mentionable: boolean; hoist: boolean; members: number }
/** nsfw: age-restricted channel (channel.get). */
export interface ChannelInfo { id: Id; name: string; type: string; parentId: Id | null; position?: number; guildId?: Id; topic?: string | null; nsfw?: boolean }
export interface MessageInfo { id: Id; channelId: Id; guildId: Id | null; content: string; authorId: Id; authorName: string; bot: boolean; createdAt: string; url: string; attachments: Array<{ name: string; url: string; size: number; contentType: string | null }>; embeds: number; stickers: number }

/** A file of the plugin files: name = content hash + extension (e.g. "3f2a9c0d1b7e4a55.png"). */
/** A plugin file: images (PNG, GIF, WEBP, JPEG) or other files with their original name (filename). */
export interface StoredFile { name: string; mime: string; size: number; filename: string }

/** Who to check with config.checkAccess: an interaction event or IDs. */
export type AccessSubject = { userId: Id; guildId: Id | null; channelId?: Id | null } | { user: { id: Id }; guildId: Id | null; channelId?: Id | null };
/** reason: why not allowed (member: not on the server); null when allowed. */
export interface AccessResult { allowed: boolean; reason: 'role' | 'banned_role' | 'permission' | 'channel' | 'member' | null }

export interface GuildInfo { id: Id; name: string; memberCount: number }
export interface ModuleInfo { id: string; name: string; enabled: boolean; config: Record<string, Json> }

export interface PluginContext {
  /** Bot the plugin runs for; storage and Discord calls stay inside it. */
  readonly botId: number;

  // core (no permission)
  readonly plugin: {
    getInfo(): { id: string; name: string; version: string; permissions: string[]; botId: number };
    getId(): string;
    getVersion(): string;
    getConfig(): Record<string, Json>;
    isEnabled(): boolean;
    getPath(): string;
    getManifest(): Record<string, Json>;
  };
  readonly logger: Record<'debug' | 'info' | 'warn' | 'error' | 'success', (text: string) => Async<void>>;
  /** Plugin settings of this bot: saved on the dashboard (defaults for fields nobody saved). A dashboard save counts at once. */
  readonly config: {
    get(key: string): Json | undefined;
    has(key: string): boolean;
    getAll(): Record<string, Json>;
    /**
     * Checks a member against a "permissions" field of the settings page
     * (allowed/banned roles, required permissions, banned channels), the
     * same way a command's permissions block works. `who` is an interaction
     * event or { userId, guildId, channelId }. In DMs always allowed.
     * Always reads the saved value, so a dashboard change counts at once.
     */
    checkAccess(key: string, who: AccessSubject): Async<AccessResult>;
    /**
     * Changes one field of the settings page (e.g. a list entry added by a
     * command); the dashboard shows it. The value is checked like a
     * dashboard save: sdk.config.unknown_key, sdk.config.bad_value. Access
     * rules ("permissions") and messages stay with the dashboard
     * (sdk.config.not_settable). List entries get an "_id". Images the
     * settings no longer name are deleted from the plugin files.
     */
    set(key: string, value: Json): Async<void>;
    /** Back to the field's default. */
    delete(key: string): Async<void>;
    /**
     * Options of a "choices" field with "dynamic": true, for this bot (e.g.
     * Plex libraries as { value: "1:5", label: "Njetflix:Filme" }); the
     * dashboard shows them in the field's dropdown. At most 200; answers the
     * number stored. sdk.config.not_dynamic, sdk.config.bad_options.
     */
    setOptions(key: string, options: Array<{ value: string; label?: string } | string>): Async<number>;
  };
  readonly utils: {
    uuid(): string;
    random(min?: number, max?: number): number;
    hash(text: string, algorithm?: string): string;
    formatDate(date: string | number | Date, locale?: string): string;
    formatDuration(ms: number): string;
    formatNumber(n: number, locale?: string): string;
    validate(value: Json, schema: Json): Async<boolean>;
  };
  readonly locale: { get(): Async<string>; translate(key: string, params?: Record<string, Json>): Async<string>; has(key: string): Async<boolean>; getAvailable(): Async<string[]> };
  readonly rateLimit: { check(key: string, max: number, windowMs: number): Async<boolean>; consume(key: string, max: number, windowMs: number): Async<boolean>; reset(key: string): Async<void> };
  readonly resources: { readFile(path: string): Async<string>; exists(path: string): Async<boolean>; getPath(path: string): Async<string> };

  // "storage"
  readonly storage: {
    get(key: string): Async<string | null>;
    set(key: string, value: string): Async<void>;
    has(key: string): Async<boolean>;
    delete(key: string): Async<void>;
    increment(key: string, by?: number): Async<number>;
    decrement(key: string, by?: number): Async<number>;
    clear(): Async<void>;
    transaction<T>(fn: () => Async<T>): Async<T>;
  };
  // "storage.global": like storage, but one space per plugin for every bot of
  // the instance (10,000 keys, 10 MB; e.g. account links that hold across bots).
  readonly globalStorage: {
    get(key: string): Async<string | null>;
    set(key: string, value: string): Async<void>;
    has(key: string): Async<boolean>;
    delete(key: string): Async<void>;
    increment(key: string, by?: number): Async<number>;
    decrement(key: string, by?: number): Async<number>;
    clear(): Async<void>;
  };
  // "storage.collections"
  readonly collection: {
    create(name: string): Async<void>;
    find(name: string, query?: Record<string, Json>): Async<Record<string, Json>[]>;
    findOne(name: string, query?: Record<string, Json>): Async<Record<string, Json> | null>;
    count(name: string, query?: Record<string, Json>): Async<number>;
    insert(name: string, doc: Record<string, Json>): Async<Id>;
    update(name: string, query: Record<string, Json>, changes: Record<string, Json>): Async<number>;
    upsert(name: string, query: Record<string, Json>, doc: Record<string, Json>): Async<Id>;
    delete(name: string, query: Record<string, Json>): Async<number>;
  };
  // "cache"
  readonly cache: {
    get(key: string): Async<Json>;
    set(key: string, value: Json, ttlMs?: number): Async<void>;
    has(key: string): Async<boolean>;
    delete(key: string): Async<void>;
    clear(): Async<void>;
    increment(key: string, by?: number): Async<number>;
    decrement(key: string, by?: number): Async<number>;
  };
  // "scheduler"
  readonly scheduler: {
    timeout(name: string, ms: number): Async<Id>;
    interval(name: string, ms: number): Async<Id>;
    cron(name: string, expression: string): Async<Id>;
    every(name: string, duration: string): Async<Id>;
    cancel(id: Id): Async<void>;
    list(): Async<{ id: Id; name: string }[]>;
  };
  // "events.plugin", "discord.events", "bothub.events"
  readonly events: {
    on(event: string, handler: (payload: Json) => unknown): Async<void>;
    once(event: string, handler: (payload: Json) => unknown): Async<void>;
    off(event: string): Async<void>;
    emit(event: string, payload?: Json): Async<void>;
    list(): Async<string[]>;
  };

  // Discord (only servers of this bot). Roles and members: only below the bot's highest role, never Administrator.
  readonly guild: {
    get(guildId: Id): Async<GuildInfo>;
    list(): Async<GuildInfo[]>;
    getChannels(guildId: Id): Async<ChannelInfo[]>;
    getRoles(guildId: Id): Async<RoleInfo[]>;
    getEmojis(guildId: Id): Async<Array<{ id: Id; name: string; animated: boolean; url: string }>>;
    /** "discord.members.read" */
    getMembers(guildId: Id, options?: { limit?: number }): Async<MemberInfo[]>;
  };
  readonly member: {
    get(guildId: Id, userId: Id): Async<MemberInfo>;
    list(guildId: Id, options?: { limit?: number }): Async<MemberInfo[]>;
    addRole(guildId: Id, userId: Id, roleId: Id, reason?: string): Async<void>;
    removeRole(guildId: Id, userId: Id, roleId: Id, reason?: string): Async<void>;
    /** ms up to 28 days; null ends the timeout. */
    timeout(guildId: Id, userId: Id, ms: number | null, reason?: string): Async<void>;
    kick(guildId: Id, userId: Id, reason?: string): Async<void>;
    ban(guildId: Id, userId: Id, reason?: string): Async<void>;
    unban(guildId: Id, userId: Id, reason?: string): Async<void>;
    setNickname(guildId: Id, userId: Id, nickname: string | null, reason?: string): Async<void>;
  };
  readonly channel: {
    get(channelId: Id): Async<ChannelInfo>;
    list(guildId: Id): Async<ChannelInfo[]>;
    create(guildId: Id, options: { name: string; type?: 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'stage'; topic?: string; parentId?: Id; nsfw?: boolean; position?: number; reason?: string }): Async<{ id: Id; name: string }>;
    edit(channelId: Id, options: { name?: string; topic?: string; parentId?: Id | null; position?: number; slowmode?: number; reason?: string }): Async<void>;
    delete(channelId: Id, reason?: string): Async<void>;
    /** Permission names in snake_case (view_channel, send_messages, …); Administrator is refused. */
    setPermissions(channelId: Id, targetId: Id, options: { allow?: string[]; deny?: string[]; reason?: string }): Async<void>;
  };
  readonly role: {
    get(guildId: Id, roleId: Id): Async<RoleInfo>;
    list(guildId: Id): Async<RoleInfo[]>;
    create(guildId: Id, options: { name?: string; color?: string; hoist?: boolean; mentionable?: boolean; permissions?: string[]; reason?: string }): Async<RoleInfo>;
    edit(guildId: Id, roleId: Id, options: { name?: string; color?: string; hoist?: boolean; mentionable?: boolean; permissions?: string[]; reason?: string }): Async<RoleInfo>;
    delete(guildId: Id, roleId: Id, reason?: string): Async<void>;
    addToMember(guildId: Id, userId: Id, roleId: Id, reason?: string): Async<void>;
    removeFromMember(guildId: Id, userId: Id, roleId: Id, reason?: string): Async<void>;
  };
  readonly message: {
    get(channelId: Id, messageId: Id): Async<MessageInfo>;
    /**
     * "discord.messages.files": posts an image of the plugin files as an
     * attachment, with an optional message. In an embed, image_url or
     * thumbnail_url "attachment" shows the file there. Max. 5 messages per 5 s
     * (shared with send). spoiler: true blurs the image until clicked.
     */
    sendFile(channelId: Id, fileName: string, message?: (Message & { spoiler?: boolean }) | string): Async<Id>;
    /** "discord.messages.send": returns the message ID. No pings, max. 5 per 5 s. */
    send(channelId: Id, message: Message | string): Async<Id>;
    /** "discord.messages.send": direct message to a user; returns the message ID. */
    dm(userId: Id, message: Message | string): Async<Id>;
    /** Only the bot's own messages. */
    edit(channelId: Id, messageId: Id, message: Message | string): Async<void>;
    delete(channelId: Id, messageId: Id): Async<void>;
    pin(channelId: Id, messageId: Id, reason?: string): Async<void>;
    unpin(channelId: Id, messageId: Id, reason?: string): Async<void>;
    react(channelId: Id, messageId: Id, emoji: string): Async<void>;
  };
  /**
   * "discord.interactions": answer a command (BlockInput.interaction) or a
   * click/select/modal (InteractionEvent.handle). The token stays in the bot.
   */
  readonly interaction: {
    /** options.file: a plugin file sent along (storage.files), e.g. privately with ephemeral. */
    reply(handle: string, message: Message | string, options?: { ephemeral?: boolean; file?: string }): Async<void>;
    editReply(handle: string, message: Message | string): Async<void>;
    deferReply(handle: string, options?: { ephemeral?: boolean }): Async<void>;
    followUp(handle: string, message: Message | string, options?: { ephemeral?: boolean; file?: string }): Async<void>;
    /** Changes the message whose button/select was used. */
    update(handle: string, message: Message | string): Async<void>;
    /** Only before any other answer to the interaction. */
    showModal(handle: string, modal: Modal): Async<void>;
    respond(handle: string, payload?: Json): Async<void>;
  };
  /**
   * "discord.emojis.read": list / get (mention = the text that shows the emoji in a message).
   * "discord.emojis.manage": create / delete, image as base64 (PNG/GIF/WEBP/JPEG, max. 256 KB).
   */
  readonly emoji: {
    list(guildId: Id): Async<Array<{ id: Id; name: string; animated: boolean; available: boolean; url: string; mention: string }>>;
    get(guildId: Id, emojiId: Id): Async<{ id: Id; name: string; animated: boolean; available: boolean; url: string; mention: string }>;
    create(guildId: Id, name: string, imageBase64: string, reason?: string): Async<{ id: Id; name: string; animated: boolean }>;
    delete(guildId: Id, emojiId: Id, reason?: string): Async<void>;
  };
  /**
   * "discord.audit.read": the server's Discord audit log (newest first, max. 100).
   * type: AuditLogEvent name, e.g. "MemberBanAdd"; the bot needs "View Audit Log".
   */
  readonly audit: {
    list(guildId: Id, options?: { type?: string; user?: Id; limit?: number; before?: Id }): Async<Array<{
      id: Id; action: string; executorId: Id | null; targetId: Id | null; targetType: string; reason: string | null;
      changes: Array<{ key: string; old: string | null; new: string | null }>; createdAt: string;
    }>>;
  };
  /**
   * "moderation.cases": cases and notes of the bot's Moderation module. A recorded case
   * gets the next case number, the DM, the log channel post and the automatic
   * punishments the module is set up for; null when the module is off.
   */
  readonly moderation: {
    warn(guildId: Id, userId: Id, reason: string, moderatorId?: Id): Async<number | null>;
    record(guildId: Id, userId: Id, action: 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban' | 'role_add' | 'role_remove' | 'voice_mute' | 'voice_unmute' | 'voice_deafen' | 'voice_undeafen' | 'voice_kick', reason?: string, duration?: string, moderatorId?: Id): Async<number | null>;
    history(guildId: Id, userId: Id): Async<Array<{ number: number; userId: Id; moderatorId: Id | null; action: string; reason: string; duration: string; auto: boolean; createdAt: string }>>;
    getCase(guildId: Id, number: number): Async<{ number: number; userId: Id; moderatorId: Id | null; action: string; reason: string; duration: string; auto: boolean; createdAt: string } | null>;
    note(guildId: Id, userId: Id, content: string, authorId?: Id): Async<number>;
    notes(guildId: Id, userId: Id): Async<Array<{ id: number; authorId: Id | null; content: string; createdAt: string }>>;
  };
  /** "economy": balances of the bot's Economy module (the same as /balance). */
  readonly economy: {
    get(guildId: Id, userId: Id): Async<number>;
    add(guildId: Id, userId: Id, amount: number): Async<number>;
    /** Fails with sdk.economy.not_enough instead of going below 0. */
    remove(guildId: Id, userId: Id, amount: number): Async<number>;
    transfer(guildId: Id, fromUserId: Id, toUserId: Id, amount: number): Async<void>;
    leaderboard(guildId: Id, limit?: number): Async<Array<{ userId: Id; balance: number }>>;
  };
  readonly commands: {
    register(definition: Record<string, Json>): Async<Id>;
    unregister(name: string): Async<void>;
    get(name: string): Async<Json>;
    list(): Async<Json[]>;
    isEnabled(name: string): Async<boolean>;
    getPermissions(name: string): Async<Json>;
    setPermissions(name: string, permissions: Record<string, Json>): Async<void>;
  };
  readonly permissions: Record<'check' | 'checkUser' | 'checkMember' | 'checkRole' | 'checkChannel' | 'require', (...args: Json[]) => Async<boolean>>;

  // BotHub
  /** "modules.read": BotHub modules of this bot (read only). */
  readonly module: {
    get(key: string): Async<ModuleInfo>;
    getId(key: string): Async<string>;
    getName(key: string): Async<string>;
    isEnabled(key: string): Async<boolean>;
    getConfig(key: string): Async<Record<string, Json>>;
    list(): Async<ModuleInfo[]>;
  };
  readonly plugins: {
    get(id: string): Async<Json>;
    list(): Async<Json[]>;
    isInstalled(id: string): Async<boolean>;
    isEnabled(id: string): Async<boolean>;
    getAPI(id: string): Async<Json>;
    emit(id: string, event: string, payload?: Json): Async<void>;
  };
  readonly dashboard: Record<'registerPage' | 'registerSettings' | 'registerComponent' | 'registerMenuItem' | 'getRoute', (definition: Record<string, Json>) => Async<string>>;
  /**
   * "secrets.use": http.secret sends a request with admin secrets the plugin
   * never sees. url is the name of a secret that holds the address (any
   * address the admin set, also in the home network; path is added), or an
   * https URL of a host in bothub.json "services.hosts". auth puts a secret
   * into a header (Bearer <key> or <key>) or a URL parameter. Only names of
   * "services.secrets" the admin shared; values are masked in the answer.
   * Response max. 1 MB, timeout 10 s.
   * "http.outbound" (high risk): https to the hosts in bothub.json
   * "services.hosts" only; private addresses are refused; max. 1 MB, 10 s.
   */
  readonly http: {
    get(url: string, options?: { query?: Record<string, string>; headers?: Record<string, string> }): Async<HttpAnswer>;
    delete(url: string, options?: { query?: Record<string, string>; headers?: Record<string, string> }): Async<HttpAnswer>;
    post(url: string, json?: Json, options?: { query?: Record<string, string>; headers?: Record<string, string>; body?: string }): Async<HttpAnswer>;
    put(url: string, json?: Json, options?: { query?: Record<string, string>; headers?: Record<string, string>; body?: string }): Async<HttpAnswer>;
    patch(url: string, json?: Json, options?: { query?: Record<string, string>; headers?: Record<string, string>; body?: string }): Async<HttpAnswer>;
    secret(request: SecretRequest): Async<{ status: number; headers: Record<string, string | SecretFileAnswer>; json: Json; text: string }>;
    /**
     * "http.check": does a website answer? Any public http(s) URL, only status
     * and latency (never the page). Network trouble is an answer with ok false
     * and error (timeout, dns, private_address, too_many_redirects, failed).
     */
    check(url: string, options?: { method?: 'GET' | 'HEAD'; timeoutMs?: number }): Async<{ ok: boolean; status: number | null; latencyMs: number | null; error?: string }>;
  };
  /** "discord.voice": play files of the plugin folder (sounds/<name>.ogg|mp3|wav). */
  readonly voice: {
    join(guildId: Id, channelId: Id): Async<void>;
    leave(guildId: Id): Async<void>;
    play(guildId: Id, file: string, options?: { volume?: number }): Async<void>;
    stop(guildId: Id): Async<void>;
    state(guildId: Id): Async<{ channelId: Id | null; playing: boolean; file: string | null }>;
  };
  /**
   * "secrets.read": a secret of Admin > API / Secrets by its exact name. The
   * name must be in bothub.json "services.secrets" and the admin must share it
   * with the plugin; otherwise the answer is null. There is no call that
   * lists secrets. Read values are masked in the plugin's log lines.
   */
  readonly secrets: { get(name: string): Async<string | null>; has(name: string): Async<boolean> };


  // "data.variables": Data Storage variables of this bot that the plugin
  // creates; the Custom Command Builder and the Message Builder use them as
  // {var.<key>}. Only the plugin's own variables; uninstalling deletes them.
  readonly variables: {
    /** Creates the variable or updates the plugin's own (a new type, owner or server setting drops its values). sdk.variables.taken, .bad_key, .bad_type, .limit. */
    create(def: VariableDefinition): Async<{ key: string; created: boolean }>;
    delete(key: string): Async<boolean>;
    list(): Async<VariableDefinition[]>;
    /** The value (else the default); where names the server / member / channel the variable is kept per. */
    get(key: string, where?: VariableWhere): Async<string>;
    /** Text for text and number, any JSON for lists and objects. */
    set(key: string, value: Json, where?: VariableWhere): Async<boolean>;
    /** Back to the default. */
    reset(key: string, where?: VariableWhere): Async<boolean>;
  };
  // "storage.files": images of this bot (PNG, GIF, WEBP, JPEG; max. 2 MB each,
  // 100 files, 25 MB). "image" fields of the settings page store their upload
  // here; the value of the field is the file name.
  readonly files: {
    list(): Async<StoredFile[]>;
    /** The file with its content (base64), null when unknown. */
    get(name: string): Async<(StoredFile & { data: string }) | null>;
    /**
     * Stores a file (base64; max. about 48 KB per call, bigger ones via
     * fromDiscord). Without filename only images; with one any file but
     * programs (exe, bat, js, …). Same content = same name.
     */
    put(base64: string, filename?: string): Async<StoredFile>;
    /** Stores a Discord attachment (cdn.discordapp.com / media.discordapp.net), e.g. a command's attachment option; any file but programs, up to 8 MB. */
    fromDiscord(url: string, filename?: string): Async<StoredFile>;
    delete(name: string): Async<boolean>;
  };
}

/** A Data Storage variable ({var.<key>}). */
export interface VariableDefinition {
  /** a-z, 0-9, _; starts with a letter; max. 32. */
  key: string;
  name?: string;
  description?: string;
  type?: 'text' | 'number' | 'list' | 'object' | 'object_list';
  /** One value, one per member or one per channel. */
  owner?: 'shared' | 'member' | 'channel';
  /** Separate values per server (default true). */
  perServer?: boolean;
  default?: Json;
  /** Group on the Data Storage page (default: the plugin name). */
  group?: string;
}

/** Where a value is kept: the IDs the variable needs (server if perServer, member or channel by owner). */
export interface VariableWhere {
  guildId?: string;
  userId?: string;
  channelId?: string;
}

/** What a builder block of the plugin gets: its config and the run's variables. */
export interface BlockInput {
  /** Block config with placeholders already filled in. */
  config: Record<string, Json>;
  /** Variables of the run ({user.id} → vars['user.id']). */
  vars: Record<string, string>;
  /** Handle of the command or click that runs the graph (ctx.interaction.*), when there is one. */
  interaction?: string;
}

export interface BlockResult {
  /** Output port to continue at; default "next". */
  port?: string;
  /** Results stored under the block's variable: '' → {Var1}, '.count' → {Var1.count}. */
  results?: Record<string, string>;
}

export type BlockHandler = (ctx: PluginContext, input: BlockInput) => Promise<BlockResult | void> | BlockResult | void;
type Hook = (ctx: PluginContext) => Promise<void> | void;

export interface PluginDefinition {
  /** After the plugin file is loaded. */
  onLoad?: Hook;
  /** The plugin starts for a bot. */
  onEnable?: Hook;
  /** The plugin stops for a bot (switched off, bot stopped, update). */
  onDisable?: Hook;
  /** Last call before the process ends. */
  onUnload?: Hook;
  /** Handlers of the blocks in bothub-plugin.json "blocks", by name. */
  blocks?: Record<string, BlockHandler>;
  /** Discord events listed in the manifest "events" (permission "discord.events"); called like a block. */
  events?: Record<string, (ctx: PluginContext, payload: Record<string, Json>) => Promise<void> | void>;
  /** Tasks listed in the manifest "tasks" ({name, every} or {name, cron}, permission "scheduler"). */
  tasks?: Record<string, (ctx: PluginContext) => Promise<void> | void>;
  /** Buttons and selects of the plugin's messages, by key ("discord.interactions"). */
  components?: Record<string, (ctx: PluginContext, event: InteractionEvent) => Promise<void> | void>;
  /**
   * Inbound webhooks of bothub.json "services.webhooks" ("webhooks.inbound"):
   * payload = the JSON the caller sent (or its form field "payload").
   */
  webhooks?: Record<string, (ctx: PluginContext, payload: Record<string, Json>) => Promise<void> | void>;
  /** Modals of the plugin, by key ("discord.interactions"). */
  modals?: Record<string, (ctx: PluginContext, event: InteractionEvent) => Promise<void> | void>;
}

/** Marks the default export of a plugin (keeps types; no runtime logic). */
export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

/** Errors a plugin can throw on purpose; the key shows up in the bot log. */
export class PluginError extends Error {
  constructor(readonly key: string, message?: string) {
    super(message ?? key);
    this.name = 'PluginError';
  }
}
