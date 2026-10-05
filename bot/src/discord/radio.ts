// Radio (music module, /radio): internet radio stations from all over the
// world from Radio Browser (radio-browser.info, a free and open station
// database for apps; no key). A station plays as a live track of the music
// queue: its stream URL goes straight to ffmpeg (no yt-dlp).

import type { Track } from './music.js';
import { MusicError } from './music.js';

// The API runs on several servers; the first one that answers wins.
const SERVERS = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
const HEADERS = { 'user-agent': 'BotHub/1.0 (+https://github.com/Kljub/BothubV3)', accept: 'application/json' };

export interface Station { uuid: string; name: string; url: string; country: string; countryCode: string; tags: string; codec: string; bitrate: number; homepage: string; favicon: string }

async function api(path: string, query: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  let last: unknown;
  for (const base of SERVERS) {
    try {
      const res = await fetch(`${base}${path}?${qs}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw new MusicError(`The radio directory is not reachable right now (${(last as Error)?.message ?? 'no answer'}).`);
}

/** Stations from the API answer (working ones with a stream). */
export function stationsOf(raw: unknown): Station[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s === 'object' && s.lastcheckok !== 0 && /^https?:\/\//.test(String(s.url_resolved || s.url || '')))
    .map((s) => ({
      uuid: String(s.stationuuid ?? ''),
      name: String(s.name ?? '').trim().slice(0, 100) || 'Radio',
      url: String(s.url_resolved || s.url),
      country: String(s.country ?? ''),
      countryCode: String(s.countrycode ?? '').toUpperCase(),
      tags: String(s.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4).join(', '),
      codec: String(s.codec ?? ''),
      bitrate: Number(s.bitrate) || 0,
      homepage: String(s.homepage ?? ''),
      favicon: String(s.favicon ?? ''),
    }));
}

/** Search by station name, genre (tag) and/or country (two letters), most popular first. */
export async function findStations(opts: { name?: string; tag?: string; country?: string; random?: boolean }, limit = 10): Promise<Station[]> {
  // Random: a random pick among stations that work and are listened to.
  const query: Record<string, string> = opts.random
    ? { hidebroken: 'true', order: 'random', limit: String(Math.max(1, Math.min(25, limit))), bitrateMin: '64' }
    : { hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: String(Math.max(1, Math.min(25, limit))) };
  if (opts.name?.trim()) query.name = opts.name.trim().slice(0, 100);
  if (opts.tag?.trim()) query.tag = opts.tag.trim().toLowerCase().slice(0, 50);
  const cc = opts.country?.trim().toUpperCase();
  if (cc) {
    if (!/^[A-Z]{2}$/.test(cc)) throw new MusicError('The country is a two-letter code, e.g. DE, US or JP.');
    query.countrycode = cc;
  }
  if (!opts.random && !query.name && !query.tag && !query.countrycode) throw new MusicError('Name a station, a genre or a country.');
  return stationsOf(await api('/json/stations/search', query));
}

/** Tells Radio Browser a station was played (their click counter; best effort). */
export function countClick(uuid: string): void {
  if (!uuid) return;
  void api(`/json/url/${encodeURIComponent(uuid)}`, {}).catch(() => undefined);
}

const FLAG = (cc: string): string => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '📻');

/** A station as a live track of the queue. */
export function stationTrack(s: Station, requester: string | null): Track {
  return { title: `${FLAG(s.countryCode)} ${s.name}`, url: s.url, duration: 0, author: [s.country, s.tags].filter(Boolean).join(' · '), requester, live: true };
}

/** "🇩🇪 1Live · Germany · pop, rock (128 kbps MP3)" lines. */
export function stationLines(list: Station[]): string {
  return list.map((s, i) => `${i + 1}. ${FLAG(s.countryCode)} **${s.name.length > 60 ? `${s.name.slice(0, 59)}…` : s.name}**${s.country ? ` · ${s.country}` : ''}${s.tags ? ` · ${s.tags}` : ''}${s.bitrate ? ` (${s.bitrate} kbps${s.codec ? ` ${s.codec}` : ''})` : ''}`).join('\n');
}
