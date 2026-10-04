import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runBlock } from '#sdk-testing';
import plugin from '../index.js';

const replies = [
  { _id: 'a', trigger: 'Rules', answer: 'Read #rules.' },
  { _id: 'b', trigger: 'help', answer: 'Ask in #support.' },
];

test('reply_for: first matching trigger, case-insensitive', async () => {
  const ctx = createTestContext({ id: '__ID__', config: { replies } });
  const out = await runBlock(plugin, 'reply_for', ctx, { config: { text: 'where are the RULES?' } });
  assert.equal(out.port, 'next');
  assert.equal(out.results[''], 'Read #rules.');
});

test('reply_for: port "none" without match or before the page was saved', async () => {
  const saved = createTestContext({ id: '__ID__', config: { replies } });
  assert.equal((await runBlock(plugin, 'reply_for', saved, { config: { text: 'hi' } })).port, 'none');
  const empty = createTestContext({ id: '__ID__' });
  assert.equal((await runBlock(plugin, 'reply_for', empty, { config: { text: 'rules' } })).port, 'none');
});

test('config.set: only fields of the settings page', async () => {
  const settings = { fields: [{ key: 'greeting', type: 'text' }] };
  const ctx = createTestContext({ id: '__ID__', config: { greeting: 'x' }, settings });
  await ctx.config.set('greeting', 'y');
  assert.equal(ctx.config.get('greeting'), 'y');
  await assert.rejects(ctx.config.set('nope', 1), { message: 'sdk.config.unknown_key' });
});
