// Social notifications: Twitch, Kick, YouTube, Reddit and GitHub. ModuleTimers
// calls pollFeeds() every 30 seconds; each platform has its own interval and
// a request budget per round. Every list entry keeps what it announced last
// in module_state, so a stream, video, post or event is posted once.

import type { Guild, MessageCreateOptions, SendableChannels } from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, idIn, idsIn, type MessageConfig, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

const UA = 'BotHub (Discord bot; +https://github.com/Kljub/BotHub)';
const TIMEOUT = 10_000;

// ---------- pure helpers ----------

/** A message field; older configs stored plain text. */
export function messageOf(v: unknown, fallback: MessageConfig): MessageConfig {
  if (typeof v === 'string') return v.trim() ? { mode: 'text', content: v } : fallback;
  if (v && typeof v === 'object') return v as MessageConfig;
  return fallback;
}

/** The message with the roles pinged in front of it. */
export function notification(m: MessageConfig, vars: Record<string, string>, roles: string[]): MessageCreateOptions | null {
  const payload = buildMessage(m, vars);
  if (!payload) return null;
  const mentions = roles.map((r) => `<@&${r}>`).join(' ');
  if (mentions) payload.content = `${mentions}${payload.content ? `\n${payload.content}` : ''}`.slice(0, 2000);
  payload.allowedMentions = { roles };
  return payload;
}

export interface Video {
  id: string;
  title: string;
  author: string;
  url: string;
  description: string;
}

function xmlText(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** Videos of a YouTube channel feed, newest first. */
export function parseFeed(xml: string): Video[] {
  const out: Video[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const id = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1];
    if (!id) continue;
    out.push({
      id,
      title: xmlText(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? ''),
      author: xmlText(/<author>\s*<name>([\s\S]*?)<\/name>/.exec(e)?.[1] ?? ''),
      url: `https://www.youtube.com/watch?v=${id}`,
      description: xmlText(/<media:description>([\s\S]*?)<\/media:description>/.exec(e)?.[1] ?? '').slice(0, 1000),
    });
  }
  return out;
}

/** Items newer than the last one seen (oldest first, at most max). */
export function newVideos<T extends { id: string }>(items: T[], lastSeen: string | undefined, max = 3): T[] {
  if (!lastSeen) return [];
  const i = items.findIndex((v) => v.id === lastSeen);
  return (i < 0 ? items.slice(0, 1) : items.slice(0, i)).slice(0, max).reverse();
}

/** The channel ID on a YouTube channel page (for @handles). */
export function channelIdOfPage(html: string): string | null {
  return (
    /<meta itemprop="identifier" content="(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1] ??
    /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})/.exec(html)?.[1] ??
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1] ??
    null
  );
}

export interface RedditPost {
  name: string;
  created: number;
  title: string;
  author: string;
  url: string;
  link: string;
  flair: string;
  image: string;
  nsfw: boolean;
}

/** Posts of a subreddit listing (new.json), newest first. */
export function parseReddit(json: unknown): RedditPost[] {
  const children = (json as { data?: { children?: { data?: Record<string, unknown> }[] } })?.data?.children ?? [];
  const out: RedditPost[] = [];
  for (const c of children) {
    const d = c.data ?? {};
    if (typeof d.name !== 'string' || typeof d.created_utc !== 'number') continue;
    const preview = (d.preview as { images?: { source?: { url?: string } }[] } | undefined)?.images?.[0]?.source?.url ?? '';
    const link = typeof d.url === 'string' ? d.url : '';
    const image = /^https:\/\//.test(preview) ? preview : /^https:\/\/i\.redd\.it\//.test(link) ? link : '';
    out.push({
      name: d.name,
      created: d.created_utc,
      title: String(d.title ?? ''),
      author: String(d.author ?? ''),
      url: `https://www.reddit.com${String(d.permalink ?? '')}`,
      link,
      flair: String(d.link_flair_text ?? ''),
      image,
      nsfw: d.over_18 === true,
    });
  }
  return out;
}

