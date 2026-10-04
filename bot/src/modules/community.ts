// Community modules: Leveling, Reaction Roles, Invite Tracker, Suggestions.

import {
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Invite,
  type Message,
  type MessageReaction,
  type PartialGuildMember,
  type PartialMessageReaction,
  type PartialUser,
  type User,
  type VoiceState,
} from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, fill, idIn, idsIn, passes, reactionOf, sameEmoji, type ModuleContext } from './context.js';
import { assignable, send, warn } from './guard.js';

// ---------- Leveling ----------

/** Total XP needed to reach a level: level 1 costs base, each next level step more. */
export function xpForLevel(level: number, base: number, step: number): number {
  return level <= 0 ? 0 : level * base + (step * level * (level - 1)) / 2;
}

export function levelFor(xp: number, base: number, step: number, maxLevel = 0): number {
  let level = 0;
  while (xpForLevel(level + 1, base, step) <= xp && (maxLevel <= 0 || level < maxLevel) && level < 100_000) level++;
  return level;
}

interface LevelConfig {
  minXp: number; maxXp: number; cooldown: number; baseXp: number; stepXp: number; maxLevel: number;
  voiceXp: boolean; voiceXpPerMinute: number; levelUp: string; levelUpChannel: unknown; levelUpMessage: string;
  clearOnLeave: boolean; channelMode: string; channels: unknown; roleMode: string; roles: unknown; stackRewards: boolean;
  rewards: { level: number; role: unknown }[];
}

/** Adds XP, returns the new and old level. */
function addXp(ctx: ModuleContext, guildId: string, userId: string, xp: number, cfg: Partial<LevelConfig>, message: boolean, voiceMinutes = 0): { old: number; level: number } {
  const row = ctx.db.prepare('SELECT xp, level FROM leveling_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(ctx.botId, guildId, userId) as { xp: number; level: number } | undefined;
  const total = (row?.xp ?? 0) + xp;
  const level = levelFor(total, cfg.baseXp ?? 100, cfg.stepXp ?? 50, cfg.maxLevel ?? 0);
  ctx.db
    .prepare(
      `INSERT INTO leveling_members (bot_id, guild_id, user_id, xp, level, messages, voice_minutes, last_xp_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level,
         messages = messages + excluded.messages, voice_minutes = voice_minutes + excluded.voice_minutes,
         last_xp_at = COALESCE(excluded.last_xp_at, last_xp_at)`,
    )
    .run(ctx.botId, guildId, userId, total, level, message ? 1 : 0, voiceMinutes, message ? new Date().toISOString() : null);
  return { old: row?.level ?? 0, level };
}

async function levelUp(ctx: ModuleContext, member: GuildMember, old: number, level: number, cfg: Partial<LevelConfig>, channelId: string | null): Promise<void> {
  if (level <= old) return;
  const guild = member.guild;
  // Role rewards: the rewards up to this level (all of them, or only the highest).
  const rewards = (cfg.rewards ?? []).filter((r) => idIn(r.role, guild.id)).sort((a, b) => a.level - b.level);
  const earned = rewards.filter((r) => r.level <= level);
  const give = cfg.stackRewards === false ? earned.slice(-1) : earned;
  const giveIds = assignable(ctx, 'leveling', guild, give.map((r) => idIn(r.role, guild.id)!));
  if (giveIds.length) await member.roles.add(giveIds, 'Leveling reward').catch(() => undefined);
  if (cfg.stackRewards === false) {
    const drop = earned.slice(0, -1).map((r) => idIn(r.role, guild.id)!).filter((id) => member.roles.cache.has(id));
    if (drop.length) await member.roles.remove(drop, 'Leveling reward').catch(() => undefined);
  }
  const mode = cfg.levelUp ?? 'current';
  if (mode === 'off') return;
  const text = fill(cfg.levelUpMessage || '🎉 {user.mention} reached level **{level}**!', { ...baseVars(guild, member), level: String(level), 'level.old': String(old) }).slice(0, 2000);
  if (mode === 'dm') {
    await member.send({ content: text }).catch(() => undefined);
    return;
  }
  const target = guild.channels.cache.get((mode === 'channel' ? idIn(cfg.levelUpChannel, guild.id) : channelId) ?? '');
  if (target?.isSendable()) await send(ctx, 'leveling', target, { content: text, allowedMentions: { users: [member.id] } });
}

function xpAllowed(cfg: Partial<LevelConfig>, guildId: string, channelIds: string[], member: GuildMember): boolean {
  return passes(cfg.channelMode, idsIn(cfg.channels, guildId), channelIds) && passes(cfg.roleMode, idsIn(cfg.roles, guildId), [...member.roles.cache.keys()]);
}

const lastXp = new Map<string, number>();

export async function levelingMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || !msg.member || !ctx.enabled('leveling')) return;
  const cfg = ctx.config<LevelConfig>('leveling');
  const channelIds = [msg.channelId, ...(msg.channel.isThread() && msg.channel.parentId ? [msg.channel.parentId] : [])];
  if (!xpAllowed(cfg, msg.guildId, channelIds, msg.member)) return;
  const key = `${ctx.botId}:${msg.guildId}:${msg.author.id}`;
  const now = Date.now();
  if (now - (lastXp.get(key) ?? 0) < (cfg.cooldown ?? 60) * 1000) return;
  lastXp.set(key, now);
  const min = Math.min(cfg.minXp ?? 15, cfg.maxXp ?? 25);
  const max = Math.max(cfg.minXp ?? 15, cfg.maxXp ?? 25);
  const gain = min + Math.floor(Math.random() * (max - min + 1));
  const { old, level } = addXp(ctx, msg.guildId, msg.author.id, gain, cfg, true);
  await levelUp(ctx, msg.member, old, level, cfg, msg.channelId);
}

