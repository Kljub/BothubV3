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
import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import type { Db } from '../core/db.js';
import { log } from '../core/log.js';
import { privateAddress } from '../sdk/discord-api.js';

type Design = Record<string, unknown>;
interface Renderer {
  drawCard(ctx: unknown, design: Design, opts: { vars: Record<string, string>; loadImage: (url: string) => Promise<Image | null> }): Promise<void>;
  normalize(design: Design): { width: number; height: number };
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
  if (!body) return null;
  return loadImage(body).catch(() => null);
}

/** Draws a design to PNG. */
export async function renderDesign(design: Design, vars: Record<string, string>): Promise<Buffer> {
  const r = await cardRenderer();
  const { width, height } = r.normalize(design);
  const canvas = createCanvas(width, height);
  await r.drawCard(canvas.getContext('2d'), design, { vars, loadImage: fetchImage });
  return canvas.toBuffer('image/png');
}

/** Draws a card of the bot by ID; null when the card does not exist or drawing failed. */
export async function renderCard(db: Db, botId: number, cardId: number, vars: Record<string, string>): Promise<Buffer | null> {
  const row = db.prepare('SELECT design FROM bot_cards WHERE id = ? AND bot_id = ?').get(cardId, botId) as { design: string } | undefined;
  if (!row) return null;
  try {
    return await renderDesign(JSON.parse(row.design) as Design, vars);
  } catch (err) {
    log.warn('card render failed', { botId, cardId, err: String(err) });
    return null;
  }
}
