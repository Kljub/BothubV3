// Boost module: a message when a member boosts the server for the first
// time, boosts again or stops boosting; roles while boosting, a thank-you DM.
// Boosts are seen two ways: Discord's boost system message (every boost) and
// the member's "boosting since" (start and stop); a boost seen both ways
// within two minutes counts once.

import { MessageType, type GuildMember, type Message, type PartialGuildMember } from 'discord.js';
import { stats } from '../core/stats.js';
import { baseVars, buildMessage, idIn, idsIn, type MessageConfig, type ModuleContext } from './context.js';
import { allow, assignable, send } from './guard.js';
import { addCard } from './members.js';

interface BoostConfig {
  channel: unknown; firstMessage: MessageConfig; againMessage: MessageConfig; stopMessage: MessageConfig; card: string;
  roles: unknown; dm: boolean; dmMessage: MessageConfig;
}

interface BoostState {
  count: number;
  first: string;
}

const BOOST_TYPES = new Set<MessageType>([MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]);
const recent = new Map<string, number>();

/** True when this boost of the member was already handled in the last two minutes. */
export function seenBoost(key: string, now = Date.now()): boolean {
  for (const [k, t] of recent) if (now - t > 120_000) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

async function boosted(ctx: ModuleContext, member: GuildMember, kind: 'boost' | 'stop'): Promise<void> {
  if (!ctx.enabled('boost')) return;
  const guild = member.guild;
  if (kind === 'boost' && seenBoost(`${ctx.botId}:${guild.id}:${member.id}`)) return;
  const cfg = ctx.config<BoostConfig>('boost');
  const key = `u:${member.id}`;
  const state = ctx.getState<BoostState>('boost', guild.id, key) ?? { count: 0, first: new Date().toISOString() };
  let path: 'first' | 'again' | 'stop' = 'stop';
  if (kind === 'boost') {
    state.count += 1;
    ctx.setState('boost', guild.id, key, state);
    path = state.count === 1 ? 'first' : 'again';
  }
  stats(ctx.db).add(ctx.botId, guild.id, `path:boost:${path}`);
  const vars = baseVars(guild, member, {
    boost_count: String(guild.premiumSubscriptionCount ?? 0),
    boosts: String(guild.premiumSubscriptionCount ?? 0), // the boost card templates use {boosts}
    boost_level: String(guild.premiumTier),
    times_boosted: String(state.count),
  });
  const message = { first: cfg.firstMessage, again: cfg.againMessage, stop: cfg.stopMessage }[path];
  const channel = guild.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
  const text = buildMessage(message, vars);
  // The card goes with boost messages only, not with "stopped boosting".
  const payload = path === 'stop' ? text : await addCard(ctx, cfg.card, guild, member.user, member, vars, text);
  if (channel?.isSendable() && payload) await send(ctx, 'boost', channel, payload);

  const roles = assignable(ctx, 'boost', guild, idsIn(cfg.roles, guild.id));
  if (path === 'stop') {
    const drop = roles.filter((r) => member.roles.cache.has(r));
    if (drop.length) await member.roles.remove(drop, 'Stopped boosting').catch(() => undefined);
    return;
  }
  if (roles.length) await member.roles.add(roles, 'Server booster').catch(() => undefined);
  if (cfg.dm && allow(ctx, 'boost', `dm:${member.id}`)) {
    const dm = buildMessage(cfg.dmMessage, vars);
    if (dm) await member.send(dm).catch(() => undefined);
  }
}

/** Discord's "… just boosted the server!" message. */
export async function boostMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || !BOOST_TYPES.has(msg.type) || !ctx.enabled('boost')) return;
  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (member) await boosted(ctx, member, 'boost');
}

/** "Boosting since" set or cleared. */
export async function boostChange(ctx: ModuleContext, before: GuildMember | PartialGuildMember, after: GuildMember): Promise<void> {
  if (before.partial || !ctx.enabled('boost')) return;
  if (!before.premiumSinceTimestamp && after.premiumSinceTimestamp) await boosted(ctx, after, 'boost');
  else if (before.premiumSinceTimestamp && !after.premiumSinceTimestamp) await boosted(ctx, after, 'stop');
}
