import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDue, localTime, nextRun, type TimedEvent } from './timed.js';

const at = (iso: string) => Date.parse(iso);
const ev = (e: Partial<TimedEvent>): TimedEvent => ({ id: 1, name: 't', kind: 'interval', intervalSeconds: 30, times: [], weekdays: [], lastRunAt: null, ...e });

test('local time in a time zone', () => {
  assert.deepEqual(localTime(at('2026-09-30T06:30:05Z'), 'Europe/Berlin'), { weekday: 3, hms: '08:30:05', date: '2026-09-30' });
  assert.equal(localTime(at('2026-09-30T23:30:00Z'), 'Asia/Tokyo').weekday, 4);
});

test('interval: counts from last run, else from bot start', () => {
  const start = at('2026-09-30T10:00:00Z');
  assert.equal(isDue(ev({}), start, start + 29_000, start, 'UTC'), false);
  assert.equal(isDue(ev({}), start, start + 30_000, start, 'UTC'), true);
  assert.equal(isDue(ev({ lastRunAt: start + 20_000 }), start, start + 40_000, start, 'UTC'), false);
  assert.equal(isDue(ev({ lastRunAt: start + 20_000 }), start, start + 50_000, start, 'UTC'), true);
  // Weekday filter: 2026-09-30 is a Wednesday (3).
  assert.equal(isDue(ev({ weekdays: [1] }), start, start + 30_000, start, 'UTC'), false);
  assert.equal(isDue(ev({ intervalSeconds: 5 }), start, start + 60_000, start, 'UTC'), false);
});

test('schedule: fires once when the time is crossed, in the bot time zone', () => {
  const e = ev({ kind: 'schedule', intervalSeconds: null, times: ['08:30:00'] });
  const t = at('2026-09-30T06:30:00Z'); // 08:30 in Berlin
  assert.equal(isDue(e, t - 1000, t, 0, 'Europe/Berlin'), true);
  assert.equal(isDue(e, t, t + 1000, 0, 'Europe/Berlin'), false);
  assert.equal(isDue(e, t - 1000, t, 0, 'UTC'), false);
  // A missed tick (event loop busy for 3 s) still fires.
  assert.equal(isDue(e, t - 2000, t + 1000, 0, 'Europe/Berlin'), true);
  assert.equal(isDue({ ...e, weekdays: [0, 6] }, t - 1000, t, 0, 'Europe/Berlin'), false);
});

test('next run for {schedule.next}', () => {
  const now = at('2026-09-30T10:00:00Z'); // Wednesday, 12:00 in Berlin
  const s = ev({ kind: 'schedule', intervalSeconds: null, times: ['20:30:00', '08:00:00'] });
  assert.equal(nextRun(s, now, 'Europe/Berlin'), '2026-09-30 20:30:00');
  assert.equal(nextRun({ ...s, times: ['08:00:00'] }, now, 'Europe/Berlin'), '2026-10-01 08:00:00');
  assert.equal(nextRun({ ...s, times: ['08:00:00'], weekdays: [1] }, now, 'Europe/Berlin'), '2026-10-05 08:00:00');
  assert.equal(nextRun(ev({ intervalSeconds: 90 }), now, 'UTC'), '2026-09-30 10:01:30');
});
