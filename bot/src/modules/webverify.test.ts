import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from '../core/db.js';
import { Repo } from '../core/repo.js';
import { ModuleContext } from './context.js';
import { newToken, parseList, reasonText, tokenHash, webVerifyCleanup } from './webverify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const G = '900000000000000001';
const U = '222222222222222222';

test('web verify: link tokens are 43 URL characters, only the hash is stored', () => {
  const a = newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newToken());
  assert.match(tokenHash(a), /^[0-9a-f]{64}$/);
  assert.equal(tokenHash('x'), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
});

test('web verify: reasons in words, broken JSON is an empty list', () => {
  assert.equal(reasonText(['vpn', 'alt']), 'VPN, proxy or hosting network, same address as another account');
  assert.equal(reasonText([]), 'no findings');
  assert.deepEqual(parseList('["1","2",3]'), ['1', '2']);
  assert.deepEqual(parseList('{'), []);
});

test('web verify: cleanup deletes address hashes after the retention time, also while the module is off', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'bothub-wv-')), 'bothub.sqlite'));
  const dir = join(root, 'api', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.exec("INSERT INTO bots (id, name, application_id) VALUES (1, 'Bot', '111111111111111111')");
  db.prepare("INSERT INTO bot_modules (bot_id, module_key, enabled, config) VALUES (1, 'web-verify', 0, ?)").run(JSON.stringify({ retentionDays: 10 }));
  const now = Date.parse('2026-10-22T12:00:00.000Z');
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const ip = (n: number, days: number) => db.prepare('INSERT INTO web_verify_ips (bot_id, guild_id, ip_hash, user_id, seen_at) VALUES (1, ?, ?, ?, ?)').run(G, String(n).repeat(64), U, ago(days));
  ip(1, 2);
  ip(2, 11);
  const req = (n: number, days: number) =>
    db.prepare('INSERT INTO web_verify_requests (bot_id, guild_id, user_id, token_hash, created_at, expires_at) VALUES (1, ?, ?, ?, ?, ?)').run(G, U, String(n).repeat(64), ago(days), ago(days));
  req(3, 1);
  req(4, 8);
  const ctx = new ModuleContext(1, new Repo(db));
  assert.equal(ctx.enabled('web-verify'), false);
  webVerifyCleanup(ctx, now);
  assert.deepEqual(db.prepare('SELECT substr(ip_hash, 1, 1) AS n FROM web_verify_ips').all(), [{ n: '1' }]);
  assert.deepEqual(db.prepare('SELECT substr(token_hash, 1, 1) AS n FROM web_verify_requests').all(), [{ n: '3' }]);
});
