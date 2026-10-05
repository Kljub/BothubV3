// Bookmarks (module "bookmarks"): the message context menu "Bookmark" saves
// a message for the member: a copy with link goes to their DMs (setting) and
// it lands in their list (/bookmarks, the last 50 per server and member,
// module_state "u:<id>").

import type { Message, User } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { ModuleContext } from './context.js';

export interface Bookmark { url: string; author: string; text: string; at: number }

const MAX = 50;

export function bookmarksOf(ctx: ModuleContext, guildId: string, userId: string): Bookmark[] {
  return ctx.getState<Bookmark[]>('bookmarks', guildId, `u:${userId}`) ?? [];
}

/** The DM copy of a bookmarked message. */
export function bookmarkEmbed(msg: { content: string; url: string; authorName: string; authorAvatar: string | null; channelName: string; image: string | null; createdAt: Date }): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(0xfacc15)
    .setAuthor({ name: msg.authorName.slice(0, 256), ...(msg.authorAvatar ? { iconURL: msg.authorAvatar } : {}) })
    .setDescription(`${msg.content.slice(0, 3800) || '*(no text)*'}\n\n[Jump to the message](${msg.url})`)
    .setFooter({ text: `🔖 Bookmark · #${msg.channelName}`.slice(0, 2048) })
    .setTimestamp(msg.createdAt);
  if (msg.image) e.setImage(msg.image);
  return e;
}

/** Saves a message for a member; returns whether the DM copy arrived. */
export async function bookmark(ctx: ModuleContext, msg: Message, user: User, now = Date.now()): Promise<{ dm: boolean; count: number }> {
  if (!msg.guildId) throw new Error('Bookmarks work on a server only.');
  const list = bookmarksOf(ctx, msg.guildId, user.id).filter((b) => b.url !== msg.url);
  const text = msg.content.replace(/\s+/g, ' ').trim();
  list.unshift({ url: msg.url, author: msg.member?.displayName ?? msg.author.username, text: text.length > 80 ? `${text.slice(0, 79)}…` : text, at: now });
  ctx.setState('bookmarks', msg.guildId, `u:${user.id}`, list.slice(0, MAX));
  let dm = false;
  if (ctx.config<{ dm: boolean }>('bookmarks').dm !== false) {
    const image = msg.attachments.find((a) => (a.contentType ?? '').startsWith('image/'))?.url ?? msg.embeds.find((e) => e.image)?.image?.url ?? null;
    const embed = bookmarkEmbed({
      content: msg.content, url: msg.url, authorName: msg.member?.displayName ?? msg.author.username, authorAvatar: msg.author.displayAvatarURL(),
      channelName: 'name' in msg.channel ? String(msg.channel.name) : 'channel', image, createdAt: msg.createdAt,
    });
    dm = await user.send({ embeds: [embed] }).then(() => true, () => false);
  }
  return { dm, count: Math.min(list.length, MAX) };
}

/** "1. Ann: text … (link)" lines of a member's bookmarks. */
export function bookmarkLines(list: Bookmark[], limit = 10): string {
  return list.slice(0, limit).map((b, i) => `**${i + 1}.** ${b.author}: ${b.text || '*(no text)*'} · [open](${b.url}) · <t:${Math.floor(b.at / 1000)}:R>`).join('\n');
}

export function removeBookmark(ctx: ModuleContext, guildId: string, userId: string, index: number): boolean {
  const list = bookmarksOf(ctx, guildId, userId);
  if (index < 1 || index > list.length) return false;
  list.splice(index - 1, 1);
  ctx.setState('bookmarks', guildId, `u:${userId}`, list);
  return true;
}
