// Reaction Roles → role groups: a message the bot posts and keeps up to date
// (like the ticket panels) with one button per role or one select menu.
// Members pick their roles there; the group decides how many they may hold,
// who may pick at all and whether a picked role can be given back.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { baseVars, buildMessage, idsIn, idIn, type MessageConfig, type ModuleContext } from './context.js';
import { assignable } from './guard.js';
import { ensurePanel } from './support.js';

export interface RoleGroup {
  _id?: string;
  name: string;
  channel: unknown;
  style: string; // buttons, select
  message: MessageConfig;
  roles: unknown;
  labels: string[];
  emojis: string[];
  buttonStyle: string; // secondary, primary, success, danger
  placeholder: string;
  maxRoles: number; // 0: no limit
  requiredRoles: unknown;
  blacklist: unknown;
  permanent: boolean;
}

const MODULE = 'reaction-roles';
const styles: Record<string, ButtonStyle> = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

/** The roles of a group in their order, with label and emoji (same position in labels/emojis). */
export function groupOptions(g: RoleGroup, guild: Guild): { id: string; label: string; emoji?: string }[] {
  return idsIn(g.roles, guild.id)
    .slice(0, 25)
    .map((id, i) => ({
      id,
      label: ((g.labels ?? [])[i] || guild.roles.cache.get(id)?.name || id).slice(0, 80),
      emoji: (g.emojis ?? [])[i] || undefined,
    }));
}

/** The panel message: the group's text plus buttons (5 per row) or a select menu. */
export function groupPayload(g: RoleGroup, guild: Guild): MessageCreateOptions {
  const payload = buildMessage(g.message, baseVars(guild, null)) ?? { content: g.name || 'Roles' };
  const options = groupOptions(g, guild);
  if (!g._id || !options.length) return { ...payload, components: [] };
  if (g.style === 'select') {
    const max = g.maxRoles > 0 ? Math.min(g.maxRoles, options.length) : options.length;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`bhm:rr:${g._id}`)
      .setPlaceholder((g.placeholder || 'Choose your roles').slice(0, 150))
      .setMinValues(0)
      .setMaxValues(max)
      .addOptions(options.map((o) => ({ label: o.label, value: o.id, ...(o.emoji ? { emoji: o.emoji } : {}) })));
    return { ...payload, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
  }
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  options.forEach((o, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    const b = new ButtonBuilder().setCustomId(`bhm:rr:${g._id}:${o.id}`).setLabel(o.label).setStyle(styles[g.buttonStyle] ?? ButtonStyle.Secondary);
    if (o.emoji) b.setEmoji(o.emoji);
    rows[rows.length - 1]!.addComponents(b);
  });
  return { ...payload, components: rows };
}

/** Posts or updates every group's panel; removes panels of deleted groups. */
export async function ensureRoleGroups(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  const groups = ctx.enabled(MODULE) ? (ctx.config<{ groups: RoleGroup[] }>(MODULE).groups ?? []) : [];
  for (const guild of guilds) {
    const here = groups.filter((g) => g._id && idIn(g.channel, guild.id));
    for (const g of here) await ensurePanel(ctx, MODULE, `group:${g._id}`, guild, idIn(g.channel, guild.id)!, groupPayload(g, guild));
    const known = ctx.getState<string[]>(MODULE, guild.id, 'groups') ?? [];
    const ids = here.map((g) => g._id!);
    for (const id of known.filter((k) => !ids.includes(k))) {
      const panel = ctx.getState<{ channel: string; message: string }>(MODULE, guild.id, `group:${id}`);
      const channel = panel && guild.channels.cache.get(panel.channel);
      if (panel && channel?.isTextBased()) await channel.messages.delete(panel.message).catch(() => undefined);
      ctx.deleteState(MODULE, guild.id, `group:${id}`);
    }
    if (ids.length || known.length) ctx.setState(MODULE, guild.id, 'groups', ids);
  }
}

