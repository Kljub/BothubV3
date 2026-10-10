// Live updates for the dashboard: the bot publishes small notes on the Redis
// channel bothub:live (status of a bot changed); the dashboard forwards them
// to open browser tabs (Server-Sent Events), which reload the changed parts.
// Best effort: without Redis nothing is sent and the dashboard polls.

import { createClient } from 'redis';
import { log } from './log.js';

export const LIVE_CHANNEL = 'bothub:live';

export type LiveNote = { type: 'bot.status'; botId: number; status: string } | { type: 'plugin.tasks'; botId: number };

/** Task manager rows of a bot (JSON {at, tasks}), refreshed every 5 s. */
export const tasksKey = (botId: number) => `bothub:plugin-tasks:${botId}`;
const TASKS_TTL_SECONDS = 20;

type Redis = ReturnType<typeof createClient>;
let redis: Redis | null = null;

export async function startLive(url: string): Promise<void> {
  const r = createClient({ url });
  r.on('error', () => undefined); // logged by the stream consumer
  try {
    await r.connect();
    redis = r;
  } catch (err) {
    log.warn('live updates off: no Redis', { err: String(err) });
  }
}

export function publishLive(note: LiveNote): void {
  if (!redis?.isReady) return;
  redis.publish(LIVE_CHANNEL, JSON.stringify(note)).catch(() => undefined);
}

/** Writes the task manager rows of a bot (read by the API). */
export function writeTasks(botId: number, tasks: unknown[]): void {
  if (!redis?.isReady) return;
  redis.set(tasksKey(botId), JSON.stringify({ at: new Date().toISOString(), tasks }), { EX: TASKS_TTL_SECONDS }).catch(() => undefined);
}

/**
 * Every 5 s: the task manager rows of every bot with plugins; a change of a
 * state or process (not just memory/CPU) is also announced live.
 */
export function startTaskReports(source: { botsWithTasks(): number[]; tasks(botId: number): { pluginId: string; state: string; pid: number | null }[] }): () => void {
  const last = new Map<number, string>();
  const tick = () => {
    const seen = new Set<number>();
    for (const botId of source.botsWithTasks()) {
      seen.add(botId);
      const tasks = source.tasks(botId);
      writeTasks(botId, tasks);
      const sig = tasks.map((t) => `${t.pluginId}:${t.state}:${t.pid}`).join('|');
      if (last.has(botId) && last.get(botId) !== sig) publishLive({ type: 'plugin.tasks', botId });
      last.set(botId, sig);
    }
    for (const botId of [...last.keys()]) {
      if (seen.has(botId)) continue;
      last.delete(botId);
      writeTasks(botId, []);
      publishLive({ type: 'plugin.tasks', botId });
    }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  reportNow = tick;
  return () => {
    clearInterval(timer);
    reportNow = () => undefined;
  };
}

let reportNow: () => void = () => undefined;

/** After an end task/restart or a plugin switch: report at once, not in up to 5 s. */
export function reportTasksNow(): void {
  reportNow();
}

export async function stopLive(): Promise<void> {
  const r = redis;
  redis = null;
  await r?.quit().catch(() => undefined);
}