const voiceSince = new Map<string, number>();

const counts = (s: VoiceState) => !!s.channelId && !s.selfDeaf && !s.serverDeaf && s.channelId !== s.guild.afkChannelId;

/**
 * Voice XP: time is counted per channel. Leaving, switching channels or
 * deafening closes the running interval and pays it out when the channel
 * it was spent in gives XP.
 */
export async function levelingVoice(ctx: ModuleContext, before: VoiceState, after: VoiceState): Promise<void> {
  if (!ctx.enabled('leveling')) return;
  const member = after.member ?? before.member;
  if (!member || member.user.bot) return;
  const key = `${ctx.botId}:${member.guild.id}:${member.id}`;
  if (before.channelId === after.channelId && counts(before) === counts(after)) return;
  const since = voiceSince.get(key);
  voiceSince.delete(key);
  if (counts(after)) voiceSince.set(key, Date.now());
  if (since === undefined || !before.channelId) return;
  const minutes = Math.floor((Date.now() - since) / 60_000);
  const cfg = ctx.config<LevelConfig>('leveling');
  if (!cfg.voiceXp || minutes < 1 || !xpAllowed(cfg, member.guild.id, [before.channelId], member)) return;
  const { old, level } = addXp(ctx, member.guild.id, member.id, minutes * (cfg.voiceXpPerMinute ?? 5), cfg, false, minutes);
  await levelUp(ctx, member, old, level, cfg, null);
}

/** After a (re)start: members already in voice start counting now. */
export function levelingVoiceInit(ctx: ModuleContext, guilds: Guild[]): void {
  for (const g of guilds) {
    for (const vs of g.voiceStates.cache.values()) {
      if (vs.member && !vs.member.user.bot && counts(vs)) voiceSince.set(`${ctx.botId}:${g.id}:${vs.id}`, Date.now());
    }
  }
}

