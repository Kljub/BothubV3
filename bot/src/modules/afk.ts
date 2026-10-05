// AFK (module "afk"): /afk set <reason> marks a member as away. Whoever
// mentions them gets "💤 … is AFK: <reason> (since …)"; their next message
// ends the AFK status ("Welcome back"). Optional: "[AFK] " in front of the
// nickname while away (needs Manage Nicknames; owners and higher roles keep
// their name). State per server and member in module_state ("u:<id>").

import type { GuildMember, Message } from 'discord.js';
import type { ModuleContext } from './context.js';
import { tempNotice } from './messages.js';

export interface AfkConfig { nickPrefix: boolean; prefix: string; endOnMessage: boolean; deleteAfter: number }
interface AfkState { reason: string; since: number; nick: string | null }

const cfgOf = (ctx: ModuleContext): Partial<AfkConfig> => ctx.config<AfkConfig>('afk');
const prefixOf = (cfg: Partial<AfkConfig>): string => (typeof cfg.prefix === 'string' && cfg.prefix.trim() ? cfg.prefix : '[AFK] ').slice(0, 10);

export function afkOf(ctx: ModuleContext, guildId: string, userId: string): AfkState | undefined {
  return ctx.getState<AfkState>('afk', guildId, `u:${userId}`);
}

/** Marks a member as AFK (and puts the prefix in front of the nickname when set up). */
export async function setAfk(ctx: ModuleContext, member: GuildMember, reason: string, now = Date.now()): Promise<AfkState> {
  const cfg = cfgOf(ctx);
  const old = afkOf(ctx, member.guild.id, member.id);
  const state: AfkState = { reason: reason.trim().slice(0, 200) || 'AFK', since: now, nick: old ? old.nick : member.nickname };
  ctx.setState('afk', member.guild.id, `u:${member.id}`, state);
  if (cfg.nickPrefix !== false && member.manageable) {
    const prefix = prefixOf(cfg);
    const name = member.displayName.startsWith(prefix) ? member.displayName : `${prefix}${member.displayName}`.slice(0, 32);
    await member.setNickname(name, 'AFK').catch(() => undefined);
  }
  return state;
}

/** Ends the AFK status; null when the member was not AFK. */
export async function clearAfk(ctx: ModuleContext, member: GuildMember): Promise<AfkState | null> {
  const state = afkOf(ctx, member.guild.id, member.id);
  if (!state) return null;
  ctx.deleteState('afk', member.guild.id, `u:${member.id}`);
  const prefix = prefixOf(cfgOf(ctx));
  if (member.manageable && member.displayName.startsWith(prefix)) await member.setNickname(state.nick, 'AFK ended').catch(() => undefined);
  return state;
}

/** Messages: mentions of AFK members get a note, the author's next message ends their AFK status. */
export async function afkMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || !ctx.enabled('afk')) return;
  const cfg = cfgOf(ctx);
  const ms = Math.max(0, Math.min(300, Number(cfg.deleteAfter ?? 10) || 0)) * 1000;
  const channel = msg.channel;
  if (!channel.isSendable()) return;
  if (cfg.endOnMessage !== false && msg.member) {
    const ended = await clearAfk(ctx, msg.member);
    if (ended) await tempNotice(ctx, 'afk', channel, `👋 Welcome back <@${msg.author.id}>! You were AFK since <t:${Math.floor(ended.since / 1000)}:R>.`, ms);
  }
  const notes: string[] = [];
  for (const user of msg.mentions.users.values()) {
    if (user.id === msg.author.id || user.bot) continue;
    const state = afkOf(ctx, msg.guildId, user.id);
    if (state) notes.push(`💤 **${msg.guild.members.cache.get(user.id)?.displayName ?? user.username}** is AFK: ${state.reason} (since <t:${Math.floor(state.since / 1000)}:R>)`);
    if (notes.length >= 5) break;
  }
  if (notes.length) await tempNotice(ctx, 'afk', channel, notes.join('\n'), ms);
}
