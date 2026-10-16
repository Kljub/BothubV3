import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from '../core/db.js';
import { Repo } from '../core/repo.js';
import { decrypt, encrypt } from '../core/secrets.js';
import { ModuleContext } from './context.js';
import { connectionsTick, diff, eventVars, linkUrl, matches, rolesFor, type Conn } from './connections.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const G = '900000000000000001';
const ref = (id: string) => ({ id, guild: G });

const steam: Conn = { type: 'steam', id: '765', name: 'Entity', verified: true };
const github: Conn = { type: 'github', id: '42', name: 'Kljub', verified: false };

test('rules: type, verified, name part; linked role; roles taken away', () => {
  assert.ok(matches({ connection: 'steam' }, steam));
  assert.ok(!matches({ connection: 'github' }, github), 'verified is the default');
  assert.ok(matches({ connection: 'github', verified: false }, github));
  assert.ok(matches({ connection: 'steam', name: 'enti' }, steam));
  assert.ok(!matches({ connection: 'steam', name: 'other' }, steam));
  const cfg = { rules: [{ connection: 'steam', role: ref('1') }, { connection: 'twitch', role: ref('2') }, { connection: 'steam', role: { id: '3', guild: 'other' } }], linkedRole: ref('9') };
  assert.deepEqual(rolesFor([steam], cfg, G), { give: ['1', '9'], take: ['2'] });
  assert.deepEqual(rolesFor(null, cfg, G), { give: [], take: ['1', '2', '9'] }, 'unlinked: every rule role goes');
  assert.deepEqual(rolesFor(null, { ...cfg, removeRoles: false }, G).take, []);
});

test('changes: added and removed connections as event placeholders', () => {
  const now = [steam, { ...github, name: 'New' }];
  assert.deepEqual(diff([github], now), { added: now, removed: [github] });
  assert.deepEqual(eventVars(now, [github]), {
    connections: 'steam: Entity, github: New',
    'connections.types': 'steam, github',
    'connections.count': '2',
    'connections.added': 'steam: Entity, github: New',
    'connections.removed': 'github: Kljub',
  });
});

function context(): { ctx: ModuleContext; key: Buffer } {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'bothub-conn-')), 'bothub.sqlite'));
  const dir = join(root, 'api', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.exec("INSERT INTO bots (id, name, application_id) VALUES (1, 'Bot', '111111111111111111')");
  db.prepare("INSERT INTO bot_modules (bot_id, module_key, config) VALUES (1, 'connection-roles', ?)").run(JSON.stringify({ rules: [{ connection: 'steam', role: ref('1') }], refreshHours: '12' }));
  const key = randomBytes(32);
  db.prepare("INSERT INTO bot_oauth_app (bot_id, client_secret_enc, public_url) VALUES (1, ?, 'https://bothub.example')").run(encrypt(key, 'client-secret'));
  return { ctx: new ModuleContext(1, new Repo(db), () => null, () => key), key };
}

function link(ctx: ModuleContext, key: Buffer, conns: Conn[], { expires = Date.now() + 86_400_000, checked = '2000-01-01T00:00:00.000Z' } = {}): void {
  ctx.db
    .prepare('INSERT INTO member_connections (bot_id, user_id, user_name, access_enc, refresh_enc, expires_at, connections, dirty, checked_at) VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run('222222222222222222', 'Kljub', encrypt(key, 'acc'), encrypt(key, 'ref'), new Date(expires).toISOString(), JSON.stringify(conns), checked);
}

const row = (ctx: ModuleContext) => ctx.db.prepare('SELECT * FROM member_connections').get() as Record<string, unknown> | undefined;

test('member link from the dashboard address', () => {
  const { ctx } = context();
  assert.equal(linkUrl(ctx), 'https://bothub.example/connect/111111111111111111');
});

test('refresh: new connections mark the member, a renewed token is stored, refusals drop the link', async () => {
  const { ctx, key } = context();
  link(ctx, key, [steam], { expires: Date.now() + 60_000 });
  const calls: string[] = [];
  let answer: unknown[] = [{ type: 'steam', id: '765', name: 'Entity', verified: true }, { type: 'github', id: '42', name: 'Kljub', verified: true }];
  let ok = true;
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${String(url)} ${init?.body ? String(init.body) : ''}`);
    if (!ok) return new Response('{}', { status: 401 });
    if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'acc2', refresh_token: 'ref2', expires_in: 604800 });
    return Response.json(answer);
  }) as typeof fetch;

  await connectionsTick(ctx, [], null, Date.now(), fake);
  assert.match(calls[0]!, /oauth2\/token grant_type=refresh_token&refresh_token=ref&client_id=111111111111111111&client_secret=client-secret/);
  let r = row(ctx)!;
  assert.equal(decrypt(key, r.access_enc as Uint8Array), 'acc2', 'token renewed and stored');
  assert.equal(r.dirty, 1, 'changed: the next round gives roles and fires the event');
  assert.equal(JSON.parse(String(r.previous)).length, 1);

  // Nothing changed: only the check time moves.
  ctx.db.prepare("UPDATE member_connections SET dirty = 0, checked_at = '2000-01-01T00:00:00.000Z'").run();
  await connectionsTick(ctx, [], null, Date.now(), fake);
  r = row(ctx)!;
  assert.equal(r.dirty, 0);
  assert.ok(String(r.checked_at) > '2020');

  // Not due yet: no call.
  const before = calls.length;
  await connectionsTick(ctx, [], null, Date.now(), fake);
  assert.equal(calls.length, before);

  // Refused three times: the link goes.
  ok = false;
  for (let i = 0; i < 3; i++) {
    ctx.db.prepare("UPDATE member_connections SET checked_at = '2000-01-01T00:00:00.000Z'").run();
    await connectionsTick(ctx, [], null, Date.now(), fake);
  }
  assert.equal(row(ctx), undefined);
  answer = [];
});

test('changed members: dirty is cleared even without a server', async () => {
  const { ctx, key } = context();
  link(ctx, key, [steam], { checked: new Date().toISOString() });
  ctx.db.prepare('UPDATE member_connections SET dirty = 1').run();
  await connectionsTick(ctx, [], null, Date.now(), (async () => new Response('[]')) as typeof fetch);
  assert.equal(row(ctx)!.dirty, 0);
});
