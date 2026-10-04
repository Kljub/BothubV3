// Free Games (module "free-games", block Free Games): Epic Games' free
// promotions and free Steam games (GamerPower API). The module posts new free
// games to its channel: as soon as they are found, or collected at a set time
// on chosen weekdays (bot time zone). Answers are cached for 30 minutes.

import { EmbedBuilder, type Guild } from 'discord.js';
import type { localTime } from '../core/timed.js';
import { idIn, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

export interface FreeGame { title: string; store: 'Epic Games' | 'Steam'; url: string; until: string | null; image: string | null; description: string }

export interface FreeGamesConfig {
  channel: unknown; pingRole: unknown; epic: boolean; steam: boolean; schedule: boolean; time: string;
  mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean;
}

const EPIC = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
const STEAM = 'https://www.gamerpower.com/api/giveaways?platform=steam&type=game';
const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { at: number; games: FreeGame[] }>();

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Epic's answer: games with a 100 % discount running right now. */
export function epicGames(raw: unknown, now = Date.now()): FreeGame[] {
  const els = (raw as { data?: { Catalog?: { searchStore?: { elements?: unknown[] } } } })?.data?.Catalog?.searchStore?.elements ?? [];
  const out: FreeGame[] = [];
  for (const e of els as Record<string, any>[]) {
    const offers = (e.promotions?.promotionalOffers ?? []).flatMap((p: any) => p.promotionalOffers ?? []);
    const active = offers.find((o: any) => o.discountSetting?.discountPercentage === 0 && Date.parse(o.startDate) <= now && Date.parse(o.endDate) > now);
    if (!active) continue;
    const slug = e.catalogNs?.mappings?.[0]?.pageSlug ?? e.productSlug ?? e.urlSlug;
    const images = (e.keyImages ?? []) as { type: string; url: string }[];
    const image = (images.find((i) => i.type === 'OfferImageWide') ?? images.find((i) => i.type === 'Thumbnail') ?? images[0])?.url ?? null;
    out.push({
      title: String(e.title ?? '?'),
      store: 'Epic Games',
      url: slug ? `https://store.epicgames.com/p/${String(slug).replace(/\/home$/, '')}` : 'https://store.epicgames.com/free-games',
      until: active.endDate ?? null,
      image,
      description: String(e.description ?? '').slice(0, 300),
    });
  }
  return out;
}

/** GamerPower's answer: Steam games free to keep. */
export function steamGames(raw: unknown): FreeGame[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g: any) => g && g.status === 'Active')
    .slice(0, 15)
    .map((g: any) => ({
      title: String(g.title ?? '?').replace(/\s*\(Steam\)\s*(?:Key\s*)?Giveaway$/i, ''),
      store: 'Steam' as const,
      url: String(g.open_giveaway_url ?? g.gamerpower_url ?? ''),
      until: g.end_date && g.end_date !== 'N/A' ? new Date(`${String(g.end_date).replace(' ', 'T')}Z`).toISOString() : null,
      image: typeof g.image === 'string' ? g.image : null,
      description: String(g.description ?? '').slice(0, 300),
    }));
}

export async function freeGames(platforms: { epic: boolean; steam: boolean }): Promise<FreeGame[]> {
  const key = `${platforms.epic}:${platforms.steam}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.games;
  const games: FreeGame[] = [];
  if (platforms.epic) games.push(...epicGames(await getJson(EPIC)));
  if (platforms.steam) games.push(...steamGames(await getJson(STEAM).catch(() => [])));
  cache.set(key, { at: Date.now(), games });
  return games;
}

/** Platforms of the module settings (both when never set). */
export function platformsOf(cfg: Partial<FreeGamesConfig>): { epic: boolean; steam: boolean } {
  return { epic: cfg.epic !== false, steam: cfg.steam !== false };
}

/** "**Title** (Epic Games) · free until <t:…:R>" lines with links. */
export function freeGamesText(games: FreeGame[]): string {
  return games
    .slice(0, 20)
    .map((g) => {
      const until = g.until && !Number.isNaN(Date.parse(g.until)) ? ` · free until <t:${Math.floor(Date.parse(g.until) / 1000)}:R>` : '';
      return `**[${g.title}](${g.url})** (${g.store})${until}`;
    })
    .join('\n');
}

/** Identity of a game for "already posted" (title and store; promotions repeat). */
export const gameKey = (g: FreeGame): string => `${g.store}:${g.title.toLowerCase()}:${g.until ?? ''}`;

/** Games not posted yet. */
export function newGames(games: FreeGame[], posted: string[]): FreeGame[] {
  return games.filter((g) => !posted.includes(gameKey(g)));
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Whether the scheduled post is due: the day is chosen, the time has come, not posted today. */
export function scheduleDue(cfg: Partial<FreeGamesConfig>, local: ReturnType<typeof localTime>, lastDay: string | undefined): boolean {
  const day = DAY_KEYS[local.weekday];
  if (!day || cfg[day] === false) return false;
  return local.hms.slice(0, 5) >= (cfg.time || '18:00') && lastDay !== local.date;
}

export function gameEmbed(g: FreeGame): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(g.title.slice(0, 256))
    .setURL(g.url || null)
    .setColor(g.store === 'Steam' ? 0x1b2838 : 0x2a2a2a)
    .setAuthor({ name: `Free on ${g.store}` });
  if (g.description) e.setDescription(g.description);
  if (g.until && !Number.isNaN(Date.parse(g.until))) e.addFields({ name: 'Free until', value: `<t:${Math.floor(Date.parse(g.until) / 1000)}:F> (<t:${Math.floor(Date.parse(g.until) / 1000)}:R>)` });
  if (g.image) e.setImage(g.image);
  return e;
}

/** Posts the free games of the module to one server (timer, every 30 minutes and at the set time). */
export async function postFreeGames(ctx: ModuleContext, guild: Guild, local: ReturnType<typeof localTime>, check: boolean): Promise<void> {
  const cfg = ctx.config<FreeGamesConfig>('free-games');
  const channelId = idIn(cfg.channel, guild.id);
  if (!channelId) return;
  const due = cfg.schedule ? scheduleDue(cfg, local, ctx.getState<string>('free-games', guild.id, 'day')) : check;
  if (!due) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isSendable()) {
    warn(ctx, 'WAR-2008', { module: 'free-games', problem: 'the channel is missing or the bot cannot write there' });
    return;
  }
  let games: FreeGame[];
  try {
    games = await freeGames(platformsOf(cfg));
  } catch {
    return; // the stores are not reachable: next try in 30 minutes
  }
  if (cfg.schedule) ctx.setState('free-games', guild.id, 'day', local.date);
  const posted = ctx.getState<string[]>('free-games', guild.id, 'posted') ?? [];
  const fresh = newGames(games, posted);
  if (!fresh.length) return;
  const role = idIn(cfg.pingRole, guild.id);
  for (let i = 0; i < fresh.length; i += 10) {
    const part = fresh.slice(i, i + 10);
    const sent = await send(ctx, 'free-games', channel, {
      content: i === 0 ? `${role ? `<@&${role}> ` : ''}🎮 **${fresh.length === 1 ? 'A new free game' : `${fresh.length} new free games`}**` : undefined,
      embeds: part.map(gameEmbed),
      allowedMentions: { roles: role ? [role] : [] },
    });
    if (!sent) return;
    posted.push(...part.map(gameKey));
    ctx.setState('free-games', guild.id, 'posted', posted.slice(-300));
  }
}