export function levelingLeave(ctx: ModuleContext, member: GuildMember | PartialGuildMember): void {
  if (!ctx.enabled('leveling') || !ctx.config<LevelConfig>('leveling').clearOnLeave) return;
  ctx.db.prepare('DELETE FROM leveling_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(ctx.botId, member.guild.id, member.id);
}

// ---------- Reaction Roles ----------

interface RREntry {
  channel: unknown; messageId: string; emoji: string[]; addRoles: unknown; removeRoles: unknown;
  unique: boolean; toggle: boolean; blacklist: unknown;
}

export async function reactionRoles(ctx: ModuleContext, partial: MessageReaction | PartialMessageReaction, partialUser: User | PartialUser, added: boolean): Promise<void> {
  if (!ctx.enabled('reaction-roles') || partialUser.bot) return;
  const reaction = partial.partial ? await partial.fetch() : partial;
  const guild = reaction.message.guild;
  if (!guild) return;
  const entries = (ctx.config<{ entries: RREntry[] }>('reaction-roles').entries ?? []).filter(
    (e) => e.messageId === reaction.message.id && idIn(e.channel, guild.id) === reaction.message.channelId,
  );
  const entry = entries.find((e) => (e.emoji ?? [])[0] && sameEmoji(e.emoji[0]!, reaction.emoji));
  if (!entry) return;
  const member = await guild.members.fetch(partialUser.id).catch(() => null);
  if (!member || idsIn(entry.blacklist, guild.id).some((r) => member.roles.cache.has(r))) {
    if (added && member) await reaction.users.remove(member.id).catch(() => undefined);
    return;
  }
  const add = assignable(ctx, 'reaction-roles', guild, idsIn(entry.addRoles, guild.id));
  const remove = assignable(ctx, 'reaction-roles', guild, idsIn(entry.removeRoles, guild.id));
  if (added) {
    if (entry.toggle && add.length && add.every((r) => member.roles.cache.has(r))) {
      await member.roles.remove(add, 'Reaction role toggle').catch(() => undefined);
    } else {
      if (add.length) await member.roles.add(add, 'Reaction role').catch(() => undefined);
      if (remove.length) await member.roles.remove(remove, 'Reaction role').catch(() => undefined);
    }
    if (entry.toggle) await reaction.users.remove(member.id).catch(() => undefined);
    if (entry.unique) {
      // Remove this member's other reactions of the message's reaction roles.
      for (const other of entries) {
        if (other === entry || !(other.emoji ?? [])[0]) continue;
        const r = reaction.message.reactions.cache.find((x) => sameEmoji(other.emoji[0]!, x.emoji));
        if (r) await r.users.remove(member.id).catch(() => undefined);
      }
    }
  } else if (!entry.toggle && add.length) {
    await member.roles.remove(add, 'Reaction role removed').catch(() => undefined);
  }
}

/** Adds the bot's own reaction to every configured message (after saving). */
export async function prepareReactionRoles(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled('reaction-roles')) return;
  for (const e of ctx.config<{ entries: RREntry[] }>('reaction-roles').entries ?? []) {
    const emoji = (e.emoji ?? [])[0];
    const guild = guilds.find((g) => idIn(e.channel, g.id));
    const channel = guild?.channels.cache.get(idIn(e.channel, guild.id) ?? '');
    if (!emoji || !e.messageId || !channel?.isTextBased()) continue;
    const msg = await channel.messages.fetch(e.messageId).catch(() => null);
    if (msg && !msg.reactions.cache.find((r) => sameEmoji(emoji, r.emoji) && r.me)) await msg.react(reactionOf(emoji)).catch(() => undefined);
  }
}

// ---------- Invite Tracker ----------

/** Which invite code was used: the one whose use count went up. */
export function usedInvite(before: Map<string, number>, after: Map<string, number>): string | null {
  const grown = [...after.entries()].filter(([code, uses]) => uses > (before.get(code) ?? 0));
  if (grown.length === 1) return grown[0]![0];
  // A one-use invite disappears when it is used.
  const gone = [...before.keys()].filter((code) => !after.has(code));
  return grown.length === 0 && gone.length === 1 ? gone[0]! : null;
}

const inviteCache = new Map<string, { uses: Map<string, number>; inviter: Map<string, string> }>();

export async function cacheInvites(ctx: ModuleContext, guild: Guild): Promise<void> {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) {
    if (ctx.enabled('invite-tracker')) warn(ctx, 'WAR-2008', { module: 'invite-tracker', problem: `cannot read the invites of ${guild.name} (needs Manage Server)` });
    return;
  }
  inviteCache.set(`${ctx.botId}:${guild.id}`, {
    uses: new Map(invites.map((i) => [i.code, i.uses ?? 0])),
    inviter: new Map(invites.filter((i) => !!i.inviterId).map((i) => [i.code, i.inviterId!])),
  });
}

export function inviteChanged(ctx: ModuleContext, invite: Invite): void {
  if (invite.guild && 'invites' in invite.guild) void cacheInvites(ctx, invite.guild as Guild);
}

function inviteCount(ctx: ModuleContext, guildId: string, inviterId: string): number {
  const row = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND inviter_id = ? AND fake = 0 AND reset_at IS NULL AND left_at IS NULL')
    .get(ctx.botId, guildId, inviterId) as { n: number };
  return Number(row.n);
}

