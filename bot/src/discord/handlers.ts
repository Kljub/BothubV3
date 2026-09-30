// Blocks that talk to Discord. Every API call counts against the run limit.
// Blocks that are not here yet fail with error.run.unsupported_block and go
// to the error handler, so a graph never silently does half of its work.

import {
  MessageFlags,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type RepliableInteraction,
  type SendableChannels,
  type User,
} from 'discord.js';
import { GraphError, type Handler, type Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { parseDuration, snowflake, snowflakes } from '../graph/util.js';
import type { CaseAction, ModCase, Repo } from '../core/repo.js';
import { buildMessage, hasBody } from './message.js';
import { actionName, type CaseHandle, type Moderation } from './moderation.js';

/** What a run knows about where it runs (run.data). */
export interface DiscordData {
  client: Client;
  botId: number;
  guild: Guild | null;
  channel: SendableChannels | null;
  member: GuildMember | null;
  user: User | null;
  interaction?: RepliableInteraction;
  /** Message that started the run (message events). */
  message?: Message;
  hideReplies?: boolean;
  /** custom_id for a button or menu block of this run. */
  customId(component: GraphNode): string;
  /** Messages sent by this run, by block variable ({Var1}). */
  messages: Map<string, Message>;
}

export function data(run: Run): DiscordData {
  return run.data as unknown as DiscordData;
}

async function guildOf(run: Run, node: GraphNode): Promise<Guild> {
  const d = data(run);
  const id = run.str(node, 'guild').trim();
  if (id) {
    run.countDiscordCall();
    const g = await d.client.guilds.fetch(snowflake(id, 'guild')).catch(() => null);
    if (!g) throw new GraphError('error.run.server_not_found', { value: id });
    return g;
  }
  if (!d.guild) throw new GraphError('error.run.needs_server');
  return d.guild;
}

async function memberOf(run: Run, node: GraphNode, key = 'user'): Promise<GuildMember> {
  const guild = await guildOf(run, node);
  const id = snowflake(run.str(node, key), key);
  run.countDiscordCall();
  const m = await guild.members.fetch(id).catch(() => null);
  if (!m) throw new GraphError('error.run.member_not_found', { value: id });
  return m;
}

async function channelOf(run: Run, value: string, field: string): Promise<SendableChannels> {
  const d = data(run);
  run.countDiscordCall();
  const ch = await d.client.channels.fetch(snowflake(value, field)).catch(() => null);
  if (!ch || !ch.isSendable()) throw new GraphError('error.run.channel_not_found', { value });
  return ch;
}

/** A message reference: a block variable, a message link, "channel/message" or an ID in this channel. */
async function messageOf(run: Run, node: GraphNode, key: string): Promise<Message> {
  const d = data(run);
  const rawValue = String(run.raw(node, key) ?? '').trim();
  const known = d.messages.get(rawValue);
  if (known) return known;
  const value = run.render(rawValue);
  const link = /channels\/(?:\d+|@me)\/(\d{17,20})\/(\d{17,20})/.exec(value) ?? /^(\d{17,20})[/-](\d{17,20})$/.exec(value);
  let channel: SendableChannels | null = d.channel;
  let id = value;
  if (link) {
    channel = await channelOf(run, link[1]!, key);
    id = link[2]!;
  } else if (!d.message || value !== d.message.id) {
    id = snowflake(value, key);
  } else {
    return d.message;
  }
  if (!channel || !('messages' in channel)) throw new GraphError('error.run.message_not_found', { value });
  run.countDiscordCall();
  const msg = await channel.messages.fetch(id).catch(() => null);
  if (!msg) throw new GraphError('error.run.message_not_found', { value });
  return msg;
}

/** "**#12** Ban · <@123> · reason · 3 days ago" */
function caseLine(c: ModCase): string {
  const when = `<t:${Math.floor(Date.parse(c.createdAt) / 1000)}:R>`;
  const dur = c.duration ? ` (${c.duration})` : '';
  return `**#${c.number}** ${actionName(c.action, c.duration)}${dur} · <@${c.userId}> · ${c.reason || '–'} · ${when}`;
}

function reason(run: Run, node: GraphNode): string | undefined {
  return run.str(node, 'reason').slice(0, 512) || undefined;
}

/** Discord errors become run errors with the Discord message. */
async function discord<T>(run: Run, call: () => Promise<T>): Promise<T> {
  run.countDiscordCall();
  try {
    return await call();
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 50013) throw new GraphError('error.run.missing_permissions', { message: e.message });
    throw new GraphError('error.run.discord', { message: e.message ?? String(err), code: e.code });
  }
}

