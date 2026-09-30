import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from './db.js';
import { dataStore, validDataValue } from './datastore.js';
import { GraphError } from '../graph/interpreter.js';

// Tests run from bot/dist/core; the repo root is three levels up.
const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'api', 'migrations');

function db(): Db {
  const d = openDb(join(mkdtempSync(join(tmpdir(), 'bothub-data-')), 'bothub.sqlite'));
  for (const f of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) d.exec(readFileSync(join(migrations, f), 'utf8'));
  d.prepare("INSERT INTO bots (name, autostart) VALUES ('Test', 1)").run();
  return d;
}

const ctx = { guildId: '100000000000000001', userId: '200000000000000002', channelId: '300000000000000003' };

test('data storage: values per member and server, starting value, types', () => {
  const d = db();
  d.prepare("INSERT INTO data_variables (bot_id, key, name, type, owner, per_server, default_value) VALUES (1, 'coins', 'Coins', 'number', 'member', 1, '10')").run();
  d.prepare("INSERT INTO data_variables (bot_id, key, name, type, owner, per_server, default_value) VALUES (1, 'motd', 'MOTD', 'text', 'shared', 0, '')").run();
  const store = dataStore(d, 1);

  assert.equal(store.get('coins', ctx), '10', 'starting value');
  assert.equal(store.get('nope', ctx), undefined, 'unknown key');
  store.set('coins', ctx, '25');
  assert.equal(store.get('coins', ctx), '25');
  assert.equal(store.get('coins', { ...ctx, guildId: '100000000000000009' }), '10', 'other server has its own value');
  assert.equal(store.get('coins', { ...ctx, userId: '200000000000000009' }), '10', 'other member has its own value');

  // Not per server: the same value everywhere.
  store.set('motd', ctx, 'hello');
  assert.equal(store.get('motd', { guildId: '', userId: '', channelId: '' }), 'hello');

  assert.throws(() => store.set('coins', ctx, 'abc'), (e: unknown) => e instanceof GraphError && e.key === 'error.run.data_wrong_type');
  assert.throws(() => store.set('nope', ctx, '1'), (e: unknown) => e instanceof GraphError && e.key === 'error.run.unknown_data_variable');
  // A member variable without a member (timed event) reads the starting value, writing fails.
  assert.equal(store.get('coins', { ...ctx, userId: '' }), '10');
  assert.throws(() => store.set('coins', { ...ctx, userId: '' }, '1'), (e: unknown) => e instanceof GraphError && e.key === 'error.run.data_needs_context');

  store.delete('coins', ctx);
  assert.equal(store.get('coins', ctx), '10', 'deleted value falls back to the starting value');
});

test('data storage: value types', () => {
  assert.ok(validDataValue('number', '1.5'));
  assert.ok(!validDataValue('number', 'x'));
  for (const bad of ['NaN', 'Infinity', '0x10', '1e999']) assert.ok(!validDataValue('number', bad), bad);
  assert.ok(validDataValue('list', '["a", 1]'));
  assert.ok(!validDataValue('list', '[{"a":1}]'));
  assert.ok(validDataValue('object', '{"a":"b"}'));
  assert.ok(!validDataValue('object', '[1]'));
  assert.ok(validDataValue('object_list', '[{"a":1}]'));
  assert.ok(validDataValue('text', 'anything'));
  assert.ok(validDataValue('list', ''), 'empty is always allowed');
});
