// AntiControl (module "anticontrol", group Security): protection against
// raids, nukes, scams and take-overs in one place.
//
// - AntiRaid + Raid Lockdown: too many joins in a short time lock the server
//   (chosen or all text channels read-only for @everyone, invites paused)
//   for some minutes; /lockdown does it by hand.
// - Join checks: Account Age Protection, Join Risk Score and Suspicious User
//   Detection (new account, default avatar, scam words or staff names in the
//   name), Bot Detection (bots added by someone not trusted).
// - Messages: AntiScam / AntiPhishing (known scam domains, look-alikes of
//   Discord and Steam, "free nitro" baits), Anti Invite (invites of other
//   servers), Mass Mention Protection.
// - Audit log: AntiNuke (one person deleting channels or roles, banning or
//   kicking many in a short time), Webhook Protection (webhooks created by
//   someone not trusted are deleted), Permission Change Monitor (dangerous
//   permissions given to a role or a member).
// Trusted: the owner, the bot, and the users and roles of the settings.

import {
  AuditLogEvent, ChannelType, PermissionFlagsBits, PermissionsBitField,
  type Guild, type GuildAuditLogsEntry, type GuildMember, type Message,
} from 'discord.js';
import { idIn, idsIn, type ModuleContext } from './context.js';
import { assignable, send, warn } from './guard.js';

type Punish = 'none' | 'timeout' | 'kick' | 'ban' | 'quarantine';

export interface AntiConfig {
  logChannel: unknown; trustedUsers: string[]; trustedRoles: unknown; quarantineRole: unknown;
  raidEnabled: boolean; raidJoins: number; raidSeconds: number; raidAction: Punish; lockdownMinutes: number; lockChannels: unknown; pauseInvites: boolean;
  ageEnabled: boolean; minAccountDays: number; ageAction: Punish;
  riskEnabled: boolean; riskThreshold: number; riskAction: Punish; staffNames: string[];
  botEnabled: boolean; botAction: 'kick' | 'ban' | 'none';
  scamEnabled: boolean; scamAction: Punish; scamDomains: string[];
  inviteEnabled: boolean; inviteAction: Punish; allowedInvites: string[];
  mentionEnabled: boolean; maxMentions: number; mentionAction: Punish;
  nukeEnabled: boolean; nukeLimit: number; nukeSeconds: number; nukeAction: 'strip' | 'kick' | 'ban' | 'none';
  webhookEnabled: boolean; permEnabled: boolean; permRevert: boolean;
}

// ---------- pure checks ----------

/** Known scam domains (plus the server's own list) and look-alikes of Discord / Steam. */
const SCAM_DOMAINS = [
  'discord-nitro.gift', 'discordnitro.gift', 'dlscord.gift', 'discord-gift.com', 'discordgift.site', 'discord-app.com', 'discordapp.gift', 'discord.giveaway',
  'steamcommunity.ru', 'steamcomminuty.com', 'steamcommunlty.com', 'stearncommunity.com', 'steamcommunitty.com', 'steam-trade.org', 'steamgift.com',
  'nitro-discord.com', 'free-nitro.ru', 'discord-airdrop.com', 'grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'blasze.tk',
];
const REAL = ['discord.com', 'discord.gg', 'discordapp.com', 'discord.media', 'discordapp.net', 'discord.gift', 'steamcommunity.com', 'steampowered.com', 'steamstatic.com', 'twitch.tv'];

/** Domains of the links in a text (lower case, without www.). */
export function domainsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi)) out.push(m[1]!.toLowerCase().replace(/^www\./, ''));
  return [...new Set(out)];
}

/** Edit distance (small strings). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Why a message is a scam (domain or bait), or null. */
export function scamReason(text: string, extra: string[] = []): string | null {
  const domains = domainsOf(text);
  const known = new Set([...SCAM_DOMAINS, ...extra.map((d) => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean)]);
  for (const d of domains) {
    if (REAL.some((r) => d === r || d.endsWith(`.${r}`))) continue;
    if ([...known].some((k) => d === k || d.endsWith(`.${k}`))) return `scam link (${d})`;
    const base = d.split('.').slice(-2).join('.');
    // Look-alikes: "dlscord.com", "steamcommunlty.com", "discord-nitro.xyz".
    for (const r of REAL) {
      const rb = r.split('.')[0]!;
      const db = base.split('.')[0]!;
      if (db !== rb && db.length >= 5 && distance(db, rb) <= 2) return `look-alike of ${r} (${d})`;
      if (db.includes(rb) && db !== rb) return `fake ${rb} domain (${d})`;
    }
  }
  const t = text.toLowerCase();
  if (domains.length && /(free|gift|claim|get)\s*(discord\s*)?nitro|nitro\s*(for\s*)?free|steam\s*gift|airdrop|@everyone.*(nitro|gift)/.test(t)) return 'nitro / gift bait with a link';
  return null;
}

