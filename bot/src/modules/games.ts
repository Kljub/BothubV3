// Community modules: Counting and Starboard.

import { EmbedBuilder, PermissionFlagsBits, type Message, type MessageReaction, type PartialMessageReaction, type TextChannel, type User, type PartialUser } from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, fill, idIn, idsIn, passes, reactionOf, sameEmoji, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

// ---------- Counting ----------

export interface CountState {
  count: number;
  lastUser: string | null;
  lastAt: number;
}

export interface CountRules {
  allowTwice?: boolean;
  cooldown?: boolean;
  resetOnFail?: boolean;
}

export type CountResult = { kind: 'ignore' } | { kind: 'ok' | 'wrong' | 'twice' | 'cooldown'; state: CountState; expected: number };

const COOLDOWN_MS = 5000;

/** Decides one counting message. Messages that are not a whole number are ignored. */
export function count(state: CountState, content: string, userId: string, now: number, rules: CountRules): CountResult {
  const text = content.trim();
  if (!/^-?\d{1,15}$/.test(text)) return { kind: 'ignore' };
  const n = Number(text);
  const expected = state.count + 1;
  if (rules.cooldown && now - state.lastAt < COOLDOWN_MS) return { kind: 'cooldown', state, expected };
  if (!rules.allowTwice && state.lastUser === userId) return { kind: 'twice', state, expected };
  if (n !== expected) {
    const next = rules.resetOnFail ? { count: 0, lastUser: null, lastAt: now } : state;
    return { kind: 'wrong', state: next, expected: next.count + 1 };
  }
  return { kind: 'ok', state: { count: n, lastUser: userId, lastAt: now }, expected: n + 1 };
}

const countQueue = new Map<string, Promise<unknown>>();

/** Counting runs one message after another per channel. */
export function onCountingMessage(ctx: ModuleContext, msg: Message): void {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('counting')) return;
  const cfg = ctx.config<CountRules & { channels: unknown; mode: string; react: boolean; emoji: string[]; errors: boolean; wrongMessage: string; twiceMessage: string; cooldownMessage: string }>('counting');
  if (!idsIn(cfg.channels, msg.guildId).includes(msg.channelId)) return;
  const key = `${ctx.botId}:${msg.channelId}`;
  const run = (countQueue.get(key) ?? Promise.resolve()).then(async () => {
    const stateKey = `ch:${msg.channelId}`;
    const state = ctx.getState<CountState>('counting', msg.guildId, stateKey) ?? { count: 0, lastUser: null, lastAt: 0 };
    const res = count(state, msg.content, msg.author.id, Date.now(), cfg);
    if (res.kind === 'ignore') return;
    ctx.setState('counting', msg.guildId, stateKey, res.state);
    const vars = { ...baseVars(msg.guild, msg.member), count: String(res.state.count), 'count.next': String(res.expected) };
    if (res.kind === 'ok') {
      // Webhook mode deletes the message and reposts it: both permissions are needed.
      const canHook = msg.guild.members.me?.permissionsIn(msg.channel).has([PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages]) ?? false;
      if (cfg.mode === 'webhook' && !canHook) warn(ctx, 'WAR-2008', { module: 'counting', problem: 'webhook mode needs Manage Webhooks and Manage Messages; counting falls back to normal mode' });
      if (cfg.mode === 'webhook' && canHook && msg.channel.type === 0) {
        const channel = msg.channel as TextChannel;
        const hooks = await channel.fetchWebhooks().catch(() => null);
        const hook = hooks?.find((h) => h.owner?.id === msg.client.user.id) ?? (await channel.createWebhook({ name: 'BotHub Counting' }).catch(() => null));
        if (hook) {
          await msg.delete().catch(() => undefined);
          await hook.send({ content: msg.content, username: msg.member?.displayName ?? msg.author.username, avatarURL: msg.member?.displayAvatarURL() ?? msg.author.displayAvatarURL(), allowedMentions: { parse: [] } }).catch(() => undefined);
          return;
        }
      }
      if (cfg.react !== false) await msg.react(reactionOf((cfg.emoji ?? [])[0] || '✅')).catch(() => undefined);
      return;
    }
    await (res.kind === 'wrong' ? msg.react('❌').catch(() => undefined) : msg.delete().catch(() => undefined));
    if (cfg.errors !== false) {
      const text = res.kind === 'wrong' ? cfg.wrongMessage : res.kind === 'twice' ? cfg.twiceMessage : cfg.cooldownMessage;
      const sent = text ? await send(ctx, 'counting', msg.channel, { content: fill(text, vars).slice(0, 2000), allowedMentions: { parse: ['users'] } }) : null;
      if (sent) setTimeout(() => void sent.delete().catch(() => undefined), 5000).unref();
    }
  });
  const tail = run.catch((err) => log.debug('counting failed', { err: String(err) }));
  countQueue.set(key, tail);
  void tail.then(() => {
    if (countQueue.get(key) === tail) countQueue.delete(key);
  });
}