interface InviteConfig {
  channel: unknown; joinMessage: string; unknownMessage: string; registerLeaves: boolean; leaveMessage: string; minAccountAge: number;
  rewards: { count: number; role: unknown }[];
}

const joinQueue = new Map<string, Promise<unknown>>();

/** Joins of one server are handled one after another (invite use counts are compared). */
export function inviteJoin(ctx: ModuleContext, member: GuildMember): Promise<void> {
  if (!ctx.enabled('invite-tracker')) return Promise.resolve();
  const key = `${ctx.botId}:${member.guild.id}`;
  const run = (joinQueue.get(key) ?? Promise.resolve()).then(() => handleJoin(ctx, member));
  const tail = run.catch(() => undefined);
  joinQueue.set(key, tail);
  void tail.then(() => {
    if (joinQueue.get(key) === tail) joinQueue.delete(key);
  });
  return run;
}

async function handleJoin(ctx: ModuleContext, member: GuildMember): Promise<void> {
  const guild = member.guild;
  const key = `${ctx.botId}:${guild.id}`;
  const before = inviteCache.get(key);
  await cacheInvites(ctx, guild);
  const after = inviteCache.get(key);
  const code = before && after ? usedInvite(before.uses, after.uses) : null;
  const inviterId = code ? (after?.inviter.get(code) ?? before?.inviter.get(code) ?? null) : null;
  const cfg = ctx.config<InviteConfig>('invite-tracker');
  const fake = (cfg.minAccountAge ?? 0) > 0 && Date.now() - member.user.createdTimestamp < (cfg.minAccountAge ?? 0) * 86_400_000;
  // The same join event twice (gateway resume): keep the first row.
  const recent = ctx.db
    .prepare("SELECT 1 FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND left_at IS NULL AND joined_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')")
    .get(ctx.botId, guild.id, member.id);
  if (recent) return;
  // A rejoin without a recorded leave (bot was offline) closes the old row first.
  ctx.db.prepare("UPDATE invite_joins SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND left_at IS NULL").run(ctx.botId, guild.id, member.id);
  ctx.db.prepare('INSERT INTO invite_joins (bot_id, guild_id, user_id, inviter_id, code, fake) VALUES (?, ?, ?, ?, ?, ?)').run(ctx.botId, guild.id, member.id, inviterId, code, fake ? 1 : 0);

  const invites = inviterId ? inviteCount(ctx, guild.id, inviterId) : 0;
  const inviter = inviterId ? await guild.members.fetch(inviterId).catch(() => null) : null;
  const vars = { ...baseVars(guild, member), 'inviter.id': inviterId ?? '', 'inviter.name': inviter?.user.username ?? '?', 'inviter.mention': inviterId ? `<@${inviterId}>` : '?', invites: String(invites), 'invite.code': code ?? '' };
  const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
  const text = inviterId ? cfg.joinMessage : cfg.unknownMessage;
  if (channel?.isSendable() && text) await send(ctx, 'invite-tracker', channel, { content: fill(text, vars).slice(0, 2000), allowedMentions: { parse: [] } });
  if (inviter && !fake) {
    const give = assignable(ctx, 'invite-tracker', guild, (cfg.rewards ?? []).filter((r) => r.count <= invites).map((r) => idIn(r.role, guild.id)).filter((id): id is string => !!id));
    if (give.length) await inviter.roles.add(give, 'Invite reward').catch(() => undefined);
  }
}

