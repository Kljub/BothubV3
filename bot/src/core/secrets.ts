// Bot tokens are stored encrypted (context/decisions.md, "Secrets"):
// AES-256-GCM, blob = nonce (12 bytes) || ciphertext || tag (16 bytes).
// Key: ENV BOTHUB_SECRET_KEY (base64, 32 bytes) or KEYS_DIR/secret.key (the
// API creates it on first start; /keys, its own volume, read-only for the
// bot). Old installs: /data/secret.key. Only the API and the bot ever see a token
// in clear text; it is never logged.

import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NONCE = 12;
const TAG = 16;

export function loadSecretKey(dataDir: string, env = process.env): Buffer {
  const fromEnv = env.BOTHUB_SECRET_KEY;
  if (fromEnv) return checkKey(Buffer.from(fromEnv, 'base64'));
  const keys = env.KEYS_DIR ? join(env.KEYS_DIR, 'secret.key') : '';
  const file = keys && existsSync(keys) ? keys : join(dataDir, 'secret.key');
  if (!existsSync(file)) throw new Error('no secret key: set BOTHUB_SECRET_KEY or start the API once to create /keys/secret.key');
  const raw = readFileSync(file);
  // The file holds 32 raw bytes or their base64 text.
  return checkKey(raw.length === 32 ? raw : Buffer.from(raw.toString('utf8').trim(), 'base64'));
}

function checkKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('secret key must be 32 bytes');
  return key;
}

export function decrypt(key: Buffer, blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  if (buf.length <= NONCE + TAG) throw new Error('encrypted value too short');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, NONCE));
  decipher.setAuthTag(buf.subarray(buf.length - TAG));
  return Buffer.concat([decipher.update(buf.subarray(NONCE, buf.length - TAG)), decipher.final()]).toString('utf8');
}

/** Same format as the API writes; used by tests and tools. */
export function encrypt(key: Buffer, text: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
