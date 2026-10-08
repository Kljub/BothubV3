// Audit Log (module "auditlog", Security): a configurable log of what
// happens on the server, posted as embeds into a log channel (or one channel
// per event group). Who did it comes from Discord's audit log when the bot
// may read it (View Audit Log); without it the entry just has no "by".
//
// Groups and events (settings keys): messages (messageDelete, messageEdit,
// imageDelete, bulkDelete, invites), members (memberJoin, memberLeave,
// roleAdd, roleRemove, timeout, nickname, ban, unban), roles (roleCreate,
// roleUpdate, roleDelete), channels (channelCreate, channelUpdate,
// channelDelete), emojis (emojiCreate, emojiUpdate, emojiDelete), voice
// (voiceJoin, voiceLeave, voiceMove), server (serverUpdate, threadCreate,
// threadDelete). Ignored channels and roles are left out.

import { AuditLogEvent, Events, type Client, type Guild, type GuildMember, type Message, type PartialGuildMember, type PartialMessage, type User } from 'discord.js';
import { idIn, idsIn, type ModuleContext } from './context.js';
import { send } from './guard.js';

const KEY = 'auditlog';

type Group = 'messages' | 'members' | 'roles' | 'channels' | 'emojis' | 'voice' | 'server';

interface AuditConfig {
  logChannel: unknown;
  perGroup: boolean;
  messagesChannel: unknown; membersChannel: unknown; rolesChannel: unknown; channelsChannel: unknown; emojisChannel: unknown; voiceChannel: unknown; serverChannel: unknown;
  ignoredChannels: unknown;
  ignoredRoles: unknown;
  showAvatar: boolean;
  newAccountDays: number;
  [event: string]: unknown;
}

const COLORS = { add: 0x22c55e, remove: 0xef4444, change: 0xf59e0b, info: 0x5865f2 };

/** Defaults: everything on except the noisy voice events. */
const DEFAULT_OFF = new Set(['voiceJoin', 'voiceLeave', 'voiceMove', 'serverUpdate', 'threadCreate', 'threadDelete']);

export function eventOn(cfg: Partial<AuditConfig>, event: string): boolean {
  const v = cfg[event];
  return v === undefined ? !DEFAULT_OFF.has(event) : v === true;
}

/** Where a group's entries go: its own channel (per group on), else the log channel. */
export function channelFor(cfg: Partial<AuditConfig>, group: Group, guildId: string): string | null {
  if (cfg.perGroup) {
    const own = idIn(cfg[`${group}Channel`], guildId);
    if (own) return own;
  }
  return idIn(cfg.logChannel, guildId);
}

/** Short text for a log line: no mentions, at most n characters. */
export function clip(text: string | null | undefined, n = 1000): string {
  const t = (text ?? '').replace(/@(everyone|here)/g, '@​$1').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || '*(empty)*';
}

interface Entry {
  group: Group;
  event: string;
  title: string;
  color: number;
  lines: [string, string][];
  text?: string;
  user?: User | null;
  channelId?: string | null;
  member?: GuildMember | PartialGuildMember | null;
}

async function post(ctx: ModuleContext, guild: Guild, e: Entry): Promise<void> {
  if (!ctx.enabled(KEY)) return;
  const cfg = ctx.config<AuditConfig>(KEY);
  if (!eventOn(cfg, e.event)) return;
  if (e.channelId && idsIn(cfg.ignoredChannels, guild.id).includes(e.channelId)) return;
  const ignoredRoles = idsIn(cfg.ignoredRoles, guild.id);
  if (e.member && ignoredRoles.length && 'roles' in e.member && e.member.roles.cache.some((r) => ignoredRoles.includes(r.id))) return;
  const target = channelFor(cfg, e.group, guild.id);
  const ch = target ? guild.channels.cache.get(target) : null;
  if (!ch?.isSendable()) return;
  const embed: Record<string, unknown> = {
    color: e.color,
    title: e.title.slice(0, 256),
    description: e.text ? e.text.slice(0, 4000) : undefined,
    fields: e.lines.filter(([, v]) => v).slice(0, 20).map(([name, value]) => ({ name: name.slice(0, 256), value: value.slice(0, 1024), inline: value.length < 40 })),
    timestamp: new Date().toISOString(),
  };
  if (e.user) {
    embed.author = { name: `${e.user.tag ?? e.user.username}`.slice(0, 256), icon_url: e.user.displayAvatarURL() };
    embed.footer = { text: `ID: ${e.user.id}` };
    if (cfg.showAvatar !== false && (e.event === 'memberJoin' || e.event === 'memberLeave')) embed.thumbnail = { url: e.user.displayAvatarURL({ size: 256 }) };
  }
  await send(ctx, KEY, ch, { embeds: [embed], allowedMentions: { parse: [] } });
}

