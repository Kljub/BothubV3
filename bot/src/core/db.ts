// SQLite access of the bot. The API owns the schema and runs migrations; the
// bot only waits until the database has the version in shared/db-schema.json.
// Write rules (plan.md): WAL, busy_timeout 5000, BEGIN IMMEDIATE, short
// transactions, no network call inside one. The bot writes runtime data only.
//
// Encryption at rest: SQLite3 Multiple Ciphers in the SQLCipher 4 format, the
// same as the API (api/src/Database/Connection.php). The key: BOTHUB_DB_KEY,
// else KEYS_DIR/db.key; 64 hex characters are the key itself, other text is
// hashed with SHA-256. A file that is still plain (the API encrypts it at its
// start) opens without the key. KEYS_DIR/db.raw: the key is SQLCipher's raw
// key (x'…', fast); without it the older passphrase form (PBKDF2).

import Database from 'better-sqlite3-multiple-ciphers';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './log.js';

export type Db = Database.Database;

const PLAIN_HEADER = 'SQLite format 3\0';

/** The hex key of the database, or null (no key: the database stays plain). */
export function dbKey(): string | null {
  let raw = process.env.BOTHUB_DB_KEY ?? '';
  if (raw.trim() === '') {
    const file = join(process.env.KEYS_DIR || '/keys', 'db.key');
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
  raw = raw.trim();
  if (raw === '') return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  return createHash('sha256').update(raw).digest('hex');
}

/** The database uses the raw key (marker KEYS_DIR/db.raw, written by the API). */
export function rawKey(): boolean {
  return existsSync(join(process.env.KEYS_DIR || process.env.DATA_DIR || '/data', 'db.raw'));
}

/** True when the file exists and starts with the plain SQLite header. */
export function isPlain(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(16);
    return readSync(fd, buf, 0, 16, 0) === 16 && buf.toString('latin1') === PLAIN_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  const key = path === ':memory:' ? null : dbKey();
  if (key !== null && !isPlain(path)) {
    db.pragma(`cipher = 'sqlcipher'`);
    db.pragma('legacy = 4');
    if (rawKey()) db.pragma(`key = "x'${key}'"`);
    else db.pragma(`hexkey = '${key}'`);
  }
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0);
}

/**
 * Waits until the API has created the database and migrated it to the
 * expected version. A newer version means this bot build is too old. A
 * database that cannot be read yet (the API is encrypting it) is tried again.
 */
export async function waitForSchema(path: string, expected: number, signal?: AbortSignal): Promise<Db> {
  let reported = -1;
  for (;;) {
    signal?.throwIfAborted();
    if (existsSync(path)) {
      let db: Db | undefined;
      let version = -3;
      try {
        db = openDb(path);
        version = schemaVersion(db);
      } catch (err) {
        if (reported !== -3) log.warn('the database cannot be read yet', { error: (err as Error).message });
        reported = -3;
      }
      if (db && version === expected) return db;
      db?.close();
      if (version > expected) {
        throw new Error(`database schema ${version} is newer than this bot build (${expected}); update the bot`);
      }
      if (version >= 0 && version !== reported) log.info('waiting for database migrations', { version, expected });
      if (version >= 0) reported = version;
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