/**
 * What a pick changes. wanted: the group roles the member should hold
 * afterwards (select: the picked ones; button: the current ones with the
 * clicked one toggled). Returns the roles to add and to remove, or why not.
 */
export function planPick(g: RoleGroup, groupRoles: string[], has: string[], wanted: string[], clicked?: string): { add: string[]; remove: string[]; error?: string } {
  let want = wanted.filter((r) => groupRoles.includes(r));
  const holding = groupRoles.filter((r) => has.includes(r));
  // Permanent: nothing of the group can be given back here.
  if (g.permanent) want = [...new Set([...want, ...holding])];
  const max = g.maxRoles > 0 ? g.maxRoles : groupRoles.length;
  if (want.length > max) {
    // One role per group: a click swaps instead of refusing.
    if (max === 1 && clicked && want.includes(clicked) && !g.permanent) want = [clicked];
    else return { add: [], remove: [], error: max === 1 ? 'one' : 'max' };
  }
  return { add: want.filter((r) => !has.includes(r)), remove: holding.filter((r) => !want.includes(r)) };
}

export async function roleGroupInteraction(ctx: ModuleContext, i: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>, groupId: string, roleId?: string): Promise<void> {
  const g = (ctx.config<{ groups: RoleGroup[] }>(MODULE).groups ?? []).find((x) => x._id === groupId);
  if (!ctx.enabled(MODULE) || !g) return void (await i.reply({ content: 'This role menu is no longer active.', flags: 64 }));
  const member = i.member as GuildMember;
  const roles = (): string[] => [...member.roles.cache.keys()];
  if (idsIn(g.blacklist, i.guildId).some((r) => member.roles.cache.has(r))) return void (await i.reply({ content: 'You cannot use this role menu.', flags: 64 }));
  const required = idsIn(g.requiredRoles, i.guildId);
  if (required.length && !required.some((r) => member.roles.cache.has(r))) {
    const names = required.map((r) => `<@&${r}>`).join(', ');
    return void (await i.reply({ content: `You need one of these roles first: ${names}`, flags: 64, allowedMentions: { parse: [] } }));
  }
  const groupRoles = groupOptions(g, i.guild).map((o) => o.id);
  const has = roles();
  let wanted: string[];
  if (i.isStringSelectMenu()) wanted = i.values;
  else {
    if (!roleId || !groupRoles.includes(roleId)) return void (await i.reply({ content: 'This role is no longer part of the menu.', flags: 64 }));
    const current = groupRoles.filter((r) => has.includes(r));
    wanted = current.includes(roleId) ? current.filter((r) => r !== roleId) : [...current, roleId];
  }
  const plan = planPick(g, groupRoles, has, wanted, roleId);
  if (plan.error) {
    const text = plan.error === 'one' ? 'You can only have one role of this menu.' : `You can have at most ${g.maxRoles} roles of this menu.`;
    return void (await i.reply({ content: text, flags: 64 }));
  }
  const add = assignable(ctx, MODULE, i.guild, plan.add);
  const remove = assignable(ctx, MODULE, i.guild, plan.remove);
  if (add.length) await member.roles.add(add, 'Role menu').catch(() => undefined);
  if (remove.length) await member.roles.remove(remove, 'Role menu').catch(() => undefined);
  const lines = [...add.map((r) => `➕ <@&${r}>`), ...remove.map((r) => `➖ <@&${r}>`)];
  const refused = plan.add.length + plan.remove.length - add.length - remove.length;
  if (refused) lines.push('⚠️ The bot cannot manage some of these roles. Please tell the server team.');
  if (g.permanent && !i.isStringSelectMenu() && roleId && has.includes(roleId)) lines.push('This role cannot be removed here.');
  await i.reply({ content: lines.join('\n') || 'Nothing changed.', flags: 64, allowedMentions: { parse: [] } });
}
