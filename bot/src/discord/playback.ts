// Playbacks and errors that tell why: the trace of a run for the builder,
// "When it fails" of the trigger (what members see, staff alert, stop or
// continue) and a check before the run for blocks that would fail.

import { EmbedBuilder, PermissionFlagsBits, type Guild, type GuildMember, type SendableChannels, type User } from 'discord.js';
import type { CommandRow, RunTrace } from '../core/repo.js';
import { explain, permissionKind, type Hint, type RunErrorTexts } from '../graph/explain.js';
import type { Run, RunResult } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';

export const FRIENDLY_FAIL = 'Something went wrong while running this command.';

export interface FailConfig {
  reply: 'friendly' | 'reason' | 'none';
  message: string;
  channel: string;
  flow: 'stop' | 'continue';
  record: boolean;
}

function trigger(cmd: CommandRow): GraphNode | undefined {
  return cmd.graph.nodes.find((n) => n.type === 'trigger.slash' || n.type === 'trigger.event' || n.type === 'trigger.timed');
}

export function failConfig(cmd: CommandRow): FailConfig {
  const c = trigger(cmd)?.config ?? {};
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '');
  const reply = s('fail_reply');
  return {
    reply: reply === 'reason' || reply === 'none' ? reply : 'friendly',
    message: s('fail_message').slice(0, 500) || FRIENDLY_FAIL,
    channel: /^\d{17,20}$/.test(s('fail_channel')) ? s('fail_channel') : '',
    flow: s('fail_flow') === 'continue' ? 'continue' : 'stop',
    record: c.record_runs !== false,
  };
}

/** Sets the trace and fail flow of a run from its trigger. */
export function prepare(run: Run, cmd: CommandRow): FailConfig {
  const f = failConfig(cmd);
  run.trace = f.record;
  run.failFlow = f.flow;
  return f;
}

/** The reason of a failed run, or null (ok or no text). */
export function hintOf(result: RunResult, texts: RunErrorTexts | undefined): Hint | null {
  if (result.ok || !result.errorKey || !texts) return null;
  return explain(result.errorNode?.type ?? '', result.errorKey, result.errorParams ?? {}, texts);
}

/** The plain-language reason for Discord (members with "reason", owner tips). */
export function reasonText(result: RunResult, hint: Hint | null): string {
  if (hint) return hint.text;
  return (result.errorMessage ?? 'A block failed.').slice(0, 500);
}

export interface TraceContext {
  source: string;
  user: User | null;
  guild: Guild | null;
  channel: SendableChannels | null;
  warnings?: { node: string; text: string }[];
}

export function traceOf(botId: number, cmd: CommandRow, runKey: string, run: Run, result: RunResult, hint: Hint | null, ctx: TraceContext, startVars: Record<string, string>): RunTrace {
  const ch = ctx.channel as { id?: string; name?: string } | null;
  return {
    botId,
    commandId: cmd.id,
    runKey,
    source: ctx.source,
    userId: ctx.user?.id ?? null,
    userName: ctx.user ? (ctx.user.globalName ?? ctx.user.username) : null,
    guildId: ctx.guild?.id ?? null,
    guildName: ctx.guild?.name ?? null,
    channelId: ch?.id ?? null,
    channelName: ch?.name ?? null,
    ok: result.ok,
    errorNode: result.ok ? null : (result.errorNode?.id ?? null),
    errorKey: result.ok ? null : (result.errorKey ?? null),
    errorHint: hint,
    errorText: result.ok ? null : (result.errorMessage ?? null),
    startVars,
    steps: run.steps,
    warnings: ctx.warnings ?? [],
  };
}

