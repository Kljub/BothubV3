import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runBlock } from '#sdk-testing';
import plugin from '../index.js';
import { readJson, writeJson } from '../services/storage.js';

const ctxWith = (permissions = ['storage']) => createTestContext({ id: '__ID__', permissions });

test('count: per server and per member', async () => {
  const ctx = ctxWith();
  const vars = { 'server.id': '1', 'user.id': '10' };
  await runBlock(plugin, 'count', ctx, { vars });
  const out = await runBlock(plugin, 'count', ctx, { config: { step: 5 }, vars: { ...vars, 'user.id': '11' } });
  assert.equal(out.results[''], '6');
  assert.equal(out.results['.user'], '5');
  const other = await runBlock(plugin, 'count', ctx, { vars: { 'server.id': '2' } });
  assert.equal(other.results[''], '1');
});

test('JSON helpers round-trip and survive broken values', async () => {
  const ctx = ctxWith();
  await writeJson(ctx, 'state', { a: [1, 2] });
  assert.deepEqual(await readJson(ctx, 'state', null), { a: [1, 2] });
  await ctx.storage.set('broken', '{nope');
  assert.equal(await readJson(ctx, 'broken', 'fallback'), 'fallback');
});

test('without the storage permission the call is denied', async () => {
  await assert.rejects(runBlock(plugin, 'count', ctxWith([]), {}), { message: 'sdk.call.denied' });
});
