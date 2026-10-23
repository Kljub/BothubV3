// Link to Media: Instagram, TikTok, Reddit and Bluesky post links become the
// post's video or picture. An embed service (kkinstagram, tnktok, rxddit,
// bskx; host set per platform) answers Discord's crawler with the media
// address: "upload" fetches that file and attaches it, "embed" only swaps the
// link host so Discord shows the service's player. "replace" deletes the
// original and posts again with the member's name and picture (own webhook),
// "reply" answers below it and hides the original's preview.

import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { AttachmentBuilder, PermissionFlagsBits, type Message } from 'discord.js';
import { idsIn, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';
import { canUseWebhook, forgetWebhook, ownWebhook } from '../discord/webhooks.js';
import { privateAddress } from '../sdk/discord-api.js';

export type Platform = 'instagram' | 'tiktok' | 'reddit' | 'bluesky';

export const DEFAULT_HOSTS: Record<Platform, string> = {
  instagram: 'kkinstagram.com',
  tiktok: 'tnktok.com',
  reddit: 'rxddit.com',
  bluesky: 'bskx.app',
};

// <link> (embed suppressed by the author) is left alone. Each pattern gives
// the path the embed service takes.
const PATTERNS: Record<Platform, { re: RegExp; path: (m: RegExpExecArray) => string }> = {
  instagram: {
    re: /(?<!<)https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:[\w.]{1,30}\/)?(p|reels?|tv)\/([\w-]{5,40})[^\s>|]*/gi,
    path: (m) => `${m[1]!.toLowerCase() === 'reels' ? 'reel' : m[1]!.toLowerCase()}/${m[2]}`,
  },
  tiktok: {
    re: /(?<!<)https?:\/\/(?:(?:www\.|m\.)?tiktok\.com\/(@[\w.]{1,30}\/(?:video|photo)\/\d{5,25}|t\/[\w]{5,20})|(?:vm|vt)\.tiktok\.com\/([\w]{5,20}))[^\s>|]*/gi,
    path: (m) => m[1] ?? `t/${m[2]}`,
  },
  reddit: {
    re: /(?<!<)https?:\/\/(?:www\.|old\.|new\.|m\.)?reddit\.com\/(r\/\w{2,21}\/(?:comments\/\w{4,12}(?:\/\w*)?|s\/\w{5,20}))[^\s>|]*/gi,
    path: (m) => m[1]!,
  },
  bluesky: {
    re: /(?<!<)https?:\/\/bsky\.app\/(profile\/[\w.:-]{3,253}\/post\/\w{5,20})[^\s>|]*/gi,
    path: (m) => m[1]!,
  },
};

const MAX_LINKS = 3;
const MAX_PAGE = 512 * 1024;
// Discord's crawler: the services answer it with the media tags.
const CRAWLER = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

export interface FoundLink {
  platform: Platform;
  /** The link as written in the message. */
  original: string;
  /** The same post at the embed service. */
  fixed: string;
}

/** The post links of a text (max. 3, in order, no repeats). */
export function findLinks(text: string, platforms: Platform[], hosts: Partial<Record<Platform, string>> = {}): FoundLink[] {
  const found: (FoundLink & { at: number })[] = [];
  for (const platform of platforms) {
    const p = PATTERNS[platform];
    if (!p) continue;
    const host = validHost(hosts[platform]) ?? DEFAULT_HOSTS[platform];
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      found.push({ platform, original: m[0], fixed: `https://${host}/${p.path(m)}`, at: m.index });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  return found.filter((l) => !seen.has(l.fixed) && seen.add(l.fixed)).slice(0, MAX_LINKS).map(({ at: _at, ...l }) => l);
}

function validHost(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null;
}

/** The media address of a service page: video first, else the picture. */
export function mediaOf(html: string): string | null {
  const tags: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const name = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name && content && !(name in tags)) tags[name] = content.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&quot;/g, '"');
  }
  const pick = ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream', 'og:image:secure_url', 'og:image', 'twitter:image'];
  for (const key of pick) {
    const v = tags[key];
    if (v && /^https:\/\//i.test(v)) return v;
  }
  return null;
}

/** Upload limit of a server: 10 MB, boost level 2 50 MB, level 3 100 MB. */
export function uploadLimit(premiumTier: number): number {
  return (premiumTier >= 3 ? 100 : premiumTier >= 2 ? 50 : 10) * 1024 * 1024;
}

interface Fetched {
  type: string;
  body: Buffer;
  url: URL;
}

/**
 * GET of a public https address: checked IP for every hop (no private
 * networks), max. 4 redirects, stops at maxBytes. Null on any problem.
 */
export async function fetchPublic(raw: string, maxBytes: number, timeoutMs: number): Promise<Fetched | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return null;
    const pinned = addrs[0]!;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const res = await new Promise<{ redirect?: string; fetched?: Fetched } | null>((resolve) => {
      const req = https.get(url, {
        timeout: left,
        headers: { 'User-Agent': CRAWLER, Accept: '*/*' },
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family))) as never,
      }, (r) => {
        const status = r.statusCode ?? 0;
        if (status >= 300 && status < 400 && r.headers.location) {
          r.resume();
          resolve({ redirect: r.headers.location });
          return;
        }
        if (status !== 200 || Number(r.headers['content-length'] ?? 0) > maxBytes) {
          r.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            resolve(null);
          } else chunks.push(c);
        });
        r.on('end', () => resolve({ fetched: { type: String(r.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(), body: Buffer.concat(chunks), url } }));
        r.on('error', () => resolve(null));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
    if (!res) return null;
    if (res.fetched) return res.fetched;
    try {
      url = new URL(res.redirect!, url);
    } catch {
      return null;
    }
  }
  return null;
}

