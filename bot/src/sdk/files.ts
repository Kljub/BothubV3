// Plugin files ("storage.files"): files a plugin keeps per bot (plugin_files,
// migrations 0025, 0030). Uploads come from the dashboard (image settings
// field, images only) or from the plugin (base64 or a Discord attachment
// link). Images are recognized by their first bytes; other files keep the
// extension of their original name (executables are refused). The name is
// the content's hash, so the same file is stored once.

import { createHash } from 'node:crypto';
import type { Db } from '../core/db.js';
import { SdkError } from './errors.js';

export interface FileLimits {
  maxBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export const FILE_LIMITS: FileLimits = { maxBytes: 8 * 1024 * 1024, maxFiles: 100, maxTotalBytes: 50 * 1024 * 1024 };

/** Types of other files by extension; anything else is application/octet-stream. */
const MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', svg: 'image/svg+xml',
};
/** Never stored: files that run when opened. */
const EXECUTABLE = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'hta', 'jar', 'sh', 'apk', 'dll', 'lnk', 'reg']);

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

/** Image file names are <16 hex>.<ext> (image settings fields). */
export const FILE_NAME = /^[0-9a-f]{16}\.(png|gif|webp|jpg)$/;
/** Any stored file: <16 hex>.<extension>. */
export const ANY_FILE = /^[0-9a-f]{16}\.[a-z0-9]{1,8}$/;

export interface StoredFile {
  name: string;
  mime: string;
  size: number;
  /** Original name (other files), '' for images. */
  filename: string;
}

/** Type and extension of a file: images by content, others by the original name; null for executables. */
export function fileType(data: Buffer, filename = ''): { mime: string; ext: string } | null {
  const image = sniff(data);
  if (image) return image;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  const ext = m ? m[1]!.toLowerCase() : 'bin';
  // An image name without image content, or a program: refused.
  if (EXECUTABLE.has(ext) || ['png', 'gif', 'webp', 'jpg', 'jpeg'].includes(ext)) return null;
  return { mime: MIME[ext] ?? 'application/octet-stream', ext };
}

/** An original file name that is safe in a download (no paths, max. 100). */
export function cleanFilename(name: unknown): string {
  return typeof name === 'string' ? name.replace(/^.*[\\/]/, '').replace(/[^\w.\- ()]/g, '_').slice(-100) : '';
}

export class PluginFiles {
  constructor(
    private readonly db: Db,
    private readonly botId: number,
    private readonly pluginId: string,
    private readonly limits: FileLimits = FILE_LIMITS,
  ) {}

  list(): StoredFile[] {
    return (this.db.prepare('SELECT name, mime, size, filename FROM plugin_files WHERE bot_id = ? AND plugin_id = ? ORDER BY created_at').all(this.botId, this.pluginId) as unknown as StoredFile[]).map((r) => ({
      name: String(r.name), mime: String(r.mime), size: Number(r.size), filename: String(r.filename ?? ''),
    }));
  }

  get(name: unknown): (StoredFile & { data: Buffer }) | null {
    if (typeof name !== 'string' || !ANY_FILE.test(name)) return null;
    const row = this.db.prepare('SELECT name, mime, size, filename, data FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?').get(this.botId, this.pluginId, name) as
      | { name: string; mime: string; size: number; filename: string; data: Uint8Array }
      | undefined;
    return row ? { name: row.name, mime: row.mime, size: Number(row.size), filename: String(row.filename ?? ''), data: Buffer.from(row.data) } : null;
  }

  /**
   * Stores a file; returns its name (the same content again gives the same
   * name). imagesOnly: refuse other files (the old put without a file name).
   */
  put(data: Buffer, filename = '', imagesOnly = false): StoredFile {
    if (!data.length || data.length > this.limits.maxBytes) throw new SdkError('sdk.files.too_big', { max: this.limits.maxBytes });
    const type = imagesOnly ? sniff(data) : fileType(data, filename);
    if (!type) throw new SdkError('sdk.files.bad_type');
    const original = sniff(data) ? '' : cleanFilename(filename);
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${type.ext}`;
    const exists = this.db.prepare('SELECT 1 FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?').get(this.botId, this.pluginId, name);
    if (!exists) {
      const usage = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM plugin_files WHERE bot_id = ? AND plugin_id = ?').get(this.botId, this.pluginId) as { n: number; total: number };
      if (Number(usage.n) >= this.limits.maxFiles) throw new SdkError('sdk.files.full', { max: this.limits.maxFiles });
      if (Number(usage.total) + data.length > this.limits.maxTotalBytes) throw new SdkError('sdk.files.full', { max: this.limits.maxTotalBytes });
      this.db.prepare('INSERT INTO plugin_files (bot_id, plugin_id, name, mime, size, data, filename) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.botId, this.pluginId, name, type.mime, data.length, data, original);
    }
    return { name, mime: type.mime, size: data.length, filename: original };
  }

  delete(name: unknown): boolean {
    if (typeof name !== 'string' || !ANY_FILE.test(name)) return false;
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
