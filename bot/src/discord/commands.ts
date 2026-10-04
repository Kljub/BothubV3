// Application commands from command graphs: the trigger block gives name,
// type and settings, the option blocks plugged into it give the options.
// "ticket open" becomes the subcommand "open" of /ticket (and "a b c" the
// subcommand c in group b).

import { ApplicationCommandOptionType, ApplicationCommandType, PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { CommandRow } from '../core/repo.js';
import type { GraphNode } from '../graph/types.js';

const OPTION_TYPE: Record<string, ApplicationCommandOptionType> = {
  'option.text': ApplicationCommandOptionType.String,
  'option.choice': ApplicationCommandOptionType.String,
  'option.music_search': ApplicationCommandOptionType.String,
  'option.number': ApplicationCommandOptionType.Number,
  'option.user': ApplicationCommandOptionType.User,
  'option.channel': ApplicationCommandOptionType.Channel,
  'option.role': ApplicationCommandOptionType.Role,
  'option.attachment': ApplicationCommandOptionType.Attachment,
};

export interface TriggerSettings {
  commandType: 'slash' | 'user' | 'message';
  name: string;
  menuName: string;
  description: string;
  hideReplies: boolean;
  contexts: 'guild' | 'guild_dm';
  cooldownType: 'none' | 'user' | 'server' | 'global';
  cooldownSeconds: number;
  permissions: Permissions;
}

export interface Permissions {
  allowed_roles: { id: string; guild?: string }[];
  banned_roles: { id: string; guild?: string }[];
  required_permissions: string[];
  banned_channels: { id: string; guild?: string }[];
  hide_without_permission: boolean;
}

const OPEN: Permissions = { allowed_roles: [{ id: 'everyone' }], banned_roles: [], required_permissions: [], banned_channels: [], hide_without_permission: false };

export function triggerOf(cmd: CommandRow): GraphNode | undefined {
  return cmd.graph.nodes.find((n) => n.type === 'trigger.slash');
}

export function settingsOf(cmd: CommandRow): TriggerSettings {
  const c = triggerOf(cmd)?.config ?? {};
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  const type = s('command_type');
  return {
    commandType: type === 'user' || type === 'message' ? type : 'slash',
    name: s('command_name') || cmd.name,
    menuName: s('menu_name') || s('command_name') || cmd.name,
    description: s('description') || cmd.description,
    hideReplies: c.hide_replies === true,
    contexts: s('contexts') === 'guild_dm' ? 'guild_dm' : 'guild',
    cooldownType: (['user', 'server', 'global'].includes(s('cooldown_type')) ? s('cooldown_type') : 'none') as TriggerSettings['cooldownType'],
    cooldownSeconds: cooldownOf(c.cooldown_seconds),
    permissions: { ...OPEN, ...((c.permissions as Partial<Permissions> | undefined) ?? {}) },
  };
}

/** "manage_guild" -> PermissionFlagsBits.ManageGuild (case and underscores ignored). */
export function permissionBit(name: string): bigint | undefined {
  const want = name.replace(/_/g, '').toLowerCase();
  for (const [key, bit] of Object.entries(PermissionFlagsBits)) if (key.toLowerCase() === want) return bit;
  return undefined;
}

function optionJson(run: { nodes: GraphNode[] }, cmd: CommandRow): Record<string, unknown>[] {
  const trig = triggerOf(cmd);
  if (!trig) return [];
  const opts = cmd.graph.edges
    .filter((e) => e.to.node === trig.id && e.to.port === 'options')
    .map((e) => run.nodes.find((n) => n.id === e.from.node))
    .filter((n): n is GraphNode => !!n && !n.disabled && n.type in OPTION_TYPE)
    .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
  const out = opts.map((o) => {
    const name = String(o.config.name ?? '').slice(0, 32);
    const json: Record<string, unknown> = {
      type: OPTION_TYPE[o.type],
      name,
      description: (String(o.config.description ?? '') || name).slice(0, 100),
      required: o.config.required !== false,
    };
    if (o.type === 'option.choice') {
      const choices = String(o.config.choices ?? '')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 25);
      if (choices.length) json.choices = choices.map((c) => ({ name: c.slice(0, 100), value: c.slice(0, 100) }));
    }
    return json;
  });
  // Discord wants required options first.
  return [...out.filter((o) => o.required), ...out.filter((o) => !o.required)];
}

/**
 * Builds the payload for PUT /applications/{id}/commands. Commands of
 * disabled modules and duplicate names are left out (first one wins).
 */
/** cooldown_seconds: a whole number 1–86400; anything else (text, NaN, Infinity) is the default 10. */
export function cooldownOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 86_400 ? v : 10;
}

/**
 * Discord accepts 100 top-level commands (+ menus); onOverflow gets the number left out.
 * allDm: the DM Commands module is on, every command is offered in DMs too.
 */
