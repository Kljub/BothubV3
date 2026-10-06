// Achievements (module "achievements") with Daily Challenges. Members get
// achievements for activity (messages, minutes in voice, reactions,
// commands, days on the server, level of the Leveling module) and the
// server's daily challenges (e.g. "write 20 messages today"); both can pay
// Economy coins and give a role. Counts are kept in memory and written every
// 30 seconds (one write per active member, not per message).
//
// module_state "u:<user>" = MemberAch (per server).

import type { Guild, GuildMember, Interaction, Message, MessageReaction, PartialMessageReaction, PartialUser, User, VoiceState } from 'discord.js';
import { idIn, type ModuleContext } from './context.js';
import { assignable, send } from './guard.js';

export type Metric = 'messages' | 'voice' | 'reactions' | 'commands' | 'days' | 'level';
const COUNTED = ['messages', 'voice', 'reactions', 'commands'] as const;
type Counted = (typeof COUNTED)[number];

export interface Achievement { _id?: string; name: string; description: string; emoji: string; metric: Metric; goal: number; role: unknown; coins: number; hidden: boolean }
export interface Challenge { _id?: string; name: string; metric: Counted; goal: number; coins: number }
interface AchConfig {
  channel: unknown; dm: boolean; achievements: Achievement[];
  dailyEnabled: boolean; dailyCount: number; streakCoins: number; challenges: Challenge[];
}
export interface MemberAch {
  total: Record<Counted, number>;
  unlocked: string[];
  day: { date: string; counts: Record<Counted, number>; done: string[] };
  streak: number;
  lastFull: string; // the last day all challenges were done
}

const zero = (): Record<Counted, number> => ({ messages: 0, voice: 0, reactions: 0, commands: 0 });
const keyOf = (a: { _id?: string; name: string }) => a._id ?? a.name;

