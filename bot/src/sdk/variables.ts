// SDK variables.* (permission data.variables): a plugin creates and deletes
// Data Storage variables of a bot (data_variables, plugin_id = the plugin)
// and reads and writes their values. The Custom Command Builder and the
// Message Builder list them like dashboard variables ({var.<key>}). A plugin
// touches only the variables it created; a key another variable uses is
// refused (sdk.variables.taken).

import type { Db } from '../core/db.js';
import { dataStore, validDataValue, type DataContext } from '../core/datastore.js';
import { GraphError } from '../graph/interpreter.js';
import { SdkError } from './errors.js';

const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const TYPES = ['text', 'number', 'list', 'object', 'object_list'];
const OWNERS = ['shared', 'member', 'channel'];
/** Variables per bot, like the dashboard (DataStore::MAX_VARIABLES). */
const MAX_VARIABLES = 200;

export interface VariableInfo {
  key: string;
  name: string;
  description: string;
  type: string;
  owner: string;
  perServer: boolean;
  default: string;
  group: string;
}

type Row = { id: number; key: string; name: string; description: string; type: string; owner: string; per_server: number; default_value: string; group_name: string; plugin_id: string | null };

const info = (r: Row): VariableInfo => ({ key: r.key, name: r.name, description: r.description, type: r.type, owner: r.owner, perServer: r.per_server === 1, default: r.default_value, group: r.group_name });

/** A value as stored: text for text and number, JSON for lists and objects. */
function stored(type: string, v: unknown): string {
  if (typeof v === 'string') return v;
  if (type === 'number' && typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (type !== 'text' && type !== 'number' && v !== null && typeof v === 'object') return JSON.stringify(v);
  if (v === undefined || v === null) return '';
  throw new SdkError('sdk.variables.bad_value');
}

function context(where: unknown): DataContext {
  const w = (where && typeof where === 'object' ? where : {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && SNOWFLAKE.test(v) ? v : '');
  return { guildId: id(w.guildId), userId: id(w.userId), channelId: id(w.channelId) };
}

export function pluginVariables(db: Db, botId: number, pluginId: string, pluginName: string) {
  const row = (key: unknown): Row | undefined =>
    typeof key === 'string' ? (db.prepare('SELECT * FROM data_variables WHERE bot_id = ? AND key = ?').get(botId, key) as Row | undefined) : undefined;
  const own = (key: unknown): Row => {
    const r = row(key);
    if (!r || r.plugin_id !== pluginId) throw new SdkError('sdk.variables.unknown', { key: String(key).slice(0, 40) });
    return r;
  };
  const values = dataStore(db, botId);
  const run = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      // Data Storage errors (wrong type, needs a server or member, limit) keep their key.
      if (err instanceof GraphError) throw new SdkError(err.key.replace(/^error\.run\./, 'sdk.variables.'), err.params);
      throw err;
    }
  };

  return {
    /**
     * Creates the variable, or updates it when the plugin made it before
     * (a new type, owner or server setting drops its stored values).
     */
    create(def: unknown): { key: string; created: boolean } {
      const d = (def && typeof def === 'object' ? def : {}) as Record<string, unknown>;
      const key = d.key;
      if (typeof key !== 'string' || !KEY.test(key)) throw new SdkError('sdk.variables.bad_key');
      const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : key;
      const description = typeof d.description === 'string' ? d.description.trim() : '';
      const type = d.type ?? 'text';
      const owner = d.owner ?? 'shared';
      const perServer = d.perServer !== false;
      const group = typeof d.group === 'string' && d.group.trim() ? d.group.trim() : pluginName;
      const dflt = d.default === undefined ? '' : stored(String(type), d.default);
      if (name.length > 32 || description.length > 200 || group.length > 40 || dflt.length > 4000) throw new SdkError('sdk.variables.too_long');
      if (typeof type !== 'string' || !TYPES.includes(type) || typeof owner !== 'string' || !OWNERS.includes(owner)) throw new SdkError('sdk.variables.bad_type');
      if (!validDataValue(type, dflt)) throw new SdkError('sdk.variables.bad_value');
      const old = row(key);
      if (old && old.plugin_id !== pluginId) throw new SdkError('sdk.variables.taken', { key });
      if (old) {
        if (old.type !== type || old.owner !== owner || old.per_server !== (perServer ? 1 : 0)) db.prepare('DELETE FROM data_values WHERE variable_id = ?').run(old.id);
        db.prepare(
          `UPDATE data_variables SET name = ?, description = ?, type = ?, owner = ?, per_server = ?, default_value = ?, group_name = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(name, description, type, owner, perServer ? 1 : 0, dflt, group, old.id);
        return { key, created: false };
      }
      const count = Number((db.prepare('SELECT COUNT(*) AS n FROM data_variables WHERE bot_id = ?').get(botId) as { n: number }).n);
      if (count >= MAX_VARIABLES) throw new SdkError('sdk.variables.limit', { max: MAX_VARIABLES });
      db.prepare(
        'INSERT INTO data_variables (bot_id, key, name, description, type, owner, per_server, default_value, group_name, plugin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(botId, key, name, description, type, owner, perServer ? 1 : 0, dflt, group, pluginId);
      return { key, created: true };
    },
    /** Deletes one of the plugin's variables with its values. */
    delete(key: unknown): boolean {
      db.prepare('DELETE FROM data_variables WHERE id = ?').run(own(key).id);
      return true;
    },
    /** The plugin's variables of this bot. */
    list(): VariableInfo[] {
      return (db.prepare('SELECT * FROM data_variables WHERE bot_id = ? AND plugin_id = ? ORDER BY key').all(botId, pluginId) as Row[]).map(info);
    },
    /** A value (else the default); where = { guildId, userId, channelId } as the variable needs. */
    get(key: unknown, where: unknown): string {
      const r = own(key);
      return run(() => values.get(r.key, context(where)) ?? r.default_value);
    },
    set(key: unknown, value: unknown, where: unknown): boolean {
      const r = own(key);
      run(() => values.set(r.key, context(where), stored(r.type, value)));
      return true;
    },
    /** Removes a stored value: back to the default. */
    reset(key: unknown, where: unknown): boolean {
      const r = own(key);
      run(() => values.delete(r.key, context(where)));
      return true;
    },
  };
}
