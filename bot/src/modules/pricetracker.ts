// Game Price Tracker (module "free-games"): prices of games across PC stores
// (Steam, GOG, Humble, Fanatical, Green Man Gaming, Epic, …) from the free
// CheapShark API (prices in US dollars). The module watches the games of
// its settings and posts when a game drops to the target price or to its
// lowest price ever; /gameprice (block "Game price") shows the best deals.
// Checked every two hours; answers are cached for 30 minutes.

import type { Guild } from 'discord.js';
import { idIn, idsIn, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

const API = 'https://www.cheapshark.com/api/1.0';
const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function getJson(url: string): Promise<unknown> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'User-Agent': 'BotHub/1.0 (Discord bot; +https://github.com/Kljub/BothubV3)' } });
  if (!res.ok) throw new Error(`CheapShark HTTP ${res.status}`);
  const value = await res.json();
  cache.set(url, { at: Date.now(), value });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return value;
}

export interface Deal { store: string; price: number; retail: number; savings: number; url: string }
export interface GamePrice { id: string; title: string; thumb: string; deals: Deal[]; lowest: { price: number; date: number } | null }

let stores: { at: number; names: Map<string, string> } | null = null;

/** Store names by ID (cached a day). */
export async function storeNames(): Promise<Map<string, string>> {
  if (stores && Date.now() - stores.at < 86_400_000) return stores.names;
  const list = (await getJson(`${API}/stores`)) as { storeID: string; storeName: string; isActive: number }[];
  stores = { at: Date.now(), names: new Map(list.filter((s) => s.isActive).map((s) => [String(s.storeID), String(s.storeName)])) };
  return stores.names;
}

/** CheapShark's game ID of a name (best match) or null. */
export async function findGame(name: string): Promise<{ id: string; title: string } | null> {
  const q = name.trim().slice(0, 100);
  if (q.length < 2) return null;
  const list = (await getJson(`${API}/games?title=${encodeURIComponent(q)}&limit=10`)) as { gameID: string; external: string }[];
  if (!Array.isArray(list) || !list.length) return null;
  // An exact title wins over the first hit.
  const exact = list.find((g) => g.external.toLowerCase() === q.toLowerCase());
  const g = exact ?? list[0]!;
  return { id: String(g.gameID), title: String(g.external) };
}

/** The deals of games (max. 25 per call), cheapest first. */
export function parseGames(raw: unknown, names: Map<string, string>): GamePrice[] {
  const out: GamePrice[] = [];
  for (const [id, v] of Object.entries((raw ?? {}) as Record<string, any>)) {
    if (!v?.info) continue;
    const deals: Deal[] = (Array.isArray(v.deals) ? v.deals : [])
      .map((d: any) => ({
        store: names.get(String(d.storeID)) ?? `Store ${d.storeID}`,
        price: Number(d.price),
        retail: Number(d.retailPrice),
        savings: Math.round(Number(d.savings) || 0),
        // dealID comes URL-encoded already
        url: `https://www.cheapshark.com/redirect?dealID=${String(d.dealID)}`,
      }))
      .filter((d: Deal) => Number.isFinite(d.price))
      .sort((a: Deal, b: Deal) => a.price - b.price);
    const low = v.cheapestPriceEver;
    out.push({
      id: String(id),
      title: String(v.info.title ?? '?'),
      thumb: String(v.info.thumb ?? ''),
      deals,
      lowest: low && Number.isFinite(Number(low.price)) ? { price: Number(low.price), date: Number(low.date) || 0 } : null,
    });
  }
  return out;
}

export async function gamePrices(ids: string[]): Promise<GamePrice[]> {
  const names = await storeNames().catch(() => new Map<string, string>());
  const out: GamePrice[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    out.push(...parseGames(await getJson(`${API}/games?ids=${ids.slice(i, i + 25).map(encodeURIComponent).join(',')}`), names));
  }
  return out;
}

export const usd = (v: number) => `$${v.toFixed(2)}`;

