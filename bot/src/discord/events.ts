// Discord gateway events to custom event types (shared/events.json). Each
// entry names the event key and the placeholders it gives the blocks.
// Webhooks, timed events and IFTTT start their runs elsewhere; music events
// come from the music player (MUSIC_EVENT).

import { AuditLogEvent, Events, GuildScheduledEventStatus, type Client, type Guild, type GuildMember, type GuildScheduledEvent, type PartialGuildScheduledEvent, type SendableChannels, type User, type Message, type PartialMessage } from 'discord.js';
import { MUSIC_EVENT, type MusicEvent } from './music.js';
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
      if (before.pending && !after.pending) emit({ type: 'member_screening', vars: {}, ...base });
      // Server boosts: premiumSince is set while the member boosts.
      const boost = { boosts: String(after.guild.premiumSubscriptionCount ?? 0), boost_level: String(after.guild.premiumTier) };
      if (!before.premiumSince && after.premiumSince) emit({ type: 'boost_start', vars: boost, ...base });
      if (before.premiumSince && !after.premiumSince) emit({ type: 'boost_stop', vars: boost, ...base });
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
  client.on(Events.MessageReactionRemoveAll, (m) => emit(fromMessage('reaction_remove_all', m)));
  client.on(Events.MessageReactionRemoveEmoji, (r) => emit(fromMessage('reaction_remove_emoji', r.message, { emoji: r.emoji.toString(), 'emoji.id': r.emoji.id ?? '' })));

  // --- typing, pins (Discord tells only that the pins changed: the newest pin is read) ---
  client.on(Events.TypingStart, (t) => {
    if (own(t.user as User) || !t.guild) return;
    const user = t.user.partial ? null : (t.user as User);
    emit({ type: 'typing_start', vars: { ...channelVars(t.channel), ...userVars(user, t.member ?? null) }, guild: t.guild, channel: sendable(t.channel), member: t.member ?? null, user });
  });
  const lastPin = new Map<string, string>();
  client.on(Events.ChannelPinsUpdate, async (ch) => {
    const guild = 'guild' in ch ? (ch.guild as Guild) : null;
    if (!guild) return;
    emit({ type: 'channel_pins', vars: channelVars(ch), guild, channel: sendable(ch), member: null, user: null });
    if (!('messages' in ch)) return;
    const pins = await (ch as { messages: { fetchPinned(): Promise<Map<string, Message>> } }).messages.fetchPinned().catch(() => null);
    const newest = pins ? [...pins.values()][0] : undefined;
    if (newest && lastPin.get(ch.id) !== newest.id) {
      const had = lastPin.has(ch.id);
      lastPin.set(ch.id, newest.id);
      // The first update after a start only learns the current pin.
      if (had || Date.now() - (newest.editedTimestamp ?? newest.createdTimestamp) < 60_000) emit(fromMessage('message_pin', newest));
    }
  });

  // --- presence (needs the Presence intent in the Developer Portal) ---
  client.on(Events.PresenceUpdate, (before, after) => {
    if (!after.guild || !after.member) return;
    const old = before?.status ?? 'offline';
    if (old === after.status) return;
    emit({ type: 'member_status', vars: { old_status: old, new_status: after.status }, guild: after.guild, channel: null, member: after.member, user: after.member.user });
  });

  // --- polls ---
  const vote = (type: string) => async (answer: { id: number; text: string | null; poll: { message: Message | PartialMessage } }, userId: string) => {
    const msg = answer.poll.message;
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user || own(user)) return;
    const ctx = fromMessage(type, msg, { 'poll.answer': answer.text ?? '', 'poll.answer_id': String(answer.id) });
    ctx.user = user;
    ctx.member = msg.guild?.members.cache.get(userId) ?? null;
    Object.assign(ctx.vars, userVars(user, ctx.member));
    emit(ctx);
  };
  client.on(Events.MessagePollVoteAdd, vote('poll_vote_add') as never);
  client.on(Events.MessagePollVoteRemove, vote('poll_vote_remove') as never);

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
    const perms = (c: unknown) => JSON.stringify((c as { permissionOverwrites?: { cache: Map<string, { allow: { bitfield: bigint }; deny: { bitfield: bigint } }> } }).permissionOverwrites?.cache
      ? [...(c as { permissionOverwrites: { cache: Map<string, { allow: { bitfield: bigint }; deny: { bitfield: bigint } }> } }).permissionOverwrites.cache].map(([id, o]) => `${id}:${o.allow.bitfield}:${o.deny.bitfield}`).sort()
      : []);
    if (perms(before) !== perms(after)) emit({ type: 'channel_permissions', vars: channelVars(after), guild, ...guildOnly });
    const oldTopic = 'topic' in before ? (before.topic ?? '') : '';
    const newTopic = 'topic' in after ? (after.topic ?? '') : '';
    if (oldTopic !== newTopic) emit({ type: 'channel_topic', vars: { ...channelVars(after), old_topic: oldTopic, new_topic: newTopic }, guild, ...guildOnly });
  });
  const threadVars = (t: { id: string; name: string; parentId: string | null }) => ({ thread: t.name, 'thread.id': t.id, 'thread.name': t.name, 'thread.parent_id': t.parentId ?? '' });
  client.on(Events.ThreadCreate, (t) => emit({ type: 'thread_create', vars: threadVars(t), guild: t.guild, ...guildOnly }));
  client.on(Events.ThreadDelete, (t) => emit({ type: 'thread_delete', vars: threadVars(t), guild: t.guild, ...guildOnly }));
  client.on(Events.ThreadUpdate, (_b, t) => emit({ type: 'thread_update', vars: threadVars(t), guild: t.guild, ...guildOnly }));
  client.on(Events.ThreadMembersUpdate, (added, removed, t) => {
    for (const [action, list] of [['join', added], ['leave', removed]] as const) {
      for (const tm of [...list.values()].slice(0, 10)) {
        const user = tm.user ?? null;
        if (own(user)) continue;
        emit({ type: 'thread_members', vars: { ...threadVars(t), ...userVars(user, tm.guildMember ?? null), 'thread_member.action': action }, guild: t.guild, channel: sendable(t), member: tm.guildMember ?? null, user });
      }
    }
  });
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

  // --- scheduled events (Discord's server events) ---
  const scheduledVars = (ev: GuildScheduledEvent | PartialGuildScheduledEvent) => ({
    'scheduled_event.id': ev.id,
    'scheduled_event.name': ev.name ?? '',
    'scheduled_event.url': ev.url,
    'scheduled_event.start': ev.scheduledStartTimestamp ? `<t:${Math.floor(ev.scheduledStartTimestamp / 1000)}:F>` : '',
  });
  client.on(Events.GuildScheduledEventCreate, (ev) => emit({ type: 'scheduled_create', vars: scheduledVars(ev), guild: ev.guild, ...guildOnly }));
  client.on(Events.GuildScheduledEventDelete, (ev) => emit({ type: 'scheduled_delete', vars: scheduledVars(ev), guild: ev.guild, ...guildOnly }));
  client.on(Events.GuildScheduledEventUpdate, (before, ev) => {
    emit({ type: 'scheduled_update', vars: scheduledVars(ev), guild: ev.guild, ...guildOnly });
    if (before && before.status !== ev.status) {
      const S = GuildScheduledEventStatus;
      const type = ev.status === S.Active ? 'scheduled_start' : ev.status === S.Completed ? 'scheduled_end' : ev.status === S.Canceled ? 'scheduled_cancel' : '';
      if (type) emit({ type, vars: scheduledVars(ev), guild: ev.guild, ...guildOnly });
    }
  });
  const rsvp = (type: string) => (ev: GuildScheduledEvent | PartialGuildScheduledEvent, user: User) =>
    emit({ type, vars: { ...scheduledVars(ev), ...userVars(user, ev.guild?.members.cache.get(user.id) ?? null) }, guild: ev.guild, channel: null, member: ev.guild?.members.cache.get(user.id) ?? null, user });
  client.on(Events.GuildScheduledEventUserAdd, rsvp('scheduled_user_add'));
  client.on(Events.GuildScheduledEventUserRemove, rsvp('scheduled_user_remove'));

  // --- auto moderation ---
  const ruleVars = (r: { id: string; name: string }) => ({ 'rule.id': r.id, 'rule.name': r.name });
  client.on(Events.AutoModerationActionExecution, (a) => {
    const user = a.member?.user ?? client.users.cache.get(a.userId) ?? null;
    emit({
      type: 'automod_action',
      vars: { ...(a.autoModerationRule ? ruleVars(a.autoModerationRule) : { 'rule.id': a.ruleId, 'rule.name': '' }), content: a.content ?? '', matched: a.matchedKeyword ?? a.matchedContent ?? '', ...channelVars(a.channel ?? null), ...userVars(user, a.member ?? null) },
      guild: a.guild,
      channel: sendable(a.channel),
      member: a.member ?? null,
      user,
    });
  });
  client.on(Events.AutoModerationRuleCreate, (r) => emit({ type: 'automod_rule_create', vars: ruleVars(r), guild: r.guild, ...guildOnly }));
  client.on(Events.AutoModerationRuleUpdate, (_b, r) => emit({ type: 'automod_rule_update', vars: ruleVars(r), guild: r.guild, ...guildOnly }));
  client.on(Events.AutoModerationRuleDelete, (r) => emit({ type: 'automod_rule_delete', vars: ruleVars(r), guild: r.guild, ...guildOnly }));

  // --- audit log (needs "View Audit Log" on the server) ---
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    const action = (AuditLogEvent as unknown as Record<number, string>)[entry.action] ?? String(entry.action);
    emit({
      type: 'audit_entry',
      vars: { 'audit.action': action, 'audit.executor': entry.executorId ? `<@${entry.executorId}>` : '', 'audit.executor_id': entry.executorId ?? '', 'audit.target_id': entry.targetId ?? '', 'audit.reason': entry.reason ?? '' },
      guild,
      ...guildOnly,
    });
  });

  // --- commands, stickers, stage ---
  client.on(Events.ApplicationCommandPermissionsUpdate, (d) => {
    const g = client.guilds.cache.get(d.guildId);
    const cmd = client.application?.commands.cache.get(d.id);
    if (g) emit({ type: 'app_command_permissions', vars: { 'command.id': d.id, 'command.name': cmd?.name ?? '' }, guild: g, ...guildOnly });
  });
  const stickerVars = (s: { id: string; name: string }) => ({ 'sticker.id': s.id, 'sticker.name': s.name });
  client.on(Events.GuildStickerCreate, (s) => s.guild && emit({ type: 'sticker_create', vars: stickerVars(s), guild: s.guild, ...guildOnly }));
  client.on(Events.GuildStickerUpdate, (_b, s) => s.guild && emit({ type: 'sticker_update', vars: stickerVars(s), guild: s.guild, ...guildOnly }));
  client.on(Events.GuildStickerDelete, (s) => s.guild && emit({ type: 'sticker_delete', vars: stickerVars(s), guild: s.guild, ...guildOnly }));
  const stage = (type: string) => (s: { topic: string; channel: unknown; guild: Guild | null }) =>
    s.guild && emit({ type, vars: { 'stage.topic': s.topic, ...channelVars(s.channel as never) }, guild: s.guild, channel: null, member: null, user: null });
  client.on(Events.StageInstanceCreate, stage('stage_start'));
  client.on(Events.StageInstanceUpdate, (_b, s) => stage('stage_update')(s));
  client.on(Events.StageInstanceDelete, stage('stage_end'));

  // --- music (from the player, see music.ts) and its listeners ---
  client.on(MUSIC_EVENT as never, (ev: MusicEvent) => {
    const guild = client.guilds.cache.get(ev.guildId) ?? null;
    if (!guild) return;
    const member = ev.userId ? (guild.members.cache.get(ev.userId) ?? null) : null;
    const user = member?.user ?? (ev.userId ? (client.users.cache.get(ev.userId) ?? null) : null);
    emit({ type: ev.type, vars: { ...ev.vars, ...userVars(user, member) }, guild, channel: null, member, user });
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    const me = after.guild.members.me?.voice.channelId;
    const member = after.member ?? before.member;
    if (!me || !member || member.user.bot) return;
    if (after.channelId === me && before.channelId !== me) emit({ type: 'music_listener_join', vars: channelVars(after.channel), guild: after.guild, channel: sendable(after.channel), member, user: member.user });
    if (before.channelId === me && after.channelId !== me) emit({ type: 'music_listener_leave', vars: channelVars(before.channel), guild: after.guild, channel: sendable(before.channel), member, user: member.user });
  });

  // --- the bot itself ---
  client.on(Events.GuildCreate, (g) => emit({ type: 'bot_guild_join', vars: {}, guild: g, ...guildOnly }));
  client.on(Events.GuildDelete, (g) => emit({ type: 'bot_guild_leave', vars: { server: g.name ?? '', 'server.id': g.id }, guild: null, ...guildOnly }));
  client.on(Events.GuildUpdate, (before, g) => {
    emit({ type: 'guild_update', vars: {}, guild: g, ...guildOnly });
    if (before.premiumTier !== g.premiumTier) {
      emit({ type: g.premiumTier > before.premiumTier ? 'boost_level_up' : 'boost_level_down', vars: { boost_level: String(g.premiumTier), boosts: String(g.premiumSubscriptionCount ?? 0) }, guild: g, ...guildOnly });
    }
  });
  client.on(Events.UserUpdate, (_b, u) => {
    if (u.id !== client.user?.id) return;
    // The bot's own profile: every server it is on gets the event.
    for (const g of client.guilds.cache.values()) emit({ type: 'bot_updated', vars: { 'bot.name': u.username }, guild: g, ...guildOnly });
  });
}
