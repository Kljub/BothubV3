// Match conditions (role, permission, channel, user, status, subcommand).
// The state block's value is what the member must have or be: a role ID, a
// permission name, a channel ID, a user ID, a status or a subcommand name.

import type { GuildMember } from 'discord.js';
import type { Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { snowflake } from '../graph/util.js';
import { permissionBit } from './commands.js';
import { data } from './handlers.js';

async function subjectMember(run: Run, cond: GraphNode): Promise<GuildMember | null> {
  const d = data(run);
  const who = run.str(cond, 'user');
  if (!who || !d.guild) return d.member;
  run.countDiscordCall();
  return d.guild.members.fetch(snowflake(who, 'user')).catch(() => null);
}

export async function matchState(cond: GraphNode, state: GraphNode, run: Run): Promise<boolean> {
  const d = data(run);
  const values = run
    .str(state, 'value')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.length) return false;
  const all = run.raw(cond, 'require') === 'all';
  const test = (fn: (v: string) => boolean) => (all ? values.every(fn) : values.some(fn));

  switch (cond.type) {
    case 'condition.role': {
      const m = await subjectMember(run, cond);
      return !!m && test((v) => m.roles.cache.has(v.replace(/[<@&>]/g, '')));
    }
    case 'condition.permission': {
      const m = await subjectMember(run, cond);
      return !!m && test((v) => {
        const bit = permissionBit(v);
        return bit !== undefined && m.permissions.has(bit);
      });
    }
    case 'condition.channel':
      return test((v) => v.replace(/[<#>]/g, '') === (d.channel?.id ?? run.vars.get('channel.id')));
    case 'condition.user':
      return test((v) => v.replace(/[<@!>]/g, '') === (d.user?.id ?? run.vars.get('user.id')));
    case 'condition.status': {
      const m = await subjectMember(run, cond);
      const status = m?.presence?.status ?? 'offline';
      return test((v) => v.toLowerCase() === status);
    }
    case 'condition.subcommand':
      return test((v) => v === (run.vars.get('command.subcommand') ?? ''));
    default:
      return false;
  }
}
