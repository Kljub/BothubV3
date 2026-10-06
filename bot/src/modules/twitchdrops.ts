// Twitch Drops Tracker (module "twitch-notifs"): watched games are checked
// every 15 minutes; when streams with Drops start for a game, the module
// posts it with the biggest of those streams. /twitch-drops (block "Twitch
// drops") shows them for any game.
//
// Source: Twitch's own website interface (gql.twitch.tv, the public client
// ID of twitch.tv, no sign-in). It is not an official API: Twitch may change
// it without notice; then the tracker stays quiet and logs a warning.

import type { Guild } from 'discord.js';
import { idIn, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

const GQL = 'https://gql.twitch.tv/gql';
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const QUERY = 'query($name: String!) { game(name: $name) { id displayName boxArtURL(width: 285, height: 380) streams(first: 5, options: {systemFilters: [DROPS_ENABLED], sort: VIEWER_COUNT}) { edges { node { title viewersCount broadcaster { login displayName } } } } } }';

export interface DropStream { login: string; name: string; title: string; viewers: number }
export interface DropsInfo { game: string; id: string; image: string; streams: DropStream[] }

/** The answer of the query: the game and its streams with Drops (null: no such game). */
export function parseDrops(raw: unknown): DropsInfo | null {
  const g = (raw as { data?: { game?: any } })?.data?.game;
  if (!g?.id) return null;
  return {
    game: String(g.displayName ?? ''),
    id: String(g.id),
    image: String(g.boxArtURL ?? ''),
    streams: (g.streams?.edges ?? []).map((e: any) => ({
      login: String(e?.node?.broadcaster?.login ?? ''),
      name: String(e?.node?.broadcaster?.displayName ?? e?.node?.broadcaster?.login ?? ''),
      title: String(e?.node?.title ?? '').slice(0, 100),
      viewers: Number(e?.node?.viewersCount) || 0,
    })).filter((s: DropStream) => s.login),
  };
}

export async function dropsOf(name: string): Promise<DropsInfo | null> {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Client-Id': WEB_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { name: name.trim().slice(0, 100) } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Twitch HTTP ${res.status}`);
  const body = await res.json();
  if ((body as { errors?: unknown[] })?.errors?.length) throw new Error('Twitch refused the query');
  return parseDrops(body);
}

export function dropsText(d: DropsInfo, limit = 5): string {
  if (!d.streams.length) return `No streams of **${d.game}** with Drops right now.`;
  return d.streams.slice(0, limit).map((s) => `🔴 **[${s.name}](https://twitch.tv/${s.login})** · ${s.viewers.toLocaleString('en-US')} viewers\n${s.title}`).join('\n');
}

/** Post once when Drops start (none before → some now); "ended" after an hour without. */
export function dropsChange(prev: { live: boolean; since: number } | undefined, live: boolean, now = Date.now()): { post: boolean; state: { live: boolean; since: number } } {
  if (!prev) return { post: false, state: { live, since: now } }; // first check: only remember
  if (live && !prev.live) return { post: true, state: { live: true, since: now } };
  if (!live && prev.live) return { post: false, state: { live: now - prev.since < 3_600_000 ? true : false, since: prev.since } };
  return { post: false, state: live ? { live: true, since: now } : prev };
}

interface DropsEntry { _id?: string; game: string; channel: unknown; role: unknown }

/** Every 15 minutes: the watched games of the Twitch module. */
export async function watchDrops(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled('twitch-notifs')) return;
  const list = (ctx.config<{ dropsGames: DropsEntry[] }>('twitch-notifs').dropsGames ?? []).filter((e) => e?.game?.trim()).slice(0, 25);
  for (const e of list) {
    const guild = guilds.find((g) => idIn(e.channel, g.id));
    const channel = guild?.channels.cache.get(idIn(e.channel, guild.id) ?? '');
    if (!guild || !channel?.isSendable()) continue;
    let d: DropsInfo | null;
    try {
      d = await dropsOf(e.game);
    } catch (err) {
      warn(ctx, 'WAR-2008', { module: 'twitch-notifs', problem: `Drops of "${e.game}" could not be checked: ${(err as Error).message}` });
      return;
    }
    if (!d) continue;
    const key = `drops:${e._id ?? e.game.toLowerCase()}`;
    const prev = ctx.getState<{ live: boolean; since: number }>('twitch-notifs', guild.id, key);
    const { post, state } = dropsChange(prev, d.streams.length > 0);
    ctx.setState('twitch-notifs', guild.id, key, state);
    if (!post) continue;
    const role = idIn(e.role, guild.id);
    await send(ctx, 'twitch-notifs', channel, {
      content: role ? `<@&${role}>` : undefined,
      embeds: [{ color: 0x9146ff, title: `🎁 Twitch Drops are live for ${d.game}!`, url: `https://www.twitch.tv/directory/category/${encodeURIComponent(d.game.toLowerCase().replace(/\s+/g, '-'))}?filter=drops`, thumbnail: d.image ? { url: d.image } : undefined, description: dropsText(d, 3), footer: { text: 'Watch a stream with Drops to earn the rewards · twitch.tv/drops/campaigns' } }],
      allowedMentions: { roles: role ? [role] : [] },
    });
  }
}
