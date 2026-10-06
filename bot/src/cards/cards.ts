// Card Designer on the bot side: draws a card of the bot (table bot_cards)
// with the shared renderer (shared/cards/render.mjs, the same code as the
// Card Studio preview) and the fonts of shared/cards/fonts. Pictures come
// from public https addresses only, fetched with the checked IP (no
// redirects, no private networks, max. 5 MB, 6 s).

import { lookup } from 'node:dns/promises';
import { readdirSync } from 'node:fs';
import https from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts, ImageData, loadImage, type Canvas, type Image } from '@napi-rs/canvas';
import omggif from 'omggif';
import gifenc from 'gifenc';

const { GifReader } = omggif;
const { GIFEncoder, applyPalette, quantize } = gifenc;
import type { Db } from '../core/db.js';
import { log } from '../core/log.js';
import { privateAddress } from '../sdk/discord-api.js';

type Design = Record<string, unknown>;
interface Renderer {
  drawCard(ctx: unknown, design: Design, opts: { vars: Record<string, string>; loadImage: (url: string) => Promise<unknown>; time?: number }): Promise<void>;
  normalize(design: Design): { width: number; height: number; animated: boolean };
  loopLength(img: unknown): number;
  SAMPLE_VARS: Record<string, string>;
  FONTS: { family: string; file: string; weights: Record<string, string> }[];
}

const MAX_IMAGE = 5 * 1024 * 1024;
const sharedDir = () => process.env.SHARED_DIR || '/shared';
let renderer: Promise<Renderer> | null = null;

/** Loads the shared renderer once and registers its fonts. */
export function cardRenderer(dir = sharedDir()): Promise<Renderer> {
  renderer ??= (async () => {
    const r = (await import(pathToFileURL(join(dir, 'cards', 'render.mjs')).href)) as Renderer;
    const fontDir = join(dir, 'cards', 'fonts');
    const files = new Set(readdirSync(fontDir));
    for (const f of r.FONTS) {
      for (const style of Object.values(f.weights)) {
        const file = `${f.file}-${style}.ttf`;
        if (files.has(file)) GlobalFonts.registerFromPath(join(fontDir, file), f.family);
      }
    }
    return r;
  })();
  return renderer;
}

/** A picture from a public https address (or null). */
export async function fetchImage(raw: string): Promise<Image | null> {
  const body = await fetchBytes(raw);
  return body ? loadImage(body).catch(() => null) : null;
}

/** The bytes of a picture from a public https address (or null). */
export async function fetchBytes(raw: string): Promise<Buffer | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return null;
  const pinned = addrs[0]!;
  const body = await new Promise<Buffer | null>((resolve) => {
    const req = https.get(url, {
      timeout: 6000,
      headers: { 'User-Agent': 'BotHub cards' },
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family))) as never,
    }, (res) => {
      if ((res.statusCode ?? 0) !== 200 || !/^image\//.test(String(res.headers['content-type'] ?? ''))) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_IMAGE) {
          req.destroy();
          resolve(null);
        } else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
  return body;
}

const isGif = (b: Buffer) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8';

/** The frames of an animated GIF (composited like a viewer shows them), max. 100. */
export function gifFrames(buf: Buffer): { frames: { image: Canvas; delay: number }[] } | null {
  let reader: InstanceType<typeof GifReader>;
  try {
    reader = new GifReader(new Uint8Array(buf));
  } catch {
    return null;
  }
  const w = reader.width;
  const h = reader.height;
  if (reader.numFrames() < 2 || w * h > 4_000_000) return null;
  const pixels = new Uint8ClampedArray(w * h * 4);
  const frames: { image: Canvas; delay: number }[] = [];
  for (let i = 0; i < Math.min(reader.numFrames(), 100); i++) {
    const info = reader.frameInfo(i);
    const before = info.disposal === 3 ? pixels.slice() : null;
    reader.decodeAndBlitFrameRGBA(i, pixels as unknown as Uint8Array);
    const c = createCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(pixels.slice(), w, h), 0, 0);
    frames.push({ image: c, delay: Math.max(20, (info.delay || 10) * 10) });
    if (info.disposal === 2) {
      for (let y = info.y; y < Math.min(h, info.y + info.height); y++) pixels.fill(0, (y * w + info.x) * 4, (y * w + Math.min(w, info.x + info.width)) * 4);
    } else if (before) pixels.set(before);
  }
  return { frames };
}

/** Longest animation drawn into a card (ms), frames per GIF, Discord's upload limit. */
const MAX_LOOP_MS = 8000;
const MAX_FRAMES = 60;
const MAX_GIF_BYTES = 9.5 * 1024 * 1024;

/**
 * Draws a design: a PNG, or with "animated" on and an animated GIF in it, a
 * GIF (the result starts with "GIF8"). "asset:<id>" pictures come from loadAsset.
 */
