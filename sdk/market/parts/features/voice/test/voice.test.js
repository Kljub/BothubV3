import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createTestContext, runBlock } from '#sdk-testing';
import plugin from '../index.js';
import { SOUNDS } from '../services/voice.js';

const GUILD = '900000000000000001';
const VOICE = '900000000000000005';
const sounds = (await readdir(new URL('../sounds/', import.meta.url))).map((f) => `sounds/${f}`);
const ctxWith = (config) => createTestContext({
  id: '__ID__', permissions: ['discord.voice.connect', 'discord.voice.speak'], config, sounds,
  guilds: [{ id: GUILD, name: 'Test', memberCount: 3 }],
});

test('every sound the code names exists in sounds/', () => {
  for (const file of Object.values(SOUNDS)) assert.ok(sounds.includes(file), file);
});

test('play_sound: joins the settings channel and plays with the volume', async () => {
  const ctx = ctxWith({ voice_channel: { id: VOICE, guild: GUILD }, volume: 50 });
  const out = await runBlock(plugin, 'play_sound', ctx, { config: { sound: 'ding' }, vars: { 'server.id': GUILD } });
  assert.equal(out.results[''], 'sounds/ding.wav');
  assert.deepEqual(ctx.played, [{ guildId: GUILD, channelId: VOICE, file: 'sounds/ding.wav', volume: 0.5 }]);
  assert.deepEqual(await ctx.voice.state(GUILD), { channelId: VOICE, playing: true, file: 'sounds/ding.wav' });
});

test('play_sound: the voice channel of the member wins; an unfilled placeholder is ignored', async () => {
  const ctx = ctxWith({ voice_channel: { id: VOICE, guild: GUILD } });
  const member = '900000000000000006';
  await runBlock(plugin, 'play_sound', ctx, { config: { channel: member }, vars: { 'server.id': GUILD } });
  await runBlock(plugin, 'play_sound', ctx, { config: { channel: '{user.voice.channel.id}' }, vars: { 'server.id': GUILD } });
  assert.deepEqual(ctx.played.map((p) => p.channelId), [member, VOICE]);
});

test('play_sound: another player (e.g. music) is busy -> error', async () => {
  const ctx = createTestContext({ id: '__ID__', permissions: ['discord.voice.connect', 'discord.voice.speak'], sounds, busyGuilds: [GUILD], guilds: [{ id: GUILD, name: 'Test', memberCount: 3 }] });
  await assert.rejects(runBlock(plugin, 'play_sound', ctx, { config: { channel: VOICE }, vars: { 'server.id': GUILD } }), { message: 'sdk.voice.busy' });
});

test('play_sound: no channel -> port "no_channel"; stop leaves', async () => {
  const ctx = ctxWith({});
  const out = await runBlock(plugin, 'play_sound', ctx, { vars: { 'server.id': GUILD } });
  assert.equal(out.port, 'no_channel');

  await runBlock(plugin, 'play_sound', ctx, { config: { channel: VOICE }, vars: { 'server.id': GUILD } });
  await runBlock(plugin, 'stop_sound', ctx, { vars: { 'server.id': GUILD } });
  assert.deepEqual(await ctx.voice.state(GUILD), { channelId: null, playing: false, file: null });
});
