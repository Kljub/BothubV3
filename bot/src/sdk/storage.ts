// Key-value storage of a plugin for one bot (table plugin_storage). The
// plugin reaches it only through the SDK manager (storage.* calls); the
// quotas come from shared/sdk-permissions.json.

import type { Db } from '../core/db.js';
import { SdkError } from './errors.js';

export interface StorageLimits {
  storageKeys: number;
  storageValueBytes: number;
  storageTotalBytes: number;
}

const KEY = /^[\x20-\x7e]{1,128}$/;

export class PluginStorage {
  constructor(
    private readonly db: Db,
    private readonly botId: number,
    private readonly pluginId: string,
    private readonly limits: StorageLimits,
  ) {}

  private static key(key: unknown): string {
    if (typeof key !== 'string' || !KEY.test(key)) throw new SdkError('sdk.storage.bad_key');
    return key;
  }

  get(key: unknown): string | null {
    const row = this.db.prepare('SELECT value FROM plugin_storage WHERE bot_id = ? AND plugin_id = ? AND key = ?').get(this.botId, this.pluginId, PluginStorage.key(key)) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  set(key: unknown, value: unknown): void {
    const k = PluginStorage.key(key);
    if (typeof value !== 'string') throw new SdkError('sdk.storage.bad_value');
    const size = Buffer.byteLength(value);
    if (size > this.limits.storageValueBytes) throw new SdkError('sdk.storage.value_too_big', { max: this.limits.storageValueBytes });
    const stats = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes, MAX(key = ?) AS has FROM plugin_storage WHERE bot_id = ? AND plugin_id = ?')
      .get(k, this.botId, this.pluginId) as { n: number; bytes: number; has: number | null };
    const old = stats.has ? Buffer.byteLength(this.get(k) ?? '') : 0;
    if (!stats.has && stats.n >= this.limits.storageKeys) throw new SdkError('sdk.storage.too_many_keys', { max: this.limits.storageKeys });
    if (stats.bytes - old + size > this.limits.storageTotalBytes) throw new SdkError('sdk.storage.full', { max: this.limits.storageTotalBytes });
    this.db
      .prepare(
        `INSERT INTO plugin_storage (bot_id, plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(this.botId, this.pluginId, k, value, new Date().toISOString());
  }

  delete(key: unknown): void {
    this.db.prepare('DELETE FROM plugin_storage WHERE bot_id = ? AND plugin_id = ? AND key = ?').run(this.botId, this.pluginId, PluginStorage.key(key));
  }

  list(prefix: unknown): string[] {
    const p = typeof prefix === 'string' ? prefix.slice(0, 128) : '';
    const rows = this.db
      .prepare("SELECT key FROM plugin_storage WHERE bot_id = ? AND plugin_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000")
      .all(this.botId, this.pluginId, p.replace(/[\\%_]/g, (c) => `\\${c}`) + '%') as { key: string }[];
    return rows.map((r) => r.key);
  }
}
