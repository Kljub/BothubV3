// Discord Automod: BotHub keeps Discord's own AutoMod rules (names start
// with "BotHub · ") in line with the settings, in every server of the bot.
// Extra punishments count the hits per member over 24 hours.
// The media filter (no GIFs, images or videos in some channels) is checked
// by the bot itself, since Discord's AutoMod cannot look at files.

import {
  PermissionFlagsBits,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  type AutoModerationActionExecution,
  type AutoModerationActionOptions,
  type Guild,
  type Message,
  type PartialMessage,
} from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, fill, idIn, idsIn, type ModuleContext } from './context.js';
import { warn } from './guard.js';
import { tempNotice } from './messages.js';

export const PREFIX = 'BotHub · ';

export interface AutomodConfig {
  words: string[]; allowed: string[]; profanity: boolean; sexual: boolean; slurs: boolean; invites: boolean; links: boolean;
  mentionLimit: number; spam: boolean; blockMessage: string; alertChannel: unknown; timeoutSeconds: number;
  exemptRoles: unknown; exemptChannels: unknown; punishments: { count: number; action: string; minutes: number }[];
  mediaFilters: MediaFilter[];
}

export interface MediaFilter { channels: unknown; gifs?: boolean; images?: boolean; videos?: boolean; notice?: string }
export type MediaKind = 'gif' | 'image' | 'video';

/** What a message shows, as far as the media filter cares. */
export interface MediaParts {
  content: string;
  attachments: { name: string; contentType: string | null }[];
  embeds: { type: string | null; url: string | null; provider: string | null }[];
}

