// Key-value storage of a plugin: for one bot (table plugin_storage, calls
// storage.*) or for the whole instance (table plugin_global_storage, calls
// globalStorage.*, permission storage.global). The plugin reaches it only
// through the SDK manager; the quotas come from shared/sdk-permissions.json.

import type { Db } from '../core/db.js';
import { SdkError } from './errors.js';

export interface StorageLimits {
  storageKeys: number;
  storageValueBytes: number;
  storageTotalBytes: number;
  globalStorageKeys?: number;
  globalStorageTotalBytes?: number;
}

const KEY = /^[\x20-\x7e]{1,128}$/;

export class PluginStorage {
  private readonly table: string;
  private readonly where: string;
  private readonly scope: (string | number)[];
  private readonly maxKeys: number;
  private readonly maxBytes: number;

  /** botId null = the plugin's global storage (every bot of the instance). */
  constructor(
    private readonly db: Db,
    botId: number | null,
    pluginId: string,
    private readonly limits: StorageLimits,
  ) {
    const global = botId === null;
    this.table = global ? 'plugin_global_storage' : 'plugin_storage';
    this.where = global ? 'plugin_id = ?' : 'bot_id = ? AND plugin_id = ?';
    this.scope = global ? [pluginId] : [botId, pluginId];
    this.maxKeys = global ? (limits.globalStorageKeys ?? 10000) : limits.storageKeys;
    this.maxBytes = global ? (limits.globalStorageTotalBytes ?? 10485760) : limits.storageTotalBytes;
  }

  private static key(key: unknown): string {
    if (typeof key !== 'string' || !KEY.test(key)) throw new SdkError('sdk.storage.bad_key');
    return key;
  }

  get(key: unknown): string | null {
    const row = this.db.prepare(`SELECT value FROM ${this.table} WHERE ${this.where} AND key = ?`).get(...this.scope, PluginStorage.key(key)) as
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
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes, MAX(key = ?) AS has FROM ${this.table} WHERE ${this.where}`)
      .get(k, ...this.scope) as { n: number; bytes: number; has: number | null };
    const old = stats.has ? Buffer.byteLength(this.get(k) ?? '') : 0;
    if (!stats.has && stats.n >= this.maxKeys) throw new SdkError('sdk.storage.too_many_keys', { max: this.maxKeys });
    if (stats.bytes - old + size > this.maxBytes) throw new SdkError('sdk.storage.full', { max: this.maxBytes });
    const cols = this.scope.length === 2 ? 'bot_id, plugin_id' : 'plugin_id';
    const marks = this.scope.map(() => '?').join(', ');
    this.db
      .prepare(
        `INSERT INTO ${this.table} (${cols}, key, value, updated_at) VALUES (${marks}, ?, ?, ?)
         ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(...this.scope, k, value, new Date().toISOString());
  }

  has(key: unknown): boolean {
    return this.get(key) !== null;
  }

  /** Adds by (default 1) to a number value; a missing key counts as 0. */
  increment(key: unknown, by: unknown = 1): number {
    const step = Number(by);
    if (!Number.isFinite(step)) throw new SdkError('sdk.storage.bad_value');
    const current = Number(this.get(key) ?? '0');
    if (!Number.isFinite(current)) throw new SdkError('sdk.storage.not_a_number');
    const next = current + step;
    this.set(key, String(next));
    return next;
  }

  /** Removes every key of this plugin in this scope (one bot, or global). */
  clear(): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE ${this.where}`).run(...this.scope);
  }

  delete(key: unknown): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE ${this.where} AND key = ?`).run(...this.scope, PluginStorage.key(key));
  }

  list(prefix: unknown): string[] {
    const p = typeof prefix === 'string' ? prefix.slice(0, 128) : '';
    const rows = this.db
      .prepare(`SELECT key FROM ${this.table} WHERE ${this.where} AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000`)
      .all(...this.scope, p.replace(/[\\%_]/g, (c) => `\\${c}`) + '%') as { key: string }[];
    return rows.map((r) => r.key);
  }
}