async function sendMessage(node: GraphNode, run: Run): Promise<void> {
  const d = data(run);
  const payload = buildMessage(run, node, d.customId) as Record<string, unknown> & { flags?: number };
  if (!hasBody(payload)) throw new GraphError('error.run.empty_message');
  if (run.bool(node, 'silent')) payload.flags = (payload.flags ?? 0) | MessageFlags.SuppressNotifications;
  const mentions = String(run.raw(node, 'mentions') ?? 'all');
  if (mentions !== 'all') payload.allowedMentions = mentions === 'none' ? { parse: [] } : { parse: ['users'] };
  const target = String(run.raw(node, 'target') ?? 'reply');

  let sent: Message | undefined;
  switch (target) {
    case 'reply': {
      const i = d.interaction;
      if (!i) throw new GraphError('error.run.no_interaction');
      const ephemeral = run.bool(node, 'ephemeral') || d.hideReplies;
      if (ephemeral) payload.flags = (payload.flags ?? 0) | MessageFlags.Ephemeral;
      sent = await discord(run, async () => {
        if (i.replied || i.deferred) return i.followUp({ ...payload, fetchReply: true } as never) as Promise<Message>;
        const res = await i.reply({ ...payload, withResponse: true } as never);
        return (res as unknown as { resource?: { message?: Message } }).resource?.message as Message;
      });
      break;
    }
    case 'reply_message': {
      const to = await messageOf(run, node, 'reply_to');
      sent = await discord(run, () => to.reply(payload as never));
      break;
    }
    case 'command_channel':
      if (!d.channel) throw new GraphError('error.run.no_channel');
      sent = await discord(run, () => d.channel!.send(payload as never) as Promise<Message>);
      break;
    case 'channel': {
      const ch = await channelOf(run, run.str(node, 'channel'), 'channel');
      sent = await discord(run, () => ch.send(payload as never) as Promise<Message>);
      break;
    }
    case 'dm': {
      const id = snowflake(run.str(node, 'user'), 'user');
      const user = await discord(run, () => d.client.users.fetch(id));
      sent = await discord(run, () => user.send(payload as never));
      break;
    }
    case 'edit': {
      const msg = await messageOf(run, node, 'edit_message');
      sent = await discord(run, () => msg.edit(payload as never));
      break;
    }
    default:
      throw new GraphError('error.run.unsupported_option', { value: target });
  }

  if (sent) {
    const variable = typeof node.config.variable === 'string' ? node.config.variable : '';
    if (variable) d.messages.set(variable, sent);
    run.setResult(node, '', sent.id);
    run.setResult(node, '.id', sent.id);
    run.setResult(node, '.url', sent.url);
    const after = run.str(node, 'delete_after');
    if (after) {
      const msg = sent;
      setTimeout(() => void msg.delete().catch(() => undefined), Math.min(parseDuration(after), 24 * 3_600_000)).unref();
    }
  }
}

/** Who did it: the member who ran the command, else the bot. */
function moderatorOf(run: Run): string | null {
  const d = data(run);
  return d.interaction ? (d.user?.id ?? null) : (d.client.user?.id ?? null);
}

