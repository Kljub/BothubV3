// Automations: simple "when X happens, do Y" rules (module "automations",
// group Utility). A rule has one trigger (member joins or leaves, gets or
// loses a role, boosts, writes a message, reacts, joins or leaves voice),
// optional filters (words, channels, emojis, a role the member must have)
// and one action (send a message, DM, reply, give or take a role, react,
// delete the message, timeout). Several actions: several rules.

import type { Guild, GuildMember, Message, MessageReaction, PartialGuildMember, PartialMessageReaction, PartialUser, User, VoiceState } from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, idIn, idsIn, reactionOf, sameEmoji, type MessageConfig, type ModuleContext } from './context.js';
import { allow, assignable, send } from './guard.js';

export type AutoTrigger = 'member_join' | 'member_leave' | 'role_added' | 'role_removed' | 'boost' | 'message' | 'reaction_added' | 'voice_join' | 'voice_leave';
export type AutoAction = 'send_message' | 'dm' | 'reply' | 'add_role' | 'remove_role' | 'react' | 'delete_message' | 'timeout';

export interface AutoRule {
  _id?: string; name: string; enabled: boolean; trigger: AutoTrigger;
  triggerRole: unknown; words: string[]; emojis: string[]; channels: unknown; onlyRole: unknown; ignoreBots: boolean;
  action: AutoAction; actionChannel: unknown; actionMessage: MessageConfig; actionRole: unknown; actionEmojis: string[];
  timeoutMinutes: number; delaySeconds: number; cooldownSeconds: number;
}

/** What happened. */
export interface AutoEvent {
  trigger: AutoTrigger;
  guild: Guild;
  member: GuildMember | null;
  user: User | null;
  channelId?: string | null;
  message?: Message | null;
  roleId?: string;
  emoji?: { id: string | null; name: string | null };
}

/** Message filter: empty matches every message, else one of the words (any case). */
export function wordsMatch(text: string, words: string[]): boolean {
  const list = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const t = text.toLowerCase();
  return list.some((w) => t.includes(w));
}

/** Does the rule fire for the event (trigger and filters, not the cooldown)? */
export function ruleMatches(rule: Partial<AutoRule>, ev: { trigger: AutoTrigger; guildId: string; roleId?: string; channelId?: string | null; text?: string; emoji?: { id: string | null; name: string | null }; isBot: boolean; memberRoles: string[] }): boolean {
  if (rule.enabled === false || rule.trigger !== ev.trigger) return false;
  if (rule.ignoreBots !== false && ev.isBot) return false;
  if (ev.trigger === 'role_added' || ev.trigger === 'role_removed') {
    const role = idIn(rule.triggerRole, ev.guildId);
    if (role && role !== ev.roleId) return false;
  }
  const channels = idsIn(rule.channels, ev.guildId);
  if (channels.length && ['message', 'reaction_added', 'voice_join', 'voice_leave'].includes(ev.trigger) && !channels.includes(ev.channelId ?? '')) return false;
  if (ev.trigger === 'message' && !wordsMatch(ev.text ?? '', rule.words ?? [])) return false;
  if (ev.trigger === 'reaction_added' && (rule.emojis ?? []).length && !(ev.emoji && rule.emojis!.some((e) => sameEmoji(e, ev.emoji!)))) return false;
  const only = idIn(rule.onlyRole, ev.guildId);
  if (only && !ev.memberRoles.includes(only)) return false;
  return true;
}

const cooldowns = new Map<string, number>();

export async function runAutomations(ctx: ModuleContext, ev: AutoEvent): Promise<void> {
  if (!ctx.enabled('automations')) return;
  const rules = ctx.config<{ rules: AutoRule[] }>('automations').rules ?? [];
  if (!rules.length) return;
  const user = ev.user ?? ev.member?.user ?? null;
  const facts = {
    trigger: ev.trigger, guildId: ev.guild.id, roleId: ev.roleId, channelId: ev.channelId, text: ev.message?.content ?? '', emoji: ev.emoji,
    isBot: !!user?.bot, memberRoles: ev.member ? [...ev.member.roles.cache.keys()] : [],
  };
  for (const rule of rules) {
    if (!ruleMatches(rule, facts)) continue;
    const key = `${ctx.botId}:${ev.guild.id}:${rule._id ?? rule.name}:${user?.id ?? ''}`;
    const cd = (rule.cooldownSeconds ?? 0) * 1000;
    if (cd > 0) {
      const last = cooldowns.get(key) ?? 0;
      if (Date.now() - last < cd) continue;
      cooldowns.set(key, Date.now());
      if (cooldowns.size > 5000) for (const [k, t] of cooldowns) if (Date.now() - t > 86_400_000) cooldowns.delete(k);
    }
    const run = () => act(ctx, rule, ev, user).catch((err) => log.debug('automation failed', { rule: rule.name, err: String(err) }));
    const delay = Math.min(3600, Math.max(0, rule.delaySeconds ?? 0)) * 1000;
    if (delay > 0) setTimeout(() => void run(), delay).unref();
    else await run();
  }
}

