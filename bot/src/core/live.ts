// Live updates for the dashboard: the bot publishes small notes on the Redis
// channel bothub:live (status of a bot changed); the dashboard forwards them
// to open browser tabs (Server-Sent Events), which reload the changed parts.
// Best effort: without Redis nothing is sent and the dashboard polls.

import { createClient } from 'redis';
import { log } from './log.js';

export const LIVE_CHANNEL = 'bothub:live';

export interface LiveNote {
  type: 'bot.status';
  botId: number;
  status: string;
}

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

export async function stopLive(): Promise<void> {
  const r = redis;
  redis = null;
  await r?.quit().catch(() => undefined);
}
