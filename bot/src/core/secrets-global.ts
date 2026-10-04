// Global secrets (migration 0013, admin tab "API / Secrets": name, value, description).
// Values are decrypted only here and only for use in outgoing requests;
// they never go into run variables, results, logs or messages.

import { decrypt } from './secrets.js';
import type { Repo } from './repo.js';

/** Drops cached values (after bothub:events secrets.changed); values are read per use, nothing is cached. */
export function clearSecretCache(): void {
  // nothing cached
}

/** The value of a global secret, null when it does not exist (plugins: secrets.read). */
export function secretValue(repo: Repo, secretKey: () => Buffer, key: string): string | null {
  const row = repo.db.prepare('SELECT value_enc FROM secrets WHERE key = ?').get(key) as { value_enc: Uint8Array } | undefined;
  // An empty value is a placeholder ([NULL]) a plugin install created: no value yet.
  return row && row.value_enc.length > 0 ? decrypt(secretKey(), row.value_enc) : null;
}

/** Replaces every secret value in a text (error messages, response bodies). */
export function mask(text: string, hide: string[]): string {
  let out = text;
  for (const v of hide) if (v.length >= 4) out = out.split(v).join('••••');
  return out;
}