const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Downloads at once per bot; more links go out as embed links.
let running = 0;
const MAX_RUNNING = 4;

/** The post's video or picture as a file, or null (then the embed link is used). */
async function download(link: FoundLink, maxBytes: number, spoiler: boolean): Promise<AttachmentBuilder | null> {
  if (running >= MAX_RUNNING) return null;
  running++;
  try {
    const page = await fetchPublic(link.fixed, Math.max(MAX_PAGE, maxBytes), 10_000);
    if (!page) return null;
    let media: Fetched | null = page;
    if (!EXT[page.type]) {
      const address = page.type === 'text/html' && page.body.length <= MAX_PAGE ? mediaOf(page.body.toString('utf8')) : null;
      media = address ? await fetchPublic(address, maxBytes, 25_000) : null;
    }
    const ext = media && EXT[media.type];
    if (!media || !ext || !media.body.length) return null;
    return new AttachmentBuilder(media.body, { name: `${spoiler ? 'SPOILER_' : ''}${link.platform}.${ext}` });
  } finally {
    running--;
  }
}

interface LinkMediaConfig {
  platforms: unknown;
  mode: string;
  media: string;
  keepLink: boolean;
  channels: unknown;
  ignoreBots: boolean;
  instagramHost: string;
  tiktokHost: string;
  redditHost: string;
  blueskyHost: string;
}

const ALL: Platform[] = ['instagram', 'tiktok', 'reddit', 'bluesky'];

export async function linkMediaMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || !msg.content || msg.author.id === msg.client.user.id || !ctx.enabled('link-media')) return;
  const cfg = ctx.config<LinkMediaConfig>('link-media');
  // Our own reposts come back through the webhook.
  if (msg.webhookId || (msg.author.bot && cfg.ignoreBots !== false)) return;
  const only = idsIn(cfg.channels, msg.guildId);
  if (only.length && !only.includes(msg.channelId) && !only.includes(msg.channel.isThread() ? (msg.channel.parentId ?? '') : '')) return;
  const platforms = Array.isArray(cfg.platforms) ? ALL.filter((p) => (cfg.platforms as unknown[]).includes(p)) : ['instagram' as Platform];
  const links = findLinks(msg.content, platforms, { instagram: cfg.instagramHost, tiktok: cfg.tiktokHost, reddit: cfg.redditHost, bluesky: cfg.blueskyHost });
  if (!links.length) return;

  const channel = msg.channel;
  const perms = channel.permissionsFor(msg.client.user);
  const canManage = perms?.has(PermissionFlagsBits.ManageMessages) ?? false;
  const canAttach = perms?.has(PermissionFlagsBits.AttachFiles) ?? false;
  const spoiler = msg.content.includes('||');

  // Media first: a link without a file keeps the embed service's link.
  const files: AttachmentBuilder[] = [];
  const asFile = new Set<FoundLink>();
  if (cfg.media !== 'embed' && canAttach) {
    const limit = uploadLimit(msg.guild.premiumTier);
    const got = await Promise.all(links.map((l) => download(l, limit, spoiler).catch(() => null)));
    got.forEach((f, i) => {
      if (f) {
        files.push(f);
        asFile.add(links[i]!);
      }
    });
  }
  const keep = cfg.keepLink !== false;
  const shown = (l: FoundLink) => (asFile.has(l) ? (keep ? `<${l.original}>` : '') : l.fixed);

  // Replace: the original goes; attachments or stickers of it would get lost, so they reply.
  const replace = cfg.mode !== 'reply' && canManage && msg.attachments.size === 0 && msg.stickers.size === 0;
  if (replace) {
    let text = msg.content;
    for (const l of links) text = text.split(l.original).join(shown(l));
    text = text.replace(/[ \t]{2,}/g, ' ').trim();
    if (await repost(ctx, msg, text, files)) return;
  }

  const lines = links.map((l) => (asFile.has(l) ? (keep ? `<${l.fixed}>` : '') : l.fixed)).filter(Boolean);
  const sent = await send(ctx, 'link-media', channel, {
    content: lines.join('\n').slice(0, 2000) || undefined,
    files,
    allowedMentions: { parse: [], repliedUser: false },
    reply: { messageReference: msg.id, failIfNotExists: false },
  });
  if (sent && canManage) await msg.suppressEmbeds(true).catch(() => undefined);
}

/** Posts the message again with the member's name and picture, then deletes the original. False = could not. */
async function repost(ctx: ModuleContext, msg: Message<true>, content: string, files: AttachmentBuilder[]): Promise<boolean> {
  if (!canUseWebhook(msg.channel)) {
    warn(ctx, 'WAR-2008', { module: 'link-media', problem: 'replacing needs Manage Webhooks; the bot replies instead' });
    return false;
  }
  const target = await ownWebhook(msg.channel).catch(() => null);
  if (!target) return false;
  const sent = await target.hook.send({
    content: content.slice(0, 2000) || undefined,
    files,
    username: (msg.member?.displayName ?? msg.author.username).slice(0, 80),
    avatarURL: msg.member?.displayAvatarURL() ?? msg.author.displayAvatarURL(),
    allowedMentions: { parse: [] },
    threadId: target.threadId,
  }).catch((err: { code?: number }) => {
    if (err.code === 10015) forgetWebhook(target.hook.channelId);
    return null;
  });
  if (!sent) return false;
  await msg.delete().catch(() => undefined);
  return true;
}