/** The staff alert of "When it fails". */
export function alertEmbed(cmd: CommandRow, result: RunResult, hint: Hint | null, ctx: TraceContext): EmbedBuilder {
  const block = result.errorNode ? result.errorNode.label || result.errorNode.type : '–';
  const where = [ctx.user ? `<@${ctx.user.id}>` : '', ctx.channel && 'id' in ctx.channel ? `<#${ctx.channel.id}>` : ''].filter(Boolean).join(' in ');
  const e = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️ ${cmd.kind === 'command' ? `/${cmd.name}` : cmd.name} failed`.slice(0, 256))
    .setDescription(reasonText(result, hint).slice(0, 2000))
    .addFields({ name: 'Block', value: block.slice(0, 1024), inline: true })
    .setTimestamp(new Date());
  if (where) e.addFields({ name: 'Who / where', value: where.slice(0, 1024), inline: true });
  if (hint?.fix) e.addFields({ name: 'How to fix', value: hint.fix.slice(0, 1024) });
  if (hint && result.errorMessage && result.errorMessage !== hint.text) e.addFields({ name: 'Discord said', value: result.errorMessage.slice(0, 1024) });
  return e;
}

/** The private fix tip for the bot owner. */
export function ownerTip(result: RunResult, hint: Hint | null): string {
  const block = result.errorNode ? `**${(result.errorNode.label || result.errorNode.type).slice(0, 80)}**` : 'A block';
  const lines = [`🔧 ${block} failed: ${reasonText(result, hint)}`];
  if (hint?.fix) lines.push(`**Fix:** ${hint.fix}`);
  lines.push('-# Only you see this (bot owner). The run is in Playbacks in the builder.');
  return lines.join('\n').slice(0, 2000);
}

const P = PermissionFlagsBits;

/** What a block needs from the bot in the run's channel/server. */
function needs(type: string): bigint[] {
  if (type === 'action.send_message' || type === 'action.send_form' || type === 'action.make_card' || type === 'action.poll_create') return [P.ViewChannel, P.SendMessages];
  if (type === 'action.react_message') return [P.ViewChannel, P.AddReactions, P.ReadMessageHistory];
  if (type === 'action.delete_message' || type === 'action.purge_messages' || type === 'action.pin_message') return [P.ViewChannel, P.ManageMessages];
  switch (permissionKind(type)) {
    case 'roles':
      return [P.ManageRoles];
    case 'channel':
      return /thread/.test(type) ? [P.ViewChannel] : [P.ManageChannels];
    default:
      break;
  }
  if (type === 'action.kick') return [P.KickMembers];
  if (type === 'action.ban' || type === 'action.unban' || type === 'action.list_bans') return [P.BanMembers];
  if (type === 'action.timeout') return [P.ModerateMembers];
  if (type === 'action.change_nickname') return [P.ManageNicknames];
  return [];
}

const NAMES: [bigint, string][] = Object.entries(P).map(([k, v]) => [v, k.replace(/([a-z])([A-Z])/g, '$1 $2')]);

/**
 * Blocks that would fail here: the bot misses a permission they need in
 * this channel, or a role they hand out is above the bot's highest role.
 * Checked before a command runs; shown in the playback, the run still goes.
 */
export function preflight(nodes: GraphNode[], me: GuildMember | null, channel: SendableChannels | null): { node: string; text: string }[] {
  if (!me) return [];
  const out: { node: string; text: string }[] = [];
  const perms = channel && 'permissionsFor' in channel ? channel.permissionsFor(me) : me.permissions;
  for (const n of nodes) {
    if (n.disabled || out.length >= 20) continue;
    // Blocks sending to another channel are checked there by Discord; only the run's channel here.
    if (typeof n.config.channel === 'string' && n.config.channel !== '' && n.type === 'action.send_message') continue;
    const missing = needs(n.type).filter((f) => !perms?.has(f));
    if (missing.length) {
      out.push({ node: n.id, text: `The bot is missing ${missing.map((f) => NAMES.find(([v]) => v === f)?.[1] ?? '?').join(', ')} here.` });
      continue;
    }
    if (permissionKind(n.type) === 'roles') {
      for (const v of Object.values(n.config)) {
        if (typeof v !== 'string' || !/^\d{17,20}$/.test(v)) continue;
        const role = me.guild.roles.cache.get(v);
        if (role && role.position >= me.roles.highest.position) {
          out.push({ node: n.id, text: `The role @${role.name} is above the bot's highest role; drag the bot's role above it.` });
          break;
        }
      }
    }
  }
  return out;
}
