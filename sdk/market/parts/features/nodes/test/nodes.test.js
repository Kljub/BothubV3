import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runBlock } from '#sdk-testing';
import plugin from '../index.js';

test('hello: greets the name from the node config, else the user', async () => {
  const ctx = createTestContext({ id: '__ID__' });
  const out = await runBlock(plugin, 'hello', ctx, { config: { name: 'Ann' } });
  assert.equal(out.results[''], 'Hello Ann!');
  assert.equal(out.results['.length'], '10');

  const fallback = await runBlock(plugin, 'hello', ctx, { vars: { 'user.name': 'Ben' } });
  assert.equal(fallback.results[''], 'Hello Ben!');
});