/** Discord invite codes in a text. */
export function inviteCodes(text: string): string[] {
  return [...text.matchAll(/(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me)\/([A-Za-z0-9-]{2,32})/gi)].map((m) => m[1]!);
}

/** Mentions of a message: users and roles (repeats count), @everyone/@here as 5. */
export function mentionCount(m: { users: number; roles: number; everyone: boolean }): number {
  return m.users + m.roles + (m.everyone ? 5 : 0);
}

const SCAM_NAME = /(nitro|giveaway|airdrop|free\s*gift|steam\s*gift|crypto|support\s*team|official|moderator|admin)/i;

/** Join risk 0–100 with the reasons: new account, default avatar, scam or staff words in the name, digit names. */
export function riskScore(u: { createdTimestamp: number; avatar: string | null; username: string; globalName?: string | null }, staffNames: string[], now = Date.now()): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const days = (now - u.createdTimestamp) / 86_400_000;
  if (days < 1) { score += 40; reasons.push('account younger than a day'); }
  else if (days < 7) { score += 25; reasons.push('account younger than a week'); }
  else if (days < 30) { score += 10; reasons.push('account younger than a month'); }
  if (!u.avatar) { score += 15; reasons.push('default avatar'); }
  const names = [u.username, u.globalName ?? ''].join(' ');
  if (SCAM_NAME.test(names)) { score += 30; reasons.push('scam or staff word in the name'); }
  const lower = names.toLowerCase();
  if (staffNames.some((s) => s.trim().length >= 3 && lower.includes(s.trim().toLowerCase()))) { score += 35; reasons.push('looks like a staff name'); }
  if (/\d{4,}/.test(u.username)) { score += 10; reasons.push('many digits in the name'); }
  return { score: Math.min(100, score), reasons };
}

/** Counts per key in a sliding window; returns the count after adding now. */
export class Window {
  private hits = new Map<string, number[]>();
  add(key: string, seconds: number, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < seconds * 1000);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 2000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 3_600_000)) this.hits.delete(k);
    return list.length;
  }
}

const DANGEROUS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.MentionEveryone];

/** Dangerous permissions in "after" that "before" did not have (names). */
export function newDangerous(before: bigint, after: bigint): string[] {
  const added = after & ~before;
  return DANGEROUS.filter((d) => (added & d) === d).map((d) => new PermissionsBitField(d).toArray()[0] ?? String(d));
}

// ---------- runtime ----------

const joins = new Window();
const nukes = new Window();
const cfgOf = (ctx: ModuleContext) => ctx.config<AntiConfig>('anticontrol');

function trusted(ctx: ModuleContext, guild: Guild, userId: string | null | undefined, member?: GuildMember | null): boolean {
  if (!userId) return false;
  const cfg = cfgOf(ctx);
  if (userId === guild.ownerId || userId === guild.client.user.id) return true;
  if ((cfg.trustedUsers ?? []).map((s) => s.replace(/\D/g, '')).includes(userId)) return true;
  const roles = idsIn(cfg.trustedRoles, guild.id);
  const m = member ?? guild.members.cache.get(userId);
  return !!m && roles.some((r) => m.roles.cache.has(r));
}

async function log(ctx: ModuleContext, guild: Guild, title: string, text: string, color = 0xef4444): Promise<void> {
  const channel = guild.channels.cache.get(idIn(cfgOf(ctx).logChannel, guild.id) ?? '');
  if (channel?.isSendable()) await send(ctx, 'anticontrol', channel, { embeds: [{ color, title: `🛡️ ${title}`.slice(0, 256), description: text.slice(0, 4000), timestamp: new Date().toISOString() }], allowedMentions: { parse: [] } });
}

