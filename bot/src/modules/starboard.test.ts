import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardsFor } from './games.js';

const ch = (id: string) => ({ id, guild: 'g' });
const star = (e: string) => e === '⭐';

test('extra boards come first, the main board last; restrictions and age filter them', () => {
  const cfg = {
    emoji: ['⭐'], required: 5, channel: ch('main'), color: '', channelMode: 'all', channels: [],
    boards: [
      { name: 'staff', emoji: ['⭐'], required: 2, channel: ch('staffboard'), color: '', channelMode: 'only', channels: [ch('staffcat')] },
      { name: 'old', emoji: ['⭐'], required: 1, channel: ch('oldboard'), color: '', channelMode: 'all', channels: [], minAgeHours: 24 * 30 },
      { name: 'off', enabled: false, emoji: ['⭐'], required: 1, channel: ch('offboard'), color: '', channelMode: 'all', channels: [] },
      { name: 'fire', emoji: ['🔥'], required: 1, channel: ch('fireboard'), color: '', channelMode: 'all', channels: [] },
    ],
  };
  assert.deepEqual(boardsFor(cfg, 'g', star, ['chat'], 1).map((b) => b.channelId), ['main']);
  assert.deepEqual(boardsFor(cfg, 'g', star, ['t', 'staffcat'], 1).map((b) => b.channelId), ['staffboard', 'main']);
  assert.deepEqual(boardsFor(cfg, 'g', star, ['chat'], 24 * 40).map((b) => b.channelId), ['oldboard', 'main']);
  // A message in a board channel never goes to that board.
  assert.deepEqual(boardsFor(cfg, 'g', star, ['main'], 1).map((b) => b.channelId), []);
  // maxAgeDays on the main board.
  assert.deepEqual(boardsFor({ ...cfg, boards: [], maxAgeDays: 7 }, 'g', star, ['chat'], 24 * 8), []);
});
