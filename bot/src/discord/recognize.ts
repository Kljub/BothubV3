// "What song is this?" for the music module (/radio-song):
// 1. Radio streams usually send the current title in their ICY metadata
//    (Icecast/Shoutcast "StreamTitle"): free, no key.
// 2. Otherwise (or when asked) ACRCloud recognizes a 10-second sample of the
//    stream, the service behind AHA Music. Its keys are the admin's
//    integration "ACRCloud" (ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET);
//    the host is the project's region, e.g. identify-eu-west-1.acrcloud.com.

import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';

export interface Song { title: string; artist: string; album: string; link: string; source: 'radio' | 'acrcloud' }

export class RecognizeError extends Error {}

/** "Artist - Title" of an ICY StreamTitle. */
export function splitStreamTitle(raw: string): { artist: string; title: string } | null {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || /^(-|unknown|advert|werbung)/i.test(t)) return null;
  const i = t.indexOf(' - ');
  return i > 0 ? { artist: t.slice(0, i).trim(), title: t.slice(i + 3).trim() } : { artist: '', title: t };
}

/** The StreamTitle of an ICY metadata block. */
export function parseIcyMeta(block: string): string {
  return /StreamTitle='(.*?)';/s.exec(block)?.[1] ?? '';
}

/** Reads the current title from a radio stream's ICY metadata; null without metadata. */
export async function icyTitle(url: string, timeoutMs = 8000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'Icy-MetaData': '1', 'user-agent': 'BotHub/1.0' }, signal: ctrl.signal });
    const metaint = Number(res.headers.get('icy-metaint'));
    if (!res.ok || !res.body || !(metaint > 0) || metaint > 1_000_000) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) return null;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
      if (buf.length > metaint) {
        const len = buf[metaint]! * 16;
        if (len === 0) {
          void reader.cancel().catch(() => undefined);
          return '';
        }
        if (buf.length >= metaint + 1 + len) {
          void reader.cancel().catch(() => undefined);
          return parseIcyMeta(new TextDecoder('utf-8').decode(buf.subarray(metaint + 1, metaint + 1 + len)));
        }
      }
      if (buf.length > metaint + 5000) return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 10 seconds of the stream as mono MP3 (ffmpeg), for recognition. */
export function recordSample(url: string, seconds = 10): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-t', String(seconds), '-i', url, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => p.kill('SIGKILL'), (seconds + 20) * 1000);
    p.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size < 2_000_000) chunks.push(c);
    });
    p.on('error', (e) => reject(new RecognizeError(`ffmpeg is not available (${e.message}).`)));
    p.on('close', () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      if (data.length < 4000) reject(new RecognizeError('The stream could not be recorded.'));
      else resolve(data);
    });
  });
}

/** ACRCloud's signature (HMAC-SHA1, version 1). */
export function acrSignature(secret: string, accessKey: string, timestamp: string): string {
  return createHmac('sha1', secret).update(['POST', '/v1/identify', accessKey, 'audio', '1', timestamp].join('\n')).digest('base64');
}

/** The first music match of an ACRCloud answer; null when nothing was found. */
export function acrSong(json: unknown): Song | null {
  const j = json as { status?: { code?: number; msg?: string }; metadata?: { music?: Record<string, any>[] } };
  if (j?.status?.code === 1001) return null; // no result
  if (j?.status?.code !== 0) throw new RecognizeError(`ACRCloud: ${j?.status?.msg ?? 'unknown error'}.`);
  const m = j.metadata?.music?.[0];
  if (!m) return null;
  const ext = m.external_metadata ?? {};
  const spotify = ext.spotify?.track?.id ? `https://open.spotify.com/track/${ext.spotify.track.id}` : '';
  const youtube = ext.youtube?.vid ? `https://www.youtube.com/watch?v=${ext.youtube.vid}` : '';
  return {
    title: String(m.title ?? '?'),
    artist: Array.isArray(m.artists) ? m.artists.map((a: { name?: string }) => a.name).filter(Boolean).join(', ') : '',
    album: String(m.album?.name ?? ''),
    link: spotify || youtube,
    source: 'acrcloud',
  };
}

/** Recognizes a sample with ACRCloud. */
export async function acrIdentify(sample: Buffer, keys: { host: string; key: string; secret: string }, now = Date.now()): Promise<Song | null> {
  const host = keys.host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.acrcloud\.com$/i.test(host)) throw new RecognizeError('The ACRCloud host must look like identify-eu-west-1.acrcloud.com.');
  const timestamp = String(Math.floor(now / 1000));
  const form = new FormData();
  form.set('access_key', keys.key);
  form.set('sample_bytes', String(sample.length));
  form.set('timestamp', timestamp);
  form.set('signature', acrSignature(keys.secret, keys.key, timestamp));
  form.set('data_type', 'audio');
  form.set('signature_version', '1');
  form.set('sample', new Blob([new Uint8Array(sample)], { type: 'audio/mpeg' }), 'sample.mp3');
  const res = await fetch(`https://${host}/v1/identify`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
    throw new RecognizeError(`ACRCloud is not reachable (${e.message}).`);
  });
  return acrSong(await res.json().catch(() => null));
}
