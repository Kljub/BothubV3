// SQLite access of the bot. The API owns the schema and runs migrations; the
// bot only waits until the database has the version in shared/db-schema.json.
// Write rules (plan.md): WAL, busy_timeout 5000, BEGIN IMMEDIATE, short
// transactions, no network call inside one. The bot writes runtime data only.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './log.js';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Waits until the API has created the database and migrated it to the
 * expected version. A newer version means this bot build is too old.
 */
export async function waitForSchema(path: string, expected: number, signal?: AbortSignal): Promise<Db> {
  let reported = -1;
  for (;;) {
    signal?.throwIfAborted();
    if (existsSync(path)) {
      const db = openDb(path);
      const version = schemaVersion(db);
      if (version === expected) return db;
      db.close();
      if (version > expected) {
        throw new Error(`database schema ${version} is newer than this bot build (${expected}); update the bot`);
      }
      if (version !== reported) log.info('waiting for database migrations', { version, expected });
      reported = version;
    } else if (reported !== -2) {
      log.info('waiting for the API to create the database', { path });
      reported = -2;
    }
    await sleep(2000, undefined, { signal });
  }
}

/** Runs fn in a write transaction (BEGIN IMMEDIATE takes the lock up front). */
export function write<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = (): string => new Date().toISOString();
