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

/** Days the bot.* usage variables look back (the overview keeps 35). */
const VAR_DAYS = 30;

/**
 * Usage variables from the bot overview (last 30 days; this server, or all
 * servers in runs without one):
 *   {bot.active_users}         top 10 active members, one per line ("1. <@id> · 12 h")
 *   {bot.active_users.1} …     the n-th of them as mention (.1.id: the ID, .1.hours)
 *   {bot.active_users.length}  how many are in the list (max 10)
 *   {bot.active_users.count}   all members that were active
 *   {bot.total_voice_minutes}  minutes spent in voice channels
 *   {bot.commands_usage}       commands used (.top: the most used, one per line)
 *   {bot.plugin_usage}         plugin uses (.top: the most used plugins)
 * Names are case-insensitive ({bot.Active_Users} works too). Unknown: undefined.
 */
export function usageVar(db: Db, botId: number, guildId: string | null, name: string, now = Date.now()): string | undefined {
  const n = name.toLowerCase();
  if (!n.startsWith('bot.')) return undefined;
  const key = n.slice(4);
  const since = hourOf(now - VAR_DAYS * 86_400_000);
  const where = `bot_id = ? AND hour >= ?${guildId ? ' AND guild_id = ?' : ''}`;
  const args: (string | number)[] = guildId ? [botId, since, guildId] : [botId, since];
  const sum = (metric: string): string => {
    const r = db.prepare(`SELECT COALESCE(SUM(value), 0) AS v FROM bot_stats WHERE ${where} AND metric = ?`).get(...args, metric) as { v: number };
    return String(r.v);
  };
  const top = (prefix: string): string => {
    const rows = db.prepare(`SELECT substr(metric, ?) AS name, SUM(value) AS v FROM bot_stats WHERE ${where} AND metric LIKE ? GROUP BY metric ORDER BY v DESC LIMIT 10`).all(prefix.length + 1, ...args, `${prefix}%`) as { name: string; v: number }[];
    return rows.map((r, i) => `${i + 1}. ${prefix === 'cmd:' ? '/' : ''}${r.name} · ${r.v}`).join('\n');
  };
  if (key === 'total_voice_minutes') return sum('voice_minutes');
  if (key === 'commands_usage') return sum('commands');
  if (key === 'commands_usage.top') return top('cmd:');
  if (key === 'plugin_usage') return sum('plugin_uses');
  if (key === 'plugin_usage.top') return top('plugin:');
  if (!key.startsWith('active_users')) return undefined;
  if (key === 'active_users.count') {
    const r = db.prepare(`SELECT COUNT(DISTINCT user_id) AS v FROM bot_stat_users WHERE ${where}`).get(...args) as { v: number };
    return String(r.v);
  }
  const users = db.prepare(`SELECT user_id AS id, COUNT(*) AS hours FROM bot_stat_users WHERE ${where} GROUP BY user_id ORDER BY hours DESC, user_id LIMIT 10`).all(...args) as { id: string; hours: number }[];
  if (key === 'active_users') return users.map((u, i) => `${i + 1}. <@${u.id}> · ${u.hours} h`).join('\n');
  if (key === 'active_users.length') return String(users.length);
  const m = /^active_users\.(\d{1,2})(\.id|\.hours)?$/.exec(key);
  if (!m) return undefined;
  const u = users[Number(m[1]) - 1];
  if (!u) return '';
  return m[2] === '.id' ? u.id : m[2] === '.hours' ? String(u.hours) : `<@${u.id}>`;
}
