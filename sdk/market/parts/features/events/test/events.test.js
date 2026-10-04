import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runEvent } from '#sdk-testing';
import plugin from '../index.js';

const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const joined = { 'server.id': GUILD, 'server.name': 'Test', 'server.members': 42, 'user.id': '7', 'user.name': 'Ann', 'user.mention': '<@7>', 'user.bot': false };
const ctxWith = (config) => createTestContext({ id: '__ID__', permissions: ['discord.events.members', 'discord.messages.send'], config });

test('guildMemberAdd: welcome text in the configured channel', async () => {
  const ctx = ctxWith({ welcome_channel: { id: CHANNEL, guild: GUILD }, welcome_text: 'Hi {user} on {server} (#{count})' });
  await runEvent(plugin, 'guildMemberAdd', ctx, joined);
  assert.deepEqual(ctx.sent.map((m) => [m.channelId, m.message]), [[CHANNEL, 'Hi <@7> on Test (#42)']]);
});

test('guildMemberAdd: nothing without a channel, for bots, or for another server', async () => {
  const none = ctxWith({});
  await runEvent(plugin, 'guildMemberAdd', none, joined);
  const bot = ctxWith({ welcome_channel: { id: CHANNEL, guild: GUILD } });
  await runEvent(plugin, 'guildMemberAdd', bot, { ...joined, 'user.bot': true });
  const other = ctxWith({ welcome_channel: { id: CHANNEL, guild: '900000000000000009' } });
  await runEvent(plugin, 'guildMemberAdd', other, joined);
  assert.equal(none.sent.length + bot.sent.length + other.sent.length, 0);
});
