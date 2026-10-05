// Thanks (module "thanks"): /thanks @member gives a thank-you point. No
// thanks to yourself or bots; one per giver per cooldown (settings). Reward
// roles come at a number of thanks. Optional: messages like "thanks @member"
// count too (words of the settings). Points per server and member in
// module_state ("t:<id>" = { n }), the giver's last thanks in "c:<id>".

import type { Guild, GuildMember, Message } from 'discord.js';
import { assignable } from './guard.js';
import { idIn, type ModuleContext } from './context.js';

export interface ThanksConfig { cooldown: number; rewards: { count: number; role: unknown }[]; detect: boolean; words: string[] }

export class ThanksError extends Error {}

const cfgOf = (ctx: ModuleContext): Partial<ThanksConfig> => ctx.config<ThanksConfig>('thanks');

export function thanksOf(ctx: ModuleContext, guildId: string, userId: string): number {
  return ctx.getState<{ n: number }>('thanks', guildId, `t:${userId}`)?.n ?? 0;
}

/** Top members by thanks. */
export function thanksTop(ctx: ModuleContext, guildId: string, limit: number): { userId: string; n: number }[] {
  return (
    ctx.db
      .prepare(
        `SELECT key, json_extract(value, '$.n') AS n FROM module_state WHERE bot_id = ? AND module = 'thanks' AND guild_id = ? AND key LIKE 't:%'
         ORDER BY n DESC, updated_at ASC LIMIT ?`,
      )
      .all(ctx.botId, guildId, Math.max(1, Math.min(50, limit))) as { key: string; n: number }[]
  ).map((r) => ({ userId: r.key.slice(2), n: Number(r.n) || 0 }));
}

/** Place of a member in the ranking (1 = most thanks); 0 without thanks. */
export function thanksRank(ctx: ModuleContext, guildId: string, userId: string): number {
  const n = thanksOf(ctx, guildId, userId);
  if (!n) return 0;
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS c FROM module_state WHERE bot_id = ? AND module = 'thanks' AND guild_id = ? AND key LIKE 't:%' AND json_extract(value, '$.n') > ?`)
    .get(ctx.botId, guildId, n) as { c: number };
  return Number(row.c) + 1;
}

/** Gives one thank-you; returns the receiver's new count. */
export async function giveThanks(ctx: ModuleContext, guild: Guild, giverId: string, receiver: GuildMember, now = Date.now()): Promise<number> {
  if (receiver.id === giverId) throw new ThanksError('You cannot thank yourself.');
  if (receiver.user.bot) throw new ThanksError('Bots do not collect thanks.');
  const cfg = cfgOf(ctx);
  const cooldownMs = Math.max(0, Math.min(10_080, Number(cfg.cooldown ?? 60) || 0)) * 60_000;
  const last = ctx.getState<number>('thanks', guild.id, `c:${giverId}`) ?? 0;
  if (cooldownMs && now - last < cooldownMs) throw new ThanksError(`You can thank again <t:${Math.floor((last + cooldownMs) / 1000)}:R>.`);
  const n = thanksOf(ctx, guild.id, receiver.id) + 1;
  ctx.setState('thanks', guild.id, `t:${receiver.id}`, { n });
  ctx.setState('thanks', guild.id, `c:${giverId}`, now);
  await rewardRoles(ctx, guild, receiver, n);
  return n;
}

/** Reward roles for the reached number of thanks. */
async function rewardRoles(ctx: ModuleContext, guild: Guild, member: GuildMember, n: number): Promise<void> {
  const due = (cfgOf(ctx).rewards ?? [])
    .filter((r) => Number(r.count) > 0 && n >= Number(r.count))
    .map((r) => idIn(r.role, guild.id))
    .filter((id): id is string => !!id && !member.roles.cache.has(id));
  const roles = assignable(ctx, 'thanks', guild, due);
  if (roles.length) await member.roles.add(roles, `Thanks: ${n}`).catch(() => undefined);
}

/** "thanks @member" in a message counts when the setting is on. */
export async function thanksMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || !ctx.enabled('thanks')) return;
  const cfg = cfgOf(ctx);
  if (cfg.detect !== true) return;
  const words = (cfg.words?.length ? cfg.words : ['thanks', 'thank you', 'thx', 'danke']).map((w) => w.toLowerCase().trim()).filter(Boolean);
  const text = msg.content.toLowerCase();
  if (!words.some((w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(text))) return;
  const target = msg.mentions.members?.find((m) => m.id !== msg.author.id && !m.user.bot);
  if (!target) return;
  try {
    const n = await giveThanks(ctx, msg.guild, msg.author.id, target);
    await msg.react('🙏').catch(() => undefined);
    void n;
  } catch (err) {
    if (!(err instanceof ThanksError)) throw err; // cooldown or self: no answer to a normal chat message
  }
}