/** Posts created after the last one seen (oldest first, at most 3). */
export function newPosts(posts: RedditPost[], lastSeen: number | undefined): RedditPost[] {
  if (lastSeen === undefined) return [];
  return posts.filter((p) => p.created > lastSeen).sort((a, b) => a.created - b.created).slice(-3);
}

export interface GithubEntry {
  key: 'push' | 'releases' | 'issues' | 'pullRequests' | 'newRepos' | 'forks' | 'stars';
  vars: { event: string; title: string; url: string; actor: string; repo: string; 'repo.url': string; branch: string; commits: string };
}

/** One GitHub event as a notification, null for kinds the module does not post. */
export function githubEntry(e: Record<string, unknown>): GithubEntry | null {
  const actor = String((e.actor as { login?: string })?.login ?? '');
  const repo = String((e.repo as { name?: string })?.name ?? '');
  const repoUrl = `https://github.com/${repo}`;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const base = { actor, repo, 'repo.url': repoUrl, branch: '', commits: '' };
  switch (e.type) {
    case 'PushEvent': {
      const branch = String(p.ref ?? '').replace(/^refs\/(heads|tags)\//, '');
      const commits = Array.isArray(p.commits) ? (p.commits as { sha?: string; message?: string }[]) : [];
      const lines = commits.slice(0, 5).map((c) => `\`${String(c.sha ?? '').slice(0, 7)}\` ${String(c.message ?? '').split('\n')[0]!.slice(0, 100)}`);
      const url = p.before && p.head ? `${repoUrl}/compare/${String(p.before).slice(0, 12)}...${String(p.head).slice(0, 12)}` : `${repoUrl}/commits/${branch}`;
      return { key: 'push', vars: { ...base, event: 'push', title: `${actor} pushed to ${repo}:${branch}`, url, branch, commits: lines.join('\n') } };
    }
    case 'ReleaseEvent': {
      if (p.action !== 'published') return null;
      const r = (p.release ?? {}) as { tag_name?: string; name?: string; html_url?: string };
      return { key: 'releases', vars: { ...base, event: 'release', title: `Release ${r.name || r.tag_name || ''} of ${repo}`, url: String(r.html_url ?? repoUrl), branch: String(r.tag_name ?? '') } };
    }
    case 'IssuesEvent': {
      if (p.action !== 'opened' && p.action !== 'closed') return null;
      const i = (p.issue ?? {}) as { number?: number; title?: string; html_url?: string };
      return { key: 'issues', vars: { ...base, event: `issue ${p.action}`, title: `Issue #${i.number} ${p.action}: ${i.title ?? ''}`, url: String(i.html_url ?? repoUrl) } };
    }
    case 'PullRequestEvent': {
      const pr = (p.pull_request ?? {}) as { number?: number; title?: string; html_url?: string; merged?: boolean };
      const action = p.action === 'closed' && pr.merged ? 'merged' : p.action;
      if (action !== 'opened' && action !== 'closed' && action !== 'merged') return null;
      const url = pr.html_url ?? `${repoUrl}/pull/${pr.number ?? p.number ?? ''}`;
      return { key: 'pullRequests', vars: { ...base, event: `pull request ${action}`, title: `Pull request #${pr.number ?? p.number} ${action}${pr.title ? `: ${pr.title}` : ''}`, url } };
    }
    case 'CreateEvent': {
      const kind = String(p.ref_type ?? '');
      if (kind === 'repository') return { key: 'newRepos', vars: { ...base, event: 'new repository', title: `New repository ${repo}`, url: repoUrl } };
      const ref = String(p.ref ?? '');
      return { key: 'newRepos', vars: { ...base, event: `new ${kind}`, title: `New ${kind} ${ref} in ${repo}`, url: `${repoUrl}/tree/${ref}`, branch: ref } };
    }
    case 'ForkEvent': {
      const f = (p.forkee ?? {}) as { full_name?: string; html_url?: string };
      return { key: 'forks', vars: { ...base, event: 'fork', title: `${actor} forked ${repo} to ${f.full_name ?? ''}`, url: String(f.html_url ?? repoUrl) } };
    }
    case 'WatchEvent':
      return { key: 'stars', vars: { ...base, event: 'star', title: `${actor} starred ${repo}`, url: repoUrl } };
    default:
      return null;
  }
}

/** GitHub event IDs are increasing numbers (as text). */
export function newerId(id: string, than: string): boolean {
  return id.length !== than.length ? id.length > than.length : id > than;
}

// ---------- runtime ----------

interface Target {
  guild: Guild;
  channel: SendableChannels;
  roles: string[];
}

function target(guilds: Guild[], channelRef: unknown, roleRefs: unknown): Target | null {
  const guild = guilds.find((g) => idIn(channelRef, g.id));
  const channel = guild?.channels.cache.get(idIn(channelRef, guild.id) ?? '');
  if (!guild || !channel?.isSendable()) return null;
  return { guild, channel, roles: idsIn(roleRefs, guild.id) };
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers } | null> {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  if (!res) return null;
  const body = res.status === 204 || res.status === 304 ? null : await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

/** Failed requests back off per source (5 min doubling, at most 6 h) and warn after 3 in a row. */
function failed(ctx: ModuleContext, module: string, guildId: string, source: string, status: string): void {
  const key = `fail:${source}`;
  const fail = ctx.getState<{ count: number; until: number }>(module, guildId, key);
  const count = (fail?.count ?? 0) + 1;
  ctx.setState(module, guildId, key, { count, until: Date.now() + Math.min(6 * 3600_000, 300_000 * 2 ** count) });
  if (count >= 3) warn(ctx, 'WAR-2008', { module, problem: `${source} cannot be read (${status})` });
}

function waiting(ctx: ModuleContext, module: string, guildId: string, source: string): boolean {
  const fail = ctx.getState<{ count: number; until: number }>(module, guildId, `fail:${source}`);
  return !!fail && Date.now() < fail.until;
}

function recovered(ctx: ModuleContext, module: string, guildId: string, source: string): void {
  if (ctx.getState(module, guildId, `fail:${source}`)) ctx.deleteState(module, guildId, `fail:${source}`);
}

/** App access tokens (client credentials), per client ID. */
const tokens = new Map<string, { token: string; until: number }>();

async function appToken(url: string, clientId: string, clientSecret: string): Promise<string | null> {
  const hit = tokens.get(url + clientId);
  if (hit && Date.now() < hit.until) return hit.token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  const res = await fetch(url, { method: 'POST', body, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  const j = res?.ok ? ((await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null) : null;
  if (!j?.access_token) return null;
  tokens.set(url + clientId, { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 300) * 1000 });
  return j.access_token;
}

const every = (now: number, ms: number) => Math.floor(now / ms) !== Math.floor((now - 30_000) / ms);

export async function pollFeeds(ctx: ModuleContext, guilds: Guild[], now: number): Promise<void> {
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      log.warn('feed poll failed', { botId: ctx.botId, module: name, err: String(err) });
    }
  };
  if (every(now, 120_000)) {
    if (ctx.enabled('twitch-notifs')) await run('twitch-notifs', () => twitch(ctx, guilds));
    if (ctx.enabled('kick-notifs')) await run('kick-notifs', () => kick(ctx, guilds));
  }
  if (every(now, 300_000)) {
    if (ctx.enabled('youtube-notifs')) await run('youtube-notifs', () => youtube(ctx, guilds));
    if (ctx.enabled('reddit-notifs')) await run('reddit-notifs', () => reddit(ctx, guilds));
    if (ctx.enabled('github-notifs')) await run('github-notifs', () => github(ctx, guilds));
  }
}

// ---------- Twitch ----------

interface Streamer { login?: string; slug?: string; channel: unknown; mentionRoles: unknown; message: unknown }

const TWITCH_DEFAULT: MessageConfig = { mode: 'text', content: '🔴 **{streamer}** is live: {title}\n{url}' };

async function twitch(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  const list = (ctx.config<{ streamers: Streamer[] }>('twitch-notifs').streamers ?? []).filter((s) => /^[A-Za-z0-9_]{3,25}$/.test(s.login ?? ''));
  if (!list.length) return;
  const id = ctx.secret('TWITCH_CLIENT_ID');
  const secret = ctx.secret('TWITCH_CLIENT_SECRET');
  if (!id || !secret) {
    warn(ctx, 'WAR-2008', { module: 'twitch-notifs', problem: 'Twitch is not set up (Admin → API / Secrets → Integrations)' });
    return;
  }
  const token = await appToken('https://id.twitch.tv/oauth2/token', id, secret);
  if (!token) {
    warn(ctx, 'WAR-2008', { module: 'twitch-notifs', problem: 'Twitch refused the Client ID or Client Secret' });
    return;
  }
  const headers = { 'Client-Id': id, Authorization: `Bearer ${token}` };
  const logins = [...new Set(list.map((s) => s.login!.toLowerCase()))].slice(0, 100);
  const res = await getJson(`https://api.twitch.tv/helix/streams?first=100&${logins.map((l) => `user_login=${l}`).join('&')}`, { headers });
  if (res?.status === 401) tokens.clear();
  if (res?.status !== 200) return;
  const live = new Map<string, Record<string, unknown>>();
  for (const s of ((res.body as { data?: Record<string, unknown>[] })?.data ?? [])) live.set(String(s.user_login).toLowerCase(), s);
  const avatars = new Map<string, string>();
  for (const s of list) {
    const stream = live.get(s.login!.toLowerCase());
    const t = target(guilds, s.channel, s.mentionRoles);
    if (!stream || !t) continue;
    const key = `live:${s.login!.toLowerCase()}:${t.channel.id}`;
    if (ctx.getState<string>('twitch-notifs', t.guild.id, key) === String(stream.id)) continue;
    const login = String(stream.user_login);
    if (!avatars.has(login)) {
      const u = await getJson(`https://api.twitch.tv/helix/users?login=${login}`, { headers });
      avatars.set(login, String((u?.body as { data?: { profile_image_url?: string }[] })?.data?.[0]?.profile_image_url ?? ''));
    }
    const vars = {
      ...baseVars(t.guild, null),
      streamer: String(stream.user_name || login),
      'streamer.login': login,
      'streamer.avatar': avatars.get(login) ?? '',
      title: String(stream.title ?? ''),
      game: String(stream.game_name ?? ''),
      url: `https://www.twitch.tv/${login}`,
      viewers: String(stream.viewer_count ?? 0),
      thumbnail: `${String(stream.thumbnail_url ?? '').replace('{width}x{height}', '1280x720')}?t=${Date.now()}`,
    };
    const payload = notification(messageOf(s.message, TWITCH_DEFAULT), vars, t.roles);
    if (payload && (await send(ctx, 'twitch-notifs', t.channel, payload))) ctx.setState('twitch-notifs', t.guild.id, key, String(stream.id));
  }
}

// ---------- Kick ----------

const KICK_DEFAULT: MessageConfig = { mode: 'text', content: '🟢 **{streamer}** is live: {title}\n{url}' };

interface KickLive { id: string; name: string; title: string; category: string; viewers: string; thumbnail: string }

/** Live streams of Kick channels: official API with an app token, else the public channel page API. */
async function kickLive(ctx: ModuleContext, slugs: string[]): Promise<Map<string, KickLive | null> | null> {
  const out = new Map<string, KickLive | null>();
  const id = ctx.secret('KICK_CLIENT_ID');
  const secret = ctx.secret('KICK_CLIENT_SECRET');
  const token = id && secret ? await appToken('https://id.kick.com/oauth/token', id, secret) : null;
  if (token) {
    const res = await getJson(`https://api.kick.com/public/v1/channels?${slugs.map((s) => `slug=${s}`).join('&')}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res?.status === 401) tokens.clear();
    if (res?.status !== 200) return null;
    for (const c of ((res.body as { data?: Record<string, unknown>[] })?.data ?? [])) {
      const st = (c.stream ?? {}) as { is_live?: boolean; start_time?: string; viewer_count?: number; thumbnail?: string };
      const slug = String(c.slug ?? '').toLowerCase();
      out.set(slug, st.is_live ? { id: String(st.start_time ?? ''), name: String(c.slug ?? slug), title: String(c.stream_title ?? ''), category: String((c.category as { name?: string })?.name ?? ''), viewers: String(st.viewer_count ?? 0), thumbnail: String(st.thumbnail ?? '') } : null);
    }
    return out;
  }
  for (const slug of slugs.slice(0, 10)) {
    const res = await getJson(`https://kick.com/api/v2/channels/${slug}`);
    if (res?.status !== 200) continue;
    const c = res.body as { user?: { username?: string }; livestream?: { id?: number; session_title?: string; viewer_count?: number; thumbnail?: { url?: string }; categories?: { name?: string }[] } | null };
    const l = c.livestream;
    out.set(slug, l ? { id: String(l.id ?? ''), name: String(c.user?.username ?? slug), title: String(l.session_title ?? ''), category: String(l.categories?.[0]?.name ?? ''), viewers: String(l.viewer_count ?? 0), thumbnail: String(l.thumbnail?.url ?? '') } : null);
  }
  return out;
}

async function kick(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  const list = (ctx.config<{ streamers: Streamer[] }>('kick-notifs').streamers ?? []).filter((s) => /^[A-Za-z0-9_-]{2,30}$/.test(s.slug ?? ''));
  if (!list.length) return;
  const slugs = [...new Set(list.map((s) => s.slug!.toLowerCase()))].slice(0, 50);
  const live = await kickLive(ctx, slugs);
  if (!live || (!live.size && slugs.length)) {
    warn(ctx, 'WAR-2008', { module: 'kick-notifs', problem: 'Kick cannot be reached (set up the Kick integration under Admin → API / Secrets for the official API)' });
    return;
  }
  for (const s of list) {
    const stream = live.get(s.slug!.toLowerCase());
    const t = target(guilds, s.channel, s.mentionRoles);
    if (!stream || !t) continue;
    const key = `live:${s.slug!.toLowerCase()}:${t.channel.id}`;
    if (ctx.getState<string>('kick-notifs', t.guild.id, key) === stream.id) continue;
    const vars = { ...baseVars(t.guild, null), streamer: stream.name, title: stream.title, category: stream.category, url: `https://kick.com/${s.slug!.toLowerCase()}`, viewers: stream.viewers, thumbnail: stream.thumbnail };
    const payload = notification(messageOf(s.message, KICK_DEFAULT), vars, t.roles);
    if (payload && (await send(ctx, 'kick-notifs', t.channel, payload))) ctx.setState('kick-notifs', t.guild.id, key, stream.id);
  }
}

// ---------- YouTube ----------

const YOUTUBE_DEFAULT: MessageConfig = { mode: 'text', content: '📺 **{video.author}** uploaded a new video: **{video.title}**\n{video.url}' };

async function youtube(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  let budget = 10; // requests per 5-minute round
  for (const f of ctx.config<{ feeds: { youtubeChannel: string; channel: unknown; mentionRoles: unknown; message: unknown }[] }>('youtube-notifs').feeds ?? []) {
    const ref = f.youtubeChannel ?? '';
    if (!/^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{3,30})$/.test(ref)) continue;
    const t = target(guilds, f.channel, f.mentionRoles);
    if (!t || waiting(ctx, 'youtube-notifs', t.guild.id, ref)) continue;
    let channelId = ref.startsWith('@') ? ctx.getState<string>('youtube-notifs', t.guild.id, `handle:${ref.toLowerCase()}`) : ref;
    if (!channelId) {
      if (budget-- <= 0) break;
      const page = await fetch(`https://www.youtube.com/${encodeURIComponent(ref)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
      channelId = page?.ok ? (channelIdOfPage(await page.text()) ?? undefined) : undefined;
      if (!channelId) {
        failed(ctx, 'youtube-notifs', t.guild.id, ref, `HTTP ${page?.status ?? 'error'}`);
        continue;
      }
      ctx.setState('youtube-notifs', t.guild.id, `handle:${ref.toLowerCase()}`, channelId);
    }
    if (budget-- <= 0) break;
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
    if (!res?.ok) {
      failed(ctx, 'youtube-notifs', t.guild.id, ref, `HTTP ${res?.status ?? 'error'}`);
      continue;
    }
    recovered(ctx, 'youtube-notifs', t.guild.id, ref);
    const videos = parseFeed(await res.text());
    if (!videos.length) continue;
    const key = `yt:${channelId}:${t.channel.id}`;
    const fresh = newVideos(videos, ctx.getState<string>('youtube-notifs', t.guild.id, key));
    if (!fresh.length) ctx.setState('youtube-notifs', t.guild.id, key, videos[0]!.id);
    for (const v of fresh) {
      const vars = { ...baseVars(t.guild, null), 'video.title': v.title, 'video.author': v.author, 'video.url': v.url, 'video.id': v.id, 'video.description': v.description, 'video.thumbnail': `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` };
      const payload = notification(messageOf(f.message, YOUTUBE_DEFAULT), vars, t.roles);
      // The last seen video moves on only after a successful post.
      if (!payload || !(await send(ctx, 'youtube-notifs', t.channel, payload))) break;
      ctx.setState('youtube-notifs', t.guild.id, key, v.id);
    }
  }
}

// ---------- Reddit ----------

const REDDIT_DEFAULT: MessageConfig = { mode: 'text', content: '🟠 New post in r/{subreddit}: **{title}**\n{url}' };

async function reddit(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  let budget = 10;
  for (const s of ctx.config<{ subreddits: { subreddit: string; channel: unknown; mentionRoles: unknown; message: unknown }[] }>('reddit-notifs').subreddits ?? []) {
    const sub = s.subreddit ?? '';
    if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) continue;
    const t = target(guilds, s.channel, s.mentionRoles);
    if (!t || waiting(ctx, 'reddit-notifs', t.guild.id, `r/${sub}`)) continue;
    if (budget-- <= 0) break;
    const res = await getJson(`https://www.reddit.com/r/${sub}/new.json?limit=10&raw_json=1`);
    if (res?.status !== 200) {
      failed(ctx, 'reddit-notifs', t.guild.id, `r/${sub}`, `HTTP ${res?.status ?? 'error'}`);
      continue;
    }
    recovered(ctx, 'reddit-notifs', t.guild.id, `r/${sub}`);
    const posts = parseReddit(res.body);
    if (!posts.length) continue;
    const key = `last:${sub.toLowerCase()}:${t.channel.id}`;
    const last = ctx.getState<number>('reddit-notifs', t.guild.id, key);
    const fresh = newPosts(posts, last);
    if (last === undefined) ctx.setState('reddit-notifs', t.guild.id, key, Math.max(...posts.map((p) => p.created)));
    const nsfwOk = 'nsfw' in t.channel && t.channel.nsfw === true;
    for (const p of fresh) {
      if (!p.nsfw || nsfwOk) {
        const vars = { ...baseVars(t.guild, null), subreddit: sub, title: p.title, author: p.author, url: p.url, flair: p.flair, link: p.link, image: p.image };
        const payload = notification(messageOf(s.message, REDDIT_DEFAULT), vars, t.roles);
        if (!payload || !(await send(ctx, 'reddit-notifs', t.channel, payload))) break;
      }
      ctx.setState('reddit-notifs', t.guild.id, key, p.created);
    }
  }
}

// ---------- GitHub ----------

const GITHUB_DEFAULT: MessageConfig = { mode: 'text', content: '🐙 **{title}**\n{url}' };

interface GithubFeed { target: string; channel: unknown; mentionRoles: unknown; message: unknown; [flag: string]: unknown }

/** Rate limit of the GitHub API: no requests until this time. */
let githubPausedUntil = 0;

async function github(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (Date.now() < githubPausedUntil) return;
  // With the GitHub OAuth app of Admin → Integrations the limit is 5000
  // instead of 60 requests per hour.
  const id = ctx.secret('GITHUB_OAUTH_CLIENT_ID');
  const secret = ctx.secret('GITHUB_OAUTH_CLIENT_SECRET');
  const auth: Record<string, string> = id && secret ? { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` } : {};
  let budget = id && secret ? 25 : 4;
  for (const f of ctx.config<{ feeds: GithubFeed[] }>('github-notifs').feeds ?? []) {
    const what = f.target ?? '';
    if (!/^[A-Za-z0-9-]{1,39}(\/[A-Za-z0-9._-]{1,100})?$/.test(what)) continue;
    const t = target(guilds, f.channel, f.mentionRoles);
    if (!t || waiting(ctx, 'github-notifs', t.guild.id, what)) continue;
    if (budget-- <= 0) break;
    const key = `gh:${what.toLowerCase()}:${t.channel.id}`;
    const state = ctx.getState<{ last: string; etag: string }>('github-notifs', t.guild.id, key);
    const url = what.includes('/') ? `https://api.github.com/repos/${what}/events?per_page=30` : `https://api.github.com/users/${what}/events/public?per_page=30`;
    const res = await getJson(url, { headers: { Accept: 'application/vnd.github+json', ...auth, ...(state?.etag ? { 'If-None-Match': state.etag } : {}) } });
    if (res && Number(res.headers.get('x-ratelimit-remaining') ?? '1') <= 0) githubPausedUntil = Number(res.headers.get('x-ratelimit-reset') ?? '0') * 1000;
    if (res?.status === 304) continue;
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      if (res?.status !== 403 && res?.status !== 429) failed(ctx, 'github-notifs', t.guild.id, what, `HTTP ${res?.status ?? 'error'}`);
      continue;
    }
    recovered(ctx, 'github-notifs', t.guild.id, what);
    const events = res.body as Record<string, unknown>[];
    const etag = res.headers.get('etag') ?? '';
    const newest = String(events[0]?.id ?? state?.last ?? '');
    if (!state?.last) {
      ctx.setState('github-notifs', t.guild.id, key, { last: newest, etag });
      continue;
    }
    const fresh = events.filter((e) => newerId(String(e.id), state.last)).reverse().slice(-5);
    let last = state.last;
    for (const e of fresh) {
      const entry = githubEntry(e);
      if (entry && (f[entry.key] ?? DEFAULT_FLAGS[entry.key]) === true) {
        const payload = notification(messageOf(f.message, GITHUB_DEFAULT), { ...baseVars(t.guild, null), ...entry.vars }, t.roles);
        if (!payload || !(await send(ctx, 'github-notifs', t.channel, payload))) break;
      }
      last = String(e.id);
    }
    ctx.setState('github-notifs', t.guild.id, key, { last, etag: last === newest ? etag : '' });
  }
}

const DEFAULT_FLAGS: Record<GithubEntry['key'], boolean> = { push: true, releases: true, issues: false, pullRequests: true, newRepos: true, forks: false, stars: false };