export async function inviteLeave(ctx: ModuleContext, member: GuildMember | PartialGuildMember): Promise<void> {
  if (!ctx.enabled('invite-tracker')) return;
  const cfg = ctx.config<InviteConfig>('invite-tracker');
  if (cfg.registerLeaves === false) return;
  const guild = member.guild;
  const row = ctx.db
    .prepare('SELECT id, inviter_id FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(ctx.botId, guild.id, member.id) as { id: number; inviter_id: string | null } | undefined;
  if (!row) return;
  ctx.db.prepare("UPDATE invite_joins SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(row.id);
  const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
  if (channel?.isSendable() && cfg.leaveMessage && row.inviter_id) {
    const inviter = await guild.members.fetch(row.inviter_id).catch(() => null);
    const vars = { ...baseVars(guild, member.partial ? null : member), 'user.name': member.user?.username ?? '', 'inviter.name': inviter?.user.username ?? '?', 'inviter.mention': `<@${row.inviter_id}>`, invites: String(inviteCount(ctx, guild.id, row.inviter_id)) };
    await send(ctx, 'invite-tracker', channel, { content: fill(cfg.leaveMessage, vars).slice(0, 2000), allowedMentions: { parse: [] } });
  }
}

// ---------- Suggestions ----------

interface SuggestConfig {
  channel: unknown; convertMessages: boolean; upvote: string[]; neutral: boolean; downvote: string[]; color: string;
  thread: boolean; anonymous: boolean; dmAuthor: boolean; managerRoles: unknown; autoApprove: number; autoDeny: number; roleMode: string; roles: unknown;
}

/** approved / rejected / null from the vote counts (0 = rule off). */
export function autoVerdict(up: number, down: number, approveAt: number, denyAt: number): 'approved' | 'rejected' | null {
  if (approveAt > 0 && up >= approveAt) return 'approved';
  if (denyAt > 0 && down >= denyAt) return 'rejected';
  return null;
}

const COLORS = { pending: 0x60a5fa, approved: 0x4ade80, rejected: 0xf87171 } as const;

export async function suggestionMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || !msg.member || !ctx.enabled('suggestions')) return;
  const cfg = ctx.config<SuggestConfig>('suggestions');
  if (cfg.convertMessages === false || idIn(cfg.channel, msg.guildId) !== msg.channelId) return;
  const roles = [...msg.member.roles.cache.keys()];
  if (idsIn(cfg.managerRoles, msg.guildId).some((r) => roles.includes(r))) return;
  if (!passes(cfg.roleMode, idsIn(cfg.roles, msg.guildId), roles) || !msg.content.trim()) {
    await msg.delete().catch(() => undefined);
    return;
  }
  const key = `${ctx.botId}:${msg.author.id}`;
  if (Date.now() - (lastSuggestion.get(key) ?? 0) < 60_000) {
    await msg.delete().catch(() => undefined);
    await msg.author.send({ content: 'Please wait a minute before you post the next suggestion.' }).catch(() => undefined);
    return;
  }
  lastSuggestion.set(key, Date.now());
  // The original message goes only after the suggestion was posted.
  const res = await createSuggestion(ctx, msg.guild, msg.member, msg.content);
  if (res) await msg.delete().catch(() => undefined);
  else warn(ctx, 'WAR-2008', { module: 'suggestions', problem: 'a suggestion could not be posted (check the channel and the bot permissions)' });
}

const lastSuggestion = new Map<string, number>();
const numberQueue = new Map<string, Promise<unknown>>();

/** Posts a suggestion in the suggestions channel. Returns its number and message, or null without a channel. */
export function createSuggestion(ctx: ModuleContext, guild: Guild, member: GuildMember, text: string): Promise<{ number: number; message: Message } | null> {
  // One suggestion per server at a time, so numbers stay unique.
  const key = `${ctx.botId}:${guild.id}`;
  const run = (numberQueue.get(key) ?? Promise.resolve()).then(() => postSuggestion(ctx, guild, member, text));
  const tail = run.catch(() => undefined);
  numberQueue.set(key, tail);
  void tail.then(() => {
    if (numberQueue.get(key) === tail) numberQueue.delete(key);
  });
  return run;
}

async function postSuggestion(ctx: ModuleContext, guild: Guild, member: GuildMember, text: string): Promise<{ number: number; message: Message } | null> {
  const cfg = ctx.config<SuggestConfig>('suggestions');
  const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
  if (!channel?.isSendable()) return null;
  const content = text.slice(0, 2000);
  const next = (ctx.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM suggestions WHERE bot_id = ? AND guild_id = ?').get(ctx.botId, guild.id) as { n: number }).n;
  const color = /^#[0-9a-fA-F]{6}$/.test(cfg.color ?? '') ? parseInt(cfg.color!.slice(1), 16) : COLORS.pending;
  const embed = new EmbedBuilder().setTitle(`💡 Suggestion #${next}`).setDescription(content).setColor(color).setTimestamp(new Date());
  if (!cfg.anonymous) embed.setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() });
  const post = await send(ctx, 'suggestions', channel, { embeds: [embed] });
  if (!post) return null;
  ctx.db
    .prepare('INSERT INTO suggestions (bot_id, guild_id, number, channel_id, message_id, author_id, content) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.botId, guild.id, next, channel.id, post.id, member.id, content);
  for (const e of [(cfg.upvote ?? [])[0] || '👍', ...(cfg.neutral ? ['🤷'] : []), (cfg.downvote ?? [])[0] || '👎']) await post.react(reactionOf(e)).catch(() => undefined);
  if (cfg.thread && 'threads' in channel) await post.startThread({ name: `Suggestion #${next}`.slice(0, 100) }).catch(() => undefined);
  return { number: next, message: post };
}

