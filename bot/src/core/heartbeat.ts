// Process heartbeat for the resource overview (admin → Overview, row
// "BotCore"). Every 10 s the process writes its PID, CPU, memory and start
// time to Redis with a 30 s TTL; a missing key means the process is down.
// Each start is appended to a short list as "<time>|clean" or "<time>|crash":
// a graceful shutdown (restart button, deploy, docker stop) leaves a marker,
// so only starts after a crash count as unstable restarts.

import { createClient } from 'redis';

export const HEARTBEAT_KEY = 'bothub:process:botcore';
export const STARTS_KEY = 'bothub:process:botcore:starts';
export const CLEAN_STOP_KEY = 'bothub:process:botcore:clean-stop';
const INTERVAL_MS = 10_000;
const TTL_SECONDS = 30;

export interface Heartbeat {
  pid: number;
  cpuPercent: number;
  memoryBytes: number;
  startedAt: string;
  bots: number;
}

export interface HeartbeatStore {
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  pushCapped(key: string, value: string, keep: number): Promise<void>;
  /** Reads and deletes a key (GETDEL). */
  take(key: string): Promise<string | null>;
  listLength(key: string): Promise<number>;
  set(key: string, value: string): Promise<void>;
}

/**
 * Own Redis connection: the stream consumer blocks its connection with
 * XREADGROUP BLOCK, so heartbeat writes on it would wait behind that.
 */
export async function redisHeartbeatStore(url: string, onError: (err: unknown) => void): Promise<HeartbeatStore & { close(): Promise<void> }> {
  const client = createClient({ url });
  client.on('error', onError);
  await client.connect();
  return {
    setJson: async (key, value, ttl) => void (await client.set(key, JSON.stringify(value), { EX: ttl })),
    pushCapped: async (key, value, keep) => {
      await client.rPush(key, value);
      await client.lTrim(key, -keep, -1);
    },
    take: async (key) => (await client.getDel(key)) as string | null,
    listLength: async (key) => Number(await client.lLen(key)),
    set: async (key, value) => void (await client.set(key, value)),
    close: async () => void (await client.quit().catch(() => undefined)),
  };
}

/** How this start came about: after a graceful stop, the very first start, or a crash. */
export async function startKind(store: HeartbeatStore): Promise<'clean' | 'crash'> {
  const cleanStop = (await store.take(CLEAN_STOP_KEY)) !== null;
  const firstStart = (await store.listLength(STARTS_KEY)) === 0;
  return cleanStop || firstStart ? 'clean' : 'crash';
}

/** Called on a graceful shutdown: the next start is not a crash. */
export function markCleanStop(store: HeartbeatStore): Promise<void> {
  return store.set(CLEAN_STOP_KEY, new Date().toISOString());
}

/** CPU of this process in % of one core between two samples. */
export function cpuPercent(prev: NodeJS.CpuUsage, now: NodeJS.CpuUsage, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  const usedMicros = now.user - prev.user + (now.system - prev.system);
  return Math.max(0, Math.round((usedMicros / 1000 / elapsedMs) * 1000) / 10);
}

export function startHeartbeat(store: HeartbeatStore, runningBots: () => number, onError: (err: unknown) => void): () => void {
  const startedAt = new Date().toISOString();
  let prevCpu = process.cpuUsage();
  let prevAt = Date.now();
  const beat = () => {
    const cpu = process.cpuUsage();
    const at = Date.now();
    const hb: Heartbeat = {
      pid: process.pid,
      cpuPercent: cpuPercent(prevCpu, cpu, at - prevAt),
      memoryBytes: process.memoryUsage().rss,
      startedAt,
      bots: runningBots(),
    };
    prevCpu = cpu;
    prevAt = at;
    store.setJson(HEARTBEAT_KEY, hb, TTL_SECONDS).catch(onError);
  };
  startKind(store)
    .then((kind) => store.pushCapped(STARTS_KEY, `${startedAt}|${kind}`, 50))
    .catch(onError);
  beat();
  const timer = setInterval(beat, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