/** Punishes a member; returns what was done. */
async function punish(ctx: ModuleContext, member: GuildMember | null, action: Punish | 'strip', reason: string): Promise<string> {
  if (!member || action === 'none') return 'only reported';
  const why = `AntiControl: ${reason}`.slice(0, 500);
  try {
    if (action === 'timeout' && member.moderatable) { await member.timeout(60 * 60_000, why); return 'timed out for 1 hour'; }
    if (action === 'kick' && member.kickable) { await member.kick(why); return 'kicked'; }
    if (action === 'ban' && member.bannable) { await member.ban({ reason: why, deleteMessageSeconds: 3600 }); return 'banned'; }
    if (action === 'quarantine') {
      const role = idIn(cfgOf(ctx).quarantineRole, member.guild.id);
      if (role && assignable(ctx, 'anticontrol', member.guild, [role]).length) { await member.roles.add(role, why); return 'put into quarantine'; }
      if (member.moderatable) { await member.timeout(24 * 3_600_000, why); return 'timed out for 24 hours (no quarantine role)'; }
    }
    if (action === 'strip') {
      const roles = member.roles.cache.filter((r) => r.id !== member.guild.id && !r.managed && r.editable).map((r) => r.id);
      if (roles.length) { await member.roles.remove(roles, why); return `lost ${roles.length} role(s)`; }
    }
  } catch (err) {
    return `could not act (${String((err as Error).message).slice(0, 80)})`;
  }
  return 'could not act (missing permission or higher role)';
}

// ----- lockdown -----

interface LockState { until: number; channels: { id: string; send: boolean | null }[]; invites: boolean }

/** Locks the server: the channels read-only for @everyone (remembering the old setting), invites paused. */
export async function lockdown(ctx: ModuleContext, guild: Guild, minutes: number, reason: string): Promise<number> {
  const cfg = cfgOf(ctx);
  const prev = ctx.getState<LockState>('anticontrol', guild.id, 'lock');
  const chosen = idsIn(cfg.lockChannels, guild.id);
  const everyone = guild.roles.everyone;
  const channels = guild.channels.cache.filter((c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement || c.type === ChannelType.GuildForum) && (!chosen.length || chosen.includes(c.id)) && c.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages));
  const state: LockState = prev ?? { until: 0, channels: [], invites: false };
  for (const c of channels.values()) {
    if (!('permissionOverwrites' in c)) continue;
    const ow = c.permissionOverwrites.cache.get(everyone.id);
    const old = ow?.allow.has(PermissionFlagsBits.SendMessages) ? true : ow?.deny.has(PermissionFlagsBits.SendMessages) ? false : null;
    if (!state.channels.some((x) => x.id === c.id)) state.channels.push({ id: c.id, send: old });
    await c.permissionOverwrites.edit(everyone, { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false }, { reason: `Lockdown: ${reason}` }).catch(() => undefined);
  }
  if (cfg.pauseInvites !== false && !state.invites) state.invites = await guild.disableInvites(true).then(() => true, () => false);
  state.until = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
  ctx.setState('anticontrol', guild.id, 'lock', state);
  await log(ctx, guild, 'Server locked', `${reason}\n${channels.size} channel(s) read-only${state.invites ? ', invites paused' : ''}${minutes > 0 ? `, ends <t:${Math.floor(state.until / 1000)}:R>` : ' until /lockdown off'}.`, 0xf59e0b);
  return channels.size;
}

/** Ends the lockdown: the channels get their old setting back, invites run again. */
export async function unlock(ctx: ModuleContext, guild: Guild, reason: string): Promise<number> {
  const state = ctx.getState<LockState>('anticontrol', guild.id, 'lock');
  if (!state) return 0;
  const everyone = guild.roles.everyone;
  for (const x of state.channels) {
    const c = guild.channels.cache.get(x.id);
    if (c && 'permissionOverwrites' in c) await c.permissionOverwrites.edit(everyone, { SendMessages: x.send, SendMessagesInThreads: null, CreatePublicThreads: null }, { reason: `Lockdown over: ${reason}` }).catch(() => undefined);
  }
  if (state.invites) await guild.disableInvites(false).catch(() => undefined);
  ctx.deleteState('anticontrol', guild.id, 'lock');
  await log(ctx, guild, 'Server unlocked', `${reason}\n${state.channels.length} channel(s) open again.`, 0x22c55e);
  return state.channels.length;
}

/** Every 30 seconds: lockdowns whose time is up end. */
export async function anticontrolTick(ctx: ModuleContext, guilds: Guild[], now = Date.now()): Promise<void> {
  for (const g of guilds) {
    const s = ctx.getState<LockState>('anticontrol', g.id, 'lock');
    if (s && s.until > 0 && now >= s.until) await unlock(ctx, g, 'time is up');
  }
}

// ----- events -----

