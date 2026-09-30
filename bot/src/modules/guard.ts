// Safety rails shared by all modules: a send budget per bot and channel,
// and checks before a role is assigned. Problems are written to the bot log
// (at most once per 10 minutes per kind), never thrown.

import { PermissionFlagsBits, type Guild, type Message, type MessageCreateOptions, type SendableChannels } from 'discord.js';
import type { ModuleContext } from './context.js';

/** Token bucket: capacity tokens, refilled completely over windowMs. */
export class Bucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / this.windowMs) * this.capacity);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Per bot: 30 sends per 10 s; per channel: 5 sends per 5 s. */
export class SendLimiter {
  private readonly bot = new Bucket(30, 10_000);
  private readonly channels = new Map<string, Bucket>();

  allow(channelId: string, now = Date.now()): boolean {
    let ch = this.channels.get(channelId);
    if (!ch) {
      if (this.channels.size > 5000) this.channels.clear();
      ch = new Bucket(5, 5000, now);
      this.channels.set(channelId, ch);
    }
    return ch.take(now) && this.bot.take(now);
  }
}

const limiters = new WeakMap<ModuleContext, SendLimiter>();
const warned = new Map<string, number>();

/** Writes a module warning to the bot log, at most every 10 minutes per key. */
export function warn(ctx: ModuleContext, code: 'WAR-2006' | 'WAR-2007' | 'WAR-2008', params: Record<string, string>): void {
  const key = `${ctx.botId}:${code}:${Object.values(params).join(':')}`;
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < 600_000) return;
  warned.set(key, now);
  ctx.repo.logCode(ctx.botId, code, params);
}

/** Takes one unit of the send budget (for replies, reactions …). */
export function allow(ctx: ModuleContext, module: string, channelId: string): boolean {
  let limiter = limiters.get(ctx);
  if (!limiter) {
    limiter = new SendLimiter();
    limiters.set(ctx, limiter);
  }
  if (limiter.allow(channelId)) return true;
  warn(ctx, 'WAR-2006', { module, channel: channelId });
  return false;
}

/** Sends through the module send budget; null when dropped or failed. */
export async function send(ctx: ModuleContext, module: string, channel: SendableChannels, payload: MessageCreateOptions | string): Promise<Message | null> {
  if (!allow(ctx, module, channel.id)) return null;
  return channel.send(payload).catch(() => null);
}

/** Why a role cannot be assigned by the bot, or null when it can. */
export function roleProblem(guild: Guild, roleId: string): string | null {
  const role = guild.roles.cache.get(roleId);
  if (!role) return 'deleted';
  if (roleId === guild.id) return '@everyone';
  if (role.managed) return 'managed by an integration';
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 'bot lacks Manage Roles';
  if (role.position >= me.roles.highest.position) return 'above the bot role';
  return null;
}

/** The roles the bot can assign; logs the others. */
export function assignable(ctx: ModuleContext, module: string, guild: Guild, roleIds: string[]): string[] {
  return roleIds.filter((id) => {
    const problem = roleProblem(guild, id);
    if (problem) warn(ctx, 'WAR-2007', { module, role: guild.roles.cache.get(id)?.name ?? id, reason: problem });
    return !problem;
  });
}