export function discordHandlers(repo: Repo, mod?: Moderation): Map<string, Handler> {
  const guildId = (run: Run) => data(run).guild?.id ?? run.vars.get('server.id') ?? '';
  const NO_CASE: CaseHandle = { number: null, finish: async () => undefined, fail: () => undefined };

  /**
   * Runs a moderation action as a case (moderation module): case and direct
   * message first, the Discord call, then log and automatic punishments.
   * Role and voice changes only count when a command changes someone else.
   */
  async function asCase<T>(run: Run, node: GraphNode, guild: Guild, userId: string, action: CaseAction, duration: string, call: () => Promise<T>): Promise<T> {
    const d = data(run);
    const soft = action.startsWith('role_') || action.startsWith('voice_');
    const skip = !mod || (soft && (!d.interaction || d.user?.id === userId));
    const handle = skip ? NO_CASE : await mod.begin({ guild, userId, moderatorId: moderatorOf(run), action, reason: run.str(node, 'reason'), duration });
    let out: T;
    try {
      out = await call();
    } catch (err) {
      handle.fail();
      throw err;
    }
    if (handle.number !== null) run.setResult(node, '.case', handle.number);
    await handle.finish();
    return out;
  }

  /** undo_after of a block: a durable job (scheduled_jobs), runs after a restart too. */
  const undoAfter = (run: Run, node: GraphNode, payload: Record<string, unknown>, key: string | null): void => {
    const after = run.str(node, 'undo_after').trim();
    if (!after) return;
    if (key) repo.cancelJobs(data(run).botId, key);
    repo.addJob(data(run).botId, 'undo', new Date(Date.now() + parseDuration(after)), payload, key);
  };

  return new Map<string, Handler>([
    ['action.send_message', sendMessage],
    [
      'action.delete_message',
      async (node, run) => {
        const msg = await messageOf(run, node, 'message');
        const delay = Number(run.raw(node, 'delay') ?? 0);
        if (delay > 0) await run.pause(Math.min(delay, 900) * 1000);
        await discord(run, () => msg.delete());
      },
    ],
    [
      'action.react_message',
      async (node, run) => {
        const msg = await messageOf(run, node, 'message');
        const emojis = run.str(node, 'emojis').split(/\s+/).filter(Boolean).slice(0, 20);
        const mode = String(run.raw(node, 'reaction_mode') ?? 'add');
        if (mode === 'remove_all') return void (await discord(run, () => msg.reactions.removeAll()));
        for (const e of emojis) {
          if (mode === 'add') await discord(run, () => msg.react(e));
          else {
            const reaction = msg.reactions.cache.find((r) => r.emoji.name === e || r.emoji.toString() === e || r.emoji.id === e);
            if (!reaction) continue;
            const who = mode === 'remove_bot' ? data(run).client.user!.id : snowflake(run.str(node, 'user'), 'user');
            await discord(run, () => reaction.users.remove(who));
          }
        }
      },
    ],
    [
      'action.pin_message',
      async (node, run) => {
        const msg = await messageOf(run, node, 'message');
        await discord(run, () => (run.bool(node, 'unpin') ? msg.unpin() : msg.pin()));
      },
    ],
    [
      'action.add_roles',
      async (node, run) => {
        const m = await memberOf(run, node);
        const roles = snowflakes(run.str(node, 'roles'), 'roles');
        await asCase(run, node, m.guild, m.id, 'role_add', run.str(node, 'undo_after'), () => discord(run, () => m.roles.add(roles, reason(run, node))));
        undoAfter(run, node, { op: 'remove_roles', guild: m.guild.id, user: m.id, roles }, `temprole:${m.guild.id}:${m.id}:${roles.join(',')}`);
      },
    ],
    [
      'action.remove_roles',
      async (node, run) => {
        const m = await memberOf(run, node);
        const roles = snowflakes(run.str(node, 'roles'), 'roles');
        await asCase(run, node, m.guild, m.id, 'role_remove', run.str(node, 'undo_after'), () => discord(run, () => m.roles.remove(roles, reason(run, node))));
        undoAfter(run, node, { op: 'add_roles', guild: m.guild.id, user: m.id, roles }, null);
      },
    ],
    [
      'action.kick',
      async (node, run) => {
        const m = await memberOf(run, node);
        await asCase(run, node, m.guild, m.id, 'kick', '', () => discord(run, () => m.kick(reason(run, node))));
      },
    ],
    [
      'action.ban',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = snowflake(run.str(node, 'user'), 'user');
        let del = String(run.raw(node, 'delete_messages') ?? 'none');
        if (del === 'none' && mod) del = mod.banDeleteDefault();
        const seconds = del === 'none' ? 0 : parseDuration(del) / 1000;
        const temp = run.str(node, 'undo_after').trim();
        await asCase(run, node, guild, id, 'ban', temp, () => discord(run, () => guild.members.ban(id, { reason: reason(run, node), deleteMessageSeconds: seconds })));
        undoAfter(run, node, { op: 'unban', guild: guild.id, user: id }, `tempban:${guild.id}:${id}`);
      },
    ],
    [
      'action.unban',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = snowflake(run.str(node, 'user'), 'user');
        await asCase(run, node, guild, id, 'unban', '', () => discord(run, () => guild.members.unban(id, reason(run, node))));
        repo.cancelJobs(data(run).botId, `tempban:${guild.id}:${id}`);
      },
    ],
    [
      'action.timeout',
      async (node, run) => {
        const m = await memberOf(run, node);
        const text = run.str(node, 'duration');
        const ms = text ? parseDuration(text) : null; // empty = remove the timeout
        if (ms !== null && ms > 28 * 86_400_000) throw new GraphError('error.run.timeout_too_long', { max: '28d' });
        await asCase(run, node, m.guild, m.id, ms === null ? 'untimeout' : 'timeout', text, () => discord(run, () => m.timeout(ms, reason(run, node))));
      },
    ],
    [
      'action.change_nickname',
      async (node, run) => {
        const m = await memberOf(run, node);
        await discord(run, () => m.setNickname(run.str(node, 'nickname').slice(0, 32) || null, reason(run, node)));
      },
    ],
    [
      'action.mute_member',
      async (node, run) => {
        const m = await memberOf(run, node);
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        const mute = run.bool(node, 'mute') || run.raw(node, 'mute') === undefined;
        await asCase(run, node, m.guild, m.id, mute ? 'voice_mute' : 'voice_unmute', run.str(node, 'undo_after'), () => discord(run, () => m.voice.setMute(mute, reason(run, node))));
        const after = run.str(node, 'undo_after');
        if (after) {
          // In-process timer like delete_after: lost on restart, max. 24 h.
          setTimeout(() => void m.voice.setMute(!mute).catch(() => undefined), Math.min(parseDuration(after), 24 * 3_600_000)).unref();
        }
      },
    ],
    [
      'action.voice_kick',
      async (node, run) => {
        const m = await memberOf(run, node);
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        await asCase(run, node, m.guild, m.id, 'voice_kick', '', () => discord(run, () => m.voice.disconnect(reason(run, node))));
      },
    ],
    [
      'action.deafen_member',
      async (node, run) => {
        const m = await memberOf(run, node);
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        const deaf = run.bool(node, 'deafen') || run.raw(node, 'deafen') === undefined;
        const after = run.str(node, 'undo_after');
        // Like BotGhost's voice deaf: server deafen and server mute together.
        await asCase(run, node, m.guild, m.id, deaf ? 'voice_deafen' : 'voice_undeafen', after, () =>
          discord(run, async () => {
            await m.voice.setDeaf(deaf, reason(run, node));
            return m.voice.setMute(deaf, reason(run, node));
          }),
        );
        undoAfter(run, node, { op: deaf ? 'undeafen' : 'deafen', guild: m.guild.id, user: m.id }, null);
      },
    ],
    [
      'action.edit_channel',
      async (node, run) => {
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = await data(run).client.channels.fetch(snowflake(value, 'channel')).catch(() => null);
        if (!ch || !('edit' in ch) || ch.isDMBased()) throw new GraphError('error.run.channel_not_found', { value });
        const edit: Record<string, unknown> = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 100);
        const topic = run.str(node, 'topic');
        if (topic) edit.topic = topic.slice(0, 1024);
        // Slowmode in seconds, or a duration like 10s / 5m / 1h.
        const slow = run.str(node, 'slowmode').trim();
        if (slow !== '') {
          const seconds = /^\d+$/.test(slow) ? Number(slow) : parseDuration(slow) / 1000;
          edit.rateLimitPerUser = Math.max(0, Math.min(21_600, Math.trunc(seconds)));
        }
        if (node.config.nsfw !== undefined) edit.nsfw = run.bool(node, 'nsfw');
        await discord(run, () => (ch as { edit(o: Record<string, unknown>): Promise<unknown> }).edit(edit));
      },
    ],
    [
      'action.list_bans',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const bans = await discord(run, () => guild.bans.fetch({ limit: 1000 }));
        const list = [...bans.values()];
        run.setResult(node, '', list.map((b, i) => `${i + 1}. ${b.user.username} (${b.user.id})${b.reason ? ` – ${b.reason}` : ''}`).join('\n'));
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.purge_messages',
      async (node, run) => {
        const value = run.str(node, 'channel');
        const ch = value ? await channelOf(run, value, 'channel') : data(run).channel;
        if (!ch || !('bulkDelete' in ch)) throw new GraphError('error.run.no_channel');
        const amount = Math.max(1, Math.min(100, Math.trunc(run.num(node, 'amount'))));
        const fetched = await discord(run, () => ch.messages.fetch({ limit: 100 }));
        const from = run.str(node, 'from_user');
        const contains = run.str(node, 'contains').toLowerCase();
        const keepPinned = run.bool(node, 'keep_pinned') || run.raw(node, 'keep_pinned') === undefined;
        const list = [...fetched.values()]
          .filter((m) => !(keepPinned && m.pinned))
          .filter((m) => !from || m.author.id === from)
          .filter((m) => !run.bool(node, 'bots_only') || m.author.bot)
          .filter((m) => !contains || m.content.toLowerCase().includes(contains))
          .slice(0, amount);
        const deleted = await discord(run, () => ch.bulkDelete(list, true));
        run.setResult(node, '', deleted.size);
      },
    ],
    // --- moderation data ---
    [
      'action.warn',
      async (node, run) => {
        const m = await memberOf(run, node);
        // Stored inside the case, so automatic punishments count this warning.
        const id = await asCase(run, node, m.guild, m.id, 'warn', '', async () =>
          repo.addWarning(data(run).botId, m.guild.id, m.id, moderatorOf(run), run.str(node, 'reason')),
        );
        run.setResult(node, '', id);
        run.setResult(node, '.count', repo.warnings(data(run).botId, m.guild.id, m.id).length);
      },
    ],
    [
      'action.list_warnings',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = repo.warnings(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
        run.setResult(node, '', list.map((w, i) => `${i + 1}. ${w.reason || '–'}`).join('\n'));
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.clear_warnings',
      async (node, run) => {
        const guild = await guildOf(run, node);
        repo.clearWarnings(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
      },
    ],
    // --- moderation: cases and notes ---
    [
      'action.mod_case_get',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const n = Math.trunc(run.num(node, 'case'));
        const c = repo.modCase(data(run).botId, guild.id, n);
        if (!c) throw new GraphError('error.run.case_not_found', { value: n });
        run.setResult(node, '', caseLine(c));
        run.setResult(node, '.user', c.userId);
        run.setResult(node, '.moderator', c.moderatorId ?? '');
        run.setResult(node, '.action', actionName(c.action, c.duration));
        run.setResult(node, '.reason', c.reason);
        run.setResult(node, '.duration', c.duration);
        run.setResult(node, '.date', `<t:${Math.floor(Date.parse(c.createdAt) / 1000)}:f>`);
      },
    ],
    [
      'action.mod_case_remove',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const n = Math.trunc(run.num(node, 'case'));
        if (!repo.removeCase(data(run).botId, guild.id, n)) throw new GraphError('error.run.case_not_found', { value: n });
      },
    ],
    [
      'action.mod_history',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = repo.cases(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
        // Newest 25, so the text fits a message.
        run.setResult(node, '', list.slice(-25).map(caseLine).join('\n'));
        run.setResult(node, '.count', list.length);
        for (const a of ['warn', 'timeout', 'kick', 'ban'] as const) run.setResult(node, `.${a}s`, list.filter((c) => c.action === a).length);
      },
    ],
    [
      'action.mod_history_clear',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const user = snowflake(run.str(node, 'user'), 'user');
        const n = repo.clearCases(data(run).botId, guild.id, user);
        // Warnings belong to the history; automatic punishments start again from 0.
        repo.clearWarnings(data(run).botId, guild.id, user);
        run.setResult(node, '', n);
      },
    ],
    [
      'action.mod_note_add',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const text = run.str(node, 'note').trim();
        if (!text) throw new GraphError('error.run.empty_note');
        run.setResult(node, '', repo.addNote(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'), data(run).user?.id ?? null, text));
      },
    ],
    [
      'action.mod_note_remove',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = Math.trunc(run.num(node, 'note'));
        if (!repo.removeNote(data(run).botId, guild.id, id)) throw new GraphError('error.run.note_not_found', { value: id });
      },
    ],
    [
      'action.mod_notes',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = repo.notes(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
        run.setResult(node, '', list.map((n) => `**#${n.id}** ${n.content}${n.authorId ? ` – <@${n.authorId}>` : ''}`).join('\n'));
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.lock_channel',
      async (node, run) => {
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = await data(run).client.channels.fetch(snowflake(value, 'channel')).catch(() => null);
        if (!ch || ch.isDMBased() || !('permissionOverwrites' in ch)) throw new GraphError('error.run.channel_not_found', { value });
        const lock = run.bool(node, 'lock') || run.raw(node, 'lock') === undefined;
        // @everyone: deny Send Messages (and in threads), or back to "not set".
        const allow = lock ? false : null;
        await discord(run, () =>
          ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: allow, SendMessagesInThreads: allow, CreatePublicThreads: allow }, { reason: reason(run, node) }),
        );
      },
    ],
    // --- economy (default currency) ---
    ['action.economy_get', (node, run) => run.setResult(node, '', repo.balance(data(run).botId, guildId(run), snowflake(run.str(node, 'user'), 'user')))],
    ['action.economy_add', (node, run) => void repo.changeBalance(data(run).botId, guildId(run), snowflake(run.str(node, 'user'), 'user'), run.num(node, 'amount'), 'add')],
    ['action.economy_remove', (node, run) => void repo.changeBalance(data(run).botId, guildId(run), snowflake(run.str(node, 'user'), 'user'), -run.num(node, 'amount'), 'add')],
    ['action.economy_set', (node, run) => void repo.changeBalance(data(run).botId, guildId(run), snowflake(run.str(node, 'user'), 'user'), run.num(node, 'amount'), 'set')],
    [
      'action.economy_pay',
      (node, run) => {
        const ok = repo.pay(data(run).botId, guildId(run), snowflake(run.str(node, 'from_user'), 'from_user'), snowflake(run.str(node, 'to_user'), 'to_user'), Math.trunc(run.num(node, 'amount')));
        if (!ok) throw new GraphError('error.run.not_enough_balance');
      },
    ],
    [
      'action.economy_leaderboard',
      (node, run) => {
        const limit = Math.max(1, Math.min(25, Math.trunc(Number(run.raw(node, 'limit') ?? 10))));
        const rows = repo.leaderboard(data(run).botId, guildId(run), limit);
        run.setResult(node, '', rows.map((r, i) => `${i + 1}. <@${r.userId}> – ${r.balance}`).join('\n'));
      },
    ],
  ]);
}
