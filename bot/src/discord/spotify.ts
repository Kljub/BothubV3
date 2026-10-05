// Spotify links in the music queue (/play <spotify link>): Spotify streams
// are DRM protected, so yt-dlp cannot play them. The bot reads title and
// artists with the Spotify Web API (integration "Spotify" under Admin → API /
// Secrets, client credentials) and plays the matching song from a YouTube
// search instead. Tracks, albums and playlists; without the keys a track link
// still works through Spotify's public oEmbed (title only).

import type { Track } from './music.js';
import { MusicError } from './music.js';

export interface SpotifyRef { type: 'track' | 'album' | 'playlist'; id: string }
export interface SpotifyKeys { id: string | null; secret: string | null }

/** open.spotify.com/(intl-xx/)track|album|playlist/<id> or spotify:track:<id>. */
export function parseSpotify(input: string): SpotifyRef | null {
  const t = input.trim();
  const url = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]{10,40})/i.exec(t);
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{10,40})$/i.exec(t);
  const m = url ?? uri;
  return m ? { type: m[1]!.toLowerCase() as SpotifyRef['type'], id: m[2]! } : null;
}

let token: { value: string; until: number; client: string } | null = null;

async function accessToken(keys: SpotifyKeys): Promise<string> {
  if (token && token.client === keys.id && Date.now() < token.until) return token.value;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${keys.id}:${keys.secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error) => {
    throw new MusicError(`Spotify is not reachable (${e.message}).`);
  });
  if (res.status === 400 || res.status === 401) throw new MusicError('Spotify refused the client ID or secret (Admin → API / Secrets → Spotify).');
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new MusicError('Spotify gave no access token.');
  token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000, client: String(keys.id) };
  return token.value;
}

async function api(path: string, keys: SpotifyKeys): Promise<any> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { authorization: `Bearer ${await accessToken(keys)}` }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
    throw new MusicError(`Spotify is not reachable (${e.message}).`);
  });
  if (res.status === 404) throw new MusicError('Spotify does not show this link (private, or a playlist made by Spotify itself, which its API no longer shares).');
  if (!res.ok) throw new MusicError(`Spotify answered with HTTP ${res.status}.`);
  return res.json();
}

interface SpotifySong { name: string; artists: string[]; durationMs: number }

/** A Spotify song as a queue track that is found on YouTube when it plays. */
export function songTrack(s: SpotifySong, requester: string | null): Track {
  const artists = s.artists.filter(Boolean).join(', ');
  const title = `${artists ? `${artists} - ` : ''}${s.name}`.slice(0, 200);
  return { title, url: `ytsearch1:${title} audio`, duration: Math.round(s.durationMs / 1000), author: artists.slice(0, 100), requester };
}

/** The songs of a Spotify link (track, album or playlist; at most `max`). */
export async function spotifyTracks(ref: SpotifyRef, keys: SpotifyKeys, requester: string | null, max = 100): Promise<Track[]> {
  const songOf = (t: any): SpotifySong | null =>
    t && typeof t.name === 'string' ? { name: t.name, artists: Array.isArray(t.artists) ? t.artists.map((a: { name?: string }) => String(a.name ?? '')) : [], durationMs: Number(t.duration_ms) || 0 } : null;
  if (!keys.id || !keys.secret) {
    if (ref.type !== 'track') throw new MusicError('Spotify albums and playlists need the Spotify integration (Admin → API / Secrets → Spotify).');
    // Public oEmbed: the song title only.
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${ref.id}`)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const title = res?.ok ? String(((await res.json().catch(() => ({}))) as { title?: string }).title ?? '') : '';
    if (!title) throw new MusicError('This Spotify song was not found.');
    return [songTrack({ name: title, artists: [], durationMs: 0 }, requester)];
  }
  const songs: SpotifySong[] = [];
  if (ref.type === 'track') {
    const s = songOf(await api(`/tracks/${ref.id}`, keys));
    if (s) songs.push(s);
  } else if (ref.type === 'album') {
    let next: string | null = `/albums/${ref.id}/tracks?limit=50`;
    while (next && songs.length < max) {
      const page: any = await api(next, keys);
      for (const t of page.items ?? []) {
        const s = songOf(t);
        if (s) songs.push(s);
      }
      next = page.next ? String(page.next).replace('https://api.spotify.com/v1', '') : null;
    }
  } else {
    let next: string | null = `/playlists/${ref.id}/tracks?limit=100&fields=items(track(name,artists(name),duration_ms)),next`;
    while (next && songs.length < max) {
      const page: any = await api(next, keys);
      for (const it of page.items ?? []) {
        const s = songOf(it?.track);
        if (s) songs.push(s);
      }
      next = page.next ? String(page.next).replace('https://api.spotify.com/v1', '') : null;
    }
  }
  if (!songs.length) throw new MusicError('This Spotify link has no songs.');
  return songs.slice(0, max).map((s) => songTrack(s, requester));
}
