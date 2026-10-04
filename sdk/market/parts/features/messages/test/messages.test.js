import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runBlock } from '#sdk-testing';
import plugin from '../index.js';

const CHANNEL = '900000000000000002';

test('announce: sends one embed and returns its ID', async () => {
  const ctx = createTestContext({ id: '__ID__', permissions: ['discord.messages.send'] });
  const out = await runBlock(plugin, 'announce', ctx, { config: { channel: CHANNEL, title: 'News', text: 'Hello', color: '#ff0000' } });
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].channelId, CHANNEL);
  assert.deepEqual(ctx.sent[0].message, { embeds: [{ color: '#ff0000', description: 'Hello', title: 'News' }] });
  assert.equal(out.results['.id'], ctx.sent[0].id);
});

test('announce: a bad channel ID and the send limit are errors', async () => {
  const ctx = createTestContext({ id: '__ID__', permissions: ['discord.messages.send'] });
  await assert.rejects(runBlock(plugin, 'announce', ctx, { config: { channel: 'general', text: 'x' } }), { message: 'sdk.discord.bad_channel' });
  for (let i = 0; i < 5; i++) await runBlock(plugin, 'announce', ctx, { config: { channel: CHANNEL, text: String(i) } });
  await assert.rejects(runBlock(plugin, 'announce', ctx, { config: { channel: CHANNEL, text: 'six' } }), { message: 'sdk.discord.rate_limited' });
});