export function buildCommands(cmds: CommandRow[], onOverflow?: (dropped: number) => void, allDm = false): Record<string, unknown>[] {
  const top = new Map<string, Record<string, unknown>>();
  const menus: Record<string, unknown>[] = [];
  const menuNames = new Set<string>();
  // A plain command and subcommands cannot share a name on Discord: the
  // subcommands win (e.g. a plugin turned /emoji-menu into /emoji-menu show),
  // whatever the order of the rows.
  const subRoots = new Set<string>();
  for (const cmd of cmds) {
    const s = settingsOf(cmd);
    const parts = s.name.trim().split(/\s+/);
    if (s.commandType === 'slash' && parts.length > 1) subRoots.add(parts[0]!);
  }

  for (const cmd of cmds) {
    const s = settingsOf(cmd);
    const contexts = allDm || s.contexts === 'guild_dm' ? [0, 1] : [0];
    let defaultPerms: string | null = null;
    if (s.permissions.hide_without_permission && s.permissions.required_permissions.length) {
      let bits = 0n;
      for (const p of s.permissions.required_permissions) bits |= permissionBit(p) ?? 0n;
      defaultPerms = bits.toString();
    }

    if (s.commandType !== 'slash') {
      const key = `${s.commandType}:${s.menuName}`;
      if (menuNames.has(key)) continue;
      menuNames.add(key);
      menus.push({
        type: s.commandType === 'user' ? ApplicationCommandType.User : ApplicationCommandType.Message,
        name: s.menuName.slice(0, 32),
        contexts,
        integration_types: [0],
        default_member_permissions: defaultPerms,
      });
      continue;
    }

    const parts = s.name.trim().split(/\s+/);
    const options = optionJson({ nodes: cmd.graph.nodes }, cmd);
    const description = (s.description || parts.join(' ')).slice(0, 100);
    let root = top.get(parts[0]!);
    if (parts.length === 1) {
      if (root || subRoots.has(parts[0]!)) continue; // name taken
      top.set(parts[0]!, { type: ApplicationCommandType.ChatInput, name: parts[0], description, options, contexts, integration_types: [0], default_member_permissions: defaultPerms });
      continue;
    }
    if (!root) {
      root = { type: ApplicationCommandType.ChatInput, name: parts[0], description: parts[0], options: [], contexts, integration_types: [0], default_member_permissions: null };
      top.set(parts[0]!, root);
    }
    const rootOptions = root.options as Record<string, unknown>[];
    // A plain command and subcommands cannot share a name on Discord.
    if (rootOptions.some((o) => o.type !== ApplicationCommandOptionType.Subcommand && o.type !== ApplicationCommandOptionType.SubcommandGroup)) continue;
    const sub = { type: ApplicationCommandOptionType.Subcommand, name: parts[parts.length - 1], description, options };
    if (parts.length === 2) {
      if (!rootOptions.some((o) => o.name === parts[1])) rootOptions.push(sub);
    } else {
      let group = rootOptions.find((o) => o.name === parts[1] && o.type === ApplicationCommandOptionType.SubcommandGroup);
      if (!group) {
        group = { type: ApplicationCommandOptionType.SubcommandGroup, name: parts[1], description: parts[1], options: [] };
        rootOptions.push(group);
      }
      const groupOptions = group.options as Record<string, unknown>[];
      if (!groupOptions.some((o) => o.name === parts[2])) groupOptions.push(sub);
    }
  }
  const all = [...top.values(), ...menus];
  if (all.length > 100) onOverflow?.(all.length - 100);
  return all.slice(0, 100);
}

/** Resolves pseudo roles (e.g. the moderation module's moderators); undefined = a normal role. */
export type PseudoRoles = (id: string, member: GuildMember, channelId: string | null) => boolean | undefined;

/**
 * Whether a member belongs to the group a permissions block describes (who
 * counts as moderator, …): never in a banned channel or with a banned role;
 * otherwise with one of the allowed roles, or with all required permissions
 * (when there are any). Entries of other servers do not count.
 */
export function inBlock(p: Omit<Permissions, 'hide_without_permission'>, member: GuildMember, channelId: string | null): boolean {
  const guild = member.guild.id;
  const inGuild = (r: { id: string; guild?: string }) => !r.guild || r.guild === guild;
  if (p.banned_channels.some((c) => inGuild(c) && c.id === channelId)) return false;
  if (p.banned_roles.some((r) => inGuild(r) && member.roles.cache.has(r.id))) return false;
  if (p.allowed_roles.some((r) => inGuild(r) && (r.id === 'everyone' || member.roles.cache.has(r.id)))) return true;
  const bits = p.required_permissions.map(permissionBit).filter((b): b is bigint => b !== undefined);
  return bits.length > 0 && bits.every((b) => member.permissions.has(b));
}

/** Why a member may not run a command, or null when allowed. */
export function denied(
  p: Permissions,
  member: GuildMember | null,
  channelId: string | null,
  pseudo?: PseudoRoles,
): 'role' | 'banned_role' | 'permission' | 'channel' | null {
  if (!member) return null; // DMs: checked per server of the bot (BotInstance.allowedInDm)
  const guild = member.guild.id;
  // Pseudo roles have no guild: they apply on every server.
  const inGuild = (r: { id: string; guild?: string }) => !r.guild || r.guild === guild;
  const has = (r: { id: string }) => (r.id === 'everyone' ? true : (pseudo?.(r.id, member, channelId) ?? member.roles.cache.has(r.id)));
  if (p.banned_channels.some((c) => inGuild(c) && c.id === channelId)) return 'channel';
  if (p.banned_roles.some((r) => inGuild(r) && r.id !== 'everyone' && has(r))) return 'banned_role';
  const allowed = p.allowed_roles.filter(inGuild);
  if (allowed.length && !allowed.some(has)) return 'role';
  for (const name of p.required_permissions) {
    const bit = permissionBit(name);
    if (bit !== undefined && !member.permissions.has(bit)) return 'permission';
  }
  return null;
}
