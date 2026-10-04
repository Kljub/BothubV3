// Honeypot (shared/module-settings/honeypot.json): trap channels with a
// warning. Spam bots write everywhere; a member who writes in a trap channel
// is kicked, softbanned, banned or timed out. Exempt: the server owner,
// Administrator and the "exempt" group (by default Manage Messages).
// The warning is a components-v2 message: heading, text and a grey counter
// button ("🍯 Honeypot: 182") that goes up with every member caught.

import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextDisplayBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import { inBlock, type Permissions } from '../discord/commands.js';
import { parseDuration } from '../graph/util.js';
import { baseVars, fill, idIn, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

export type HoneypotAction = 'kick' | 'softban' | 'ban' | 'timeout';
interface Trap { _id?: string; channel: unknown; action?: HoneypotAction; duration?: string; title?: string; description?: string; counter?: boolean }
interface HoneypotConfig { traps: Trap[]; exempt: Partial<Permissions>; logChannel: unknown }

const DELETE_SECONDS = 86_400;
const ACTION_NAMES: Record<HoneypotAction, string> = { kick: 'Kick', softban: 'Softban', ban: 'Ban', timeout: 'Timeout' };
const DEFAULT_TITLE = '⚠️ Do not send messages in this channel!';
const DEFAULT_TEXT = 'This channel is a honeypot to detect and catch spam bots.\nEvery message leads **automatically** to a **{action}**.';
const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** The trap of a channel, if it is one. */
export function trapOf(cfg: Partial<HoneypotConfig>, guildId: string, channelId: string): Trap | null {
  return (cfg.traps ?? []).find((t) => idIn(t.channel, guildId) === channelId) ?? null;
}

/** Owner, Administrator and the exempt group may write in a trap. */
export function isExempt(cfg: Partial<HoneypotConfig>, member: GuildMember, channelId: string): boolean {
  if (member.guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const e = cfg.exempt ?? { required_permissions: ['manage_messages'] };
  return inBlock({ allowed_roles: e.allowed_roles ?? [], banned_roles: e.banned_roles ?? [], required_permissions: e.required_permissions ?? [], banned_channels: e.banned_channels ?? [] }, member, channelId);
}

/** Timeout length of a trap: its duration, at most 28 days (Discord's limit). */
export function timeoutMs(duration: string | undefined): number {
  try {
    return Math.min(parseDuration(duration || '1d'), MAX_TIMEOUT_MS);
  } catch {
    return 86_400_000;
  }
}

// Spam bots post several messages at once: one action per member and server.
const busy = new Set<string>();

export async function honeypotMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId || msg.system || !ctx.enabled('honeypot')) return;
  const cfg = ctx.config<HoneypotConfig>('honeypot');
  const trap = trapOf(cfg, msg.guildId, msg.channelId);
  if (!trap) return;
  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!member || isExempt(cfg, member, msg.channelId)) return;
  await msg.delete().catch(() => undefined);
  const key = `${msg.guildId}:${member.id}`;
  if (busy.has(key)) return;
  busy.add(key);
  setTimeout(() => busy.delete(key), 10_000).unref();

  const action = trap.action ?? 'softban';
  const done = await punish(member, action, trap.duration);
  if (!done) {
    warn(ctx, 'WAR-2008', { module: 'honeypot', problem: `cannot ${action} ${member.user.tag}: missing permission or role too high` });
    return;
  }
  const id = trap._id ?? msg.channelId;
  const count = (ctx.getState<number>('honeypot', msg.guildId, `count:${id}`) ?? 0) + 1;
  ctx.setState('honeypot', msg.guildId, `count:${id}`, count);
  if (trap.counter !== false) await ensureWarning(ctx, msg.guild, trap, msg.channelId);
  await logHit(ctx, msg.guild, idIn(cfg.logChannel, msg.guildId), member, msg, action, count);
}

