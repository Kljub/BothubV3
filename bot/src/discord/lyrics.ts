// Song lyrics from lrclib.net (free, no key). Titles of video sites carry
// extras like "(Official Video)"; those are removed before the search.

export interface Lyrics { title: string; artist: string; lyrics: string }

/** "Artist - Song (Official Music Video) [HD]" -> "Artist - Song". */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([](official|lyrics?|audio|video|music video|hd|4k|visuali[sz]er|explicit|remaster(ed)?)[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function lyricsOf(query: string): Promise<Lyrics | null> {
  const q = cleanTitle(query);
  const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'BotHub (https://github.com/Kljub)' } });
  if (!res.ok) return null;
  const list = (await res.json()) as { trackName?: string; artistName?: string; plainLyrics?: string | null }[];
  const hit = Array.isArray(list) ? list.find((l) => l.plainLyrics) : undefined;
  if (!hit?.plainLyrics) return null;
  const text = hit.plainLyrics.length > 3900 ? `${hit.plainLyrics.slice(0, 3900)}\n…` : hit.plainLyrics;
  return { title: hit.trackName ?? q, artist: hit.artistName ?? '', lyrics: text };
}
