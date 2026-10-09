// One Discord bot: login, slash command registration, running command and
// event graphs, buttons and menus of sent messages. All bots of the instance
// run in this one process (context/decisions.md, decision 5).

import { claimEvents, handover, ROLE } from '../core/handover.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  Routes,
  type ChatInputCommandInteraction,
  type UserContextMenuCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type Guild,
  type GuildMember,
  type Interaction,
  type MessageComponentInteraction,
  type RepliableInteraction,
  type SendableChannels,
  type User,
} from 'discord.js';
import type { GraphLimits } from '../core/config.js';
import { guardRest, guardValue } from '../core/leakguard.js';
import { log } from '../core/log.js';
import { cardFile, cardRenderer, cardVars, renderCard } from '../cards/cards.js';
import type { CommandRow, Repo } from '../core/repo.js';
import { GraphError, Run, type Engine, type Handler, type RunResult } from '../graph/interpreter.js';
import { cronMatches, parseCron, type Cron } from '../graph/cron.js';
import { coreHandlers, helperValue, lookupVariable } from '../graph/handlers-core.js';
import { dataStore } from '../core/datastore.js';
import type { PluginManager } from '../sdk/manager.js';
import type { DiscordApiDeps } from '../sdk/discord-api.js';
import type { Graph, GraphNode, NodeDefinition } from '../graph/types.js';
import { endGiveaway } from '../modules/giveaway.js';
import { buildCommands, denied, hideRepliesOf, settingsOf, type Permissions, type PseudoRoles } from './commands.js';
import { discordHandlers, type DiscordData } from './handlers.js';
import { buildMessage, hasBody } from './message.js';
import { VoiceManager } from './voice.js';
import { MusicManager, musicOrNull, setMusic } from './music.js';
import { Moderation } from './moderation.js';
import { matchState } from './match.js';
import { bindEvents, type EventContext } from './events.js';
import * as eco from '../modules/economy.js';
import { bindModules, ModuleContext } from '../modules/index.js';
import { secretValue } from '../core/secrets-global.js';
import { stats, usageVar } from '../core/stats.js';
import { Bucket, warn } from '../modules/guard.js';
import { moduleHandlers } from './handlers-modules.js';
import { extraHandlers } from './handlers-extra.js';
import { parsePresence, PresenceRunner } from './presence.js';
import { isDue, nextRun, type TimedEvent } from '../core/timed.js';
import { botVars, channelVars, guildVars, userVars, type Vars } from './vars.js';
import { alertEmbed, failConfig, hintOf, ownerTip, preflight, prepare, reasonText, traceOf, type FailConfig, type TraceContext } from './playback.js';
import type { Hint, RunErrorTexts } from '../graph/explain.js';

const PRIVILEGED = [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.MessageContent];
const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.AutoModerationExecution,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.GuildMessageTyping,
  GatewayIntentBits.GuildMessagePolls,
];
/** Buttons and menus keep their run this long. */
const PENDING_TTL_MS = 15 * 60_000;
/** Commands still running after this get a "thinking …" reply (Discord allows 3 s). */
const AUTO_DEFER_MS = 2200;
/** Event graphs of one bot that may run at the same time. */
const MAX_ACTIVE_RUNS = 10;
/** Command list changes are sent to Discord this long after the last change. */
const REGISTER_DEBOUNCE_MS = 2000;

/** Payload of bothub:events webhook.called (shared/streams.json). */
export interface WebhookCall {
  eventId: string;
  name: string;
  body: string;
  variables: Record<string, string>;
}

export interface InstanceDeps {
  repo: Repo;
  defs: Map<string, NodeDefinition>;
  limits: GraphLimits;
  /** SDK manager: sandboxed plugins (installed globally, plugin_installs). */
  plugins?: PluginManager;
  /** Key for secrets (bot tokens, global secrets); absent in tests. */
  secretKey?: () => Buffer;
  /** Stop Bot / Restart Bot blocks: the bot manager stops or restarts this bot. */
  control?: (botId: number, op: 'stop' | 'restart') => void;
  /** shared/run-errors.json: plain-language reasons of failed blocks. */
  runErrors?: RunErrorTexts;
}

interface RunMeta {
  runKey: string;
  startVars: Record<string, string>;
  fail: FailConfig;
  warnings: { node: string; text: string }[];
}

interface Pending {
  run: Run;
  command: CommandRow;
  invokerId: string | null;
  expires: number;
}

/** Event types of events.ts → event names of the plugin SDK. */
const PLUGIN_EVENTS: Record<string, string> = {
  message_create: 'messageCreate',
  message_update: 'messageUpdate',
  message_delete: 'messageDelete',
  bot_guild_join: 'guildCreate',
  bot_guild_leave: 'guildDelete',
  member_join: 'guildMemberAdd',
  member_leave: 'guildMemberRemove',
  member_update: 'guildMemberUpdate',
  member_ban: 'guildBanAdd',
  member_unban: 'guildBanRemove',
  member_status: 'presenceUpdate',
  channel_create: 'channelCreate',
  channel_delete: 'channelDelete',
  channel_update: 'channelUpdate',
  role_create: 'roleCreate',
  role_delete: 'roleDelete',
  role_update: 'roleUpdate',
  voice_join: 'voiceStateUpdate',
  voice_leave: 'voiceStateUpdate',
  voice_switch: 'voiceStateUpdate',
  reaction_add: 'reactionAdd',
  reaction_remove: 'reactionRemove',
};

export class BotInstance {
  private client: Client | null = null;
  /** Voice connections of this bot (plugins, later music); set while logged in. */
  voice: VoiceManager | undefined;
  private commands = new Map<string, CommandRow>();
  private events = new Map<string, CommandRow[]>();
  private timed: { cmd: CommandRow; cron: Cron }[] = [];
  private ticker: NodeJS.Timeout | undefined;
  /** Timed events (table timed_events) and the bot's time settings. */
  private schedules: TimedEvent[] = [];
  private timeSettings: { timezone: string; defaultGuildId: string | null } = { timezone: '', defaultGuildId: null };
  private scheduleTimer: NodeJS.Timeout | undefined;
  private lastCheckMs = 0;
  private startedMs = 0;
  private readonly presence = new PresenceRunner();
  /** Ready-made modules (bot/src/modules), settings cached for a few seconds. */
  private readonly modules: ModuleContext;
  /** Custom, timed and webhook events: at most 20 runs per 10 seconds per bot. */
  private readonly runBudget = new Bucket(20, 10_000);
  /** Per server and event type: 5 runs per 10 s, so one busy channel cannot use the whole budget. */
  private readonly eventBudgets = new Map<string, Bucket>();
  /** Event runs in progress; above MAX_ACTIVE_RUNS new ones are skipped. */
  private activeRuns = 0;
  private registerTimer: NodeJS.Timeout | undefined;
  private pending = new Map<string, Pending>();
  private registeredHash = '';
  private sweeper: NodeJS.Timeout | undefined;
  private jobTimer: NodeJS.Timeout | undefined;
  private jobsRunning = false;
  private readonly engine: Engine;
  private readonly moderation: Moderation;
  private readonly runMeta = new WeakMap<Run, RunMeta>();
  /** Privileged intents of this bot (Developer Portal); null when unknown. */
  private intents: { presence: boolean; members: boolean; messageContent: boolean } | null = null;
  /** Last staff alert per command (one per minute). */
  private readonly alerted = new Map<number, number>();

