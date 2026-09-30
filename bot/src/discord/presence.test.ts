import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType } from 'discord.js';
import { buildPresence, hasPlaceholders, parsePresence } from './presence.js';

test('presence defaults for a missing or broken row', () => {
  assert.deepEqual(buildPresence(parsePresence(undefined)), { status: 'online', activities: [] });
  assert.equal(parsePresence({ status: 'weird', rotation: { intervalSeconds: 5 } }).rotation.intervalSeconds, 30);
});

test('activity, custom status and streaming url', () => {
  const p = parsePresence({ status: 'dnd', activity: { type: 'streaming', name: 'Live', url: 'https://twitch.tv/x' }, customStatus: ' Hi ' });
  // Discord shows one activity of a bot: the chosen one is sent alone.
  assert.deepEqual(buildPresence(p), { status: 'dnd', activities: [{ type: ActivityType.Streaming, name: 'Live', url: 'https://twitch.tv/x' }] });
  assert.deepEqual(buildPresence({ ...p, show: 'custom' }).activities, [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Hi' }]);
  // The chosen one is empty: the other one is shown.
  assert.deepEqual(buildPresence({ ...p, show: 'custom', customStatus: '' }).activities, [{ type: ActivityType.Streaming, name: 'Live', url: 'https://twitch.tv/x' }]);
  assert.equal(parsePresence({ show: 'weird' }).show, 'activity');
  assert.deepEqual(buildPresence(parsePresence({ activity: { type: 'none', name: 'x' } })).activities, []);
});

test('rotation replaces the activity and cycles', () => {
  const p = parsePresence({
    activity: { type: 'playing', name: 'fixed' },
    rotation: { enabled: true, intervalSeconds: 60, entries: [{ type: 'watching', name: 'A' }, { type: 'none', name: 'skip' }, { type: 'listening', name: 'B' }] },
  });
  assert.deepEqual(buildPresence(p, 0).activities, [{ type: ActivityType.Watching, name: 'A' }]);
  assert.deepEqual(buildPresence(p, 1).activities, [{ type: ActivityType.Listening, name: 'B' }]);
  assert.deepEqual(buildPresence(p, 2).activities, [{ type: ActivityType.Watching, name: 'A' }]);
  const off = parsePresence({ ...p, rotation: { ...p.rotation, enabled: false } });
  assert.deepEqual(buildPresence(off, 1).activities, [{ type: ActivityType.Playing, name: 'fixed' }]);
});

test('status texts render placeholders and refresh when they have some', () => {
  const p = parsePresence({ activity: { type: 'watching', name: '{bot.members} members' }, customStatus: 'on {bot.servers} servers' });
  const render = (s: string) => s.replace('{bot.members}', '1234').replace('{bot.servers}', '5');
  assert.equal(buildPresence(p, 0, render).activities?.[0]?.name, '1234 members');
  assert.equal((buildPresence({ ...p, show: 'custom' }, 0, render).activities?.[0] as { state?: string }).state, 'on 5 servers');
  assert.equal(hasPlaceholders(p), true);
  assert.equal(hasPlaceholders(parsePresence({ activity: { type: 'playing', name: 'chess' } })), false);
  // A placeholder that renders empty drops the activity instead of sending an empty name.
  assert.equal(buildPresence(parsePresence({ activity: { type: 'playing', name: '{x}' } }), 0, () => '').activities?.length, 0);
});
