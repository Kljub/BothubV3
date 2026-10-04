// Member modules: Welcomer, Leaver, Sticky Roles.

import { AuditLogEvent, PermissionFlagsBits, type GuildBan, type GuildMember, type PartialGuildMember } from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, idIn, idsIn, reactionOf, type MessageConfig, type ModuleContext } from './context.js';
import { allow, assignable, send, warn } from './guard.js';

/** Roles a rejoining member gets back. */
export function rolesToRestore(saved: string[], mode: unknown, selected: string[]): string[] {
  return mode === 'allowed' ? saved.filter((r) => selected.includes(r)) : saved.filter((r) => !selected.includes(r));
}

interface StickyState {
  roles: string[];
  at: string;
}

export async function onMemberAdd(ctx: ModuleContext, member: GuildMember): Promise<void> {
  const guild = member.guild;
  const vars = baseVars(guild, member);

  if (ctx.enabled('welcommer')) {
    const cfg = ctx.config<{ channelEnabled: boolean; channel: unknown; message: MessageConfig; reactions: string[]; dm: boolean; dmMessage: MessageConfig; roles: unknown; ignoreBots: boolean }>('welcommer');
    if (!(cfg.ignoreBots !== false && member.user.bot)) {
      const channelId = idIn(cfg.channel, guild.id);
      if (cfg.channelEnabled !== false && channelId) {
        const channel = guild.channels.cache.get(channelId);
        const payload = buildMessage(cfg.message, vars);
        if (channel?.isSendable() && payload) {
          const sent = await send(ctx, 'welcommer', channel, payload);
          for (const e of cfg.reactions ?? []) if (sent && allow(ctx, 'welcommer', sent.channelId)) await sent.react(reactionOf(e)).catch(() => undefined);
        }
      }
      if (cfg.dm && allow(ctx, 'welcommer', `dm:${member.id}`)) {
        const payload = buildMessage(cfg.dmMessage, vars);
        if (payload) await member.send(payload).catch(() => undefined);
      }
      const roles = assignable(ctx, 'welcommer', guild, idsIn(cfg.roles, guild.id));
      if (roles.length) await member.roles.add(roles, 'Welcomer').catch((err) => log.debug('welcome roles failed', { err: String(err) }));
    }
  }

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

export async function onMemberRemove(ctx: ModuleContext, member: GuildMember | PartialGuildMember): Promise<void> {
  const guild = member.guild;

  if (ctx.enabled('leavemer')) {
    const cfg = ctx.config<{ channel: unknown; message: MessageConfig; ignoreBots: boolean }>('leavemer');
    const channelId = idIn(cfg.channel, guild.id);
    // Members that were not cached arrive partial: fetch the user for the placeholders.
    const user = member.user ?? (await guild.client.users.fetch(member.id).catch(() => null));
    if (channelId && user && !(cfg.ignoreBots !== false && user.bot)) {
      const channel = guild.channels.cache.get(channelId);
      const vars = member.partial
        ? { ...baseVars(guild, null), user: user.globalName ?? user.username, 'user.id': user.id, 'user.name': user.username, 'user.mention': `<@${user.id}>`, 'user.avatar': user.displayAvatarURL() }
        : baseVars(guild, member);
      const payload = buildMessage(cfg.message, vars);
      if (channel?.isSendable() && payload) await send(ctx, 'leavemer', channel, payload);
    }
  }

  if (ctx.enabled('sticky-roles') && !member.partial) {
    const cfg = ctx.config<{ ignoreModeration: boolean }>('sticky-roles');
    const roles = [...member.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id);
    if (!roles.length) return;
    if (!cfg.ignoreModeration) {
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        warn(ctx, 'WAR-2008', { module: 'sticky-roles', problem: 'the bot cannot read the audit log, so kicks are treated as normal leaves' });
      }
      if (await removedByModeration(member)) return;
    }
    ctx.setState('sticky-roles', guild.id, `u:${member.id}`, { roles, at: new Date().toISOString() } satisfies StickyState);
  }
}

/** Bans remove the saved roles unless "also after kick or ban" is on. */
export function onBan(ctx: ModuleContext, ban: GuildBan): void {
  if (!ctx.enabled('sticky-roles')) return;
  const cfg = ctx.config<{ ignoreModeration: boolean }>('sticky-roles');
  if (!cfg.ignoreModeration) ctx.deleteState('sticky-roles', ban.guild.id, `u:${ban.user.id}`);
}

/** Kicked or banned? A kick shows up in the audit log a moment after the member left. */
async function removedByModeration(member: GuildMember | PartialGuildMember): Promise<boolean> {
  try {
    await new Promise((r) => setTimeout(r, 1500));
    if (await member.guild.bans.fetch(member.id).then(() => true, () => false)) return true;
    const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 });
    return logs.entries.some((e) => e.targetId === member.id && Date.now() - e.createdTimestamp < 15_000);
  } catch {
    return false; // no permission to read the audit log: treat as a normal leave
  }
}
