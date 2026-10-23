// Community module: Starboard (Counting is in counting.ts).

import { EmbedBuilder, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from 'discord.js';
import { log } from '../core/log.js';
import { idIn, idsIn, passes, reactionOf, sameEmoji, type ModuleContext } from './context.js';
import { send } from './guard.js';

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

/** A starboard: the main one of the settings or one of the extra boards. */
export interface StarBoard {
  name?: string;
  enabled?: boolean;
  emoji: string[];
  required: number;
  channel: unknown;
  color: string;
  channelMode: string;
  channels: unknown;
  /** Only messages at least this old (hours) / at most this old (days); 0: any. */
  minAgeHours?: number;
  maxAgeDays?: number;
}

interface StarConfig extends StarBoard {
  react: boolean;
  deleteBelow: boolean;
  selfStar: boolean;
  boards: StarBoard[];
}

/**
 * The boards in priority order (extra boards first, the main board last) that
 * take this message for this emoji: board channel set, not the board itself,
 * channel restriction and message age passed.
 */
export function boardsFor(cfg: Partial<StarConfig>, guildId: string, emojiMatches: (emoji: string) => boolean, channels: string[], ageHours: number): (StarBoard & { channelId: string })[] {
  const all = [...(cfg.boards ?? []).filter((b) => b.enabled !== false), cfg as StarBoard];
  const out: (StarBoard & { channelId: string })[] = [];
  for (const b of all) {
    const channelId = idIn(b.channel, guildId);
    if (!channelId || channels.includes(channelId)) continue;
    if (!emojiMatches((b.emoji ?? [])[0] || '⭐')) continue;
    if (!passes(b.channelMode, idsIn(b.channels, guildId), channels)) continue;
    if ((b.minAgeHours ?? 0) > 0 && ageHours < b.minAgeHours!) continue;
    if ((b.maxAgeDays ?? 0) > 0 && ageHours > b.maxAgeDays! * 24) continue;
    out.push({ ...b, channelId });
  }
  return out;
}

async function updateStar(ctx: ModuleContext, partial: MessageReaction | PartialMessageReaction): Promise<void> {
  const reaction = partial.partial ? await partial.fetch() : partial;
  const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (!msg.inGuild()) return;
  const cfg = ctx.config<StarConfig>('starboard');
  const parent = msg.channel.isThread() ? msg.channel.parentId : null;
  const channels = [msg.channelId, ...(parent ? [parent] : [])];
  const boards = boardsFor(cfg, msg.guildId, (e) => sameEmoji(e, reaction.emoji), channels, (Date.now() - msg.createdTimestamp) / 3_600_000);
  const stateKey = `msg:${msg.id}`;
  const existing = ctx.getState<StarPost>('starboard', msg.guildId, stateKey);
  if (!boards.length && !existing) return;

  // Count people only: no bots (this one reacts to its own posts), and the
  // author only with "count the author's own reaction".
  const users = await reaction.users.fetch().catch(() => null);
  if (!users) return; // without the user list bot reactions cannot be told apart: try again on the next reaction
  const stars = users.filter((u) => !u.bot && (cfg.selfStar || u.id !== msg.author.id)).size;
  // A posted message stays on its board; otherwise the first board (by
  // priority) whose star count is reached, falling through to the next.
  const target = existing ? boards.find((b) => b.channelId === existing.channel) : boards.find((b) => stars >= (b.required ?? 5));
  if (existing && !target) return; // another emoji or board: not the one it was posted with
  const emoji = (target ?? boards[0]!).emoji?.[0] || '⭐';
  const header = `${emoji} **${stars}** · <#${msg.channelId}>`;
  if (!target) return;
  const board = msg.guild.channels.cache.get(target.channelId);
  if (!board?.isSendable()) return;

  if (stars < (target.required ?? 5)) {
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
    .setDescription(`${msg.content.slice(0, 3900) || ''}

[→ ${'Jump to message'}](${msg.url})`.trim())
    .setTimestamp(msg.createdAt);
  const color = /^#[0-9a-fA-F]{6}$/.test(target.color ?? '') ? parseInt(target.color!.slice(1), 16) : 0xfacc15;
  embed.setColor(color);
  const image = msg.attachments.find((a) => (a.contentType ?? '').startsWith('image/'));
  if (image) embed.setImage(image.url);
  const post = await send(ctx, 'starboard', board, { content: header, embeds: [embed], allowedMentions: { parse: [] } });
  if (!post) return;
  ctx.setState('starboard', msg.guildId, stateKey, { post: post.id, channel: target.channelId } satisfies StarPost);
  if (cfg.react !== false) await post.react(reactionOf(emoji)).catch(() => undefined);
}
