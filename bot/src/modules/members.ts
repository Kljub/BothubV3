// Member modules: Welcomer, Leaver, Sticky Roles.

import {
  ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
  type APIEmbed, type ButtonInteraction, type Guild, type GuildBan, type GuildMember, type Interaction, type Message, type MessageCreateOptions, type PartialGuildMember, type User,
} from 'discord.js';
import { log } from '../core/log.js';
import { cardVars, renderCard } from '../cards/cards.js';
import { baseVars, buildMessage, fill, timeVars, idIn, idsIn, reactionOf, type MessageConfig, type ModuleContext } from './context.js';
import { allow, assignable, send, warn } from './guard.js';

/** Roles a rejoining member gets back. */
export function rolesToRestore(saved: string[], mode: unknown, selected: string[]): string[] {
  return mode === 'allowed' ? saved.filter((r) => selected.includes(r)) : saved.filter((r) => !selected.includes(r));
}

interface StickyState {
  roles: string[];
  at: string;
}

/** 1st, 2nd, 3rd, 4th, 11th, 112th … */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n.toLocaleString('en-US')}${suffix}`;
}

// ---------- Welcomer ----------

interface InviteWelcome {
  code: string;
  message: MessageConfig;
}

export interface WelcomeConfig {
  channelEnabled: boolean; channel: unknown; message: MessageConfig; card: string; reactions: string[];
  roleButtons: unknown; waveButton: boolean; deleteAfter: number;
  dm: boolean; dmMessage: MessageConfig;
  roles: unknown; removeRoles: unknown; nickname: string; ignoreBots: boolean;
  modChannel: unknown; modMessage: string;
  timing: 'now' | 'wait' | 'rules'; waitMinutes: number; skipQuickLeavers: boolean;
  returningEnabled: boolean; returningMessage: MessageConfig; milestoneEvery: number; milestoneMessage: MessageConfig;
  botEnabled: boolean; botMessage: MessageConfig; inviteWelcomes: InviteWelcome[];
  raidJoins: number; raidSeconds: number; minAccountDays: number; suspiciousAction: 'notify' | 'skip' | 'both'; rejoinLimit: number;
  rulesRole: unknown; firstMessage: string; stayDays: number; stayRole: unknown; kickAfterHours: number;
}

/** Per member, while the Welcomer still has something to do (module_state "m:<id>"). */
export interface WelcomeState {
  joined: number;
  /** Rules accepted (membership screening passed). */
  rules: boolean;
  /** Welcome not sent yet: at this time (wait) … */
  welcomeAt?: number;
  /** … or once the rules are accepted. */
  afterRules?: boolean;
  /** Reply to the first message still to come. */
  first?: boolean;
  stayDone?: boolean;
  /** The welcome message (deleted again when the member leaves quickly). */
  sent?: { channel: string; message: string; at: number };
  /** Variables of the join (invite, number). */
  vars?: Record<string, string>;
}

/** What the invite tracking found for a join. */
export interface JoinInfo {
  inviterId: string | null;
  inviterName: string;
  code: string | null;
}

/** Which message welcomes this member: invite, milestone, returning or the normal one. */
export function pickWelcome(cfg: Partial<WelcomeConfig>, j: { code: string | null; members: number; timesJoined: number }): MessageConfig | undefined {
  const hasBody = (m: MessageConfig | undefined) => !!m && !!buildMessage(m, {});
  const invite = j.code ? (cfg.inviteWelcomes ?? []).find((w) => w.code.toLowerCase() === j.code!.toLowerCase()) : undefined;
  if (invite && hasBody(invite.message)) return invite.message;
  if ((cfg.milestoneEvery ?? 0) > 0 && j.members % cfg.milestoneEvery! === 0 && hasBody(cfg.milestoneMessage)) return cfg.milestoneMessage;
  if (cfg.returningEnabled && j.timesJoined > 1 && hasBody(cfg.returningMessage)) return cfg.returningMessage;
  return cfg.message;
}

/** Joins in the last raidSeconds per server: more than raidJoins is a raid. */
const joinTimes = new Map<string, { times: number[]; warned: number }>();

export function raidCheck(key: string, limit: number, seconds: number, now = Date.now()): { raid: boolean; first: boolean } {
  if (limit <= 0) return { raid: false, first: false };
  const e = joinTimes.get(key) ?? { times: [], warned: 0 };
  e.times = [...e.times.filter((t) => now - t < seconds * 1000), now];
  joinTimes.set(key, e);
  const raid = e.times.length > limit;
  const first = raid && now - e.warned > seconds * 1000;
  if (first) e.warned = now;
  return { raid, first };
}

function joinsOf(ctx: ModuleContext, guildId: string, userId: string): { total: number; today: number } {
  const row = ctx.db
    .prepare("SELECT COUNT(*) AS total, SUM(joined_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS today FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND user_id = ?")
    .get(ctx.botId, guildId, userId) as { total: number; today: number | null };
  return { total: Math.max(1, Number(row.total)), today: Number(row.today ?? 0) };
}

/** A card of the Card Designer for a user, as a file of the message. */
async function addCard(ctx: ModuleContext, cardId: string | undefined, guild: Guild, user: User, member: GuildMember | null, vars: Record<string, string>, payload: MessageCreateOptions | null): Promise<MessageCreateOptions | null> {
  const id = Number(cardId);
  if (!cardId || !Number.isInteger(id) || id < 1) return payload;
  const png = await renderCard(ctx.db, ctx.botId, id, {
    ...vars,
    ...cardVars({
      guildName: guild.name, guildId: guild.id, members: guild.memberCount, userId: user.id, userName: user.username,
      display: member?.displayName ?? user.globalName ?? user.username, avatar: user.displayAvatarURL({ extension: 'png', size: 256 }),
      createdAt: user.createdTimestamp, joinedAt: member?.joinedTimestamp ?? null,
    }),
  });
  if (!png) return payload;
  const out: MessageCreateOptions = payload ?? { allowedMentions: { parse: ['users'] } };
  out.files = [{ attachment: png, name: 'card.png' }];
  // In an embed the card is its image; a text message just carries the file.
  const embed = out.embeds?.[0] as APIEmbed | undefined;
  if (embed && !embed.image) out.embeds = [{ ...embed, image: { url: 'attachment://card.png' } }];
  return out;
}

function buttonsRow(ctx: ModuleContext, cfg: Partial<WelcomeConfig>, guild: Guild, memberId: string): ActionRowBuilder<ButtonBuilder> | null {
  const buttons: ButtonBuilder[] = [];
  for (const id of idsIn(cfg.roleButtons, guild.id).slice(0, 3)) {
    const role = guild.roles.cache.get(id);
    if (!role) continue;
    buttons.push(new ButtonBuilder().setCustomId(`bhm:welcome:role:${id}`).setLabel(role.name.slice(0, 80)).setStyle(ButtonStyle.Secondary));
  }
  if (cfg.waveButton) buttons.push(new ButtonBuilder().setCustomId(`bhm:welcome:wave:${memberId}`).setLabel('Wave').setEmoji('👋').setStyle(ButtonStyle.Primary));
  return buttons.length ? new ActionRowBuilder<ButtonBuilder>().addComponents(buttons) : null;
}

async function tellMods(ctx: ModuleContext, module: string, guild: Guild, channelRef: unknown, text: string | undefined, vars: Record<string, string>): Promise<void> {
  const channel = guild.channels.cache.get(idIn(channelRef, guild.id) ?? '');
  if (!text?.trim() || !channel?.isSendable()) return;
  await send(ctx, module, channel, { content: fill(text, vars).slice(0, 2000), allowedMentions: { parse: [] } });
}

/** Message, card, buttons, DM, roles and nickname for a member (now, after the wait or after the rules). */
async function welcome(ctx: ModuleContext, member: GuildMember, vars: Record<string, string>, code: string | null): Promise<void> {
  const cfg = ctx.config<WelcomeConfig>('welcommer');
  const guild = member.guild;
  const state = ctx.getState<WelcomeState>('welcommer', guild.id, `m:${member.id}`);
  const channelId = idIn(cfg.channel, guild.id);
  if (cfg.channelEnabled !== false && channelId) {
    const channel = guild.channels.cache.get(channelId);
    const chosen = pickWelcome(cfg, { code, members: guild.memberCount, timesJoined: Number(vars.times_joined ?? 1) });
    let payload = await addCard(ctx, cfg.card, guild, member.user, member, vars, buildMessage(chosen, vars));
    const row = buttonsRow(ctx, cfg, guild, member.id);
    if (payload && row) payload = { ...payload, components: [row] };
    if (channel?.isSendable() && payload) {
      const sent = await send(ctx, 'welcommer', channel, payload);
      if (sent) {
        vars.welcome_message_link = sent.url;
        for (const e of cfg.reactions ?? []) if (allow(ctx, 'welcommer', sent.channelId)) await sent.react(reactionOf(e)).catch(() => undefined);
        const minutes = cfg.deleteAfter ?? 0;
        if (minutes > 0) setTimeout(() => void sent.delete().catch(() => undefined), minutes * 60_000).unref();
        if (state) ctx.setState('welcommer', guild.id, `m:${member.id}`, { ...state, sent: { channel: sent.channelId, message: sent.id, at: Date.now() } } satisfies WelcomeState);
      }
    }
  }
  if (cfg.dm && allow(ctx, 'welcommer', `dm:${member.id}`)) {
    const payload = buildMessage(cfg.dmMessage, vars);
    if (payload) await member.send(payload).catch(() => undefined);
  }
  const add = assignable(ctx, 'welcommer', guild, idsIn(cfg.roles, guild.id));
  if (add.length) await member.roles.add(add, 'Welcomer').catch((err) => log.debug('welcome roles failed', { err: String(err) }));
  const remove = assignable(ctx, 'welcommer', guild, idsIn(cfg.removeRoles, guild.id)).filter((id) => member.roles.cache.has(id));
  if (remove.length) await member.roles.remove(remove, 'Welcomer').catch(() => undefined);
  const nick = fill(cfg.nickname, vars).trim().slice(0, 32);
  if (nick && member.manageable) await member.setNickname(nick, 'Welcomer').catch(() => undefined);
  await tellMods(ctx, 'welcommer', guild, cfg.modChannel, cfg.modMessage, vars);
}

function welcomeVars(ctx: ModuleContext, member: GuildMember, info: JoinInfo | null): Record<string, string> {
  const joins = joinsOf(ctx, member.guild.id, member.id);
  return baseVars(member.guild, member, {
    member_number_ordinal: ordinal(member.guild.memberCount),
    inviter_name: info?.inviterName || '?',
    times_joined: String(joins.total),
    welcome_message_link: '',
  });
}

export async function onMemberAdd(ctx: ModuleContext, member: GuildMember, info: JoinInfo | null = null): Promise<void> {
  const guild = member.guild;
  const vars = baseVars(guild, member);

  if (ctx.enabled('welcommer')) await welcomeJoin(ctx, member, info).catch((err) => log.warn('welcomer failed', { botId: ctx.botId, err: String(err) }));

  if (ctx.enabled('sticky-roles')) {
    const state = ctx.getState<StickyState>('sticky-roles', guild.id, `u:${member.id}`);
    if (state?.roles.length) {
      const cfg = ctx.config<{ mode: string; roles: unknown; dm: boolean; dmMessage: MessageConfig }>('sticky-roles');
      const restore = assignable(ctx, 'sticky-roles', guild, rolesToRestore(state.roles, cfg.mode, idsIn(cfg.roles, guild.id)).filter((id) => guild.roles.cache.has(id)));
      if (restore.length) {
        await member.roles.add(restore, 'Sticky roles').catch((err) => log.debug('sticky roles failed', { err: String(err) }));
        if (cfg.dm) {
          const names = restore.map((id) => guild.roles.cache.get(id)?.name ?? id).join(', ');
          const payload = buildMessage(cfg.dmMessage, { ...vars, roles: names });
          if (payload) await member.send(payload).catch(() => undefined);
        }
      }
      ctx.deleteState('sticky-roles', guild.id, `u:${member.id}`);
    }
  }
}

async function welcomeJoin(ctx: ModuleContext, member: GuildMember, info: JoinInfo | null): Promise<void> {
  const cfg = ctx.config<WelcomeConfig>('welcommer');
  const guild = member.guild;
  const vars = welcomeVars(ctx, member, info);

  if (member.user.bot) {
    if (cfg.botEnabled) {
      const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
      const payload = buildMessage(cfg.botMessage, vars);
      if (channel?.isSendable() && payload) await send(ctx, 'welcommer', channel, payload);
      return;
    }
    if (cfg.ignoreBots !== false) return;
  }

  // Protection: many joins at once, new accounts, join/leave spam.
  const raid = raidCheck(`${ctx.botId}:${guild.id}`, cfg.raidJoins ?? 0, cfg.raidSeconds || 10);
  if (raid.first) await tellMods(ctx, 'welcommer', guild, cfg.modChannel, `⚠️ ${cfg.raidJoins! + 1}+ members joined within ${cfg.raidSeconds || 10} seconds: welcome messages are paused until it calms down.`, vars);
  if (raid.raid) return;
  const minDays = cfg.minAccountDays ?? 0;
  if (minDays > 0 && Date.now() - member.user.createdTimestamp < minDays * 86_400_000) {
    const action = cfg.suspiciousAction ?? 'notify';
    if (action !== 'skip') await tellMods(ctx, 'welcommer', guild, cfg.modChannel, `⚠️ New account joined: {user.mention} ({user.name}), created {user.created.ago}.`, vars);
    if (action !== 'notify') return;
  }
  if ((cfg.rejoinLimit ?? 0) > 0 && joinsOf(ctx, guild.id, member.id).today > cfg.rejoinLimit!) return;

  // Later actions keep a small state per member.
  const accepted = !member.pending;
  const state: WelcomeState = { joined: Date.now(), rules: accepted, vars: { inviter_name: vars.inviter_name!, times_joined: vars.times_joined!, code: info?.code ?? '' } };
  if (cfg.firstMessage?.trim()) state.first = true;
  const timing = cfg.timing ?? 'now';
  if (timing === 'wait') state.welcomeAt = Date.now() + Math.max(1, cfg.waitMinutes ?? 5) * 60_000;
  if (timing === 'rules' && !accepted) state.afterRules = true;
  const later = state.first || state.welcomeAt || state.afterRules || idIn(cfg.stayRole, guild.id) || (cfg.kickAfterHours ?? 0) > 0 || cfg.skipQuickLeavers;
  if (later) ctx.setState('welcommer', guild.id, `m:${member.id}`, state);

  if (accepted) await rulesAccepted(ctx, member);
  if (!state.welcomeAt && !state.afterRules) await welcome(ctx, member, vars, info?.code ?? null);
}

async function rulesAccepted(ctx: ModuleContext, member: GuildMember): Promise<void> {
  const cfg = ctx.config<WelcomeConfig>('welcommer');
  const role = assignable(ctx, 'welcommer', member.guild, [idIn(cfg.rulesRole, member.guild.id) ?? ''].filter(Boolean));
  if (role.length) await member.roles.add(role, 'Welcomer: rules accepted').catch(() => undefined);
}

/** Membership screening passed: rules role, and the welcome when it waits for the rules. */
export async function onMemberUpdate(ctx: ModuleContext, before: GuildMember | PartialGuildMember, after: GuildMember): Promise<void> {
  if (!ctx.enabled('welcommer') || !before.pending || after.pending) return;
  const key = `m:${after.id}`;
  const state = ctx.getState<WelcomeState>('welcommer', after.guild.id, key);
  if (state) ctx.setState('welcommer', after.guild.id, key, { ...state, rules: true, afterRules: false } satisfies WelcomeState);
  await rulesAccepted(ctx, after);
  if (state?.afterRules) await welcome(ctx, after, { ...welcomeVars(ctx, after, null), ...(state.vars ?? {}) }, state.vars?.code || null);
}

/** First message of a new member: the Welcomer answers it once. */
export async function welcomeFirstMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || !msg.member || !ctx.enabled('welcommer')) return;
  const cfg = ctx.config<WelcomeConfig>('welcommer');
  if (!cfg.firstMessage?.trim()) return;
  const key = `m:${msg.author.id}`;
  const state = ctx.getState<WelcomeState>('welcommer', msg.guildId, key);
  if (!state?.first) return;
  ctx.setState('welcommer', msg.guildId, key, { ...state, first: false } satisfies WelcomeState);
  if (!allow(ctx, 'welcommer', msg.channelId)) return;
  await msg.reply({ content: fill(cfg.firstMessage, baseVars(msg.guild, msg.member)).slice(0, 2000), allowedMentions: { parse: ['users'], repliedUser: true } }).catch(() => undefined);
}

/** Every 30 seconds: delayed welcomes, "stayed a while" roles, kicks without accepted rules. */
export async function welcomeTick(ctx: ModuleContext, guilds: Guild[], now = Date.now()): Promise<void> {
  if (!ctx.enabled('welcommer')) return;
  const cfg = ctx.config<WelcomeConfig>('welcommer');
  const rows = ctx.db.prepare("SELECT guild_id, key, value FROM module_state WHERE bot_id = ? AND module = 'welcommer' AND key LIKE 'm:%'").all(ctx.botId) as { guild_id: string; key: string; value: string }[];
  for (const r of rows) {
    let s: WelcomeState;
    try {
      s = JSON.parse(r.value) as WelcomeState;
    } catch {
      continue;
    }
    const guild = guilds.find((g) => g.id === r.guild_id);
    if (!guild) continue;
    const stayRole = idIn(cfg.stayRole, guild.id);
    const welcomeDue = !!s.welcomeAt && now >= s.welcomeAt;
    const stayDue = !!stayRole && !s.stayDone && (cfg.stayDays ?? 0) > 0 && now - s.joined >= cfg.stayDays! * 86_400_000;
    const kickDue = !s.rules && (cfg.kickAfterHours ?? 0) > 0 && now - s.joined >= cfg.kickAfterHours! * 3_600_000;
    const open = s.first || s.afterRules || !!s.welcomeAt || (!!stayRole && !s.stayDone && (cfg.stayDays ?? 0) > 0) || (!s.rules && (cfg.kickAfterHours ?? 0) > 0) || (s.sent && now - s.sent.at < 5 * 60_000);
    if (!open) {
      ctx.deleteState('welcommer', guild.id, r.key);
      continue;
    }
    if (!welcomeDue && !stayDue && !kickDue) continue;
    const member = await guild.members.fetch(r.key.slice(2)).catch(() => null);
    if (!member) {
      ctx.deleteState('welcommer', guild.id, r.key);
      continue;
    }
    if (kickDue && member.kickable) {
      await member.kick('Welcomer: rules not accepted in time').catch(() => undefined);
      ctx.deleteState('welcommer', guild.id, r.key);
      continue;
    }
    const next: WelcomeState = { ...s, welcomeAt: welcomeDue ? undefined : s.welcomeAt, stayDone: s.stayDone || stayDue };
    ctx.setState('welcommer', guild.id, r.key, next);
    if (welcomeDue) await welcome(ctx, member, { ...welcomeVars(ctx, member, null), ...(s.vars ?? {}) }, s.vars?.code || null);
    if (stayDue) {
      const give = assignable(ctx, 'welcommer', guild, [stayRole!]);
      if (give.length) await member.roles.add(give, 'Welcomer: stayed a while').catch(() => undefined);
    }
  }
}

/** bhm:welcome:<action>:<arg> buttons. */
export async function welcomeButtonRoute(ctx: ModuleContext, i: Interaction): Promise<void> {
  if (!i.isButton() || !i.customId.startsWith('bhm:welcome:') || !i.inCachedGuild()) return;
  const [, , action, arg] = i.customId.split(':');
  if (action && arg && /^\d{15,21}$/.test(arg)) await welcomeButton(ctx, i, action, arg);
}

/** Buttons under the welcome message: a role (on/off) or a wave. */
const waved = new Map<string, number>();

export async function welcomeButton(ctx: ModuleContext, i: ButtonInteraction<'cached'>, action: string, arg: string): Promise<void> {
  const cfg = ctx.config<WelcomeConfig>('welcommer');
  if (action === 'role') {
    if (!idsIn(cfg.roleButtons, i.guildId).includes(arg) || !assignable(ctx, 'welcommer', i.guild, [arg]).length) {
      await i.reply({ content: 'This role cannot be given here.', flags: 64 });
      return;
    }
    const has = i.member.roles.cache.has(arg);
    const ok = await (has ? i.member.roles.remove(arg, 'Welcome button') : i.member.roles.add(arg, 'Welcome button')).then(() => true, () => false);
    await i.reply({ content: ok ? `${has ? 'Removed' : 'Added'} <@&${arg}>.` : 'The bot could not change the role.', flags: 64, allowedMentions: { parse: [] } });
    return;
  }
  if (action === 'wave') {
    const key = `${ctx.botId}:${i.guildId}:${i.user.id}:${arg}`;
    for (const [k, t] of waved) if (Date.now() - t > 86_400_000) waved.delete(k);
    if (arg === i.user.id || waved.has(key)) {
      await i.reply({ content: arg === i.user.id ? 'Waving at yourself? 👋' : 'You already waved.', flags: 64 });
      return;
    }
    waved.set(key, Date.now());
    await i.reply({ content: `👋 <@${i.user.id}> waves at <@${arg}>!`, allowedMentions: { users: [arg] } });
  }
}

// ---------- Leaver ----------

export interface LeaveConfig {
  channel: unknown; message: MessageConfig; card: string; ignoreBots: boolean;
  kickedMessage: MessageConfig; bannedMessage: MessageConfig; prunedMessage: MessageConfig; botMessage: MessageConfig;
  quickMinutes: number; quickMessage: MessageConfig; troubleMessage: MessageConfig; longDays: number; longMessage: MessageConfig;
  modChannel: unknown; modMessage: string;
}

export type LeaveReason = 'left' | 'kicked' | 'banned' | 'pruned';

/** Which leave message: bot, kick/ban/prune, quick, in trouble, long-timer or the normal one. */
export function pickLeave(cfg: Partial<LeaveConfig>, l: { bot: boolean; reason: LeaveReason; stayMs: number | null; timedOut: boolean }): MessageConfig | undefined {
  const has = (m: MessageConfig | undefined) => !!m && !!buildMessage(m, {});
  if (l.bot && has(cfg.botMessage)) return cfg.botMessage;
  const byReason = { kicked: cfg.kickedMessage, banned: cfg.bannedMessage, pruned: cfg.prunedMessage, left: undefined }[l.reason];
  if (has(byReason)) return byReason;
  if (l.stayMs !== null && (cfg.quickMinutes ?? 0) > 0 && l.stayMs < cfg.quickMinutes! * 60_000 && has(cfg.quickMessage)) return cfg.quickMessage;
  if (l.timedOut && has(cfg.troubleMessage)) return cfg.troubleMessage;
  if (l.stayMs !== null && (cfg.longDays ?? 0) > 0 && l.stayMs >= cfg.longDays! * 86_400_000 && has(cfg.longMessage)) return cfg.longMessage;
  return cfg.message;
}

/** Why a member is gone: a ban, kick or prune shows up in the audit log a moment later. */
async function leaveReason(member: GuildMember | PartialGuildMember): Promise<LeaveReason> {
  try {
    await new Promise((r) => setTimeout(r, 1500));
    if (await member.guild.bans.fetch(member.id).then(() => true, () => false)) return 'banned';
    const recent = (e: { createdTimestamp: number }) => Date.now() - e.createdTimestamp < 15_000;
    const kicks = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 });
    if (kicks.entries.some((e) => e.targetId === member.id && recent(e))) return 'kicked';
    const prunes = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberPrune, limit: 1 });
    if (prunes.entries.some(recent)) return 'pruned';
  } catch {
    // no permission to read the audit log: a normal leave
  }
  return 'left';
}

export async function onMemberRemove(ctx: ModuleContext, member: GuildMember | PartialGuildMember): Promise<void> {
  const guild = member.guild;

  if (ctx.enabled('welcommer')) {
    // Left before the welcome: none is sent; a welcome of the last minutes is taken back.
    const key = `m:${member.id}`;
    const s = ctx.getState<WelcomeState>('welcommer', guild.id, key);
    if (s?.sent && ctx.config<WelcomeConfig>('welcommer').skipQuickLeavers && Date.now() - s.sent.at < 5 * 60_000) {
      const channel = guild.channels.cache.get(s.sent.channel);
      if (channel?.isTextBased()) await channel.messages.delete(s.sent.message).catch(() => undefined);
    }
    if (s) ctx.deleteState('welcommer', guild.id, key);
  }

  if (ctx.enabled('leavemer')) await leave(ctx, member).catch((err) => log.warn('leaver failed', { botId: ctx.botId, err: String(err) }));

  if (ctx.enabled('sticky-roles') && !member.partial) {
    const cfg = ctx.config<{ ignoreModeration: boolean }>('sticky-roles');
    const roles = [...member.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id);
    if (!roles.length) return;
    if (!cfg.ignoreModeration) {
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        warn(ctx, 'WAR-2008', { module: 'sticky-roles', problem: 'the bot cannot read the audit log, so kicks are treated as normal leaves' });
      }
      if ((await leaveReason(member)) !== 'left') return;
    }
    ctx.setState('sticky-roles', guild.id, `u:${member.id}`, { roles, at: new Date().toISOString() } satisfies StickyState);
  }
}

async function leave(ctx: ModuleContext, member: GuildMember | PartialGuildMember): Promise<void> {
  const guild = member.guild;
  const cfg = ctx.config<LeaveConfig>('leavemer');
  // Members that were not cached arrive partial: fetch the user for the placeholders.
  const user = member.user ?? (await guild.client.users.fetch(member.id).catch(() => null));
  if (!user) return;
  const bot = user.bot;
  if (bot && cfg.ignoreBots !== false && !buildMessage(cfg.botMessage, {})) return;
  const reason = await leaveReason(member);
  const joinedAt = member.joinedTimestamp ?? null;
  const vars = {
    ...(member.partial
      ? { ...baseVars(guild, null), user: user.globalName ?? user.username, 'user.id': user.id, 'user.name': user.username, 'user.mention': `<@${user.id}>`, 'user.avatar': user.displayAvatarURL(), ...timeVars(user, joinedAt) }
      : baseVars(guild, member)),
    leave_reason: reason,
    times_joined: String(joinsOf(ctx, guild.id, user.id).total),
  };
  const chosen = pickLeave(cfg, {
    bot, reason, stayMs: joinedAt ? Date.now() - joinedAt : null,
    timedOut: !member.partial && (member.communicationDisabledUntilTimestamp ?? 0) > Date.now(),
  });
  const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
  const payload = await addCard(ctx, cfg.card, guild, user, member.partial ? null : member, vars, buildMessage(chosen, vars));
  if (channel?.isSendable() && payload) await send(ctx, 'leavemer', channel, payload);
  await tellMods(ctx, 'leavemer', guild, cfg.modChannel, cfg.modMessage, vars);
}

/** Bans remove the saved roles unless "also after kick or ban" is on. */
export function onBan(ctx: ModuleContext, ban: GuildBan): void {
  if (!ctx.enabled('sticky-roles')) return;
  const cfg = ctx.config<{ ignoreModeration: boolean }>('sticky-roles');
  if (!cfg.ignoreModeration) ctx.deleteState('sticky-roles', ban.guild.id, `u:${ban.user.id}`);
}
