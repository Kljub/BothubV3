// Discord gateway events to custom event types (shared/events.json). Each
// entry names the event key and the placeholders it gives the blocks.
// Events not listed here are not delivered yet (music, polls, audit log,
// webhooks, timed and IFTTT come with their modules).

import { Events, type Client, type Guild, type GuildMember, type SendableChannels, type User, type Message, type PartialMessage } from 'discord.js';
import { channelVars, messageVars, roleVars, userVars, type Vars } from './vars.js';

export interface EventContext {
  type: string;
  vars: Vars;
  guild: Guild | null;
  channel: SendableChannels | null;
  member: GuildMember | null;
  user: User | null;
  message?: Message;
}

type Emit = (ctx: EventContext) => void;

function sendable(ch: unknown): SendableChannels | null {
  return ch && typeof (ch as { isSendable?: () => boolean }).isSendable === 'function' && (ch as { isSendable: () => boolean }).isSendable() ? (ch as SendableChannels) : null;
}

function fromMessage(type: string, m: Message | PartialMessage, extra: Vars = {}): EventContext {
  return {
    type,
    vars: { ...messageVars(m), ...extra },
    guild: m.guild,
    channel: sendable(m.channel),
    member: m.member ?? null,
    user: m.author ?? null,
    message: m.partial ? undefined : (m as Message),
  };
}