export async function antiJoin(ctx: ModuleContext, member: GuildMember): Promise<void> {
  if (!ctx.enabled('anticontrol')) return;
  const cfg = cfgOf(ctx);
  const guild = member.guild;
  const user = member.user;

  if (user.bot) {
    if (cfg.botEnabled === false) return;
    // Who added it: the audit log entry "bot added".
    const entry = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 3 }).then((l) => l.entries.find((e) => e.targetId === user.id), () => undefined);
    if (entry && trusted(ctx, guild, entry.executorId)) return;
    const done = await punish(ctx, member, cfg.botAction === 'ban' ? 'ban' : cfg.botAction === 'none' ? 'none' : 'kick', 'bot added by someone not trusted');
    await log(ctx, guild, 'Bot Detection', `Bot **${user.tag}** (${user.id}) added by ${entry?.executorId ? `<@${entry.executorId}>` : 'unknown'}: ${done}.`);
    return;
  }

  if (cfg.raidEnabled !== false && (cfg.raidJoins ?? 0) > 0) {
    const n = joins.add(`${ctx.botId}:${guild.id}`, cfg.raidSeconds || 10);
    if (n > cfg.raidJoins!) {
      const locked = ctx.getState<LockState>('anticontrol', guild.id, 'lock');
      if (!locked) await lockdown(ctx, guild, cfg.lockdownMinutes ?? 15, `AntiRaid: ${n} joins within ${cfg.raidSeconds || 10} seconds`);
      if (cfg.raidAction && cfg.raidAction !== 'none') await punish(ctx, member, cfg.raidAction, 'joined during a raid');
      return;
    }
  }

  if (cfg.ageEnabled !== false && (cfg.minAccountDays ?? 0) > 0) {
    const days = (Date.now() - user.createdTimestamp) / 86_400_000;
    if (days < cfg.minAccountDays!) {
      const done = await punish(ctx, member, cfg.ageAction ?? 'kick', `account younger than ${cfg.minAccountDays} days`);
      await log(ctx, guild, 'Account Age Protection', `<@${user.id}> (${user.tag}), account created <t:${Math.floor(user.createdTimestamp / 1000)}:R>: ${done}.`, 0xf59e0b);
      return;
    }
  }

  if (cfg.riskEnabled !== false) {
    const r = riskScore(user, cfg.staffNames ?? []);
    if (r.score >= (cfg.riskThreshold || 60)) {
      const done = await punish(ctx, member, cfg.riskAction ?? 'quarantine', `join risk ${r.score}`);
      await log(ctx, guild, 'Suspicious user', `<@${user.id}> (${user.tag}) risk **${r.score}**/100: ${r.reasons.join(', ')} → ${done}.`, 0xf59e0b);
    }
  }
}

export async function antiMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('anticontrol')) return;
  const cfg = cfgOf(ctx);
  const guild = msg.guild;
  if (trusted(ctx, guild, msg.author.id, msg.member)) return;
  const member = msg.member;
  const text = `${msg.content} ${msg.embeds.map((e) => `${e.url ?? ''} ${e.description ?? ''}`).join(' ')}`;
  const hit = async (feature: string, action: Punish, why: string) => {
    await msg.delete().catch(() => undefined);
    const done = await punish(ctx, member, action, why);
    await log(ctx, guild, feature, `<@${msg.author.id}> in <#${msg.channelId}>: ${why} → message deleted, ${done}.\n> ${msg.content.slice(0, 300).replace(/\n/g, ' ')}`);
  };
  if (cfg.scamEnabled !== false) {
    const why = scamReason(text, cfg.scamDomains ?? []);
    if (why) return hit('AntiScam / AntiPhishing', cfg.scamAction ?? 'timeout', why);
  }
  if (cfg.inviteEnabled !== false) {
    const codes = inviteCodes(text).filter((c) => !(cfg.allowedInvites ?? []).some((a) => a.trim() && c.toLowerCase() === a.trim().toLowerCase()));
    if (codes.length) {
      // Invites of this server are fine.
      const own = await guild.invites.fetch().then((l) => new Set(l.map((i) => i.code)), () => new Set<string>());
      if (guild.vanityURLCode) own.add(guild.vanityURLCode);
      const foreign = codes.filter((c) => !own.has(c));
      if (foreign.length) return hit('Anti Invite', cfg.inviteAction ?? 'none', `invite to another server (${foreign[0]})`);
    }
  }
  if (cfg.mentionEnabled !== false) {
    const n = mentionCount({ users: msg.mentions.users.size, roles: msg.mentions.roles.size, everyone: msg.mentions.everyone });
    if (n >= (cfg.maxMentions || 8)) return hit('Mass Mention Protection', cfg.mentionAction ?? 'timeout', `${n} mentions in one message`);
  }
}