const GIF_LINK = /https?:\/\/(?:[\w-]+\.)?(?:tenor\.com|giphy\.com|gfycat\.com)\/\S+|https?:\/\/\S+\.gif(?:[?#]\S*)?(?=\s|$)/i;
const IMAGE_LINK = /https?:\/\/\S+\.(?:png|jpe?g|webp|avif|bmp)(?:[?#]\S*)?(?=\s|$)/i;
const VIDEO_LINK = /https?:\/\/\S+\.(?:mp4|mov|webm|mkv|m4v)(?:[?#]\S*)?(?=\s|$)/i;
const GIF_HOST = /(?:^|\.)(?:tenor\.com|giphy\.com|gfycat\.com)$/i;

const hostOf = (url: string | null): string => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};

/** GIFs, images and videos in a message: files, GIF links, direct file links, previews. */
export function mediaKinds(m: MediaParts): Set<MediaKind> {
  const out = new Set<MediaKind>();
  for (const a of m.attachments) {
    const ct = (a.contentType ?? '').toLowerCase();
    const name = a.name.toLowerCase();
    if (ct === 'image/gif' || name.endsWith('.gif')) out.add('gif');
    else if (ct.startsWith('image/') || /\.(png|jpe?g|webp|avif|bmp|svg)$/.test(name)) out.add('image');
    else if (ct.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/.test(name)) out.add('video');
  }
  if (GIF_LINK.test(m.content)) out.add('gif');
  if (IMAGE_LINK.test(m.content)) out.add('image');
  if (VIDEO_LINK.test(m.content)) out.add('video');
  for (const e of m.embeds) {
    // Previews of GIF sites (type gifv, or the site's own image/video) are GIFs;
    // a "video" preview of a page (YouTube, …) is a link, not a video file.
    if (e.type === 'gifv' || GIF_HOST.test(hostOf(e.url))) out.add('gif');
    else if (e.type === 'image') out.add(/\.gif(?:[?#]|$)/i.test(e.url ?? '') ? 'gif' : 'image');
    else if (e.type === 'video' && !e.provider) out.add('video');
  }
  return out;
}

/** The kinds a filter blocks that the message has, in a fixed order. */
export function blockedKinds(f: MediaFilter, kinds: Set<MediaKind>): MediaKind[] {
  return (['gif', 'image', 'video'] as const).filter((k) => kinds.has(k) && (k === 'gif' ? f.gifs !== false : k === 'image' ? f.images === true : f.videos === true));
}

const KIND_NAMES: Record<MediaKind, string> = { gif: 'GIFs', image: 'images', video: 'videos' };

/** "GIFs", "GIFs and images", "GIFs, images and videos". */
export function kindList(kinds: MediaKind[]): string {
  const n = kinds.map((k) => KIND_NAMES[k]);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : (n[0] ?? '');
}

export interface WantedRule {
  name: string;
  triggerType: AutoModerationRuleTriggerType;
  triggerMetadata: Record<string, unknown>;
  actions: AutoModerationActionOptions[];
}

const INVITE = String.raw`(discord\.gg|discord(app)?\.com/invite)/[A-Za-z0-9-]+`;
const LINK = String.raw`https?://\S+`;

/** The rules a server should have (pure; one per trigger type). */
export function wantedRules(cfg: Partial<AutomodConfig>, alertChannel: string | null): WantedRule[] {
  const actions = (timeout: boolean): AutoModerationActionOptions[] => {
    const list: AutoModerationActionOptions[] = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: (cfg.blockMessage ?? '').slice(0, 150) || undefined } }];
    if (alertChannel) list.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChannel } });
    if (timeout && (cfg.timeoutSeconds ?? 0) > 0) list.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: Math.min(2419200, cfg.timeoutSeconds!) } });
    return list;
  };
  const rules: WantedRule[] = [];
  const words = (cfg.words ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 1000);
  const regex = [...(cfg.invites ? [INVITE] : []), ...(cfg.links ? [LINK] : [])];
  if (words.length || regex.length) {
    rules.push({ name: `${PREFIX}Words`, triggerType: AutoModerationRuleTriggerType.Keyword, triggerMetadata: { keywordFilter: words, regexPatterns: regex, allowList: (cfg.allowed ?? []).slice(0, 100) }, actions: actions(true) });
  }
  const presets = [
    ...(cfg.profanity ? [AutoModerationRuleKeywordPresetType.Profanity] : []),
    ...(cfg.sexual ? [AutoModerationRuleKeywordPresetType.SexualContent] : []),
    ...(cfg.slurs ? [AutoModerationRuleKeywordPresetType.Slurs] : []),
  ];
  if (presets.length) rules.push({ name: `${PREFIX}Filters`, triggerType: AutoModerationRuleTriggerType.KeywordPreset, triggerMetadata: { presets, allowList: (cfg.allowed ?? []).slice(0, 100) }, actions: actions(false) });
  if ((cfg.mentionLimit ?? 0) > 0) rules.push({ name: `${PREFIX}Mentions`, triggerType: AutoModerationRuleTriggerType.MentionSpam, triggerMetadata: { mentionTotalLimit: cfg.mentionLimit }, actions: actions(true) });
  if (cfg.spam) rules.push({ name: `${PREFIX}Spam`, triggerType: AutoModerationRuleTriggerType.Spam, triggerMetadata: {}, actions: actions(false) });
  return rules;
}

