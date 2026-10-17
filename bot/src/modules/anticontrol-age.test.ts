import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageUnbanAt } from './anticontrol.js';

const h = 3_600_000;
const d = 24 * h;

test('too new accounts: unban when old enough, a duration never earlier, at least one hour', () => {
  const now = 1_000 * d;
  assert.equal(ageUnbanAt(now, now - 1 * d, 7, 0), now + 6 * d); // until old enough
  assert.equal(ageUnbanAt(now, now - 1 * d, 7, 24), now + 6 * d); // 24 h is earlier than eligible
  assert.equal(ageUnbanAt(now, now - 1 * d, 7, 10 * 24), now + 10 * d); // duration is later
  assert.equal(ageUnbanAt(now, now - 7 * d + 60_000, 7, 0), now + h); // at least one hour
});
