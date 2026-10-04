import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runTask } from '#sdk-testing';
import plugin from '../index.js';

const CHANNEL = '900000000000000002';
const permissions = ['scheduler', 'storage', 'discord.messages.send'];

test('daily_report: counts runs, posts only with a channel', async () => {
  const quiet = createTestContext({ id: '__ID__', permissions });
  await runTask(plugin, 'daily_report', quiet);
  assert.equal(quiet.sent.length, 0);
  assert.equal(quiet.store.get('report:runs'), '1');

  const ctx = createTestContext({ id: '__ID__', permissions, config: { report_channel: { id: CHANNEL, guild: '1' } } });
  await runTask(plugin, 'daily_report', ctx);
  await runTask(plugin, 'daily_report', ctx);
  assert.equal(ctx.sent.length, 2);
  assert.match(ctx.sent[1].message, /^Daily report #2 /);
});

test('cleanup: keeps the last 30 days', async () => {
  const days = Array.from({ length: 40 }, (_, i) => `d${i}`);
  const ctx = createTestContext({ id: '__ID__', permissions, storage: { 'report:history': JSON.stringify(days) } });
  await runTask(plugin, 'cleanup', ctx);
  assert.deepEqual(JSON.parse(ctx.store.get('report:history')), days.slice(-30));
});