/** Creates, updates or deletes the BotHub rules of one server. */
export async function syncAutomod(ctx: ModuleContext, guild: Guild): Promise<void> {
  const on = ctx.enabled('automod');
  const cfg = on ? ctx.config<AutomodConfig>('automod') : {};
  const wanted = on ? wantedRules(cfg, idIn(cfg.alertChannel, guild.id)) : [];
  const rules = await guild.autoModerationRules.fetch().catch((err) => (log.debug('automod fetch failed', { guildId: guild.id, err: String(err) }), null));
  if (!rules) return;
  const ours = [...rules.values()].filter((r) => r.name.startsWith(PREFIX) && r.creatorId === guild.client.user.id);
  const exemptRoles = idsIn(cfg.exemptRoles, guild.id).filter((r) => guild.roles.cache.has(r)).slice(0, 20);
  const exemptChannels = idsIn(cfg.exemptChannels, guild.id).filter((c) => guild.channels.cache.has(c)).slice(0, 50);
  const ids: string[] = [];
  for (const w of wanted) {
    const existing = ours.find((r) => r.triggerType === w.triggerType);
    const data = { name: w.name, eventType: AutoModerationRuleEventType.MessageSend, triggerMetadata: w.triggerMetadata, actions: w.actions, enabled: true, exemptRoles, exemptChannels, reason: 'BotHub Automod settings' };
    try {
      if (existing) {
        const { triggerType: _t, ...edit } = { triggerType: w.triggerType, ...data };
        await existing.edit(edit);
        ids.push(existing.id);
      } else {
        const created = await guild.autoModerationRules.create({ ...data, triggerType: w.triggerType });
        ids.push(created.id);
      }
    } catch (err) {
      // e.g. Discord allows only one spam rule, or the bot lacks Manage Server.
      log.debug('automod rule failed', { guildId: guild.id, rule: w.name, err: String(err) });
      warn(ctx, 'WAR-2008', { module: 'automod', problem: `rule "${w.name}" in ${guild.name}: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  }
  for (const r of ours) if (!ids.includes(r.id)) await r.delete('BotHub Automod settings').catch(() => undefined);
  ctx.setState('automod', guild.id, 'rules', ids);
}

/** Extra punishments after repeated hits (counted once per blocked message). */
export async function automodHit(ctx: ModuleContext, e: AutoModerationActionExecution): Promise<void> {
  if (!ctx.enabled('automod') || e.action.type !== AutoModerationActionType.BlockMessage) return;
  const ours = ctx.getState<string[]>('automod', e.guild.id, 'rules') ?? [];
  if (!ours.includes(e.ruleId)) return;
  await countHit(ctx, e.guild, e.userId);
}

/** Media filter: deletes GIFs, images or videos in the filtered channels (new and edited messages). */
export async function automodMedia(ctx: ModuleContext, msg: Message | PartialMessage): Promise<void> {
  if (msg.partial || !msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('automod')) return;
  const cfg = ctx.config<AutomodConfig>('automod');
  if (!cfg.mediaFilters?.length) return;
  const guildId = msg.guildId;
  const channels = [msg.channelId, ...(msg.channel.isThread() && msg.channel.parentId ? [msg.channel.parentId] : [])];
  const filter = cfg.mediaFilters.find((f) => idsIn(f.channels, guildId).some((c) => channels.includes(c)));
  if (!filter) return;
  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!member) return;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (idsIn(cfg.exemptRoles, guildId).some((r) => member.roles.cache.has(r))) return;
  const kinds = blockedKinds(filter, mediaKinds({
    content: msg.content,
    attachments: [...msg.attachments.values()].map((a) => ({ name: a.name, contentType: a.contentType })),
    embeds: msg.embeds.map((e) => ({ type: e.data.type ?? null, url: e.url, provider: e.provider?.name ?? null })),
  }));
  if (!kinds.length) return;
  const deleted = await msg.delete().then(() => true, () => false);
  if (!deleted) {
    warn(ctx, 'WAR-2008', { module: 'automod', problem: `cannot delete media in #${'name' in msg.channel ? msg.channel.name : msg.channelId}: the bot needs Manage Messages` });
    return;
  }
  const notice = filter.notice ?? '{user.mention}, {media} are not allowed in this channel.';
  if (notice.trim() && msg.channel.isSendable()) {
    await tempNotice(ctx, 'automod', msg.channel, fill(notice, { ...baseVars(msg.guild, member), media: kindList(kinds) }), 10_000);
  }
  await countHit(ctx, msg.guild, member.id);
}

/** Counts a hit of a member (24 hours) and gives the punishment for that count. */
async function countHit(ctx: ModuleContext, guild: Guild, userId: string): Promise<void> {
  const cfg = ctx.config<AutomodConfig>('automod');
  const key = `hits:${userId}`;
  const now = Date.now();
  const hits = [...(ctx.getState<number[]>('automod', guild.id, key) ?? []).filter((t) => now - t < 86_400_000), now].slice(-100);
  ctx.setState('automod', guild.id, key, hits);
  const p = (cfg.punishments ?? []).find((x) => x.count === hits.length);
  if (!p) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  const reason = `Automod: ${hits.length} violations in 24 hours`;
  if (p.action === 'ban') await member.ban({ reason }).catch(() => undefined);
  else if (p.action === 'kick') await member.kick(reason).catch(() => undefined);
  else await member.timeout(Math.min(40320, p.minutes ?? 60) * 60_000, reason).catch(() => undefined);
}