/** Audit log: AntiNuke, Webhook Protection, Permission Change Monitor. */
export async function antiAudit(ctx: ModuleContext, entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  if (!ctx.enabled('anticontrol')) return;
  const cfg = cfgOf(ctx);
  const executor = entry.executorId;
  if (!executor || trusted(ctx, guild, executor)) return;
  const member = await guild.members.fetch(executor).catch(() => null);

  const NUKE: Partial<Record<AuditLogEvent, string>> = {
    [AuditLogEvent.ChannelDelete]: 'channels deleted', [AuditLogEvent.RoleDelete]: 'roles deleted', [AuditLogEvent.MemberBanAdd]: 'members banned',
    [AuditLogEvent.MemberKick]: 'members kicked', [AuditLogEvent.WebhookCreate]: 'webhooks created', [AuditLogEvent.EmojiDelete]: 'emojis deleted',
  };
  const kind = NUKE[entry.action];
  if (kind && cfg.nukeEnabled !== false) {
    const n = nukes.add(`${ctx.botId}:${guild.id}:${executor}`, cfg.nukeSeconds || 30);
    if (n >= (cfg.nukeLimit || 4)) {
      const done = await punish(ctx, member, cfg.nukeAction ?? 'strip', `AntiNuke: ${n} actions in ${cfg.nukeSeconds || 30} s`);
      await log(ctx, guild, 'AntiNuke', `<@${executor}>: ${n} ${kind} within ${cfg.nukeSeconds || 30} seconds → ${done}.`);
    }
  }

  if (entry.action === AuditLogEvent.WebhookCreate && cfg.webhookEnabled !== false) {
    const hooks = await guild.fetchWebhooks().catch(() => null);
    const hook = hooks?.get(entry.targetId ?? '');
    if (hook) await hook.delete('AntiControl: webhook created by someone not trusted').catch(() => undefined);
    await log(ctx, guild, 'Webhook Protection', `<@${executor}> created the webhook **${hook?.name ?? entry.targetId}**${hook ? ' → deleted' : ''}.`, 0xf59e0b);
  }

  if (cfg.permEnabled !== false) {
    if (entry.action === AuditLogEvent.RoleUpdate) {
      const change = entry.changes.find((c) => c.key === 'permissions');
      if (change) {
        const added = newDangerous(BigInt(String(change.old ?? '0')), BigInt(String(change.new ?? '0')));
        if (added.length) {
          const role = guild.roles.cache.get(entry.targetId ?? '');
          let reverted = '';
          if (cfg.permRevert && role?.editable) reverted = await role.setPermissions(BigInt(String(change.old ?? '0')), 'AntiControl: dangerous permission given by someone not trusted').then(() => ' → reverted', () => ' (could not revert)');
          await log(ctx, guild, 'Permission Change Monitor', `<@${executor}> gave the role **${role?.name ?? entry.targetId}**: ${added.join(', ')}${reverted}.`, 0xf59e0b);
        }
      }
    }
    if (entry.action === AuditLogEvent.MemberRoleUpdate) {
      const addedRoles = (entry.changes.find((c) => c.key === '$add')?.new ?? []) as { id: string; name: string }[];
      const risky = addedRoles.map((r) => guild.roles.cache.get(r.id)).filter((r) => r && newDangerous(0n, r.permissions.bitfield).length);
      if (risky.length) {
        let reverted = '';
        if (cfg.permRevert) {
          const target = await guild.members.fetch(entry.targetId ?? '').catch(() => null);
          if (target) reverted = await target.roles.remove(risky.map((r) => r!.id), 'AntiControl: dangerous role given by someone not trusted').then(() => ' → removed again', () => ' (could not remove)');
        }
        await log(ctx, guild, 'Permission Change Monitor', `<@${executor}> gave <@${entry.targetId}> ${risky.map((r) => `**${r!.name}**`).join(', ')} (dangerous permissions)${reverted}.`, 0xf59e0b);
      }
    }
  }
}

export function antiAuditWarn(ctx: ModuleContext, guild: Guild): void {
  if (ctx.enabled('anticontrol') && !guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    warn(ctx, 'WAR-2008', { module: 'anticontrol', problem: `the bot cannot read the audit log of ${guild.name} (AntiNuke, webhooks and permissions need View Audit Log)` });
  }
}