// ---------- Starboard ----------

interface StarPost {
  post: string;
  channel: string;
}

const starQueue = new Map<string, Promise<unknown>>();

export function onStarReaction(ctx: ModuleContext, reaction: MessageReaction | PartialMessageReaction, _user: User | PartialUser): void {
  if (!ctx.enabled('starboard')) return;
  const key = `${ctx.botId}:${reaction.message.id}`;
  // The queue holds the caught tail, so a failure is logged once and the
  // entry is removed when this update was the last one of the message.
  const tail = (starQueue.get(key) ?? Promise.resolve())
    .then(() => updateStar(ctx, reaction))
    .catch((err) => log.debug('starboard failed', { err: String(err) }));
  starQueue.set(key, tail);
  void tail.then(() => {
    if (starQueue.get(key) === tail) starQueue.delete(key);
  });
}

async function updateStar(ctx: ModuleContext, partial: MessageReaction | PartialMessageReaction): Promise<void> {
  const reaction = partial.partial ? await partial.fetch() : partial;
  const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (!msg.inGuild()) return;
  const cfg = ctx.config<{ emoji: string[]; required: number; channel: unknown; color: string; react: boolean; deleteBelow: boolean; selfStar: boolean; channelMode: string; channels: unknown }>('starboard');
  const emoji = (cfg.emoji ?? [])[0] || '⭐';
  if (!sameEmoji(emoji, reaction.emoji)) return;
  const boardId = idIn(cfg.channel, msg.guildId);
  if (!boardId || msg.channelId === boardId) return;
  const parent = msg.channel.isThread() ? msg.channel.parentId : null;
  if (!passes(cfg.channelMode, idsIn(cfg.channels, msg.guildId), [msg.channelId, ...(parent ? [parent] : [])])) return;

  // Count people only: no bots (this one reacts to its own posts), and the
  // author only with "count the author's own reaction".
  const users = await reaction.users.fetch().catch(() => null);
  if (!users) return; // without the user list bot reactions cannot be told apart: try again on the next reaction
  const stars = users.filter((u) => !u.bot && (cfg.selfStar || u.id !== msg.author.id)).size;
  const board = msg.guild.channels.cache.get(boardId);
  if (!board?.isSendable()) return;
  const stateKey = `msg:${msg.id}`;
  const existing = ctx.getState<StarPost>('starboard', msg.guildId, stateKey);
  const header = `${emoji} **${stars}** · <#${msg.channelId}>`;

  if (stars < (cfg.required ?? 5)) {
    if (existing && cfg.deleteBelow) {
      await board.messages.delete(existing.post).catch(() => undefined);
      ctx.deleteState('starboard', msg.guildId, stateKey);
    } else if (existing) {
      await board.messages.edit(existing.post, { content: header }).catch(() => undefined);
    }
    return;
  }
  if (existing) {
    const edited = await board.messages.edit(existing.post, { content: header }).catch(() => null);
    if (edited) return;
    ctx.deleteState('starboard', msg.guildId, stateKey); // post was deleted: post it again
  }
  const embed = new EmbedBuilder()
    .setAuthor({ name: msg.member?.displayName ?? msg.author.username, iconURL: msg.author.displayAvatarURL() })
    .setDescription(`${msg.content.slice(0, 3900) || ''}\n\n[→ ${'Jump to message'}](${msg.url})`.trim())
    .setTimestamp(msg.createdAt);
  const color = /^#[0-9a-fA-F]{6}$/.test(cfg.color ?? '') ? parseInt(cfg.color!.slice(1), 16) : 0xfacc15;
  embed.setColor(color);
  const image = msg.attachments.find((a) => (a.contentType ?? '').startsWith('image/'));
  if (image) embed.setImage(image.url);
  const post = await send(ctx, 'starboard', board, { content: header, embeds: [embed], allowedMentions: { parse: [] } });
  if (!post) return;
  ctx.setState('starboard', msg.guildId, stateKey, { post: post.id, channel: boardId } satisfies StarPost);
  if (cfg.react !== false) await post.react(reactionOf(emoji)).catch(() => undefined);
}
