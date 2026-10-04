// Twitter Link-Fix: x.com / twitter.com post links get a host that Discord
// embeds properly (fxtwitter, vxtwitter, fixupx). Either as a reply (the
// original's own embeds are hidden when the bot may) or the original is
// replaced by a message of the bot.

import { PermissionFlagsBits, type Message } from 'discord.js';
import { baseVars, buildMessage, idsIn, type MessageConfig, type ModuleContext } from './context.js';
import { send } from './guard.js';
import { messageOf } from './feeds.js';

const HOSTS: Record<string, string> = { fxtwitter: 'fxtwitter.com', vxtwitter: 'vxtwitter.com', fixupx: 'fixupx.com' };

// <link> (embed suppressed by the author) is left alone.
const POST = /(?<!<)https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/(\w{1,15}\/status\/\d+)[^\s>]*/gi;

/** The fixed links of a text and the text with them replaced. */
export function fixLinks(text: string, service: string): { links: string[]; text: string } {
  const host = HOSTS[service] ?? HOSTS.fxtwitter!;
  const links: string[] = [];
  const out = text.replace(POST, (_whole, path: string) => {
    const link = `https://${host}/${path}`;
    links.push(link);
    return link;
  });
  return { links: [...new Set(links)], text: out };
}

interface LinkfixConfig { mode: string; service: string; channels: unknown; ignoreBots: boolean; replyMessage: unknown; replaceMessage: unknown }

export async function linkfixMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || !msg.content || msg.author.id === msg.client.user.id || !ctx.enabled('twitter-linkfix')) return;
  const cfg = ctx.config<LinkfixConfig>('twitter-linkfix');
  if (msg.author.bot && cfg.ignoreBots !== false) return;
  const only = idsIn(cfg.channels, msg.guildId);
  if (only.length && !only.includes(msg.channelId) && !only.includes(msg.channel.isThread() ? (msg.channel.parentId ?? '') : '')) return;
  const fixed = fixLinks(msg.content, cfg.service ?? 'fxtwitter');
  if (!fixed.links.length) return;
  const channel = msg.channel;
  const vars = {
    ...baseVars(msg.guild, msg.member),
    channel: 'name' in channel ? channel.name : '',
    'channel.mention': `<#${channel.id}>`,
    'message.content': fixed.text,
    links: fixed.links.join('\n'),
  };
  const canManage = channel.permissionsFor(msg.client.user)?.has(PermissionFlagsBits.ManageMessages) ?? false;
  if (cfg.mode === 'replace' && canManage) {
    const payload = buildMessage(messageOf(cfg.replaceMessage, { mode: 'text', content: '**{user}:** {message.content}' } satisfies MessageConfig), vars);
    if (!payload) return;
    payload.allowedMentions = { parse: [] };
    if (msg.reference?.messageId) payload.reply = { messageReference: msg.reference.messageId, failIfNotExists: false };
    if (await send(ctx, 'twitter-linkfix', channel, payload)) await msg.delete().catch(() => undefined);
    return;
  }
  const payload = buildMessage(messageOf(cfg.replyMessage, { mode: 'text', content: '{links}' }), vars);
  if (!payload) return;
  payload.allowedMentions = { parse: [], repliedUser: false };
  payload.reply = { messageReference: msg.id, failIfNotExists: false };
  if ((await send(ctx, 'twitter-linkfix', channel, payload)) && canManage) await msg.suppressEmbeds(true).catch(() => undefined);
}
