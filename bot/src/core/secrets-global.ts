// Secrets (migration 0027): every user keeps their own (User settings →
// API / Secrets); a bot, its modules and its plugins use the secrets of the
// bot's owner (bots.owner_id).
// Values are decrypted only here and only for use in outgoing requests;
// they never go into run variables, results, logs or messages.

import { guardValue } from './leakguard.js';
import { decrypt } from './secrets.js';
import type { Repo } from './repo.js';

/** Drops cached values (after bothub:events secrets.changed); values are read per use, nothing is cached. */
export function clearSecretCache(): void {
  // nothing cached
}

/** A secret of the bot's owner, null when it does not exist (plugins: secrets.read). */
export function secretValue(repo: Repo, secretKey: () => Buffer, botId: number, key: string): string | null {
  const row = repo.db
    .prepare('SELECT s.value_enc FROM secrets s JOIN bots b ON b.owner_id = s.owner_id WHERE b.id = ? AND s.key = ?')
    .get(botId, key) as { value_enc: Uint8Array } | undefined;
  // An empty value is a placeholder ([NULL]) a plugin install created: no value yet.
  const value = row && row.value_enc.length > 0 ? decrypt(secretKey(), row.value_enc) : null;
  guardValue(value);
  return value;
}

/** Replaces every secret value in a text (error messages, response bodies). */
export function mask(text: string, hide: string[]): string {
  let out = text;
  for (const v of hide) if (v.length >= 4) out = out.split(v).join('••••');
  return out;
}