async function act(ctx: ModuleContext, rule: AutoRule, ev: AutoEvent, user: User | null): Promise<void> {
  const guild = ev.guild;
  const member = ev.member;
  const role = ev.roleId ? guild.roles.cache.get(ev.roleId) : undefined;
  const vars = baseVars(guild, member, {
    channel: ev.channelId ? `<#${ev.channelId}>` : '',
    'channel.id': ev.channelId ?? '',
    'message.content': (ev.message?.content ?? '').slice(0, 1000),
    'message.link': ev.message?.url ?? '',
    role: role?.name ?? '',
    'role.id': ev.roleId ?? '',
    emoji: ev.emoji ? (ev.emoji.id ? `<:${ev.emoji.name}:${ev.emoji.id}>` : (ev.emoji.name ?? '')) : '',
    rule: rule.name,
  });
  if (!member && user) Object.assign(vars, { user: user.globalName ?? user.username, 'user.name': user.username, 'user.id': user.id, 'user.mention': `<@${user.id}>` });
  const msg = ev.message ?? null;
  switch (rule.action) {
    case 'send_message': {
      const channel = guild.channels.cache.get(idIn(rule.actionChannel, guild.id) ?? ev.channelId ?? '');
      const payload = buildMessage(rule.actionMessage, vars);
      if (channel?.isSendable() && payload) await send(ctx, 'automations', channel, payload);
      return;
    }
    case 'dm': {
      const payload = buildMessage(rule.actionMessage, vars);
      if (user && payload && allow(ctx, 'automations', `dm:${user.id}`)) await user.send(payload).catch(() => undefined);
      return;
    }
    case 'reply': {
      const payload = buildMessage(rule.actionMessage, vars);
      if (msg && payload && allow(ctx, 'automations', msg.channelId)) await msg.reply(payload).catch(() => undefined);
      return;
    }
    case 'add_role':
    case 'remove_role': {
      const id = idIn(rule.actionRole, guild.id);
      if (!member || !id || !assignable(ctx, 'automations', guild, [id]).length) return;
      if (rule.action === 'add_role') await member.roles.add(id, `Automation: ${rule.name}`).catch(() => undefined);
      else await member.roles.remove(id, `Automation: ${rule.name}`).catch(() => undefined);
      return;
    }
    case 'react':
      if (msg) for (const e of (rule.actionEmojis ?? []).slice(0, 5)) await msg.react(reactionOf(e)).catch(() => undefined);
      return;
    case 'delete_message':
      if (msg?.deletable) await msg.delete().catch(() => undefined);
      return;
    case 'timeout': {
      const minutes = Math.min(40_320, Math.max(1, rule.timeoutMinutes ?? 10));
      if (member?.moderatable) await member.timeout(minutes * 60_000, `Automation: ${rule.name}`).catch(() => undefined);
      return;
    }
  }
}

// ---------- event adapters ----------

export const autoMemberAdd = (ctx: ModuleContext, m: GuildMember) => runAutomations(ctx, { trigger: 'member_join', guild: m.guild, member: m, user: m.user });

export const autoMemberRemove = (ctx: ModuleContext, m: GuildMember | PartialGuildMember) =>
  runAutomations(ctx, { trigger: 'member_leave', guild: m.guild, member: null, user: m.user ?? null });

export async function autoMemberUpdate(ctx: ModuleContext, before: GuildMember | PartialGuildMember, after: GuildMember): Promise<void> {
  if (before.partial || !ctx.enabled('automations')) return;
  for (const id of after.roles.cache.keys()) if (!before.roles.cache.has(id)) await runAutomations(ctx, { trigger: 'role_added', guild: after.guild, member: after, user: after.user, roleId: id });
  for (const id of before.roles.cache.keys()) if (!after.roles.cache.has(id)) await runAutomations(ctx, { trigger: 'role_removed', guild: after.guild, member: after, user: after.user, roleId: id });
  if (!before.premiumSinceTimestamp && after.premiumSinceTimestamp) await runAutomations(ctx, { trigger: 'boost', guild: after.guild, member: after, user: after.user });
}

export async function autoMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.system || msg.webhookId) return;
  await runAutomations(ctx, { trigger: 'message', guild: msg.guild, member: msg.member, user: msg.author, channelId: msg.channelId, message: msg });
}

export async function autoReaction(ctx: ModuleContext, r: MessageReaction | PartialMessageReaction, u: User | PartialUser): Promise<void> {
  if (!ctx.enabled('automations')) return;
  const reaction = r.partial ? await r.fetch().catch(() => null) : r;
  const message = reaction?.message.partial ? await reaction.message.fetch().catch(() => null) : reaction?.message;
  if (!reaction || !message?.inGuild()) return;
  const user = u.partial ? await u.fetch().catch(() => null) : u;
  const member = await message.guild.members.fetch(u.id).catch(() => null);
  await runAutomations(ctx, { trigger: 'reaction_added', guild: message.guild, member, user, channelId: message.channelId, message, emoji: { id: reaction.emoji.id, name: reaction.emoji.name } });
}

export async function autoVoice(ctx: ModuleContext, before: VoiceState, after: VoiceState): Promise<void> {
  if (before.channelId === after.channelId) return;
  const member = after.member ?? before.member;
  if (!member) return;
  if (before.channelId) await runAutomations(ctx, { trigger: 'voice_leave', guild: before.guild, member, user: member.user, channelId: before.channelId });
  if (after.channelId) await runAutomations(ctx, { trigger: 'voice_join', guild: after.guild, member, user: member.user, channelId: after.channelId });
}
