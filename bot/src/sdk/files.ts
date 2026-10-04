// Plugin files ("storage.files"): images a plugin keeps per bot (plugin_files,
// migration 0025). Uploads come from the dashboard (image settings field) or
// from the plugin (base64 or a Discord attachment link). Only PNG, GIF, WEBP
// and JPEG, recognized by their first bytes; the name is the content's hash,
// so the same picture is stored once.

import { createHash } from 'node:crypto';
import type { Db } from '../core/db.js';
import { SdkError } from './errors.js';

export interface FileLimits {
  maxBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export const FILE_LIMITS: FileLimits = { maxBytes: 2 * 1024 * 1024, maxFiles: 100, maxTotalBytes: 25 * 1024 * 1024 };

const TYPES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/** The image type of a buffer, null when it is none of the allowed ones. */
export function sniff(data: Buffer): { mime: string; ext: string } | null {
  const t = TYPES.find((x) => x.test(data));
  return t ? { mime: t.mime, ext: t.ext } : null;
}

/** File names are <16 hex>.<ext>. */
export const FILE_NAME = /^[0-9a-f]{16}\.(png|gif|webp|jpg)$/;

export interface StoredFile {
  name: string;
  mime: string;
  size: number;
}

export class PluginFiles {
  constructor(
    private readonly db: Db,
    private readonly botId: number,
    private readonly pluginId: string,
    private readonly limits: FileLimits = FILE_LIMITS,
  ) {}

  list(): StoredFile[] {
    return (this.db.prepare('SELECT name, mime, size FROM plugin_files WHERE bot_id = ? AND plugin_id = ? ORDER BY created_at').all(this.botId, this.pluginId) as unknown as StoredFile[]).map((r) => ({
      name: String(r.name), mime: String(r.mime), size: Number(r.size),
    }));
  }

  get(name: unknown): (StoredFile & { data: Buffer }) | null {
    if (typeof name !== 'string' || !FILE_NAME.test(name)) return null;
    const row = this.db.prepare('SELECT name, mime, size, data FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?').get(this.botId, this.pluginId, name) as
      | { name: string; mime: string; size: number; data: Uint8Array }
      | undefined;
    return row ? { name: row.name, mime: row.mime, size: Number(row.size), data: Buffer.from(row.data) } : null;
  }

  /** Stores an image; returns its name (the same picture again gives the same name). */
  put(data: Buffer): StoredFile {
    if (!data.length || data.length > this.limits.maxBytes) throw new SdkError('sdk.files.too_big', { max: this.limits.maxBytes });
    const type = sniff(data);
    if (!type) throw new SdkError('sdk.files.bad_type');
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${type.ext}`;
    const exists = this.db.prepare('SELECT 1 FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?').get(this.botId, this.pluginId, name);
    if (!exists) {
      const usage = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM plugin_files WHERE bot_id = ? AND plugin_id = ?').get(this.botId, this.pluginId) as { n: number; total: number };
      if (Number(usage.n) >= this.limits.maxFiles) throw new SdkError('sdk.files.full', { max: this.limits.maxFiles });
      if (Number(usage.total) + data.length > this.limits.maxTotalBytes) throw new SdkError('sdk.files.full', { max: this.limits.maxTotalBytes });
      this.db.prepare('INSERT INTO plugin_files (bot_id, plugin_id, name, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)').run(this.botId, this.pluginId, name, type.mime, data.length, data);
    }
    return { name, mime: type.mime, size: data.length };
  }

  delete(name: unknown): boolean {
    if (typeof name !== 'string' || !FILE_NAME.test(name)) return false;
    return this.db.prepare('DELETE FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?').run(this.botId, this.pluginId, name).changes > 0;
  }
}

/** Discord attachment links a plugin may store (the files of a command's attachment option). */
export function discordAttachmentUrl(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) && /^\/(ephemeral-)?attachments\//.test(u.pathname) ? u : null;
  } catch {
    return null;
  }
}