/** Approves or rejects a suggestion (by message ID or number): updates the post and tells the author. */
export async function decideSuggestion(ctx: ModuleContext, guild: Guild, ref: string, verdict: 'approved' | 'rejected', by: string, reason = ''): Promise<boolean> {
  const row = ctx.db
    .prepare("SELECT id, number, author_id, channel_id, message_id FROM suggestions WHERE bot_id = ? AND guild_id = ? AND (message_id = ? OR number = ?) AND status = 'pending'")
    .get(ctx.botId, guild.id, ref, /^\d{1,9}$/.test(ref) ? Number(ref) : -1) as { id: number; number: number; author_id: string; channel_id: string | null; message_id: string | null } | undefined;
  if (!row) return false;
  // Atomic: only the first decision wins (a second one changes no row).
  const changed = ctx.db
    .prepare("UPDATE suggestions SET status = ?, decided_by = ?, reason = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'")
    .run(verdict, by, reason || null, row.id);
  if (Number(changed.changes) !== 1) return false;
  const channel = guild.channels.cache.get(row.channel_id ?? '');
  const msg = channel?.isTextBased() && row.message_id ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
  if (msg?.embeds[0]) {
    const embed = EmbedBuilder.from(msg.embeds[0]).setColor(COLORS[verdict]).setFooter({ text: `${verdict === 'approved' ? '✅ Approved' : '❌ Denied'}${reason ? `: ${reason}` : ''}`.slice(0, 2048) });
    await msg.edit({ embeds: [embed] }).catch(() => undefined);
  }
  if (ctx.config<SuggestConfig>('suggestions').dmAuthor !== false) {
    const author = await guild.client.users.fetch(row.author_id).catch(() => null);
    await author?.send({ content: `Your suggestion #${row.number} in ${guild.name} was ${verdict === 'approved' ? 'approved ✅' : 'denied ❌'}${reason ? `: ${reason}` : '.'}`.slice(0, 2000) }).catch(() => undefined);
  }
  return true;
}

export async function suggestionVote(ctx: ModuleContext, partial: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot || !ctx.enabled('suggestions')) return;
  const reaction = partial.partial ? await partial.fetch() : partial;
  const msg = reaction.message;
  if (!msg.guildId) return;
  const row = ctx.db
    .prepare("SELECT id, number, author_id, status FROM suggestions WHERE bot_id = ? AND guild_id = ? AND message_id = ?")
    .get(ctx.botId, msg.guildId, msg.id) as { id: number; number: number; author_id: string; status: string } | undefined;
  if (!row || row.status !== 'pending') return;
  const cfg = ctx.config<SuggestConfig>('suggestions');
  const up = (cfg.upvote ?? [])[0] || '👍';
  const down = (cfg.downvote ?? [])[0] || '👎';
  const full = msg.partial ? await msg.fetch() : msg;
  const count = (e: string) => Math.max(0, (full.reactions.cache.find((r) => sameEmoji(e, r.emoji))?.count ?? 1) - 1);
  const verdict = autoVerdict(count(up), count(down), cfg.autoApprove ?? 0, cfg.autoDeny ?? 0);
  if (!verdict) return;
  const changed = ctx.db.prepare("UPDATE suggestions SET status = ?, decided_by = 'auto', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'").run(verdict, row.id);
  if (Number(changed.changes) !== 1) return;
  const embed = EmbedBuilder.from(full.embeds[0]!).setColor(COLORS[verdict]).setFooter({ text: verdict === 'approved' ? '✅ Approved' : '❌ Denied' });
  await full.edit({ embeds: [embed] }).catch(() => undefined);
  if (cfg.dmAuthor !== false) {
    const author = await full.client.users.fetch(row.author_id).catch(() => null);
    await author?.send({ content: `Your suggestion #${row.number} in ${full.guild?.name ?? 'the server'} was ${verdict === 'approved' ? 'approved ✅' : 'denied ❌'}.` }).catch(() => undefined);
  }
  log.debug('suggestion decided', { botId: ctx.botId, number: row.number, verdict });
}