/** Today as YYYY-MM-DD (UTC; the challenges change at midnight UTC). */
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** The challenges of a day: the same for everybody on the server, picked from the pool by the date. */
export function challengesOf(pool: Challenge[], date: string, guildId: string, count: number): Challenge[] {
  const list = pool.filter((c) => c?.name && c.goal > 0);
  let h = 2166136261;
  for (const ch of `${date}|${guildId}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const order = list.map((c, i) => ({ c, r: Math.imul(h ^ (i + 1) * 2654435761, 2246822519) >>> 0 })).sort((a, b) => a.r - b.r);
  return order.slice(0, Math.max(1, Math.min(5, count))).map((o) => o.c);
}

/** Pending counts in memory: botId → guild → user → counts. */
const pending = new Map<number, Map<string, Map<string, Record<Counted, number>>>>();
const voiceSince = new Map<string, number>(); // bot:guild:user → time of joining (or the last count)

function bump(ctx: ModuleContext, guildId: string, userId: string, metric: Counted, n = 1): void {
  if (!ctx.enabled('achievements') || n <= 0) return;
  let g = pending.get(ctx.botId);
  if (!g) pending.set(ctx.botId, (g = new Map()));
  let u = g.get(guildId);
  if (!u) g.set(guildId, (u = new Map()));
  const c = u.get(userId) ?? zero();
  c[metric] += n;
  u.set(userId, c);
}

export function load(ctx: ModuleContext, guildId: string, userId: string, date = today()): MemberAch {
  const s = ctx.getState<MemberAch>('achievements', guildId, `u:${userId}`);
  const base: MemberAch = { total: zero(), unlocked: [], day: { date, counts: zero(), done: [] }, streak: 0, lastFull: '' };
  const m = s ? { ...base, ...s, total: { ...zero(), ...s.total } } : base;
  if (m.day?.date !== date) m.day = { date, counts: zero(), done: [] };
  return m;
}

/** State with the counts not written yet (for the blocks). */
export function current(ctx: ModuleContext, guildId: string, userId: string): MemberAch {
  const m = load(ctx, guildId, userId);
  const p = pending.get(ctx.botId)?.get(guildId)?.get(userId);
  if (p) for (const k of COUNTED) {
    m.total[k] += p[k];
    m.day.counts[k] += p[k];
  }
  return m;
}

/** Value of a metric for an achievement. */
export function valueOf(m: MemberAch, metric: Metric, extra: { days: number; level: number }): number {
  if (metric === 'days') return extra.days;
  if (metric === 'level') return extra.level;
  return m.total[metric] ?? 0;
}

/** Achievements reached now and not unlocked before. */
export function newlyUnlocked(m: MemberAch, list: Achievement[], extra: { days: number; level: number }): Achievement[] {
  return list.filter((a) => a?.name && a.goal > 0 && !m.unlocked.includes(keyOf(a)) && valueOf(m, a.metric, extra) >= a.goal);
}

/** Challenges done now and not done before (today). */
export function newlyDone(m: MemberAch, todays: Challenge[]): Challenge[] {
  return todays.filter((c) => !m.day.done.includes(keyOf(c)) && (m.day.counts[c.metric] ?? 0) >= c.goal);
}

const bar = (v: number, goal: number) => {
  const f = Math.max(0, Math.min(10, Math.round((v / goal) * 10)));
  return `${'▰'.repeat(f)}${'▱'.repeat(10 - f)} ${Math.min(v, goal)}/${goal}`;
};
const METRIC_TEXT: Record<Metric, string> = { messages: 'messages', voice: 'minutes in voice', reactions: 'reactions', commands: 'commands', days: 'days on the server', level: 'level' };

/** Text of /achievements: unlocked ones and the progress of the others (hidden ones only when unlocked). */
export function achievementsText(m: MemberAch, list: Achievement[], extra: { days: number; level: number }): string {
  const lines: string[] = [];
  for (const a of list.filter((x) => x?.name && x.goal > 0)) {
    const got = m.unlocked.includes(keyOf(a));
    if (!got && a.hidden) continue;
    const icon = a.emoji?.trim() || '🏆';
    lines.push(got ? `${icon} **${a.name}** ✅` : `🔒 **${a.name}** — ${bar(valueOf(m, a.metric, extra), a.goal)} ${METRIC_TEXT[a.metric]}`);
  }
  return lines.join('\n') || 'No achievements set up yet.';
}

/** Text of /daily-challenges. */
export function dailyText(m: MemberAch, todays: Challenge[], streakCoins: number): string {
  const lines = todays.map((c) => `${m.day.done.includes(keyOf(c)) ? '✅' : '⬜'} **${c.name}** — ${bar(m.day.counts[c.metric] ?? 0, c.goal)} ${METRIC_TEXT[c.metric]}${c.coins ? ` · 💰 ${c.coins}` : ''}`);
  const next = new Date(`${today()}T00:00:00Z`).getTime() / 1000 + 86400;
  lines.push('', `🔥 Streak: **${m.streak}** day(s)${streakCoins ? ` · all done: +${streakCoins} × streak` : ''} · new challenges <t:${next}:R>`);
  return lines.join('\n');
}

/** Every 30 seconds: write the counts, unlock achievements, finish challenges, pay rewards. */
export async function flushAchievements(ctx: ModuleContext, guilds: Guild[], now = Date.now()): Promise<void> {
  // Members in voice: the minutes since the last count.
  for (const [k, since] of voiceSince) {
    const [bot, guildId, userId] = k.split(':');
    if (Number(bot) !== ctx.botId) continue;
    const minutes = Math.floor((now - since) / 60_000);
    if (minutes > 0) {
      bump(ctx, guildId!, userId!, 'voice', minutes);
      voiceSince.set(k, since + minutes * 60_000);
    }
  }
  const byGuild = pending.get(ctx.botId);
  if (!byGuild?.size) return;
  pending.delete(ctx.botId);
  if (!ctx.enabled('achievements')) return;
  const cfg = ctx.config<AchConfig>('achievements');
  const date = today(now);
  for (const [guildId, users] of byGuild) {
    const guild = guilds.find((g) => g.id === guildId);
    if (!guild) continue;
    const todays = cfg.dailyEnabled !== false ? challengesOf(cfg.challenges ?? [], date, guildId, cfg.dailyCount ?? 3) : [];
    for (const [userId, counts] of users) {
      const m = load(ctx, guildId, userId, date);
      for (const k of COUNTED) {
        m.total[k] += counts[k];
        m.day.counts[k] += counts[k];
      }
      const member = guild.members.cache.get(userId) ?? null;
      const extra = { days: member?.joinedTimestamp ? Math.floor((now - member.joinedTimestamp) / 86_400_000) : 0, level: levelOf(ctx, guildId, userId) };
      const got = newlyUnlocked(m, cfg.achievements ?? [], extra);
      const done = newlyDone(m, todays);
      m.unlocked.push(...got.map(keyOf));
      m.day.done.push(...done.map(keyOf));
      let streakPay = 0;
      if (todays.length && done.length && todays.every((c) => m.day.done.includes(keyOf(c))) && m.lastFull !== date) {
        const yesterday = today(now - 86_400_000);
        m.streak = m.lastFull === yesterday ? m.streak + 1 : 1;
        m.lastFull = date;
        streakPay = Math.max(0, cfg.streakCoins ?? 0) * m.streak;
      }
      ctx.setState('achievements', guildId, `u:${userId}`, m);
      if (got.length || done.length || streakPay) await reward(ctx, guild, member, userId, cfg, got, done, streakPay, m.streak);
    }
  }
}

function levelOf(ctx: ModuleContext, guildId: string, userId: string): number {
  try {
    const row = ctx.db.prepare('SELECT level FROM leveling_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(ctx.botId, guildId, userId) as { level: number } | undefined;
    return row?.level ?? 0;
  } catch {
    return 0;
  }
}

async function reward(ctx: ModuleContext, guild: Guild, member: GuildMember | null, userId: string, cfg: Partial<AchConfig>, got: Achievement[], done: Challenge[], streakPay: number, streak: number): Promise<void> {
  const coins = got.reduce((s, a) => s + Math.max(0, a.coins || 0), 0) + done.reduce((s, c) => s + Math.max(0, c.coins || 0), 0) + streakPay;
  if (coins > 0) ctx.repo.changeBalance(ctx.botId, guild.id, userId, coins, 'add');
  const roles = assignable(ctx, 'achievements', guild, got.map((a) => idIn(a.role, guild.id)).filter((r): r is string => !!r));
  if (member && roles.length) await member.roles.add(roles, 'Achievement').catch(() => undefined);
  const lines = [
    ...got.map((a) => `${a.emoji?.trim() || '🏆'} <@${userId}> unlocked **${a.name}**${a.description ? ` — ${a.description}` : ''}${a.coins ? ` (+${a.coins} 💰)` : ''}`),
    ...done.map((c) => `🎯 <@${userId}> finished the daily challenge **${c.name}**${c.coins ? ` (+${c.coins} 💰)` : ''}`),
    ...(streakPay ? [`🔥 <@${userId}> did all daily challenges — streak **${streak}** (+${streakPay} 💰)`] : []),
  ];
  const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
  if (channel?.isSendable()) await send(ctx, 'achievements', channel, { content: lines.join('\n').slice(0, 2000), allowedMentions: { users: [userId] } });
  else if (cfg.dm && member) await member.send(lines.join('\n').replace(`<@${userId}> `, 'You ').slice(0, 2000)).catch(() => undefined);
}

// ---------- event adapters ----------

export function achMessage(ctx: ModuleContext, msg: Message): void {
  if (msg.inGuild() && !msg.author.bot && !msg.system) bump(ctx, msg.guildId, msg.author.id, 'messages');
}

export function achReaction(ctx: ModuleContext, r: MessageReaction | PartialMessageReaction, u: User | PartialUser): void {
  if (!u.bot && r.message.guildId) bump(ctx, r.message.guildId, u.id, 'reactions');
}

export function achCommand(ctx: ModuleContext, i: Interaction): void {
  if (i.isChatInputCommand() && i.guildId && !i.user.bot) bump(ctx, i.guildId, i.user.id, 'commands');
}

export function achVoice(ctx: ModuleContext, before: VoiceState, after: VoiceState, now = Date.now()): void {
  const member = after.member ?? before.member;
  if (!member || member.user.bot) return;
  const k = `${ctx.botId}:${after.guild.id}:${member.id}`;
  const counts = (s: VoiceState) => !!s.channelId && s.channelId !== s.guild.afkChannelId && !s.selfDeaf;
  if (counts(after) && !voiceSince.has(k)) voiceSince.set(k, now);
  if (!counts(after) && voiceSince.has(k)) {
    const minutes = Math.floor((now - voiceSince.get(k)!) / 60_000);
    voiceSince.delete(k);
    bump(ctx, after.guild.id, member.id, 'voice', minutes);
  }
}
