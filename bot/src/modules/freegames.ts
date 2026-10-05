// Free Games (module "free-games", block Free Games): Epic Games' free
// promotions and free Steam games (GamerPower API). The module posts to its
// channel: new free games as soon as they are found, or the current list at a
// set time on chosen weekdays (bot time zone). With "edit the last message"
// it keeps one message up to date instead of posting new ones. Answers are
// cached for 30 minutes.

import { EmbedBuilder, type Guild } from 'discord.js';
import type { localTime } from '../core/timed.js';
import { idIn, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

export interface FreeGame { title: string; store: 'Epic Games' | 'Steam'; url: string; until: string | null; image: string | null; description: string }

export interface FreeGamesConfig {
  channel: unknown; pingRole: unknown; epic: boolean; steam: boolean; schedule: boolean; time: string; editLast: boolean;
  mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean;
  salesCountry: string; // store country of /gamesales (prices and currency), e.g. "de"
  salesImage: string; // picture of the /gamesales answer (https link)
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

// ---------- Steam sales (/gamesales) ----------

export interface GameSale { id: number; title: string; url: string; percent: number; original: number; final: number; currency: string; until: number | null }

const SALES = (cc: string) => `https://store.steampowered.com/api/featuredcategories?cc=${encodeURIComponent(cc)}&l=english`;

/** Discounted games of Steam's store front (specials, new releases, top sellers), biggest discount first. */
export function steamSales(raw: unknown): GameSale[] {
  const byId = new Map<number, GameSale>();
  for (const cat of Object.values((raw ?? {}) as Record<string, { items?: unknown[] }>)) {
    if (!cat || typeof cat !== 'object' || !Array.isArray(cat.items)) continue;
    for (const i of cat.items as Record<string, any>[]) {
      const percent = Number(i?.discount_percent ?? 0);
      if (!i?.discounted || !(percent > 0) || !Number.isInteger(i.id) || byId.has(i.id)) continue;
      byId.set(i.id, {
        id: i.id,
        title: String(i.name ?? '?'),
        url: `https://store.steampowered.com/app/${i.id}/`,
        percent,
        original: Number(i.original_price ?? 0),
        final: Number(i.final_price ?? 0),
        currency: String(i.currency ?? 'USD'),
        until: Number.isInteger(i.discount_expiration) ? i.discount_expiration : null,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.percent - a.percent || a.title.localeCompare(b.title));
}

const salesCache = new Map<string, { at: number; sales: GameSale[] }>();

export async function gameSales(country: string): Promise<GameSale[]> {
  const cc = /^[a-z]{2}$/.test(country) ? country : 'de';
  const hit = salesCache.get(cc);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sales;
  const sales = steamSales(await getJson(SALES(cc)));
  salesCache.set(cc, { at: Date.now(), sales });
  return sales;
}

/** Price in cents as money, e.g. 1799 EUR -> "17,99 €" (German format for EUR). */
export function price(cents: number, currency: string): string {
  const v = cents / 100;
  try {
    return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', { style: 'currency', currency }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

/** One line per sale: "-70 % **[Title](url)** ~~59,99 €~~ **17,99 €** · until <t:…:R>". */
export function gameSalesText(sales: GameSale[]): string {
  return sales
    .map((s) => {
      const until = s.until ? ` · until <t:${s.until}:R>` : '';
      return `\`-${s.percent} %\` **[${s.title}](${s.url})** ~~${price(s.original, s.currency)}~~ **${price(s.final, s.currency)}**${until}`;
    })
    .join('\n');
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

/** The whole current list as one message: an embed per game (max. 10), the rest as lines. */
export function listPayload(games: FreeGame[], role: string | null): { content: string; embeds: EmbedBuilder[]; allowedMentions: { roles: string[] } } {
  const head = `${role ? `<@&${role}> ` : ''}🎮 **${games.length === 1 ? 'Free game right now' : `${games.length} free games right now`}**`;
  const rest = games.length > 10 ? `\n${freeGamesText(games.slice(10))}` : '';
  return { content: `${head}${rest}`.slice(0, 2000), embeds: games.slice(0, 10).map(gameEmbed), allowedMentions: { roles: role ? [role] : [] } };
}

/** Signature of a list: changes when a game comes or goes. */
export const listSignature = (games: FreeGame[]): string => games.map(gameKey).sort().join('|');

/** After a failed store request: no new try for 5 minutes (per server). */
const failedAt = new Map<string, number>();
const RETRY_MS = 5 * 60_000;

/** Posts the free games of the module to one server (timer, every 30 seconds; checks every 30 minutes and at the set time). */
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
  const failKey = `${ctx.botId}:${guild.id}`;
  if (Date.now() - (failedAt.get(failKey) ?? 0) < RETRY_MS) return;
  let games: FreeGame[];
  try {
    games = await freeGames(platformsOf(cfg));
  } catch {
    failedAt.set(failKey, Date.now()); // the stores are not reachable: try again in 5 minutes
    return;
  }
  failedAt.delete(failKey);
  if (cfg.schedule) ctx.setState('free-games', guild.id, 'day', local.date);
  const posted = ctx.getState<string[]>('free-games', guild.id, 'posted') ?? [];
  const role = idIn(cfg.pingRole, guild.id);

  // At the set time, or when one message is kept up to date: the whole current list.
  if (cfg.schedule || cfg.editLast) {
    if (!games.length) return;
    const sig = listSignature(games);
    if (!cfg.schedule && ctx.getState<string>('free-games', guild.id, 'sig') === sig) return; // nothing changed
    const payload = listPayload(games, role);
    const remember = (id: string): void => {
      ctx.setState('free-games', guild.id, 'sig', sig);
      ctx.setState('free-games', guild.id, 'last', { channel: channelId, id });
      ctx.setState('free-games', guild.id, 'posted', [...new Set([...posted, ...games.map(gameKey)])].slice(-300));
    };
    if (cfg.editLast) {
      const last = ctx.getState<{ channel: string; id: string }>('free-games', guild.id, 'last');
      if (last?.channel === channelId) {
        const msg = await channel.messages.fetch(last.id).catch(() => null);
        if (msg?.editable && (await msg.edit(payload).then(() => true, () => false))) {
          remember(msg.id);
          return;
        }
      }
    }
    const sent = await send(ctx, 'free-games', channel, payload);
    if (sent) remember(sent.id);
    return;
  }

  const fresh = newGames(games, posted);
  if (!fresh.length) return;
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
