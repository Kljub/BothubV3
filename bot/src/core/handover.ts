// Updates without offline bots (deploy/update.sh). While the bot service is
// rebuilt, a second BotCore from the new image ("handover" role) runs the
// same bots. Both receive every Discord event; while the update script's
// flag bothub:overlap is set, an event is handled only by the core that
// claims it first in Redis (SET NX), so nothing runs twice and nothing is
// lost. Timers (timed events, module ticks, plugin tasks) run only on the
// core that holds bothub:leader. With a single core nothing of this costs
// anything: no flag, no claims, and the core is the leader.

import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { log } from './log.js';

export const ROLE: 'main' | 'handover' = process.env.BOTHUB_CORE_ROLE === 'handover' ? 'handover' : 'main';
export const OVERLAP_KEY = 'bothub:overlap';
export const LEADER_KEY = 'bothub:leader';
export const readyKey = (role: string) => `bothub:core:ready:${role}`;
const CLAIM_TTL_S = 120;
const LEADER_TTL_MS = 15_000;

/** Events that only fill caches or describe the connection: every core handles them itself. */
const LOCAL = new Set(['ready', 'clientReady', 'debug', 'warn', 'error', 'raw', 'invalidated', 'cacheSweep', 'shardReady', 'shardResume', 'shardDisconnect', 'shardReconnecting', 'shardError', 'inviteCreate', 'inviteDelete', 'guildAvailable', 'guildUnavailable']);

/**
 * The same key for the same Discord event on every core: the event name and
 * the new state of what it is about (for *Update events the old state is
 * left out: one core may have it cached, the other not). null: not claimed.
 */
export function claimKey(event: string, args: unknown[]): string | null {
  if (LOCAL.has(event)) return null;
  const first = args[0] as { id?: string } | undefined;
  if (event === 'interactionCreate' || event === 'messageCreate' || event === 'messageDelete') return first?.id ? `${event}:${first.id}` : null;
  const parts = (event.endsWith('Update') ? args.slice(1) : args).map((a) => {
    if (a === null || a === undefined) return null;
    if (typeof a !== 'object') return a;
    try {
      const j = (a as { toJSON?: () => unknown }).toJSON?.();
      return j ?? (a as { id?: string }).id ?? null;
    } catch {
      return (a as { id?: string }).id ?? null;
    }
  });
  let json: string;
  try {
    json = JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return null;
  }
  return `${event}:${createHash('sha1').update(json).digest('hex')}`;
}

type Redis = ReturnType<typeof createClient>;

class Handover {
  /** The update script's flag: two cores run. Refreshed every second. */
  overlap = false;
  private leader = true;
  private redis: Redis | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly id = `${ROLE}:${process.pid}:${Date.now()}`;

  async start(url: string): Promise<void> {
    const r = createClient({ url });
    r.on('error', () => undefined); // no Redis: one core, no claims (logged by the stream consumer)
    try {
      await r.connect();
    } catch (err) {
      log.warn('handover: no Redis, running alone', { err: String(err) });
      return;
    }
    this.redis = r;
    const poll = async () => {
      try {
        this.overlap = (await r.exists(OVERLAP_KEY)) === 1;
        // Leader: take the lock when free, keep it while holding it.
        const holder = await r.get(LEADER_KEY);
        if (!holder || holder === this.id) {
          await r.set(LEADER_KEY, this.id, { PX: LEADER_TTL_MS });
          this.leader = true;
        } else this.leader = false;
      } catch {
        this.overlap = false;
        this.leader = true;
      }
    };
    await poll();
    this.timers.push(setInterval(() => void poll(), 1000));
    for (const t of this.timers) t.unref();
  }

  /** Runs timers (timed events, module ticks, plugin tasks)? */
  isLeader(): boolean {
    return this.leader;
  }

  /** True when this core handles the event (always, unless two cores run). */
  async claim(botId: number, key: string): Promise<boolean> {
    if (!this.overlap || !this.redis) return true;
    try {
      return (await this.redis.set(`bothub:claim:${botId}:${key}`, this.id, { NX: true, EX: CLAIM_TTL_S })) === 'OK';
    } catch {
      return true; // Redis gone: better twice than never
    }
  }

  /** "This core runs all its bots" (the update script waits for it). */
  async markReady(): Promise<void> {
    const r = this.redis;
    if (!r) return;
    const write = () => r.set(readyKey(ROLE), String(Date.now()), { EX: 30 }).catch(() => undefined);
    await write();
    const t = setInterval(() => void write(), 10_000);
    t.unref();
    this.timers.push(t);
  }

  /** Shutdown: no longer ready, leader lock freed for the other core. */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const r = this.redis;
    if (!r) return;
    try {
      await r.del(readyKey(ROLE));
      if ((await r.get(LEADER_KEY)) === this.id) await r.del(LEADER_KEY);
      await r.quit();
    } catch {
      // gone anyway
    }
    this.redis = null;
  }
}

export const handover = new Handover();

/**
 * Discord events of a client go through the claim while two cores run:
 * the client emits as usual, but a claimed-elsewhere event never reaches
 * the listeners.
 */
export function claimEvents(client: { emit: (event: string, ...args: unknown[]) => boolean }, botId: number): void {
  const emit = client.emit.bind(client);
  client.emit = (event: string, ...args: unknown[]) => {
    if (!handover.overlap) return emit(event, ...args);
    const key = claimKey(event, args);
    if (!key) return emit(event, ...args);
    void handover.claim(botId, key).then((mine) => {
      if (mine) emit(event, ...args);
    });
    return true;
  };
}
