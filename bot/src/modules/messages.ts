// Message modules: Autoresponder, Auto-React, Media Channels, Polls Filter,
// Sticky Messages. All run on new messages; each checks its own settings.

import { PermissionFlagsBits, type Guild, type Message, type SendableChannels } from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, fill, idIn, idsIn, passes, reactionOf, type MessageConfig, type ModuleContext } from './context.js';
import { allow, send } from './guard.js';

// ---------- Autoresponder ----------

export interface Responder {
  match?: 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'word';
  keywords?: string[];
  message?: MessageConfig;
  reply?: boolean;
  cooldown?: number;
  channelMode?: string;
  channels?: unknown;
  roleMode?: string;
  roles?: unknown;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the message text trigger a responder? Case-insensitive. */
export function keywordMatch(content: string, keywords: string[] | undefined, match: Responder['match'] = 'contains'): boolean {
  const text = content.toLowerCase().trim();
  if (!text) return false;
  return (keywords ?? []).some((raw) => {
    const k = raw.toLowerCase().trim();
    if (!k) return false;
    switch (match) {
      case 'equals':
        return text === k;
      case 'starts_with':
        return text.startsWith(k);
      case 'ends_with':
        return text.endsWith(k);
      case 'word':
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(k)}($|[^\\p{L}\\p{N}_])`, 'u').test(text);
      default:
        return text.includes(k);
    }
  });
}

// ---------- Media Channels ----------

export interface MediaConfig {
  allowText?: boolean;
  allowEmbeds?: boolean;
  blockDuplicates?: boolean;
  maxAttachments?: number;
  mediaType?: 'all' | 'images' | 'videos' | 'advanced';
  extensions?: string[];
}

export interface MediaMessage {
  content: string;
  attachments: { name: string; contentType: string | null; size: number }[];
  embeds: number;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;

/** null = allowed, else the reason the message breaks the rules. */
export function mediaViolation(m: MediaMessage, cfg: MediaConfig): 'no_media' | 'text' | 'too_many' | 'type' | null {
  const embeds = cfg.allowEmbeds === false ? 0 : m.embeds;
  const count = m.attachments.length + embeds;
  if (count === 0) return 'no_media';
  // Without text only a bare link that Discord turned into a preview (embed) passes.
  if (cfg.allowText === false && m.content.trim() !== '' && !(embeds > 0 && m.attachments.length === 0 && /^https?:\/\/\S+$/.test(m.content.trim()))) return 'text';
  if ((cfg.maxAttachments ?? 0) > 0 && count > (cfg.maxAttachments ?? 0)) return 'too_many';
  const type = cfg.mediaType ?? 'all';
  if (type !== 'all') {
    const exts = (cfg.extensions ?? []).map((e) => e.toLowerCase().replace(/^\./, ''));
    const ok = (a: MediaMessage['attachments'][number]) => {
      const ct = a.contentType ?? '';
      if (type === 'images') return ct.startsWith('image/') || IMAGE.test(a.name);
      if (type === 'videos') return ct.startsWith('video/') || VIDEO.test(a.name);
      const ext = a.name.includes('.') ? a.name.split('.').pop()!.toLowerCase() : '';
      return exts.includes(ext);
    };
    if (!m.attachments.every(ok)) return 'type';
    if (m.attachments.length === 0) return 'type'; // only embeds, but a file type is required
  }
  return null;
}

// ---------- handler ----------

const lastResponse = new Map<string, number>(); // botId:responder:channel -> ms
const stickyCount = new Map<string, number>(); // botId:channel -> messages since the last repost
const stickyBusy = new Set<string>();

async function tempNotice(ctx: ModuleContext, module: string, channel: SendableChannels, text: string, ms: number): Promise<void> {
  if (!text.trim()) return;
  const sent = await send(ctx, module, channel, { content: text.slice(0, 2000), allowedMentions: { parse: ['users'] } });
  if (sent && ms > 0) setTimeout(() => void sent.delete().catch(() => undefined), ms).unref();
}

/** edited: only the media check runs again (an edit must not trigger responses). */
export async function onMessage(ctx: ModuleContext, msg: Message, edited = false): Promise<void> {
  if (!msg.inGuild() || msg.author.id === msg.client.user.id) return;
  const guildId = msg.guildId;
  const channelIds = [msg.channelId, ...(msg.channel.isThread() && msg.channel.parentId ? [msg.channel.parentId] : [])];
  const roleIds = msg.member ? [...msg.member.roles.cache.keys()] : [];
  const vars = {
    ...baseVars(msg.guild, msg.member),
    channel: `#${'name' in msg.channel ? msg.channel.name : ''}`,
    'channel.id': msg.channelId,
    'channel.mention': `<#${msg.channelId}>`,
    'message.content': msg.content,
    'message.url': msg.url,
  };

  // Media channels and the polls filter may delete the message: run first.
  if (ctx.enabled('media-channels') && !msg.author.bot) {
    const cfg = ctx.config<MediaConfig & { channels: { channel?: unknown; whitelist?: unknown }[]; errorEnabled: boolean; errorMessage: string }>('media-channels');
    const entry = (cfg.channels ?? []).find((c) => channelIds.includes(idIn(c.channel, guildId) ?? ''));
    if (entry && !idsIn(entry.whitelist, guildId).some((r) => roleIds.includes(r))) {
      let reason = mediaViolation(
        { content: msg.content, attachments: [...msg.attachments.values()].map((a) => ({ name: a.name, contentType: a.contentType, size: a.size })), embeds: msg.embeds.length },
        cfg,
      );
      if (!reason && cfg.blockDuplicates && msg.attachments.size) {
        const key = `dup:${msg.channelId}`;
        const seen = ctx.getState<string[]>('media-channels', guildId, key) ?? [];
        const sigs = [...msg.attachments.values()].map((a) => `${a.name}:${a.size}:${a.width ?? ''}x${a.height ?? ''}`);
        if (sigs.some((s) => seen.includes(s))) reason = 'type';
        else ctx.setState('media-channels', guildId, key, [...seen, ...sigs].slice(-500));
      }
      if (reason) {
        await msg.delete().catch(() => undefined);
        if (cfg.errorEnabled !== false) await tempNotice(ctx, 'media-channels', msg.channel, fill(cfg.errorMessage || '{user.mention}, only media can be posted in this channel.', vars), 10_000);
        return;
      }
    }
  }
  if (edited) return;

  if (ctx.enabled('polls-filter') && msg.poll) {
    const cfg = ctx.config<{
      delete: boolean; timeout: boolean; timeoutSeconds: number; notify: boolean; notifyMessage: string; notifyDelete: number;
      dm: boolean; dmMessage: string; channelMode: string; channels: unknown; roleMode: string; roles: unknown;
    }>('polls-filter');
    // Moderators (Manage Messages) may always post polls.
    const moderator = msg.member?.permissionsIn(msg.channel).has(PermissionFlagsBits.ManageMessages) ?? false;
    if (!moderator && passes(cfg.channelMode, idsIn(cfg.channels, guildId), channelIds) && passes(cfg.roleMode, idsIn(cfg.roles, guildId), roleIds)) {
      if (cfg.delete !== false) await msg.delete().catch(() => undefined);
      if (cfg.timeout && msg.member?.moderatable) await msg.member.timeout(Math.min(cfg.timeoutSeconds ?? 300, 2419200) * 1000, 'Polls filter').catch(() => undefined);
      if (cfg.notify !== false) await tempNotice(ctx, 'polls-filter', msg.channel, fill(cfg.notifyMessage || '{user.mention}, polls are not allowed here.', vars), (cfg.notifyDelete ?? 10) * 1000);
      if (cfg.dm && cfg.dmMessage) await msg.author.send({ content: fill(cfg.dmMessage, vars).slice(0, 2000) }).catch(() => undefined);
      if (cfg.delete !== false) return;
    }
  }

  if (ctx.enabled('autoreact')) {
    const cfg = ctx.config<{ channels: unknown; emojis: string[]; ignoreEmbeds: boolean; ignoreBots: boolean; roles: unknown; words: string[] }>('autoreact');
    const roles = idsIn(cfg.roles, guildId);
    const ok =
      (cfg.emojis ?? []).length > 0 &&
      idsIn(cfg.channels, guildId).some((c) => channelIds.includes(c)) &&
      !(cfg.ignoreBots !== false && msg.author.bot) &&
      !(cfg.ignoreEmbeds && msg.embeds.length > 0) &&
      (roles.length === 0 || roles.some((r) => roleIds.includes(r))) &&
      ((cfg.words ?? []).length === 0 || keywordMatch(msg.content, cfg.words, 'contains'));
    if (ok && allow(ctx, 'autoreact', msg.channelId)) for (const e of cfg.emojis ?? []) await msg.react(reactionOf(e)).catch((err) => log.debug('autoreact failed', { err: String(err) }));
  }

  if (ctx.enabled('auto-responder') && !msg.author.bot) {
    const cfg = ctx.config<{ responders: Responder[] }>('auto-responder');
    const now = Date.now();
    for (const [i, r] of (cfg.responders ?? []).entries()) {
      if (!keywordMatch(msg.content, r.keywords, r.match)) continue;
      if (!passes(r.channelMode, idsIn(r.channels, guildId), channelIds)) continue;
      if (!passes(r.roleMode, idsIn(r.roles, guildId), roleIds)) continue;
      const key = `${ctx.botId}:${i}:${msg.channelId}`;
      if (now - (lastResponse.get(key) ?? 0) < (r.cooldown ?? 0) * 1000) continue;
      const payload = buildMessage(r.message, vars);
      if (!payload) continue;
      if (!allow(ctx, 'auto-responder', msg.channelId)) continue;
      lastResponse.set(key, now);
      await (r.reply !== false ? msg.reply(payload) : msg.channel.send(payload)).catch((err) => log.debug('autoresponder failed', { err: String(err) }));
    }
  }

  // Messages of bots (this one and others) never count, so two bots with
  // sticky messages cannot trigger each other.
  if (ctx.enabled('sticky-messages') && !msg.author.bot && !msg.webhookId) {
    const cfg = ctx.config<{ stickies: { channel?: unknown; message?: MessageConfig; every?: number }[]; reaction: string[] }>('sticky-messages');
    const sticky = (cfg.stickies ?? []).find((s) => idIn(s.channel, guildId) === msg.channelId);
    if (sticky) {
      const key = `${ctx.botId}:${msg.channelId}`;
      const n = (stickyCount.get(key) ?? 0) + 1;
      stickyCount.set(key, n);
      if (n >= Math.max(1, sticky.every ?? 10) && !stickyBusy.has(key)) {
        stickyBusy.add(key);
        stickyCount.set(key, 0);
        try {
          await postSticky(ctx, msg.guild, msg.channel, sticky.message, (cfg.reaction ?? [])[0]);
        } catch (err) {
          log.debug('sticky message failed', { err: String(err) });
        } finally {
          stickyBusy.delete(key);
        }
      }
    }
  }
}

/** Replaces the sticky message of a channel with a new one at the bottom. */
async function postSticky(ctx: ModuleContext, guild: Guild, channel: SendableChannels, message: MessageConfig | undefined, reaction: string | undefined): Promise<void> {
  const payload = buildMessage(message, baseVars(guild, null));
  if (!payload) return;
  const prev = ctx.getState<string>('sticky-messages', guild.id, `last:${channel.id}`);
  const sent = await send(ctx, 'sticky-messages', channel, payload);
  if (!sent) return;
  if (prev) await channel.messages.delete(prev).catch(() => undefined);
  ctx.setState('sticky-messages', guild.id, `last:${channel.id}`, sent.id);
  if (reaction) await sent.react(reactionOf(reaction)).catch(() => undefined);
}

/** After saving: channels without a sticky message get their first one. */
export async function ensureStickies(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled('sticky-messages')) return;
  const cfg = ctx.config<{ stickies: { channel?: unknown; message?: MessageConfig }[]; reaction: string[] }>('sticky-messages');
  for (const s of cfg.stickies ?? []) {
    const guild = guilds.find((g) => idIn(s.channel, g.id));
    const channel = guild?.channels.cache.get(idIn(s.channel, guild.id) ?? '');
    if (!guild || !channel?.isSendable() || ctx.getState<string>('sticky-messages', guild.id, `last:${channel.id}`)) continue;
    await postSticky(ctx, guild, channel, s.message, (cfg.reaction ?? [])[0]);
  }
}
