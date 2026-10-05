// RSS / Atom feeds (module "rss-notifs") and Bluesky accounts (module
// "bluesky-notifs"). Polled every 5 minutes from pollFeeds (feeds.ts). Each
// entry keeps the IDs it has seen (last 100) in module_state; the first
// round only remembers, so old posts are not flooded into the channel.

import { lookup } from 'node:dns/promises';
import type { Guild } from 'discord.js';
import { privateAddress } from '../sdk/discord-api.js';
import { baseVars, type MessageConfig, type ModuleContext } from './context.js';
import { send } from './guard.js';
import { failed, messageOf, notification, recovered, target, waiting } from './feeds.js';

const UA = 'BotHub (Discord bot; +https://github.com/Kljub/BothubV3)';
const MAX_FEED_BYTES = 2_000_000;

// ---------- RSS / Atom ----------

export interface FeedItem { id: string; title: string; url: string; author: string; summary: string; image: string; published: number }

const decode = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const tag = (block: string, name: string): string => decode(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1] ?? '').trim();
const attr = (block: string, name: string, a: string): string => new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]+)"`, 'i').exec(block)?.[1] ?? '';
/** HTML of a summary as short plain text. */
export const plain = (html: string, max = 400): string => {
  const t = decode(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Entries of an RSS 2.0 or Atom document, newest first. */
export function parseRss(xml: string): { title: string; items: FeedItem[] } {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const channel = atom ? xml.split(/<entry\b/i)[0]! : xml.split(/<item\b/i)[0]!;
  const items = blocks.map((b) => {
    const link = atom ? (attr(b, 'link[^>]*rel="alternate"', 'href') || attr(b, 'link', 'href')) : tag(b, 'link') || attr(b, 'link', 'href');
    const id = tag(b, atom ? 'id' : 'guid') || link || tag(b, 'title');
    const image = attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') || (/^image\//.test(attr(b, 'enclosure', 'type')) ? attr(b, 'enclosure', 'url') : '')
      || /<img[^>]+src="([^"]+)"/i.exec(decode(tag(b, 'content:encoded') || tag(b, 'description') || tag(b, 'content')))?.[1] || '';
    const date = Date.parse(tag(b, atom ? 'updated' : 'pubDate') || tag(b, 'published') || tag(b, 'dc:date'));
    return {
      id: id.slice(0, 300),
      title: plain(tag(b, 'title'), 256) || '(untitled)',
      url: /^https?:\/\//.test(link) ? link : '',
      author: plain(tag(b, 'dc:creator') || tag(b, 'author') || tag(tag(b, 'author'), 'name'), 100),
      summary: plain(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'), 400),
      image: /^https:\/\//.test(image) ? image : '',
      published: Number.isFinite(date) ? date : 0,
    };
  }).filter((i) => i.id);
  items.sort((a, b) => b.published - a.published);
  return { title: plain(tag(channel, 'title'), 100), items };
}

/** Feeds only from public hosts (no home network, no services of this server). */
async function publicUrl(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const ips = await lookup(url.hostname, { all: true }).then((r) => r.map((x) => x.address)).catch(() => []);
  return ips.length && !ips.some(privateAddress) ? url : null;
}

async function fetchText(url: URL): Promise<{ status: number; text: string } | null> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return null;
  if (!res.ok) return { status: res.status, text: '' };
  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength > MAX_FEED_BYTES) return { status: 413, text: '' };
  return { status: res.status, text: new TextDecoder('utf-8').decode(buf) };
}

/** IDs not seen yet (oldest first, at most max); null on the first round. */
export function unseen<T extends { id: string }>(items: T[], seen: string[] | undefined, max = 5): T[] | null {
  if (!seen) return null;
  return items.filter((i) => !seen.includes(i.id)).slice(0, max).reverse();
}

const RSS_DEFAULT: MessageConfig = { mode: 'text', content: '📰 **{title}**\n{url}' };
interface RssEntry { url: string; channel: unknown; mentionRoles: unknown; message: unknown }