/** Who did it: the newest audit log entry of this type for the target (last 10 s). */
async function executor(guild: Guild, type: AuditLogEvent, targetId: string): Promise<string> {
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  const hit = logs?.entries.find((x) => x.targetId === targetId && Date.now() - x.createdTimestamp < 10_000);
  return hit?.executorId ? `<@${hit.executorId}>${hit.reason ? ` · ${clip(hit.reason, 200)}` : ''}` : '';
}

const age = (t: number) => `<t:${Math.floor(t / 1000)}:R>`;

export function bindAuditLog(client: Client, ctx: ModuleContext): void {
  const on = <A extends unknown[]>(fn: (...a: A) => Promise<void> | void) => (...a: A) => {
    if (!ctx.enabled(KEY)) return;
    Promise.resolve(fn(...a)).catch(() => undefined);
  };

  // --- messages ---
  client.on(Events.MessageDelete, on(async (m: Message | PartialMessage) => {
    if (!m.guild || m.author?.bot) return;
    const images = [...m.attachments.values()].filter((a) => a.contentType?.startsWith('image/'));
    const base = { channelId: m.channelId, user: m.author ?? null, member: m.member };
    await post(ctx, m.guild, {
      ...base, group: 'messages', event: 'messageDelete', color: COLORS.remove,
      title: `🗑️ Message deleted in #${'name' in m.channel ? m.channel.name : ''}`,
      text: m.partial ? '*The message was sent before the bot started: its text is unknown.*' : clip(m.content, 3500),
      lines: [['Channel', `<#${m.channelId}>`], ['Author', m.author ? `<@${m.author.id}>` : ''], ['Sent', age(m.createdTimestamp)]],
    });
    for (const img of images.slice(0, 3)) {
      await post(ctx, m.guild, { ...base, group: 'messages', event: 'imageDelete', color: COLORS.remove, title: '🖼️ Image deleted', lines: [['Channel', `<#${m.channelId}>`], ['File', `[${img.name}](${img.proxyURL})`]] });
    }
  }));
  client.on(Events.MessageUpdate, on(async (before: Message | PartialMessage, after: Message | PartialMessage) => {
    if (!after.guild || after.author?.bot || before.content === after.content || before.partial) return;
    await post(ctx, after.guild, {
      group: 'messages', event: 'messageEdit', color: COLORS.change, channelId: after.channelId, user: after.author ?? null, member: after.member,
      title: '✏️ Message edited', lines: [['Before', clip(before.content, 1000)], ['After', clip(after.content, 1000)], ['Channel', `<#${after.channelId}>`], ['Jump', `[to the message](${after.url})`]],
    });
  }));
  client.on(Events.MessageBulkDelete, on(async (msgs, channel) => {
    if (!('guild' in channel)) return;
    const lines = [...msgs.values()].reverse().slice(0, 30).map((m) => `**${m.author?.username ?? '?'}:** ${clip(m.content, 120)}`);
    await post(ctx, channel.guild, { group: 'messages', event: 'bulkDelete', color: COLORS.remove, channelId: channel.id, title: `🧹 ${msgs.size} messages deleted`, text: lines.join('\n'), lines: [['Channel', `<#${channel.id}>`]] });
  }));
  client.on(Events.InviteCreate, on(async (inv) => {
    if (!inv.guild || !('channels' in inv.guild)) return;
    await post(ctx, inv.guild as Guild, {
      group: 'messages', event: 'invites', color: COLORS.info, user: inv.inviter ?? null, channelId: inv.channelId,
      title: '🔗 Invite created', lines: [['Code', inv.code], ['Channel', inv.channelId ? `<#${inv.channelId}>` : ''], ['Uses', inv.maxUses ? String(inv.maxUses) : '∞'], ['Expires', inv.expiresTimestamp ? age(inv.expiresTimestamp) : 'never']],
    });
  }));

  // --- members ---
  client.on(Events.GuildMemberAdd, on(async (m: GuildMember) => {
    const cfg = ctx.config<AuditConfig>(KEY);
    const days = Math.max(0, Number(cfg.newAccountDays ?? 3) || 0);
    const fresh = days > 0 && Date.now() - m.user.createdTimestamp < days * 86_400_000;
    await post(ctx, m.guild, {
      group: 'members', event: 'memberJoin', color: fresh ? COLORS.change : COLORS.add, user: m.user, member: m,
      title: fresh ? '📥 Member joined · ⚠️ new account' : '📥 Member joined',
      lines: [['Member', `<@${m.id}>`], ['Account created', age(m.user.createdTimestamp)], ['Members', String(m.guild.memberCount)]],
    });
  }));
  client.on(Events.GuildMemberRemove, on(async (m: GuildMember | PartialGuildMember) => {
    const kickedBy = await executor(m.guild, AuditLogEvent.MemberKick, m.id);
    await post(ctx, m.guild, {
      group: 'members', event: 'memberLeave', color: COLORS.remove, user: m.user, member: m,
      title: kickedBy ? '👢 Member kicked' : '📤 Member left',
      lines: [['Member', `<@${m.id}>`], ['Joined', m.joinedTimestamp ? age(m.joinedTimestamp) : ''], ['Roles', 'roles' in m && m.roles ? m.roles.cache.filter((r) => r.id !== m.guild.id).map((r) => `<@&${r.id}>`).join(' ').slice(0, 1000) : ''], ['By', kickedBy]],
    });
  }));
  client.on(Events.GuildMemberUpdate, on(async (before: GuildMember | PartialGuildMember, after: GuildMember) => {
    if (before.partial) return;
    const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
    const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
    const by = added.size || removed.size ? await executor(after.guild, AuditLogEvent.MemberRoleUpdate, after.id) : '';
    if (added.size) await post(ctx, after.guild, { group: 'members', event: 'roleAdd', color: COLORS.add, user: after.user, member: after, title: '➕ Role given', lines: [['Member', `<@${after.id}>`], ['Roles', added.map((r) => `<@&${r.id}>`).join(' ')], ['By', by]] });
    if (removed.size) await post(ctx, after.guild, { group: 'members', event: 'roleRemove', color: COLORS.remove, user: after.user, member: after, title: '➖ Role taken', lines: [['Member', `<@${after.id}>`], ['Roles', removed.map((r) => `<@&${r.id}>`).join(' ')], ['By', by]] });
    if (before.nickname !== after.nickname) {
      await post(ctx, after.guild, { group: 'members', event: 'nickname', color: COLORS.change, user: after.user, member: after, title: '🏷️ Nickname changed', lines: [['Member', `<@${after.id}>`], ['Before', clip(before.nickname ?? before.user.username, 100)], ['After', clip(after.nickname ?? after.user.username, 100)]] });
    }
    const was = before.communicationDisabledUntilTimestamp ?? 0;
    const now = after.communicationDisabledUntilTimestamp ?? 0;
    if (was !== now && (now > Date.now() || was > Date.now())) {
      const timedOut = now > Date.now();
      await post(ctx, after.guild, {
        group: 'members', event: 'timeout', color: timedOut ? COLORS.change : COLORS.add, user: after.user, member: after,
        title: timedOut ? '🔇 Member timed out' : '🔊 Timeout ended', lines: [['Member', `<@${after.id}>`], ['Until', timedOut ? age(now) : ''], ['By', await executor(after.guild, AuditLogEvent.MemberUpdate, after.id)]],
      });
    }
  }));
  client.on(Events.GuildBanAdd, on(async (ban) => {
    await post(ctx, ban.guild, { group: 'members', event: 'ban', color: COLORS.remove, user: ban.user, title: '🔨 Member banned', lines: [['Member', `<@${ban.user.id}>`], ['Reason', clip(ban.reason, 500)], ['By', await executor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id)]] });
  }));
  client.on(Events.GuildBanRemove, on(async (ban) => {
    await post(ctx, ban.guild, { group: 'members', event: 'unban', color: COLORS.add, user: ban.user, title: '🕊️ Member unbanned', lines: [['Member', `<@${ban.user.id}>`], ['By', await executor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id)]] });
  }));

  // --- roles ---
  client.on(Events.GuildRoleCreate, on(async (r) => {
    await post(ctx, r.guild, { group: 'roles', event: 'roleCreate', color: COLORS.add, title: '🎭 Role created', lines: [['Role', `<@&${r.id}> (${clip(r.name, 100)})`], ['By', await executor(r.guild, AuditLogEvent.RoleCreate, r.id)]] });
  }));
  client.on(Events.GuildRoleDelete, on(async (r) => {
    await post(ctx, r.guild, { group: 'roles', event: 'roleDelete', color: COLORS.remove, title: '🎭 Role deleted', lines: [['Role', clip(r.name, 100)], ['By', await executor(r.guild, AuditLogEvent.RoleDelete, r.id)]] });
  }));
  client.on(Events.GuildRoleUpdate, on(async (b, r) => {
    const changes: [string, string][] = [];
    if (b.name !== r.name) changes.push(['Name', `${clip(b.name, 100)} → ${clip(r.name, 100)}`]);
    if (b.hexColor !== r.hexColor) changes.push(['Colour', `${b.hexColor} → ${r.hexColor}`]);
    if (b.permissions.bitfield !== r.permissions.bitfield) {
      const gained = r.permissions.toArray().filter((p) => !b.permissions.has(p));
      const lost = b.permissions.toArray().filter((p) => !r.permissions.has(p));
      if (gained.length) changes.push(['Permissions added', gained.join(', ')]);
      if (lost.length) changes.push(['Permissions removed', lost.join(', ')]);
    }
    if (b.hoist !== r.hoist) changes.push(['Shown separately', String(r.hoist)]);
    if (b.mentionable !== r.mentionable) changes.push(['Mentionable', String(r.mentionable)]);
    if (!changes.length) return; // position changes only
    await post(ctx, r.guild, { group: 'roles', event: 'roleUpdate', color: COLORS.change, title: '🎭 Role changed', lines: [['Role', `<@&${r.id}>`], ...changes, ['By', await executor(r.guild, AuditLogEvent.RoleUpdate, r.id)]] });
  }));

  // --- channels ---
  client.on(Events.ChannelCreate, on(async (c) => {
    await post(ctx, c.guild, { group: 'channels', event: 'channelCreate', color: COLORS.add, channelId: c.id, title: '📁 Channel created', lines: [['Channel', `<#${c.id}> (${clip(c.name, 100)})`], ['By', await executor(c.guild, AuditLogEvent.ChannelCreate, c.id)]] });
  }));
  client.on(Events.ChannelDelete, on(async (c) => {
    if (!('guild' in c)) return;
    await post(ctx, c.guild, { group: 'channels', event: 'channelDelete', color: COLORS.remove, title: '📁 Channel deleted', lines: [['Channel', clip(c.name, 100)], ['By', await executor(c.guild, AuditLogEvent.ChannelDelete, c.id)]] });
  }));
  client.on(Events.ChannelUpdate, on(async (b, c) => {
    if (!('guild' in c) || !('guild' in b)) return;
    const changes: [string, string][] = [];
    if (b.name !== c.name) changes.push(['Name', `${clip(b.name, 100)} → ${clip(c.name, 100)}`]);
    const topic = (x: unknown) => ('topic' in (x as object) ? ((x as { topic: string | null }).topic ?? '') : '');
    if (topic(b) !== topic(c)) changes.push(['Topic', `${clip(topic(b), 400)} → ${clip(topic(c), 400)}`]);
    const slow = (x: unknown) => ('rateLimitPerUser' in (x as object) ? Number((x as { rateLimitPerUser: number | null }).rateLimitPerUser ?? 0) : 0);
    if (slow(b) !== slow(c)) changes.push(['Slowmode', `${slow(b)} s → ${slow(c)} s`]);
    const nsfw = (x: unknown) => ('nsfw' in (x as object) ? Boolean((x as { nsfw: boolean }).nsfw) : false);
    if (nsfw(b) !== nsfw(c)) changes.push(['NSFW', String(nsfw(c))]);
    const perms = (x: unknown) => ('permissionOverwrites' in (x as object) ? (x as { permissionOverwrites: { cache: Map<string, { allow: { bitfield: bigint }; deny: { bitfield: bigint } }> } }).permissionOverwrites.cache : new Map());
    const pb = perms(b);
    const pc = perms(c);
    if ([...pc].some(([id, o]) => pb.get(id)?.allow.bitfield !== o.allow.bitfield || pb.get(id)?.deny.bitfield !== o.deny.bitfield) || [...pb.keys()].some((id) => !pc.has(id))) changes.push(['Permissions', 'changed']);
    if (!changes.length) return;
    await post(ctx, c.guild, { group: 'channels', event: 'channelUpdate', color: COLORS.change, channelId: c.id, title: '📁 Channel changed', lines: [['Channel', `<#${c.id}>`], ...changes, ['By', await executor(c.guild, AuditLogEvent.ChannelUpdate, c.id)]] });
  }));

  // --- emojis ---
  client.on(Events.GuildEmojiCreate, on(async (e) => {
    await post(ctx, e.guild, { group: 'emojis', event: 'emojiCreate', color: COLORS.add, title: '😀 Emoji created', lines: [['Emoji', `${e.toString()} :${e.name}:`], ['By', await executor(e.guild, AuditLogEvent.EmojiCreate, e.id)]] });
  }));
  client.on(Events.GuildEmojiUpdate, on(async (b, e) => {
    if (b.name === e.name) return;
    await post(ctx, e.guild, { group: 'emojis', event: 'emojiUpdate', color: COLORS.change, title: '😀 Emoji renamed', lines: [['Emoji', e.toString()], ['Name', `:${b.name}: → :${e.name}:`], ['By', await executor(e.guild, AuditLogEvent.EmojiUpdate, e.id)]] });
  }));
  client.on(Events.GuildEmojiDelete, on(async (e) => {
    await post(ctx, e.guild, { group: 'emojis', event: 'emojiDelete', color: COLORS.remove, title: '😀 Emoji deleted', lines: [['Emoji', `:${e.name}:`], ['By', await executor(e.guild, AuditLogEvent.EmojiDelete, e.id)]] });
  }));

  // --- voice ---
  client.on(Events.VoiceStateUpdate, on(async (b, a) => {
    const member = a.member ?? b.member;
    if (!member || member.user.bot || b.channelId === a.channelId) return;
    const base = { group: 'voice' as const, user: member.user, member };
    if (!b.channelId && a.channelId) await post(ctx, a.guild, { ...base, event: 'voiceJoin', color: COLORS.add, channelId: a.channelId, title: '🔊 Joined voice', lines: [['Member', `<@${member.id}>`], ['Channel', `<#${a.channelId}>`]] });
    else if (b.channelId && !a.channelId) await post(ctx, a.guild, { ...base, event: 'voiceLeave', color: COLORS.remove, channelId: b.channelId, title: '🔈 Left voice', lines: [['Member', `<@${member.id}>`], ['Channel', `<#${b.channelId}>`]] });
    else await post(ctx, a.guild, { ...base, event: 'voiceMove', color: COLORS.change, channelId: a.channelId, title: '🔀 Switched voice channel', lines: [['Member', `<@${member.id}>`], ['From', `<#${b.channelId}>`], ['To', `<#${a.channelId}>`]] });
  }));

  // --- server ---
  client.on(Events.GuildUpdate, on(async (b, g) => {
    const changes: [string, string][] = [];
    if (b.name !== g.name) changes.push(['Name', `${clip(b.name, 100)} → ${clip(g.name, 100)}`]);
    if (b.icon !== g.icon) changes.push(['Icon', 'changed']);
    if (b.ownerId !== g.ownerId) changes.push(['Owner', `<@${b.ownerId}> → <@${g.ownerId}>`]);
    if (b.verificationLevel !== g.verificationLevel) changes.push(['Verification level', `${b.verificationLevel} → ${g.verificationLevel}`]);
    if (!changes.length) return;
    await post(ctx, g, { group: 'server', event: 'serverUpdate', color: COLORS.change, title: '🏠 Server changed', lines: changes });
  }));
  client.on(Events.ThreadCreate, on(async (t, isNew) => {
    if (!isNew || !t.guild) return;
    await post(ctx, t.guild, { group: 'server', event: 'threadCreate', color: COLORS.add, channelId: t.parentId, title: '🧵 Thread created', lines: [['Thread', `<#${t.id}> (${clip(t.name, 100)})`], ['In', t.parentId ? `<#${t.parentId}>` : ''], ['By', t.ownerId ? `<@${t.ownerId}>` : '']] });
  }));
  client.on(Events.ThreadDelete, on(async (t) => {
    if (!t.guild) return;
    await post(ctx, t.guild, { group: 'server', event: 'threadDelete', color: COLORS.remove, channelId: t.parentId, title: '🧵 Thread deleted', lines: [['Thread', clip(t.name, 100)], ['In', t.parentId ? `<#${t.parentId}>` : '']] });
  }));
}