  constructor(
    readonly botId: number,
    private readonly deps: InstanceDeps,
  ) {
    this.modules = new ModuleContext(botId, deps.repo, (key) => (deps.secretKey ? secretValue(deps.repo, deps.secretKey, botId, key) : null), deps.secretKey ?? null);
    const store = deps.repo.varStore(botId);
    // Stored variables that change start "bot_variable_change" (budgets of
    // mayRun keep an event that changes variables itself from running wild).
    const vars: typeof store = {
      ...store,
      set: (scope, scopeId, name, value) => {
        const old = store.get(scope, scopeId, name);
        store.set(scope, scopeId, name, value);
        if (old !== value) this.variableChanged(scope, scopeId, name, old ?? '', value);
      },
    };
    const core = {
      vars,
      secret: (key: string) => (deps.secretKey ? secretValue(deps.repo, deps.secretKey, botId, key) : null),
      data: dataStore(deps.repo.db, botId),
      logError: (run: Run, text: string) => this.logRun(run, 'ERR-1007', { text }),
      resetCooldown: (command: string, scopeKey: string) => {
        const cmd = this.commands.get(command.trim().split(/\s+/).join(' '));
        if (!cmd) throw new GraphError('error.run.unknown_command', { value: command });
        deps.repo.clearCooldown(cmd.id, scopeKey);
      },
    };
    this.moderation = new Moderation(botId, deps.repo, () => this.client);
    const handlers = new Map<string, Handler>([...coreHandlers(core), ...discordHandlers(deps.repo, this.moderation, core.secret, deps.secretKey), ...moduleHandlers(deps.repo, botId, core.secret, deps.secretKey ?? null), ...extraHandlers({ repo: deps.repo, secret: core.secret })]);
    // Own copy of the definitions: plugin blocks exist only for this bot.
    this.engine = { defs: new Map(deps.defs), handlers, limits: deps.limits, match: matchState, lookup: (name, run) => lookupVariable(core, name, run) ?? this.liveVar(name, run) };
  }

  /** {bot.ping}, {bot.uptime}, {bot.memory}: read when a block uses them, not on every run. */
  private liveVar(name: string, run?: Run): string | undefined {
    const c = this.client;
    if (/^bot\.(active_users|total_voice_minutes|commands_usage|plugin_usage)/i.test(name)) {
      // The overview's numbers: flushed once a minute, so write what is counted first.
      stats(this.deps.repo.db).flush();
      return usageVar(this.deps.repo.db, this.botId, (run?.data as { guild?: { id: string } | null } | undefined)?.guild?.id ?? null, name);
    }
    if (name === 'bot.ping') return c ? String(Math.max(0, Math.round(c.ws.ping))) : undefined;
    if (name === 'bot.uptime') return c?.uptime ? formatUptime(c.uptime) : undefined;
    if (name === 'bot.memory') return String(Math.round(process.memoryUsage().rss / 1024 / 1024));
    return undefined;
  }

  get running(): boolean {
    return this.client?.isReady() ?? false;
  }

  // ---------- lifecycle ----------

  async start(token: string): Promise<void> {
    guardValue(token);
    await this.stop();
    this.deps.repo.setBotStatus(this.botId, 'starting');
    this.reloadGraphs();
    try {
      // Only the privileged intents the Developer Portal allows (one that is
      // off would otherwise cost all three).
      const allowed = await privilegedIntents(token);
      if (allowed) {
        this.deps.repo.setBotIntents(this.botId, allowed);
        this.intents = allowed;
      }
      const wanted = allowed
        ? PRIVILEGED.filter((f) => (f === GatewayIntentBits.GuildPresences ? allowed.presence : f === GatewayIntentBits.GuildMembers ? allowed.members : allowed.messageContent))
        : PRIVILEGED;
      this.client = await this.login(token, [...BASE_INTENTS, ...wanted]);
    } catch (err) {
      if ((err as { code?: number }).code === 4014 || /disallowed intents/i.test(String((err as Error).message))) {
        // Privileged intents are off in the Discord developer portal: run
        // without member, presence and message content data.
        this.deps.repo.logCode(this.botId, 'WAR-2002', { intent: 'GuildMembers, GuildPresences, MessageContent' });
        this.intents = { presence: false, members: false, messageContent: false };
        this.deps.repo.setBotIntents(this.botId, this.intents);
        this.client = await this.login(token, BASE_INTENTS);
      } else {
        const tokenInvalid = /token/i.test(String((err as Error).message)) || (err as { code?: string }).code === 'TokenInvalid';
        this.deps.repo.setBotStatus(this.botId, 'error', tokenInvalid ? 'log.code.ERR-1001' : 'error.bot.start_failed');
        if (tokenInvalid) this.deps.repo.logCode(this.botId, 'ERR-1001', {});
        throw err;
      }
    }
    this.sweeper = setInterval(() => this.sweepPending(), 60_000);
    this.sweeper.unref();
    this.scheduleTick();
    this.startedMs = this.lastCheckMs = Date.now();
    this.scheduleTimer = setInterval(() => this.checkSchedules(), 1000);
    this.scheduleTimer.unref();
    this.jobTimer = setInterval(() => void this.runJobs().catch((err) => log.error('scheduled jobs failed', { botId: this.botId, err })), 15_000);
    this.jobTimer.unref();
    this.voice = this.client ? new VoiceManager(this.client) : undefined;
    if (this.client) setMusic(this.client, new MusicManager(this.client, () => this.voice));
    await this.startPlugins();
  }

  /** Starts the bot's plugins and adds their blocks (plugin.<id>.<name>) to the engine. */
  async startPlugins(): Promise<void> {
    const plugins = this.deps.plugins;
    if (!plugins) return;
    for (const key of [...this.engine.handlers.keys()]) if (key.startsWith('plugin.')) this.engine.handlers.delete(key);
    for (const key of [...this.engine.defs.keys()]) if (key.startsWith('plugin.')) this.engine.defs.delete(key);
    try {
      await plugins.startBot(this.botId);
    } catch (err) {
      log.error('plugins failed', { botId: this.botId, err });
      return;
    }
    for (const [type, def] of plugins.blockDefs(this.botId)) this.engine.defs.set(type, def);
    for (const [type, handler] of plugins.blockHandlers(this.botId)) this.engine.handlers.set(type, handler);
  }

