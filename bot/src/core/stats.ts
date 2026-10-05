// Usage numbers of the bot overview (migration 0031): counted in memory and
// written once a minute in one transaction, so a busy server costs no write
// per message. Hour buckets in UTC; data older than 35 days is dropped.

import { write, type Db } from './db.js';
import { log } from './log.js';

const KEEP_DAYS = 35;
/** Paths of the member modules ("path:…", Stats module) are kept longer: 90 days are shown. */
const KEEP_PATH_DAYS = 95;

export const hourOf = (t = Date.now()): string => new Date(t).toISOString().slice(0, 13);

export class StatsCollector {
  private counts = new Map<string, number>();
  private users = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private lastPurge = 0;

  constructor(private readonly db: Db) {}

  start(): void {
    this.timer ??= setInterval(() => this.flush(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }

  /** Adds to a metric of a server (top lists: "cmd:<name>", "plugin:<id>", "mod:<action>"). */
  add(botId: number, guildId: string | null | undefined, metric: string, n = 1, t = Date.now()): void {
    if (!guildId || !n) return;
    const key = `${botId}|${guildId}|${hourOf(t)}|${metric.slice(0, 120)}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  /** A member was active (message, command, voice) in this hour. */
  active(botId: number, guildId: string | null | undefined, userId: string, t = Date.now()): void {
    if (guildId) this.users.add(`${botId}|${guildId}|${hourOf(t)}|${userId}`);
  }

  flush(now = Date.now()): void {
    if (!this.counts.size && !this.users.size) return;
    const counts = this.counts;
    const users = this.users;
    this.counts = new Map();
    this.users = new Set();
    try {
      const add = this.db.prepare(
        'INSERT INTO bot_stats (bot_id, guild_id, hour, metric, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = value + excluded.value',
      );
      const seen = this.db.prepare('INSERT OR IGNORE INTO bot_stat_users (bot_id, guild_id, hour, user_id) VALUES (?, ?, ?, ?)');
      write(this.db, () => {
        for (const [key, n] of counts) {
          const [bot, guild, hour, metric] = key.split('|');
          add.run(Number(bot), guild!, hour!, metric!, n);
        }
        for (const key of users) {
          const [bot, guild, hour, user] = key.split('|');
          seen.run(Number(bot), guild!, hour!, user!);
        }
        if (now - this.lastPurge > 3_600_000) {
          const cut = hourOf(now - KEEP_DAYS * 86_400_000);
          this.db.prepare("DELETE FROM bot_stats WHERE hour < ? AND metric NOT LIKE 'path:%'").run(cut);
          this.db.prepare('DELETE FROM bot_stats WHERE hour < ?').run(hourOf(now - KEEP_PATH_DAYS * 86_400_000));
          this.db.prepare('DELETE FROM bot_stat_users WHERE hour < ?').run(cut);
          this.lastPurge = now;
        }
      });
    } catch (err) {
      // A deleted bot (foreign key) or a busy database: these numbers are lost, the bot goes on.
      log.warn('stats flush failed', { err: String(err) });
    }
  }
}

const collectors = new WeakMap<Db, StatsCollector>();

/** The collector of a database (one per process). */
export function stats(db: Db): StatsCollector {
  let c = collectors.get(db);
  if (!c) {
    c = new StatsCollector(db);
    collectors.set(db, c);
    c.start();
  }
  return c;
}
