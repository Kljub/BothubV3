// Data Storage module: variables defined on the dashboard (data_variables)
// and their values (data_values). Blocks reach them as {var.<key>}, and the
// variable blocks write them with the name "var.<key>".

import type { Db } from './db.js';
import { GraphError } from '../graph/interpreter.js';

type Row = Record<string, unknown>;

export interface DataContext {
  guildId: string;
  userId: string;
  channelId: string;
}

export interface DataStore {
  /** Stored value, else the starting value; undefined for an unknown key. */
  get(key: string, ctx: DataContext): string | undefined;
  set(key: string, ctx: DataContext, value: string): void;
  delete(key: string, ctx: DataContext): void;
}

interface Definition {
  id: number;
  type: string;
  owner: string;
  perServer: boolean;
  defaultValue: string;
}

const MAX_VALUE = 4000;
/** Stored values per variable; the API and the mock use the same limit. */
export const MAX_VALUES_PER_VARIABLE = 100_000;

/** Checks a value against the variable type (numbers, JSON for lists and objects). */
export function validDataValue(type: string, value: string): boolean {
  if (value === '' || type === 'text') return true;
  if (type === 'number') return /^\s*-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i.test(value) && Number.isFinite(Number(value));
  try {
    const v: unknown = JSON.parse(value);
    if (type === 'list') return Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x));
    if (type === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
    if (type === 'object_list') return Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x));
  } catch {
    return false;
  }
  return false;
}

export function dataStore(db: Db, botId: number): DataStore {
  const definition = (key: string): Definition | undefined => {
    const row = db.prepare('SELECT id, type, owner, per_server, default_value FROM data_variables WHERE bot_id = ? AND key = ?').get(botId, key) as Row | undefined;
    if (!row) return undefined;
    return { id: Number(row.id), type: String(row.type), owner: String(row.owner), perServer: Number(row.per_server) === 1, defaultValue: String(row.default_value) };
  };

  // Which row a run reads and writes: server (if per server) and owner.
  const where = (def: Definition, ctx: DataContext): [string, string] => {
    const server = def.perServer ? ctx.guildId : '';
    const owner = def.owner === 'member' ? ctx.userId : def.owner === 'channel' ? ctx.channelId : '';
    if ((def.perServer && !server) || (def.owner !== 'shared' && !owner)) {
      throw new GraphError('error.run.data_needs_context', { owner: def.owner });
    }
    return [server, owner];
  };

  const known = (key: string): Definition => {
    const def = definition(key);
    if (!def) throw new GraphError('error.run.unknown_data_variable', { value: key });
    return def;
  };

  return {
    get(key, ctx) {
      const def = definition(key);
      if (!def) return undefined;
      let server: string, owner: string;
      try {
        [server, owner] = where(def, ctx);
      } catch {
        return def.defaultValue; // e.g. a member variable in a timed event
      }
      const row = db.prepare('SELECT value FROM data_values WHERE variable_id = ? AND server_id = ? AND owner_id = ?').get(def.id, server, owner) as Row | undefined;
      return row ? String(row.value) : def.defaultValue;
    },
    set(key, ctx, value) {
      const def = known(key);
      if (value.length > MAX_VALUE) throw new GraphError('error.run.value_too_long', { max: MAX_VALUE });
      if (!validDataValue(def.type, value)) throw new GraphError('error.run.data_wrong_type', { value: key, type: def.type });
      const [server, owner] = where(def, ctx);
      // A new row only while the variable is below its limit; changing a value always works.
      const exists = db.prepare('SELECT 1 FROM data_values WHERE variable_id = ? AND server_id = ? AND owner_id = ?').get(def.id, server, owner);
      if (!exists) {
        const count = Number((db.prepare('SELECT COUNT(*) AS n FROM data_values WHERE variable_id = ?').get(def.id) as { n: number }).n);
        if (count >= MAX_VALUES_PER_VARIABLE) throw new GraphError('error.run.data_limit', { value: key, max: MAX_VALUES_PER_VARIABLE });
      }
      db.prepare(
        `INSERT INTO data_values (variable_id, server_id, owner_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(def.id, server, owner, value, new Date().toISOString());
    },
    delete(key, ctx) {
      const def = known(key);
      const [server, owner] = where(def, ctx);
      db.prepare('DELETE FROM data_values WHERE variable_id = ? AND server_id = ? AND owner_id = ?').run(def.id, server, owner);
    },
  };
}
