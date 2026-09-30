import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_STOP_KEY, cpuPercent, HEARTBEAT_KEY, markCleanStop, startHeartbeat, startKind, STARTS_KEY, type HeartbeatStore } from './heartbeat.js';

function memoryStore(): HeartbeatStore & { kv: Map<string, string>; lists: Map<string, string[]> } {
  const kv = new Map<string, string>();
  const lists = new Map<string, string[]>();
  return {
    kv,
    lists,
    setJson: async (key, value) => void kv.set(key, JSON.stringify(value)),
    pushCapped: async (key, value) => void lists.set(key, [...(lists.get(key) ?? []), value]),
    take: async (key) => {
      const v = kv.get(key) ?? null;
      kv.delete(key);
      return v;
    },
    listLength: async (key) => lists.get(key)?.length ?? 0,
    set: async (key, value) => void kv.set(key, value),
  };
}

test('start kind: first start and after a graceful stop are clean, otherwise a crash', async () => {
  const s = memoryStore();
  assert.equal(await startKind(s), 'clean', 'first start');
  s.lists.set(STARTS_KEY, ['x|clean']);
  assert.equal(await startKind(s), 'crash');
  await markCleanStop(s);
  assert.equal(await startKind(s), 'clean');
  assert.equal(s.kv.has(CLEAN_STOP_KEY), false, 'the marker is used once');
});

test('cpu percent of one core between two samples', () => {
  assert.equal(cpuPercent({ user: 0, system: 0 }, { user: 150_000, system: 50_000 }, 1000), 20);
  assert.equal(cpuPercent({ user: 0, system: 0 }, { user: 1, system: 0 }, 0), 0);
});

test('heartbeat writes the process key with a TTL and records the start', async () => {
  const sets: { key: string; value: unknown; ttl: number }[] = [];
  const pushes: string[] = [];
  const stop = startHeartbeat(
    {
      ...memoryStore(),
      setJson: async (key, value, ttl) => void sets.push({ key, value, ttl }),
      pushCapped: async (key) => void pushes.push(key),
    },
    () => 2,
    (err) => assert.fail(String(err)),
  );
  stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushes, [STARTS_KEY]);
  assert.equal(sets[0]?.key, HEARTBEAT_KEY);
  assert.equal(sets[0]?.ttl, 30);
  assert.equal((sets[0]?.value as { bots: number; pid: number }).bots, 2);
  assert.equal((sets[0]?.value as { pid: number }).pid, process.pid);
});