/** Lines of the best deals: "**$4.99** at Steam (-75 %, was $19.99)". */
export function dealsText(g: GamePrice, limit = 5): string {
  const lines = g.deals.slice(0, limit).map((d) => `**[${usd(d.price)}](${d.url})** at ${d.store}${d.savings > 0 ? ` (-${d.savings} %, was ${usd(d.retail)})` : ''}`);
  if (g.lowest) lines.push(`📉 Lowest ever: **${usd(g.lowest.price)}**${g.lowest.date ? ` (<t:${g.lowest.date}:D>)` : ''}`);
  return lines.join('\n') || 'No store sells it right now.';
}

/** A target price "9.99" / "9,99" in dollars; null when none. */
export function parseTarget(v: unknown): number | null {
  const m = /^\s*(\d{1,4})(?:[.,](\d{1,2}))?\s*$/.exec(String(v ?? ''));
  return m ? Number(`${m[1]}.${(m[2] ?? '0').padEnd(2, '0')}`) : null;
}

/** Should the watched game be posted? Only when it just crossed the line (not every check). */
export function priceAlert(best: number, lowest: number | null, target: number | null, prev: { best: number } | undefined, historicLow: boolean): 'target' | 'low' | null {
  if (!prev) return null; // first check: only remember
  if (target !== null && best <= target && prev.best > target) return 'target';
  if (historicLow && lowest !== null && best <= lowest && prev.best > lowest) return 'low';
  return null;
}

interface WatchEntry { _id?: string; game: string; target: string; historicLow: boolean }
interface TrackerConfig { channel: unknown; pingRole: unknown; priceChannel: unknown; priceWatch: WatchEntry[] }

/** Every two hours: the watched games of every server of the module's channel. */
export async function watchPrices(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled('free-games')) return;
  const cfg = ctx.config<TrackerConfig>('free-games');
  const list = (cfg.priceWatch ?? []).filter((w) => w?.game?.trim());
  if (!list.length) return;
  const ref = cfg.priceChannel ?? cfg.channel;
  const guild = guilds.find((g) => idIn(ref, g.id));
  const channel = guild?.channels.cache.get(idIn(ref, guild.id) ?? '');
  if (!guild || !channel?.isSendable()) {
    warn(ctx, 'WAR-2008', { module: 'free-games', problem: 'the price tracker has no channel the bot can write in' });
    return;
  }
  const role = idsIn([cfg.pingRole].filter(Boolean), guild.id)[0] ?? null;
  // Find each game once (remembered per entry and name).
  const found: { entry: WatchEntry; id: string }[] = [];
  for (const entry of list) {
    const key = `price:game:${entry._id ?? entry.game}`;
    let hit = ctx.getState<{ name: string; id: string }>('free-games', guild.id, key);
    if (!hit || hit.name !== entry.game) {
      const g = await findGame(entry.game).catch(() => null);
      if (!g) continue;
      hit = { name: entry.game, id: g.id };
      ctx.setState('free-games', guild.id, key, hit);
    }
    found.push({ entry, id: hit.id });
  }
  const prices = new Map((await gamePrices([...new Set(found.map((f) => f.id))])).map((g) => [g.id, g]));
  for (const { entry, id } of found) {
    const g = prices.get(id);
    const best = g?.deals[0];
    if (!g || !best) continue;
    const key = `price:last:${id}`;
    const prev = ctx.getState<{ best: number }>('free-games', guild.id, key);
    const alert = priceAlert(best.price, g.lowest?.price ?? null, parseTarget(entry.target), prev, entry.historicLow !== false);
    ctx.setState('free-games', guild.id, key, { best: best.price });
    if (!alert) continue;
    const title = alert === 'target' ? `💲 ${g.title} is at your price: ${usd(best.price)}` : `📉 ${g.title}: lowest price ever, ${usd(best.price)}`;
    await send(ctx, 'free-games', channel, {
      content: role ? `<@&${role}>` : undefined,
      embeds: [{ color: 0x22c55e, title: title.slice(0, 256), url: best.url, thumbnail: g.thumb ? { url: g.thumb } : undefined, description: dealsText(g, 3), footer: { text: 'Prices in USD · CheapShark' } }],
      allowedMentions: { roles: role ? [role] : [] },
    });
  }
}