  /** SDK call discord.sendMessage: a message in the shape of the send block; files: images of the plugin files (message.sendFile). */
  async pluginSend(channelId: string, message: unknown, files: { name: string; data: Buffer }[] = []): Promise<string> {
    if (!this.client?.isReady()) throw new GraphError('error.bot.not_running');
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isSendable()) throw new GraphError('error.run.channel_not_found', { value: channelId });
    // Plugin buttons/selects arrive already built by the SDK manager (_components).
    const built = message && typeof message === 'object' ? (message as { _components?: unknown[] })._components : undefined;
    const empty = message === undefined || message === null || (typeof message === 'object' && !Object.keys(message as object).length);
    const payload = files.length && empty ? {} : this.pluginPayload(message);
    const attach = files.length ? { files: files.map((f) => ({ attachment: f.data, name: f.name })) } : {};
    const sent = await channel.send({ ...payload, ...attach, ...(built?.length ? { components: built } : {}), allowedMentions: { parse: [] } } as never);
    return sent.id;
  }

  /** BotHub message format (Send Message block) -> discord.js payload; placeholders are not filled in. */
  pluginPayload(message: unknown): Record<string, unknown> {
    const node: GraphNode = { id: 'plugin', type: 'action.send_message', typeVersion: 1, config: { message: typeof message === 'string' ? { mode: 'normal', content: message } : message } };
    const run = new Run({ schemaVersion: 1, nodes: [node], edges: [] }, this.engine, this.data({ runKey: 'plugin' }) as never, {});
    const payload = buildMessage(run, node, () => '') as Record<string, unknown>;
    if (!hasBody(payload) && !(message && typeof message === 'object' && ((message as { _components?: unknown[] })._components?.length || Array.isArray((message as { components?: unknown }).components)))) throw new GraphError('error.run.empty_message');
    return payload;
  }

  /** What the SDK's Discord, HTTP and economy calls need (sdk/discord-api.ts). */
  pluginApi(): DiscordApiDeps {
    const repo = this.deps.repo;
    const botId = this.botId;
    return {
      client: () => this.client ?? undefined,
      render: (m) => this.pluginPayload(m),
      moderation: {
        record: async (guild, c) => {
          const handle = await this.moderation.begin({ guild, userId: c.userId, moderatorId: c.moderatorId, action: c.action, reason: c.reason, duration: c.duration });
          await handle.finish();
          return handle.number;
        },
        cases: (g, u) => repo.cases(botId, g, u),
        modCase: (g, n) => repo.modCase(botId, g, n),
        addNote: (g, u, author, content) => repo.addNote(botId, g, u, author, content),
        notes: (g, u) => repo.notes(botId, g, u),
      },
      economy: {
        balance: (g, u, c) => repo.balance(botId, g, u, c),
        change: (g, u, n, mode, c) => repo.changeBalance(botId, g, u, n, mode, c),
        pay: (g, f, t, n, c) => repo.pay(botId, g, f, t, n, c),
        leaderboard: (g, n, c) => repo.leaderboard(botId, g, n, c),
        currencies: () => repo.currencyList(botId),
        bank: (g, u) => eco.bank(this.modules, g, u),
        bankTake: (g, f, t, n) => eco.bankTake(this.modules, g, f, t, n),
      },
    };
  }

  /** SDK call guild.list: the servers the bot is in (max. 200). */
  pluginGuildList(): { id: string; name: string; memberCount: number }[] {
    return [...(this.client?.guilds.cache.values() ?? [])].slice(0, 200).map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
  }

  /** SDK call guild.get: only servers the bot is in. */
  pluginGuildInfo(guildId: string): { id: string; name: string; memberCount: number } {
    const g = this.client?.guilds.cache.get(guildId);
    if (!g) throw new GraphError('error.run.server_not_found', { value: guildId });
    return { id: g.id, name: g.name, memberCount: g.memberCount };
  }

  /** Checks the timed events at the start of every minute. */
  private scheduleTick(): void {
    clearTimeout(this.ticker);
    this.ticker = setTimeout(() => {
      this.scheduleTick();
      // While two cores run (update), only the leader runs timers.
      if (handover.isLeader()) void this.runTimed(new Date());
    }, 60_000 - (Date.now() % 60_000) + 50);
    this.ticker.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.sweeper);
    clearTimeout(this.registerTimer);
    clearTimeout(this.ticker);
    clearInterval(this.scheduleTimer);
    clearInterval(this.jobTimer);
    this.presence.stop();
    this.deps.plugins?.stopBot(this.botId);
    if (this.client) {
      musicOrNull(this.client)?.destroyAll();
      setMusic(this.client, undefined);
    }
    this.voice?.destroyAll();
    this.voice = undefined;
    this.pending.clear();
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.destroy();
      // During an update the bots run on in the other core: no "stopped".
      if (ROLE === 'main' && !handover.overlap) {
        this.deps.repo.setBotStatus(this.botId, 'stopped');
        this.deps.repo.logUpdate(this.botId, 'log.update.bot_stopped');
      }
    }
  }

  private async login(token: string, intents: GatewayIntentBits[]): Promise<Client> {
    const client = new Client({
      intents,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember, Partials.GuildScheduledEvent, Partials.ThreadMember],
    });
    claimEvents(client as never, this.botId);
    guardRest(client.rest as never);
    client.once(Events.ClientReady, (c) => void this.onReady(c.user, [...c.guilds.cache.values()]));
    client.on(Events.InteractionCreate, (i) => void this.onInteraction(i).catch((err) => log.error('interaction failed', { botId: this.botId, err })));
    client.on(Events.GuildCreate, (g) => void this.onGuildJoin(g));
    client.on(Events.GuildDelete, (g) => this.deps.repo.guildLeft(this.botId, g.id));
    client.on(Events.ShardDisconnect, (e) => this.deps.repo.logCode(this.botId, 'ERR-1006', { code: e.code }));
    client.on(Events.Error, (err) => log.error('discord client error', { botId: this.botId, err }));
    bindEvents(client, (ctx) => {
      // Status changes of bots go to plugins only (Custom Events see members).
      if (ctx.type === 'member_status' && ctx.user?.bot) {
        this.pluginEvent(ctx);
        return;
      }
      void this.runEvent(ctx);
      this.pluginEvent(ctx);
      this.countEvent(ctx);
    });
    bindModules(client, this.modules, () => this.timeSettings.timezone);
    try {
      await client.login(token);
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw err;
    }
    return client;
  }

  private async onReady(user: User, guilds: Guild[]): Promise<void> {
    log.info('bot ready', { botId: this.botId, user: user.tag, guilds: guilds.length });
    this.deps.repo.setBotIdentity(this.botId, user.username, user.id, user.displayAvatarURL());
    this.deps.repo.setBotStatus(this.botId, 'running');
    if (ROLE === 'main') this.deps.repo.logUpdate(this.botId, 'log.update.bot_started', { name: user.username });
    this.applyPresence();
    // The application owner (or team) gets private fix tips when a run fails.
    await user.client.application?.fetch().catch(() => undefined);
    await this.enforceGuildAccess();
    await this.syncGuilds();
    await this.registerCommands();
    void this.runEvent({ type: 'bot_ready', vars: {}, guild: null, channel: null, member: null, user: null });
    this.warnMissingIntents();
  }

  /** A new server: with closed invites the bot leaves it at once unless it is allowed. */
  private async onGuildJoin(g: Guild): Promise<void> {
    if (!(await this.leaveIfNotAllowed(g, this.deps.repo.guildAccess(this.botId)))) await this.syncGuilds();
  }

  /**
   * Closed invites (Bot → Invite in the dashboard): leaves every server that
   * is not on the allowed list. At start, on join and after bot.guild_access.
   */
  async enforceGuildAccess(): Promise<void> {
    const allowed = this.deps.repo.guildAccess(this.botId);
    const c = this.client;
    if (!allowed || !c) return;
    let left = false;
    for (const g of [...c.guilds.cache.values()]) left = (await this.leaveIfNotAllowed(g, allowed)) || left;
    if (left) await this.syncGuilds();
  }

  private async leaveIfNotAllowed(g: Guild, allowed: ReadonlySet<string> | null): Promise<boolean> {
    if (!allowed || allowed.has(g.id)) return false;
    try {
      await g.leave();
    } catch (err) {
      log.error('leave failed', { botId: this.botId, guild: g.id, err });
      return false;
    }
    this.deps.repo.guildLeft(this.botId, g.id);
    this.deps.repo.logUpdate(this.botId, 'log.update.guild_left_closed', { server: g.name, id: g.id });
    return true;
  }

  private async syncGuilds(): Promise<void> {
    const c = this.client;
    if (!c) return;
    this.deps.repo.syncGuilds(
      this.botId,
      [...c.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name, iconUrl: g.iconURL(), memberCount: g.memberCount })),
    );
  }

  // ---------- graphs ----------

  /** Reloads commands and events from the database (after bothub:events). */
  reloadGraphs(): void {
    this.modules?.invalidate();
    const disabled = this.deps.repo.disabledModules(this.botId);
    this.moderation.reload(disabled);
    this.commands.clear();
    for (const cmd of this.deps.repo.commands(this.botId, 'command')) {
      if (cmd.builtin && cmd.moduleKey && disabled.has(cmd.moduleKey)) continue;
      const s = settingsOf(cmd);
      const key = s.commandType === 'slash' ? s.name.trim().split(/\s+/).join(' ') : `${s.commandType}:${s.menuName}`;
      if (!this.commands.has(key)) this.commands.set(key, cmd);
    }
    this.events.clear();
    for (const ev of this.deps.repo.commands(this.botId, 'event')) {
      if (!ev.eventType) continue;
      const list = this.events.get(ev.eventType) ?? [];
      list.push(ev);
      this.events.set(ev.eventType, list);
    }
    this.reloadTimed();
    this.timed = [];
    for (const t of this.deps.repo.commands(this.botId, 'timed')) {
      const expr = String(t.graph.nodes.find((n) => n.type === 'trigger.timed')?.config.cron ?? '').trim();
      try {
        this.timed.push({ cmd: t, cron: parseCron(expr) });
      } catch {
        this.deps.repo.logCode(this.botId, 'ERR-1008', { event: t.name, reason: 'error.run.bad_cron' });
      }
    }
  }

  /** Sets the dashboard presence on Discord (on ready and after bot.presence). */
  applyPresence(): void {
    if (!this.client?.isReady()) return;
    this.presence.apply(this.client, parsePresence(this.deps.repo.presence(this.botId)), (text) => this.renderStatus(text));
  }

  /**
   * Placeholders of the status texts: bot counts, helpers ({random:1-10})
   * and Data Storage variables that have one value for all servers.
   */
  private renderStatus(text: string): string {
    const client = this.client;
    if (!client?.isReady() || !text.includes('{')) return text;
    const guilds = [...client.guilds.cache.values()];
    const values: Record<string, string> = {
      'bot.name': client.user.username,
      'bot.id': client.user.id,
      'bot.servers': String(guilds.length),
      'bot.members': String(guilds.reduce((n, g) => n + (g.memberCount || 0), 0)),
      'bot.channels': String(client.channels.cache.size),
    };
    const store = dataStore(this.deps.repo.db, this.botId);
    return text.replace(/\{([A-Za-z0-9_][A-Za-z0-9_.:-]{0,99})\}/g, (whole, name: string) => {
      if (name in values) return values[name]!;
      if (name.startsWith('var.')) {
        try {
          return store.get(name.slice(4), { guildId: '', userId: '', channelId: '' }) ?? whole;
        } catch {
          return whole;
        }
      }
      return helperValue(name) ?? whole;
    });
  }

  /**
   * Message Builder: sends a saved message (message_templates) to a channel
   * or a Discord webhook URL. Placeholders get the channel and server of the
   * target; buttons and menus are blocks, so a template has none.
   */
  /** Card Designer "Send a test": the card in a channel, drawn for the bot's own user. */
  async sendCard(cardId: number, target: string): Promise<void> {
    if (!this.client?.isReady()) throw new GraphError('error.bot.not_running');
    const channel = await this.client.channels.fetch(target).catch(() => null);
    if (!channel || !channel.isSendable()) throw new GraphError('error.run.channel_not_found', { value: target });
    const guild = 'guild' in channel ? (channel.guild as Guild) : null;
    const me = this.client.user;
    const vars = cardVars({
      guildName: guild?.name ?? 'Server', guildId: guild?.id ?? '', members: guild?.memberCount ?? 1, userId: me.id, userName: me.username,
      display: me.globalName ?? me.username, avatar: me.displayAvatarURL({ extension: 'png', size: 256 }), createdAt: me.createdTimestamp, joinedAt: guild?.members.me?.joinedTimestamp ?? null,
    });
    // Sample values (boosts, level, …) for what a test has no real value for.
    const r = await cardRenderer();
    const problems: string[] = [];
    const png = await renderCard(this.deps.repo.db, this.botId, cardId, { ...r.SAMPLE_VARS, ...vars }, problems);
    if (!png) throw new GraphError('error.card.unknown');
    // The test names pictures that could not be drawn (and why).
    const note = problems.length ? `\n⚠️ Not drawn:\n${problems.map((p) => `• ${p}`).join('\n')}`.slice(0, 1500) : '';
    await channel.send({ content: `🖼️ Card Designer test${note}`, files: [{ attachment: png, name: cardFile(png) }], allowedMentions: { parse: [] } });
  }

  async sendTemplate(templateId: number, target: string): Promise<void> {
    const row = this.deps.repo.db.prepare('SELECT message FROM message_templates WHERE id = ? AND bot_id = ?').get(templateId, this.botId) as { message: string } | undefined;
    if (!row) throw new GraphError('error.template.unknown');
    if (!this.client?.isReady()) throw new GraphError('error.bot.not_running');
    const node: GraphNode = { id: 'send', type: 'action.send_message', typeVersion: 1, config: { message: JSON.parse(row.message) as unknown } };
    const graph: Graph = { schemaVersion: 1, nodes: [node], edges: [] };

    if (target.startsWith('https://')) {
      const run = new Run(graph, this.engine, this.data({ runKey: 'template' }) as never, this.baseVars(null, null, null, null));
      const payload = buildMessage(run, node, () => '');
      if (!hasBody(payload)) throw new GraphError('error.run.empty_message');
      const res = await fetch(`${target}?wait=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new GraphError('error.template.webhook_failed', { status: res.status });
      return;
    }
    const channel = await this.client.channels.fetch(target).catch(() => null);
    if (!channel || !channel.isSendable()) throw new GraphError('error.run.channel_not_found', { value: target });
    const guild = 'guild' in channel ? (channel.guild as Guild) : null;
    const run = new Run(graph, this.engine, this.data({ runKey: 'template', guild, channel }) as never, this.baseVars(guild, channel, null, null));
    const payload = buildMessage(run, node, () => '');
    if (!hasBody(payload)) throw new GraphError('error.run.empty_message');
    await channel.send(payload as never);
  }

  /**
   * Graphs apply at once; the Discord command list is sent 2 s after the
   * last change, so quick toggles cause one registration, not a rate limit.
   */
  async reload(): Promise<void> {
    this.reloadGraphs();
    clearTimeout(this.registerTimer);
    this.registerTimer = setTimeout(() => {
      this.registerTimer = undefined;
      void this.registerCommands().catch((err) => log.warn('command registration failed', { botId: this.botId, err }));
    }, REGISTER_DEBOUNCE_MS);
    this.registerTimer.unref();
  }

  /** PUT the full command list; skipped when nothing changed. */
  private async registerCommands(): Promise<void> {
    const c = this.client;
    if (!c?.application) return;
    const body = buildCommands(
      [...this.commands.values()],
      (dropped) => this.deps.repo.logCode(this.botId, 'WAR-2008', { module: 'commands', problem: `Discord allows 100 commands; ${dropped} were not registered` }),
      this.deps.repo.moduleOn(this.botId, 'dm-commands'),
      { currencies: this.deps.repo.currencyChoices(this.botId) },
    );
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (hash === this.registeredHash) return;
    try {
      await c.rest.put(Routes.applicationCommands(c.application.id), { body });
      this.registeredHash = hash;
      log.info('commands registered', { botId: this.botId, count: body.length });
      this.deps.repo.logUpdate(this.botId, 'log.update.commands_sync_done');
    } catch (err) {
      this.deps.repo.logCode(this.botId, 'ERR-1003', { reason: (err as Error).message });
      log.error('command registration failed', { botId: this.botId, err });
    }
  }

  // ---------- running ----------

  private data(parts: Partial<DiscordData> & { runKey: string }): DiscordData {
    const { runKey, ...rest } = parts;
    return {
      client: this.client!,
      botId: this.botId,
      guild: null,
      channel: null,
      member: null,
      user: null,
      messages: new Map(),
      voice: this.voice,
      control: this.deps.control ? (op) => this.deps.control!(this.botId, op) : undefined,
      customId: (component: GraphNode) => `bh:${runKey}:${component.id}`,
      ...rest,
    };
  }

  private baseVars(guild: Guild | null, channel: SendableChannels | null, user: User | null, member: GuildMember | null): Vars {
    return {
      ...botVars(this.client?.user, this.client?.guilds.cache.size ?? 0),
      DEFAULT_SERVER: this.timeSettings.defaultGuildId ?? '',
      'bot.timezone': this.timeSettings.timezone,
      ...guildVars(guild),
      ...channelVars(channel),
      ...userVars(user, member),
    };
  }

  private async onInteraction(i: Interaction): Promise<void> {
    guardValue(i.token, 16 * 60_000);
    this.deps.repo.touchBot(this.botId);
    if (i.isChatInputCommand()) return this.onCommand(i, [i.commandName, i.options.getSubcommandGroup(false), i.options.getSubcommand(false)].filter(Boolean).join(' '));
    if (i.isUserContextMenuCommand()) return this.onCommand(i, `user:${i.commandName}`);
    if (i.isMessageContextMenuCommand()) return this.onCommand(i, `message:${i.commandName}`);
    // Plugin components and modals (custom_id p:…) go to their plugin.
    if (this.deps.plugins?.dispatchInteraction(this.botId, i)) return;
    if (i.isButton() || i.isStringSelectMenu()) return this.onComponent(i);
  }

  /**
   * DMs: allowed when the user is on one of the bot's servers and the
   * command's permissions allow them there (banned channels do not apply).
   */
  private async allowedInDm(p: Permissions, userId: string, pseudo: PseudoRoles): Promise<boolean> {
    const guilds = [...(this.client?.guilds.cache.values() ?? [])].slice(0, 50);
    for (const g of guilds) {
      const m = g.members.cache.get(userId) ?? (await g.members.fetch(userId).catch(() => null));
      if (m && !denied(p, m, null, pseudo)) return true;
    }
    return false;
  }

  private async onCommand(i: ChatInputCommandInteraction | UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction, key: string): Promise<void> {
    const cmd = this.commands.get(key);
    if (!cmd) {
      await i.reply({ content: 'This command is not available right now.', flags: 64 }).catch(() => undefined);
      return;
    }
    const s = settingsOf(cmd);
    const member = (i.member && 'roles' in i.member && typeof i.member.roles !== 'string' && 'cache' in i.member.roles ? i.member : null) as GuildMember | null;
    const pseudo = (id: string, m: GuildMember, ch: string | null) => this.moderation.hasPseudoRole(id, m, ch);
    // In DMs a member may use what they may use on one of the bot's servers.
    const allowed = i.guildId ? !denied(s.permissions, member, i.channelId, pseudo) : await this.allowedInDm(s.permissions, i.user.id, pseudo);
    if (!allowed) {
      await i.reply({ content: 'You are not allowed to use this command here.', flags: 64 }).catch(() => undefined);
      return;
    }
    const st = stats(this.deps.repo.db);
    st.add(this.botId, i.guildId, 'commands');
    st.add(this.botId, i.guildId, `cmd:${key}`);
    st.active(this.botId, i.guildId, i.user.id);
    if (s.cooldownType !== 'none') {
      const scope = s.cooldownType === 'global' ? '' : s.cooldownType === 'server' ? `g:${i.guildId ?? ''}` : `g:${i.guildId ?? ''}:u:${i.user.id}`;
      const until = this.deps.repo.cooldownUntil(cmd.id, scope);
      if (until > Date.now()) {
        await i.reply({ content: `Slow down! Try again <t:${Math.ceil(until / 1000)}:R>.`, flags: 64 }).catch(() => undefined);
        return;
      }
      this.deps.repo.setCooldown(cmd.id, scope, new Date(Date.now() + s.cooldownSeconds * 1000));
    }

    const channel = i.channel?.isSendable() ? i.channel : null;
    const vars: Vars = {
      ...this.baseVars(i.guild, channel, i.user, member),
      'command.name': cmd.name,
      'command.id': String(cmd.id),
      'command.subcommand': i.isChatInputCommand() ? (i.options.getSubcommand(false) ?? '') : '',
    };
    if (i.isChatInputCommand()) {
      for (const opt of optionNodes(cmd)) {
        const name = String(opt.config.name ?? '');
        // An optional option left out is empty text, so {option_reason} never shows up literally.
        const value = optionValue(i, opt.type, name) ?? '';
        vars[`option_${name}`] = value;
        const v = typeof opt.config.variable === 'string' ? opt.config.variable : '';
        if (v && !(v in vars)) vars[v] = value;
      }
    } else if (i.isUserContextMenuCommand()) {
      Object.assign(vars, userVars(i.targetUser, (i.targetMember as GuildMember | null) ?? null, 'target'));
    } else if (i.isMessageContextMenuCommand()) {
      Object.assign(vars, { 'message.id': i.targetMessage.id, 'message.content': i.targetMessage.content, 'message.url': i.targetMessage.url });
    }

    const runKey = randomUUID().slice(0, 12);
    const hideReplies = hideRepliesOf(s, vars);
    const d = this.data({ runKey, guild: i.guild, channel, member, user: i.user, interaction: i, hideReplies });
    const run = new Run(cmd.graph, this.engine, d as never, vars);
    this.begin(run, cmd, runKey, i.guild ? preflight(cmd.graph.nodes, i.guild.members.me, channel) : []);
    // Discord waits 3 seconds for an answer: slow blocks (loading games,
    // finding music) get a "thinking …" first; the reply then fills it.
    const defer = setTimeout(() => {
      if (!i.replied && !i.deferred) d.deferring = i.deferReply(hideReplies ? { flags: MessageFlags.Ephemeral } : {}).catch(() => undefined);
    }, AUTO_DEFER_MS);
    defer.unref();
    const result = await run.start();
    clearTimeout(defer);
    await d.deferring;
    this.keepIfInteractive(runKey, run, cmd, i.user.id);
    await this.finishInteraction(i, run, cmd, result);
  }

  private async onComponent(i: MessageComponentInteraction): Promise<void> {
    const [prefix, runKey, nodeId] = i.customId.split(':');
    if (prefix !== 'bh' || !runKey || !nodeId) return;
    const p = this.pending.get(runKey);
    if (!p || p.expires < Date.now()) {
      await i.reply({ content: 'This button has expired. Run the command again.', flags: 64 }).catch(() => undefined);
      return;
    }
    const node = p.run.node(nodeId);
    if (!node) return;
    if (node.config.only_invoker === true && p.invokerId && i.user.id !== p.invokerId) {
      await i.reply({ content: 'Only the person who used the command can use this.', flags: 64 }).catch(() => undefined);
      return;
    }
    const d = p.run.data as unknown as DiscordData;
    d.interaction = i as RepliableInteraction;
    // {clicker} is who pressed; {user} stays the member who ran the command.
    for (const [k, v] of Object.entries(userVars(i.user, (i.member as GuildMember | null) ?? null, 'clicker'))) p.run.vars.set(k, v);
    if (i.isStringSelectMenu()) {
      // The menu's next block is the option question; it reads __selected.
      p.run.vars.set('__selected', i.values.join('\u0000'));
      p.run.setResult(node, '', i.values.join(', '));
    }
    p.expires = Date.now() + PENDING_TTL_MS;
    const result = await p.run.continueFrom(node.id, 'next');
    await this.finishInteraction(i as RepliableInteraction, p.run, p.command, result, true);
  }

  /** Runs whose messages have buttons or menus wait for clicks. */
  private keepIfInteractive(runKey: string, run: Run, command: CommandRow, invokerId: string | null): void {
    const hasComponents = run.graph.nodes.some((n) => n.type === 'component.button' || n.type === 'component.select_menu');
    if (hasComponents) this.pending.set(runKey, { run, command, invokerId, expires: Date.now() + PENDING_TTL_MS });
  }

  private sweepPending(): void {
    const t = Date.now();
    for (const [k, p] of this.pending) if (p.expires < t) this.pending.delete(k);
  }

  /** Discord needs an answer within 3 s; answer when the graph did not. */
  private async finishInteraction(i: RepliableInteraction, run: Run, cmd: CommandRow, result: RunResult, component = false): Promise<void> {
    if (!result.ok) this.logRun(run, result.errorKey === 'error.run.too_many_steps' ? 'WAR-2005' : 'ERR-1005', { reason: reasonOf(result) }, cmd);
    const source = component ? (i.isStringSelectMenu() ? 'menu' : 'button') : i.isChatInputCommand() ? 'slash' : 'context_menu';
    const hint = this.afterRun(run, cmd, result, { source, user: i.user, guild: i.guild, channel: i.channel?.isSendable() ? i.channel : null });
    const fail = this.runMeta.get(run)?.fail ?? failConfig(cmd);
    // "When it fails": a friendly text, the reason, or nothing; the owner also gets a private fix tip.
    const failText = result.ok ? '✅' : fail.reply === 'reason' ? `❌ ${reasonText(result, hint)}` : fail.reply === 'none' ? '' : fail.message;
    const tip = !result.ok && this.isOwner(i.user.id) && !this.muted(cmd, result) ? ownerTip(result, hint) : '';
    const sendTip = async () => {
      if (tip) await i.followUp({ content: tip, flags: 64 }).catch(() => undefined);
    };
    // Deferred ("thinking …") but nothing answered: replace the loading state.
    if (i.deferred && !i.replied && !component) {
      if (failText) await i.editReply({ content: failText }).catch(() => undefined);
      else await i.deleteReply().catch(() => undefined);
      await sendTip();
      return;
    }
    if (i.replied || i.deferred) return sendTip();
    if (component && i.isMessageComponent()) {
      await i.deferUpdate().catch(() => undefined);
      return sendTip();
    }
    if (failText || tip) {
      await i.reply({ content: [failText, tip].filter(Boolean).join('\n\n').slice(0, 2000), flags: 64 }).catch(() => undefined);
      return;
    }
    // "Nothing": Discord still needs an answer; a hidden one that is removed at once.
    await i.deferReply({ flags: 64 }).then(() => i.deleteReply()).catch(() => undefined);
  }

  /** Playback settings of a run (trigger "When it fails", record playbacks). */
  private begin(run: Run, cmd: CommandRow, runKey: string, warnings: { node: string; text: string }[] = []): void {
    const fail = prepare(run, cmd);
    this.runMeta.set(run, { runKey, startVars: fail.record ? run.startVars() : {}, fail, warnings });
  }

  /** After a run (or a click): saves the playback and alerts the staff channel. */
  private afterRun(run: Run, cmd: CommandRow, result: RunResult, ctx: TraceContext): Hint | null {
    const hint = hintOf(result, this.deps.runErrors);
    const meta = this.runMeta.get(run);
    if (!meta) return hint;
    if (meta.fail.record) {
      try {
        this.deps.repo.saveTrace(traceOf(this.botId, cmd, meta.runKey, run, result, hint, { ...ctx, warnings: meta.warnings }, meta.startVars));
      } catch (err) {
        log.warn('playback not saved', { botId: this.botId, command: cmd.id, err });
      }
    }
    if (!result.ok && meta.fail.channel && !this.muted(cmd, result)) {
      const last = this.alerted.get(cmd.id) ?? 0;
      if (Date.now() - last > 60_000) {
        this.alerted.set(cmd.id, Date.now());
        void this.client?.channels
          .fetch(meta.fail.channel)
          .then(async (ch) => {
            if (ch?.isSendable()) await ch.send({ embeds: [alertEmbed(cmd, result, hint, ctx)], allowedMentions: { parse: [] } });
          })
          .catch(() => undefined);
      }
    }
    return hint;
  }

  private muted(cmd: CommandRow, result: RunResult): boolean {
    if (result.ok || !result.errorNode || !result.errorKey) return false;
    try {
      return this.deps.repo.errorMuted(cmd.id, result.errorNode.id, result.errorKey);
    } catch {
      return false;
    }
  }

  /** Custom events that wait for data an intent that is off never sends. */
  private warnMissingIntents(): void {
    const it = this.intents;
    if (!it) return;
    const need: [string, boolean, string][] = [['member_status', it.presence, 'Presence Intent'], ['thread_members', it.members, 'Server Members Intent']];
    for (const [type, on, name] of need) {
      const list = this.events.get(type) ?? [];
      if (!on && list.length) {
        this.deps.repo.logCode(this.botId, 'WAR-2008', { module: 'events', problem: `"${list.map((e) => e.name).join('", "')}" waits for ${type}, but the ${name} is off in the Discord Developer Portal (Bot → Privileged Gateway Intents).` });
      }
    }
  }

  private variableChanged(scope: string, scopeId: string, name: string, old: string, value: string): void {
    if (!this.client || !this.events.get('bot_variable_change')?.length) return;
    const guildId = scope === 'global' ? '' : scopeId.split(':')[0]!;
    const userId = scope === 'user' ? (scopeId.split(':')[1] ?? '') : '';
    const guild = (guildId ? this.client.guilds.cache.get(guildId) : null) ?? null;
    const member = guild && userId ? (guild.members.cache.get(userId) ?? null) : null;
    const user = member?.user ?? (userId ? (this.client.users.cache.get(userId) ?? null) : null);
    void this.runEvent({ type: 'bot_variable_change', vars: { 'variable.name': name, 'variable.old': old.slice(0, 1000), 'variable.new': value.slice(0, 1000), 'variable.scope': scope }, guild, channel: null, member, user });
  }

  /** The bot's owner in the Discord developer portal (or a member of its team). */
  private isOwner(userId: string): boolean {
    const o = this.client?.application?.owner;
    if (!o) return false;
    return 'members' in o ? o.members.has(userId) : o.id === userId;
  }

  /**
   * Takes one event run from the budgets (per server + event type, per bot,
   * running at the same time); logs (throttled) when one is used up.
   */
  private mayRun(kind: string, scope = ''): boolean {
    if (this.activeRuns >= MAX_ACTIVE_RUNS) {
      warn(this.modules, 'WAR-2008', { module: 'events', problem: `${MAX_ACTIVE_RUNS} event runs are already running, ${kind} was skipped` });
      return false;
    }
    if (scope) {
      let b = this.eventBudgets.get(scope);
      if (!b) {
        if (this.eventBudgets.size > 2000) this.eventBudgets.clear();
        this.eventBudgets.set(scope, (b = new Bucket(5, 10_000)));
      }
      if (!b.take()) {
        warn(this.modules, 'WAR-2008', { module: 'events', problem: `too many ${kind} runs in one server, some were skipped (limit 5 per 10 seconds)` });
        return false;
      }
    }
    if (this.runBudget.take()) return true;
    warn(this.modules, 'WAR-2008', { module: 'events', problem: `too many ${kind} runs, some were skipped (limit 20 per 10 seconds)` });
    return false;
  }

  // Voice minutes: when a member joined a voice channel (guild:user -> ms).
  private voiceSince = new Map<string, number>();

  /** Usage numbers of the overview (core/stats.ts). */
  private countEvent(ctx: EventContext): void {
    const s = stats(this.deps.repo.db);
    const guild = ctx.guild?.id;
    const user = ctx.user;
    if (!guild || !user || user.bot) return;
    switch (ctx.type) {
      case 'member_join':
        s.add(this.botId, guild, 'joins');
        break;
      case 'member_leave':
        s.add(this.botId, guild, 'leaves');
        break;
      case 'message_create':
        s.add(this.botId, guild, 'messages');
        s.active(this.botId, guild, user.id);
        break;
      case 'voice_join':
        this.voiceSince.set(`${guild}:${user.id}`, Date.now());
        s.active(this.botId, guild, user.id);
        break;
      case 'voice_leave': {
        const since = this.voiceSince.get(`${guild}:${user.id}`);
        this.voiceSince.delete(`${guild}:${user.id}`);
        if (since) s.add(this.botId, guild, 'voice_minutes', Math.round((Date.now() - since) / 60_000));
        break;
      }
    }
  }

  /** Runs a graph and counts it as active while it runs. */
  private async tracked(run: Run): Promise<RunResult> {
    this.activeRuns++;
    try {
      return await run.start();
    } finally {
      this.activeRuns--;
    }
  }

  /**
   * Hands an event to the bot's plugins (SDK "events"): catalog name
   * (shared/sdk-permissions.json discord.events) and a plain JSON payload
   * with the builder variable names; user.bot is a boolean.
   */
  private pluginEvent(ctx: EventContext): void {
    const plugins = this.deps.plugins;
    const name = PLUGIN_EVENTS[ctx.type];
    if (!plugins || !name) return;
    const payload: Record<string, unknown> = { ...this.baseVars(ctx.guild, ctx.channel, ctx.user, ctx.member), ...ctx.vars };
    for (const key of Object.keys(payload)) if (key === 'DEFAULT_SERVER' || key.startsWith('bot.')) delete payload[key];
    if (ctx.user) payload['user.bot'] = ctx.user.bot;
    if (name === 'voiceStateUpdate') payload['voice.action'] = ctx.type.slice(6); // join, leave, switch
    // Messages: does it mention this bot, which message does it answer (e.g. a chat bot that replies to mentions).
    if (ctx.message) {
      payload['message.mentions_bot'] = !!this.client?.user && ctx.message.mentions.users.has(this.client.user.id);
      payload['message.reply_to'] = ctx.message.reference?.messageId ?? '';
    }
    plugins.dispatchEvent(this.botId, name, payload);
  }

  private async runEvent(ctx: EventContext): Promise<void> {
    const list = this.events.get(ctx.type);
    if (!list?.length || !this.client) return;
    for (const ev of list) {
      if (!this.mayRun(`event ${ctx.type}`, `${ctx.guild?.id ?? 'dm'}:${ctx.type}`)) return;
      const runKey = randomUUID().slice(0, 12);
      const vars = { ...this.baseVars(ctx.guild, ctx.channel, ctx.user, ctx.member), ...ctx.vars, 'event.name': ev.name };
      const run = new Run(ev.graph, this.engine, this.data({ runKey, guild: ctx.guild, channel: ctx.channel, member: ctx.member, user: ctx.user, message: ctx.message }) as never, vars);
      this.begin(run, ev, runKey);
      const result = await this.tracked(run).catch((err: Error) => ({ ok: false, steps: [], errorKey: err.message }) as RunResult);
      this.keepIfInteractive(runKey, run, ev, null);
      this.afterRun(run, ev, result, { source: 'event', user: ctx.user, guild: ctx.guild, channel: ctx.channel });
      if (!result.ok) this.deps.repo.logCode(this.botId, 'ERR-1008', { event: ev.name, reason: reasonOf(result) });
    }
  }

  /** Reloads timed events, time zone and default server (after timed.changed). */
  reloadTimed(): void {
    const known = new Set(this.schedules.map((e) => e.id));
    const now = Date.now();
    this.schedules = this.deps.repo.timedEvents(this.botId);
    // An interval event created while the bot runs counts from now, not
    // from the bot start (else it would fire at once).
    if (this.startedMs) for (const e of this.schedules) if (!known.has(e.id) && e.lastRunAt === null) e.lastRunAt = now;
    this.timeSettings = this.deps.repo.timeSettings(this.botId);
  }

  /** Called every second: starts the custom events of each due timed event. */
  private checkSchedules(): void {
    const now = Date.now();
    const prev = this.lastCheckMs;
    this.lastCheckMs = now;
    if (!this.client?.isReady() || !handover.isLeader()) return;
    for (const ev of this.schedules) {
      if (!isDue(ev, prev, now, this.startedMs, this.timeSettings.timezone)) continue;
      ev.lastRunAt = now;
      this.deps.repo.setTimedLastRun(ev.id, new Date(now));
      void this.runSchedule(ev).catch((err) => log.error('timed event failed', { botId: this.botId, timedEvent: ev.id, err }));
    }
  }

  /**
   * Runs the custom events of type "timed" that picked this timed event
   * (trigger config timed_event). Server context: the default server.
   */
  async runSchedule(ev: TimedEvent): Promise<void> {
    const list = (this.events.get('timed') ?? []).filter((c) => String(c.graph.nodes.find((n) => n.type === 'trigger.event')?.config.timed_event ?? '') === String(ev.id));
    if (!list.length || !this.client) return;
    const guildId = this.timeSettings.defaultGuildId;
    const guild = guildId ? (this.client.guilds.cache.get(guildId) ?? null) : null;
    for (const cmd of list) {
      if (!this.mayRun('timed event', `${guild?.id ?? 'none'}:timed:${ev.id}`)) return;
      const runKey = randomUUID().slice(0, 12);
      const vars = {
        ...this.baseVars(guild, null, null, null),
        'event.name': cmd.name,
        'schedule.name': ev.name,
        'schedule.next': nextRun(ev, Date.now(), this.timeSettings.timezone),
      };
      const run = new Run(cmd.graph, this.engine, this.data({ runKey, guild }) as never, vars);
      this.begin(run, cmd, runKey);
      const result = await this.tracked(run).catch((err: Error) => ({ ok: false, steps: [], errorKey: err.message }) as RunResult);
      this.keepIfInteractive(runKey, run, cmd, null);
      this.afterRun(run, cmd, result, { source: 'timed', user: null, guild, channel: null });
      if (!result.ok) this.deps.repo.logCode(this.botId, 'ERR-1008', { event: cmd.name, reason: reasonOf(result) });
    }
  }

  /**
   * A webhook was called: runs the custom events of type "webhook" whose
   * trigger picked this webhook (config webhook = eventId) or none.
   */
  async runWebhook(call: WebhookCall): Promise<void> {
    if (!this.client?.isReady()) return;
    const list = (this.events.get('webhook') ?? []).filter((c) => {
      const picked = String(c.graph.nodes.find((n) => n.type === 'trigger.event')?.config.webhook ?? '');
      return picked === '' || picked === call.eventId;
    });
    if (!list.length) return;
    const guildId = this.timeSettings.defaultGuildId;
    const guild = guildId ? (this.client.guilds.cache.get(guildId) ?? null) : null;
    let json = '';
    try {
      json = JSON.stringify(JSON.parse(call.body));
    } catch {
      json = '';
    }
    const vars: Record<string, string> = {
      ...this.baseVars(guild, null, null, null),
      'webhook.name': call.name,
      'webhook.id': call.eventId,
      'webhook.body': String(call.body ?? '').slice(0, 4000),
      'webhook.json': json.slice(0, 4000),
    };
    for (const [k, v] of Object.entries(call.variables ?? {})) if (/^[A-Za-z0-9_]{1,32}$/.test(k)) vars[`webhook.${k}`] = String(v).slice(0, 1000);
    for (const cmd of list) {
      if (!this.mayRun('webhook', `${guild?.id ?? 'none'}:webhook:${call.eventId}`)) return;
      const runKey = randomUUID().slice(0, 12);
      const run = new Run(cmd.graph, this.engine, this.data({ runKey, guild }) as never, { ...vars, 'event.name': cmd.name });
      this.begin(run, cmd, runKey);
      const result = await this.tracked(run).catch((err: Error) => ({ ok: false, steps: [], errorKey: err.message }) as RunResult);
      this.keepIfInteractive(runKey, run, cmd, null);
      this.afterRun(run, cmd, result, { source: 'webhook', user: null, guild, channel: null });
      if (!result.ok) this.deps.repo.logCode(this.botId, 'ERR-1008', { event: cmd.name, reason: reasonOf(result) });
    }
  }

  /** Runs every timed event whose schedule matches this minute (no server context). */
  async runTimed(at: Date): Promise<void> {
    if (!this.client?.isReady()) return;
    for (const { cmd, cron } of this.timed) {
      if (!cronMatches(cron, at)) continue;
      const runKey = randomUUID().slice(0, 12);
      const vars = { ...this.baseVars(null, null, null, null), 'event.name': cmd.name };
      const run = new Run(cmd.graph, this.engine, this.data({ runKey }) as never, vars);
      this.begin(run, cmd, runKey);
      const result = await this.tracked(run).catch((err: Error) => ({ ok: false, steps: [], errorKey: err.message }) as RunResult);
      this.keepIfInteractive(runKey, run, cmd, null);
      this.afterRun(run, cmd, result, { source: 'timed', user: null, guild: null, channel: null });
      if (!result.ok) this.deps.repo.logCode(this.botId, 'ERR-1008', { event: cmd.name, reason: reasonOf(result) });
    }
  }

  /**
   * Due undo jobs (scheduled_jobs kind 'undo'): end of a temp ban or temp
   * role, undo of a deafen. A failed job is closed with its error key.
   */
  async runJobs(): Promise<void> {
    const c = this.client;
    // A slow run (many Discord calls) must not overlap the next tick: jobs would run twice.
    if (!c?.isReady() || this.jobsRunning || !handover.isLeader()) return;
    this.jobsRunning = true;
    try {
      await this.runDueJobs(c);
    } finally {
      this.jobsRunning = false;
    }
  }

  private async runDueJobs(c: Client<true>): Promise<void> {
    for (const job of this.deps.repo.dueJobs(this.botId, ['undo'], new Date())) {
      const p = job.payload;
      if (p.op === 'giveaway_end') {
        await endGiveaway(this.deps.repo, this.botId, c, String(p.guild ?? ''), String(p.message ?? '')).catch((err) => log.warn('giveaway end failed', { botId: this.botId, err: String(err) }));
        this.deps.repo.finishJob(job.id);
        continue;
      }
      const guild = c.guilds.cache.get(String(p.guild ?? ''));
      // Undo of Create Role / Create Thread: delete what the block made.
      if (p.op === 'delete_role' || p.op === 'delete_channel') {
        try {
          if (p.op === 'delete_role') await guild?.roles.delete(String(p.role ?? ''), 'Undo after');
          else await (await c.channels.fetch(String(p.channel ?? '')).catch(() => null))?.delete('Undo after');
          this.deps.repo.finishJob(job.id);
        } catch (err) {
          const code = (err as { code?: number }).code;
          this.deps.repo.finishJob(job.id, code === 10011 || code === 10003 ? null : 'error.run.discord');
        }
        continue;
      }
      const user = String(p.user ?? '');
      if (!guild || !user) {
        this.deps.repo.finishJob(job.id, 'error.run.server_not_found');
        continue;
      }
      try {
        switch (p.op) {
          case 'unban': {
            const handle = await this.moderation.begin({ guild, userId: user, moderatorId: c.user.id, action: 'unban', reason: 'Temporary ban expired', duration: '', auto: true });
            try {
              await guild.members.unban(user, 'Temporary ban expired');
            } catch (err) {
              handle.fail();
              throw err;
            }
            await handle.finish();
            break;
          }
          case 'remove_roles':
          case 'add_roles': {
            const roles = Array.isArray(p.roles) ? p.roles.map(String) : [];
            const m = await guild.members.fetch(user);
            await (p.op === 'remove_roles' ? m.roles.remove(roles, 'Temporary role expired') : m.roles.add(roles, 'Undo after'));
            break;
          }
          case 'deafen':
          case 'undeafen': {
            const m = await guild.members.fetch(user);
            if (m.voice.channelId) {
              await m.voice.setDeaf(p.op === 'deafen');
              await m.voice.setMute(p.op === 'deafen');
            }
            break;
          }
          default:
            this.deps.repo.finishJob(job.id, 'error.run.unsupported_option');
            continue;
        }
        this.deps.repo.finishJob(job.id);
      } catch (err) {
        // Unknown ban / member left: nothing left to undo.
        const code = (err as { code?: number }).code;
        this.deps.repo.finishJob(job.id, code === 10026 || code === 10007 ? null : 'error.run.discord');
        if (code !== 10026 && code !== 10007) this.deps.repo.logCode(this.botId, 'ERR-1008', { event: `undo ${String(p.op)}`, reason: (err as Error).message });
      }
    }
  }

  private logRun(run: Run, code: 'ERR-1005' | 'ERR-1007' | 'WAR-2005', params: Record<string, unknown>, cmd?: CommandRow): void {
    const command = cmd?.name ?? run.vars.get('command.name') ?? run.vars.get('event.name') ?? '';
    this.deps.repo.logCode(this.botId, code, { command, steps: this.deps.limits.maxSteps, ...params });
  }
}

/**
 * Which privileged intents the bot's application has on (Developer Portal,
 * flags of /applications/@me); null when Discord cannot be asked.
 */
export async function privilegedIntents(token: string): Promise<{ presence: boolean; members: boolean; messageContent: boolean } | null> {
  try {
    const res = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return intentsOf(Number((await res.json()).flags ?? 0));
  } catch {
    return null;
  }
}

/** Application flags: GATEWAY_PRESENCE(_LIMITED) 1<<12/13, GUILD_MEMBERS 1<<14/15, MESSAGE_CONTENT 1<<18/19. */
export function intentsOf(flags: number): { presence: boolean; members: boolean; messageContent: boolean } {
  const on = (a: number, b: number) => (flags & ((1 << a) | (1 << b))) !== 0;
  return { presence: on(12, 13), members: on(14, 15), messageContent: on(18, 19) };
}

/** Log reason of a failed run: the error key, plus the block's own message when there is one. */
function reasonOf(result: RunResult): string {
  const key = result.errorKey ?? '';
  return result.errorMessage ? `${key}: ${result.errorMessage}`.slice(0, 500) : key;
}

function optionNodes(cmd: CommandRow): GraphNode[] {
  const trig = cmd.graph.nodes.find((n) => n.type === 'trigger.slash');
  if (!trig) return [];
  const ids = new Set(cmd.graph.edges.filter((e) => e.to.node === trig.id && e.to.port === 'options').map((e) => e.from.node));
  return cmd.graph.nodes.filter((n) => ids.has(n.id));
}

function optionValue(i: ChatInputCommandInteraction, type: string, name: string): string | null {
  const o = i.options;
  switch (type) {
    case 'option.user':
      return o.getUser(name)?.id ?? null;
    case 'option.channel':
      return o.getChannel(name)?.id ?? null;
    case 'option.role':
      return o.getRole(name)?.id ?? null;
    case 'option.number': {
      const n = o.getNumber(name);
      return n === null ? null : String(n);
    }
    case 'option.attachment':
      return o.getAttachment(name)?.url ?? null;
    default:
      return o.getString(name);
  }
}

/** 93784000 -> "1d 2h 3m". */
export function formatUptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', `${m % 60}m`].filter(Boolean).join(' ');
}