export async function rss(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  let budget = 15;
  for (const f of ctx.config<{ feeds: RssEntry[] }>('rss-notifs').feeds ?? []) {
    const t = target(guilds, f.channel, f.mentionRoles);
    const source = String(f.url ?? '').slice(0, 500);
    if (!t || !source || waiting(ctx, 'rss-notifs', t.guild.id, source)) continue;
    if (budget-- <= 0) break;
    const url = await publicUrl(source);
    if (!url) {
      failed(ctx, 'rss-notifs', t.guild.id, source, 'not a public http(s) address');
      continue;
    }
    const res = await fetchText(url);
    if (res?.status !== 200) {
      failed(ctx, 'rss-notifs', t.guild.id, source, `HTTP ${res?.status ?? 'error'}`);
      continue;
    }
    const feed = parseRss(res.text);
    if (!feed.items.length) {
      failed(ctx, 'rss-notifs', t.guild.id, source, 'no RSS or Atom entries');
      continue;
    }
    recovered(ctx, 'rss-notifs', t.guild.id, source);
    const key = `seen:${t.channel.id}:${source}`.slice(0, 200);
    const seen = ctx.getState<string[]>('rss-notifs', t.guild.id, key);
    const fresh = unseen(feed.items, seen);
    const remember = (ids: string[]) => ctx.setState('rss-notifs', t.guild.id, key, [...new Set([...ids, ...(seen ?? [])])].slice(0, 100));
    if (fresh === null) {
      remember(feed.items.map((i) => i.id));
      continue;
    }
    for (const item of fresh) {
      const vars = { ...baseVars(t.guild, null), feed: feed.title, title: item.title, url: item.url, author: item.author, summary: item.summary, image: item.image };
      const payload = notification(messageOf(f.message, RSS_DEFAULT), vars, t.roles);
      if (!payload || !(await send(ctx, 'rss-notifs', t.channel, payload))) break;
      remember([item.id]);
    }
  }
}

// ---------- Bluesky ----------

export interface BskyPost { id: string; url: string; text: string; image: string; repost: boolean; handle: string; name: string; avatar: string; reposter: string }

/** Posts of app.bsky.feed.getAuthorFeed, newest first. */
export function parseBluesky(json: unknown, handle: string): BskyPost[] {
  const feed = (json as { feed?: Array<{ post?: any; reason?: any }> })?.feed;
  if (!Array.isArray(feed)) return [];
  return feed.filter((f) => f?.post?.uri).map((f) => {
    const p = f.post;
    const author = p.author ?? {};
    const rkey = String(p.uri).split('/').pop() ?? '';
    const images = p.embed?.images ?? p.embed?.media?.images ?? [];
    const repost = String(f.reason?.$type ?? '').includes('reasonRepost');
    return {
      id: repost ? `repost:${p.uri}` : String(p.uri),
      url: `https://bsky.app/profile/${author.handle ?? handle}/post/${rkey}`,
      text: String(p.record?.text ?? '').slice(0, 2000),
      image: String(images[0]?.fullsize ?? images[0]?.thumb ?? p.embed?.external?.thumb ?? ''),
      repost,
      handle: String(author.handle ?? handle),
      name: String(author.displayName || author.handle || handle),
      avatar: String(author.avatar ?? ''),
      reposter: repost ? handle : '',
    };
  });
}

const BSKY_DEFAULT: MessageConfig = { mode: 'text', content: '🦋 **{name}** posted on Bluesky:\n{text}\n{url}' };
interface BskyEntry { handle: string; channel: unknown; mentionRoles: unknown; reposts: boolean; message: unknown }

export async function bluesky(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  let budget = 15;
  for (const a of ctx.config<{ accounts: BskyEntry[] }>('bluesky-notifs').accounts ?? []) {
    const handle = String(a.handle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9.-]{3,253}$/.test(handle) && !/^did:plc:[a-z0-9]{10,64}$/.test(handle)) continue;
    const t = target(guilds, a.channel, a.mentionRoles);
    if (!t || waiting(ctx, 'bluesky-notifs', t.guild.id, handle)) continue;
    if (budget-- <= 0) break;
    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=10&filter=posts_no_replies`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) {
      failed(ctx, 'bluesky-notifs', t.guild.id, handle, `HTTP ${res?.status ?? 'error'}`);
      continue;
    }
    recovered(ctx, 'bluesky-notifs', t.guild.id, handle);
    const posts = parseBluesky(await res.json().catch(() => null), handle).filter((p) => a.reposts === true || !p.repost);
    const key = `seen:${t.channel.id}:${handle}`;
    const seen = ctx.getState<string[]>('bluesky-notifs', t.guild.id, key);
    const fresh = unseen(posts, seen);
    const remember = (ids: string[]) => ctx.setState('bluesky-notifs', t.guild.id, key, [...new Set([...ids, ...(seen ?? [])])].slice(0, 100));
    if (fresh === null) {
      remember(posts.map((p) => p.id));
      continue;
    }
    for (const p of fresh) {
      const vars = { ...baseVars(t.guild, null), handle: p.handle, name: p.name, text: p.text, url: p.url, image: p.image, avatar: p.avatar, repost: p.repost ? 'true' : 'false' };
      const payload = notification(messageOf(a.message, BSKY_DEFAULT), vars, t.roles);
      if (!payload || !(await send(ctx, 'bluesky-notifs', t.channel, payload))) break;
      remember([p.id]);
    }
  }
}