export function bindEvents(client: Client, emit: Emit): void {
  const own = (u: User | null | undefined) => !!u && u.id === client.user?.id;

  // --- members ---
  client.on(Events.GuildMemberAdd, (m) => emit({ type: 'member_join', vars: {}, guild: m.guild, channel: null, member: m, user: m.user }));
  client.on(Events.GuildMemberRemove, (m) =>
    emit({ type: 'member_leave', vars: {}, guild: m.guild, channel: null, member: m.partial ? null : (m as GuildMember), user: m.user }),
  );
  client.on(Events.GuildBanAdd, (b) => emit({ type: 'member_ban', vars: { reason: b.reason ?? '' }, guild: b.guild, channel: null, member: null, user: b.user }));
  client.on(Events.GuildBanRemove, (b) => emit({ type: 'member_unban', vars: {}, guild: b.guild, channel: null, member: null, user: b.user }));
  client.on(Events.GuildMemberUpdate, (before, after) => {
    const base = { guild: after.guild, channel: null, member: after, user: after.user };
    if (!before.partial) {
      for (const role of after.roles.cache.values()) if (!before.roles.cache.has(role.id)) emit({ type: 'member_role_add', vars: roleVars(role), ...base });
      for (const role of before.roles.cache.values()) if (!after.roles.cache.has(role.id)) emit({ type: 'member_role_remove', vars: roleVars(role), ...base });
      if (before.nickname !== after.nickname) {
        emit({ type: 'member_nickname', vars: { old_nickname: before.nickname ?? '', new_nickname: after.nickname ?? '' }, ...base });
      }
    }
    emit({ type: 'member_update', vars: {}, ...base });
  });

  // --- messages (the bot's own messages never start events: no loops) ---
  client.on(Events.MessageCreate, (m) => {
    if (own(m.author)) return;
    emit(fromMessage('message_create', m));
  });
  client.on(Events.MessageUpdate, (before, after) => {
    if (own(after.author) || before.content === after.content) return;
    emit(fromMessage('message_update', after, { old_content: before.content ?? '' }));
  });
  client.on(Events.MessageDelete, (m) => {
    if (own(m.author)) return;
    emit(fromMessage('message_delete', m));
  });

  // --- reactions ---
  const reaction = (type: string) => (r: { emoji: { id: string | null; toString(): string }; message: Message | PartialMessage }, u: User | { id: string; partial?: boolean }) => {
    if (u.id === client.user?.id) return;
    const ctx = fromMessage(type, r.message, { emoji: r.emoji.toString(), 'emoji.id': r.emoji.id ?? '' });
    ctx.user = 'username' in u ? (u as User) : null;
    Object.assign(ctx.vars, userVars(ctx.user));
    emit(ctx);
  };
  client.on(Events.MessageReactionAdd, reaction('reaction_add'));
  client.on(Events.MessageReactionRemove, reaction('reaction_remove'));

  // --- voice ---
  client.on(Events.VoiceStateUpdate, (before, after) => {
    const member = after.member ?? before.member;
    const base = { guild: after.guild, member: member ?? null, user: member?.user ?? null };
    if (!before.channelId && after.channelId) emit({ type: 'voice_join', vars: channelVars(after.channel), channel: sendable(after.channel), ...base });
    else if (before.channelId && !after.channelId) emit({ type: 'voice_leave', vars: channelVars(before.channel), channel: sendable(before.channel), ...base });
    else if (before.channelId !== after.channelId) {
      emit({ type: 'voice_switch', vars: { ...channelVars(after.channel), ...channelVars(before.channel, 'old_channel') }, channel: sendable(after.channel), ...base });
    }
    if (before.selfMute !== after.selfMute || before.serverMute !== after.serverMute) {
      emit({ type: after.mute ? 'voice_mute' : 'voice_unmute', vars: channelVars(after.channel), channel: sendable(after.channel), ...base });
    }
    if (before.selfDeaf !== after.selfDeaf || before.serverDeaf !== after.serverDeaf) {
      emit({ type: after.deaf ? 'voice_deafen' : 'voice_undeafen', vars: channelVars(after.channel), channel: sendable(after.channel), ...base });
    }
    if (!before.streaming && after.streaming) emit({ type: 'voice_stream_start', vars: channelVars(after.channel), channel: sendable(after.channel), ...base });
    if (before.streaming && !after.streaming) emit({ type: 'voice_stream_stop', vars: channelVars(after.channel), channel: sendable(after.channel), ...base });
  });

  // --- channels, threads, roles, invites ---
  const guildOnly = { channel: null, member: null, user: null };
  client.on(Events.ChannelCreate, (c) => emit({ type: 'channel_create', vars: channelVars(c), guild: c.guild, ...guildOnly }));
  client.on(Events.ChannelDelete, (c) => emit({ type: 'channel_delete', vars: channelVars(c), guild: 'guild' in c ? c.guild : null, ...guildOnly }));
  client.on(Events.ChannelUpdate, (before, after) => {
    const guild = 'guild' in after ? after.guild : null;
    emit({ type: 'channel_update', vars: channelVars(after), guild, ...guildOnly });
    const oldTopic = 'topic' in before ? (before.topic ?? '') : '';
    const newTopic = 'topic' in after ? (after.topic ?? '') : '';
    if (oldTopic !== newTopic) emit({ type: 'channel_topic', vars: { ...channelVars(after), old_topic: oldTopic, new_topic: newTopic }, guild, ...guildOnly });
  });
  const threadVars = (t: { id: string; name: string; parentId: string | null }) => ({ thread: t.name, 'thread.id': t.id, 'thread.name': t.name, 'thread.parent_id': t.parentId ?? '' });
  client.on(Events.ThreadCreate, (t) => emit({ type: 'thread_create', vars: threadVars(t), guild: t.guild, ...guildOnly }));
  client.on(Events.ThreadDelete, (t) => emit({ type: 'thread_delete', vars: threadVars(t), guild: t.guild, ...guildOnly }));
  client.on(Events.ThreadUpdate, (_b, t) => emit({ type: 'thread_update', vars: threadVars(t), guild: t.guild, ...guildOnly }));
  client.on(Events.GuildRoleCreate, (r) => emit({ type: 'role_create', vars: roleVars(r), guild: r.guild, ...guildOnly }));
  client.on(Events.GuildRoleDelete, (r) => emit({ type: 'role_delete', vars: roleVars(r), guild: r.guild, ...guildOnly }));
  client.on(Events.GuildRoleUpdate, (_b, r) => emit({ type: 'role_update', vars: roleVars(r), guild: r.guild, ...guildOnly }));
  client.on(Events.InviteCreate, (inv) =>
    emit({
      type: 'invite_create',
      vars: { 'invite.code': inv.code, 'invite.url': inv.url, ...userVars(inv.inviter, null, 'inviter') },
      guild: inv.guild && 'members' in inv.guild ? (inv.guild as Guild) : null,
      ...guildOnly,
    }),
  );
  client.on(Events.InviteDelete, (inv) =>
    emit({ type: 'invite_delete', vars: { 'invite.code': inv.code, 'invite.url': inv.url }, guild: inv.guild && 'members' in inv.guild ? (inv.guild as Guild) : null, ...guildOnly }),
  );

  // --- the bot itself ---
  client.on(Events.GuildCreate, (g) => emit({ type: 'bot_guild_join', vars: {}, guild: g, ...guildOnly }));
  client.on(Events.GuildDelete, (g) => emit({ type: 'bot_guild_leave', vars: { server: g.name ?? '', 'server.id': g.id }, guild: null, ...guildOnly }));
  client.on(Events.GuildUpdate, (_b, g) => emit({ type: 'guild_update', vars: {}, guild: g, ...guildOnly }));
}