async function punish(member: GuildMember, action: HoneypotAction, duration: string | undefined): Promise<boolean> {
  const reason = 'Honeypot: wrote in a trap channel';
  const g = member.guild;
  try {
    switch (action) {
      case 'kick':
        if (!member.kickable) return false;
        await member.kick(reason);
        return true;
      case 'timeout':
        if (!member.moderatable) return false;
        await member.timeout(timeoutMs(duration), reason);
        return true;
      case 'ban':
      case 'softban':
        if (!member.bannable) return false;
        await g.members.ban(member.id, { deleteMessageSeconds: DELETE_SECONDS, reason });
        if (action === 'softban') await g.members.unban(member.id, 'Honeypot: softban').catch(() => undefined);
        return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function logHit(ctx: ModuleContext, guild: Guild, channelId: string | null, member: GuildMember, msg: Message, action: HoneypotAction, count: number): Promise<void> {
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isSendable()) return;
  const text = msg.content.length > 500 ? `${msg.content.slice(0, 500)}…` : msg.content;
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🍯 Honeypot')
    .setDescription(`${member.user.tag} (<@${member.id}>) wrote in <#${msg.channelId}>.`)
    .addFields({ name: 'Action', value: action, inline: true }, { name: 'Caught in this channel', value: String(count), inline: true })
    .setTimestamp();
  if (text) embed.addFields({ name: 'Message', value: text });
  await send(ctx, 'honeypot', channel, { embeds: [embed] });
}

/** The warning of a trap: heading, text and (when on) the counter button. */
export function warningPayload(trap: Trap, vars: Record<string, string>, count: number): MessageCreateOptions {
  const action = ACTION_NAMES[trap.action ?? 'softban'];
  const v = { ...vars, action };
  const title = fill(trap.title || DEFAULT_TITLE, v).slice(0, 200);
  const text = fill(trap.description ?? DEFAULT_TEXT, v).slice(0, 3500);
  const box = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}${text ? `\n${text}` : ''}`));
  if (trap.counter !== false) {
    box.addActionRowComponents((row) =>
      row.addComponents(new ButtonBuilder().setCustomId('bhm:honeypot:count').setStyle(ButtonStyle.Secondary).setEmoji('🍯').setLabel(`Honeypot: ${count}`).setDisabled(true)),
    );
  }
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Posts the warning of a trap, or edits it in place; remembered in module_state. */
async function ensureWarning(ctx: ModuleContext, guild: Guild, trap: Trap, channelId: string): Promise<void> {
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isSendable()) return;
  const id = trap._id ?? channelId;
  const count = ctx.getState<number>('honeypot', guild.id, `count:${id}`) ?? 0;
  const payload = warningPayload(trap, baseVars(guild, null), count);
  const key = `panel:${id}`;
  const known = ctx.getState<{ channel: string; message: string }>('honeypot', guild.id, key);
  if (known?.channel === channelId) {
    const edited = await channel.messages.edit(known.message, { components: payload.components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }).catch(() => null);
    if (edited) return;
    // An older warning (embed) cannot become a components-v2 message: replace it.
    await channel.messages.delete(known.message).catch(() => undefined);
  } else if (known) {
    const old = guild.channels.cache.get(known.channel);
    if (old?.isTextBased()) await old.messages.delete(known.message).catch(() => undefined);
  }
  const sent = await channel.send(payload).catch(() => null);
  if (sent) ctx.setState('honeypot', guild.id, key, { channel: channelId, message: sent.id });
  else warn(ctx, 'WAR-2008', { module: 'honeypot', problem: `cannot post the warning in #${channel.name}` });
}

/** Posts or updates the warning of every trap. */
export async function ensureHoneypots(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled('honeypot')) return;
  const cfg = ctx.config<HoneypotConfig>('honeypot');
  for (const t of cfg.traps ?? []) {
    for (const g of guilds) {
      const channelId = idIn(t.channel, g.id);
      if (channelId) await ensureWarning(ctx, g, t, channelId);
    }
  }
}