export async function renderDesign(design: Design, vars: Record<string, string>, loadAsset: (id: number) => Buffer | null = () => null, problems: string[] = []): Promise<Buffer> {
  const r = await cardRenderer();
  const { width, height, animated } = r.normalize(design);
  const cache = new Map<string, Promise<unknown>>();
  // Pictures that could not be drawn, with the reason (shown with a test).
  const decode = async (url: string, data: Buffer | null) => {
    if (!data) {
      problems.push(`${url}: ${url.startsWith('asset:') ? 'not among the pictures of this bot' : 'not loaded (public https picture only)'}`);
      return null;
    }
    if (animated && isGif(data)) {
      const anim = gifFrames(data);
      if (anim) return anim;
    }
    return loadImage(data).catch((err) => {
      problems.push(`${url}: cannot be read (${String((err as Error).message ?? err).slice(0, 80)}; ${data.length} bytes, starts ${data.subarray(0, 4).toString('hex')})`);
      return null;
    });
  };
  const load = (url: string): Promise<unknown> => {
    if (!cache.has(url)) {
      const asset = /^asset:(\d+)$/.exec(url);
      cache.set(url, asset ? decode(url, loadAsset(Number(asset[1]))) : fetchBytes(url).then((b) => decode(url, b)));
    }
    return cache.get(url)!;
  };
  const canvas = createCanvas(width, height);
  await r.drawCard(canvas.getContext('2d'), design, { vars, loadImage: load, time: 0 });
  if (!animated) return canvas.toBuffer('image/png');
  const loops = (await Promise.all(cache.values())).map((img) => r.loopLength(img)).filter((n) => n > 0);
  if (!loops.length) return canvas.toBuffer('image/png');
  const duration = Math.min(MAX_LOOP_MS, Math.max(...loops));
  // Big cards are made smaller first, then again while the GIF is too big.
  let scale = width * height > 300_000 ? Math.sqrt(300_000 / (width * height)) : 1;
  let frames = Math.min(MAX_FRAMES, Math.max(2, Math.round(duration / 80)));
  for (let attempt = 0; attempt < 3; attempt++) {
    const gif = await encodeGif(r, design, vars, load, { width, height, scale, frames, duration });
    if (gif.length <= MAX_GIF_BYTES) return gif;
    scale *= 0.75;
    frames = Math.max(2, Math.round(frames * 0.75));
  }
  return canvas.toBuffer('image/png');
}

async function encodeGif(
  r: Renderer, design: Design, vars: Record<string, string>, load: (url: string) => Promise<unknown>,
  o: { width: number; height: number; scale: number; frames: number; duration: number },
): Promise<Buffer> {
  const w = Math.max(1, Math.round(o.width * o.scale));
  const h = Math.max(1, Math.round(o.height * o.scale));
  const step = o.duration / o.frames;
  const gif = GIFEncoder();
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < o.frames; i++) {
    ctx.setTransform(o.scale, 0, 0, o.scale, 0, 0);
    await r.drawCard(ctx, design, { vars, loadImage: load, time: i * step });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(data, palette, 'rgba4444');
    const transparentIndex = palette.findIndex((c) => c[3] === 0);
    gif.writeFrame(index, w, h, { palette, delay: Math.round(step), transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex), dispose: 2 });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** File name of a drawn card: card.gif or card.png. */
export function cardFile(buf: Buffer, base = 'card'): string {
  return `${base}.${isGif(buf) ? 'gif' : 'png'}`;
}

/** Card placeholders of a member on a server (also used by the modules). */
export function cardVars(m: { guildName: string; guildId: string; members: number; userId: string; userName: string; display: string; avatar: string; createdAt: number; joinedAt: number | null }, now = Date.now()): Record<string, string> {
  const ordinal = (n: number) => {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
    return `${n.toLocaleString('en-US')}${n % 10 <= 3 ? s : 'th'}`;
  };
  const days = (t: number) => String(Math.max(0, Math.floor((now - t) / 86_400_000)));
  return {
    user: m.display, 'user.display': m.display, 'user.name': m.userName, 'user.id': m.userId, 'user.mention': `@${m.display}`, 'user.avatar': m.avatar,
    server: m.guildName, 'server.id': m.guildId, members: String(m.members), 'member.number': String(m.members), 'member.ordinal': ordinal(m.members),
    'account.days': days(m.createdAt), 'member.days': m.joinedAt ? days(m.joinedAt) : '0',
  };
}

/** Draws a card of the bot by ID; null when the card does not exist or drawing failed. */
export async function renderCard(db: Db, botId: number, cardId: number, vars: Record<string, string>, problems: string[] = []): Promise<Buffer | null> {
  const row = db.prepare('SELECT design FROM bot_cards WHERE id = ? AND bot_id = ?').get(cardId, botId) as { design: string } | undefined;
  if (!row) return null;
  const asset = (id: number): Buffer | null => {
    const img = db.prepare('SELECT data FROM bot_card_images WHERE id = ? AND bot_id = ?').get(id, botId) as { data: Uint8Array } | undefined;
    return img ? Buffer.from(img.data) : null;
  };
  try {
    const out = await renderDesign(JSON.parse(row.design) as Design, vars, asset, problems);
    if (problems.length) log.warn('card pictures not drawn', { botId, cardId, problems });
    return out;
  } catch (err) {
    log.warn('card render failed', { botId, cardId, err: String(err) });
    return null;
  }
}
