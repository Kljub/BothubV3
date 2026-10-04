// All SQL of the bot. JSON columns are parsed here and nowhere else
// (plan.md). The bot writes runtime data only: status, guild cache, logs,
// variables, cooldowns and module data.

import type { Db } from './db.js';
import { stats } from './stats.js';
import { now, write } from './db.js';
import type { Graph } from '../graph/types.js';
import { isGraph } from '../graph/types.js';
import type { VarStore } from '../graph/handlers-core.js';
import type { TimedEvent } from './timed.js';

export interface BotRow {
  id: number;
  name: string;
  applicationId: string | null;
  autostart: boolean;
  tokenEnc: Uint8Array | null;
}

export interface CommandRow {
  id: number;
  kind: 'command' | 'event' | 'timed';
  name: string;
  description: string;
  builtin: boolean;
  moduleKey: string | null;
  eventType: string | null;
  graph: Graph;
}

export type BotStatus = 'running' | 'stopped' | 'starting' | 'error';

export type CaseAction =
  | 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban' | 'role_add' | 'role_remove'
  | 'voice_mute' | 'voice_unmute' | 'voice_deafen' | 'voice_undeafen' | 'voice_kick';

export interface ModCase {
  number: number;
  guildId: string;
  userId: string;
  moderatorId: string | null;
  action: CaseAction;
  reason: string;
  duration: string;
  auto: boolean;
  createdAt: string;
}

type Row = Record<string, unknown>;

export class Repo {
  constructor(readonly db: Db) {}

  // ---------- bots ----------

  bots(): BotRow[] {
    return (this.db.prepare('SELECT id, name, application_id, autostart, token_enc FROM bots ORDER BY id').all() as Row[]).map(botRow);
  }

  bot(id: number): BotRow | undefined {
    const row = this.db.prepare('SELECT id, name, application_id, autostart, token_enc FROM bots WHERE id = ?').get(id) as Row | undefined;
    return row ? botRow(row) : undefined;
  }

  setBotStatus(id: number, status: BotStatus, errorKey: string | null = null): void {
    // started_at: set when the bot goes online, cleared when it is not running (uptime on the overview).
    this.db
      .prepare(
        `UPDATE bots SET status = ?, status_error_key = ?, updated_at = ?,
           started_at = CASE WHEN ? = 'running' THEN COALESCE(CASE WHEN status = 'running' THEN started_at END, ?) ELSE NULL END
         WHERE id = ?`,
      )
      .run(status, errorKey, now(), status, now(), id);
  }

  /** Name, avatar and application ID as Discord reports them after login. */
  setBotIdentity(id: number, name: string, applicationId: string, avatarUrl: string | null): void {
    this.db.prepare('UPDATE bots SET name = ?, application_id = ?, avatar_url = ?, updated_at = ? WHERE id = ?').run(name, applicationId, avatarUrl, now(), id);
  }

  /** Replaces the guild cache: listed guilds are in, all others are left. */
  syncGuilds(botId: number, guilds: { id: string; name: string; iconUrl: string | null; memberCount: number }[]): void {
    write(this.db, () => {
      const t = now();
      const upsert = this.db.prepare(
        `INSERT INTO bot_guilds (bot_id, guild_id, name, icon_url, member_count, joined_at, left_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (bot_id, guild_id) DO UPDATE SET name = excluded.name, icon_url = excluded.icon_url,
           member_count = excluded.member_count, left_at = NULL, updated_at = excluded.updated_at`,
      );
      for (const g of guilds) upsert.run(botId, g.id, g.name, g.iconUrl, g.memberCount, t, t);
      const ids = JSON.stringify(guilds.map((g) => g.id));
      this.db
        .prepare('UPDATE bot_guilds SET left_at = ?, updated_at = ? WHERE bot_id = ? AND left_at IS NULL AND guild_id NOT IN (SELECT value FROM json_each(?))')
        .run(t, t, botId, ids);
    });
  }

  /** Closed invites (migration 0026): null while open, else the servers the bot may stay on. */
  guildAccess(botId: number): ReadonlySet<string> | null {
    const row = this.db.prepare('SELECT invites_closed FROM bots WHERE id = ?').get(botId) as { invites_closed: number } | undefined;
    if (!row || row.invites_closed !== 1) return null;
    const rows = this.db.prepare('SELECT guild_id FROM bot_allowed_guilds WHERE bot_id = ?').all(botId) as { guild_id: string }[];
    return new Set(rows.map((r) => r.guild_id));
  }

  guildLeft(botId: number, guildId: string): void {
    this.db.prepare('UPDATE bot_guilds SET left_at = ?, updated_at = ? WHERE bot_id = ? AND guild_id = ?').run(now(), now(), botId, guildId);
  }

  // ---------- commands ----------

  /** Enabled, not deleted commands of one kind. Broken graphs are skipped. */
  commands(botId: number, kind: CommandRow['kind']): CommandRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, name, description, builtin, module_key, event_type, graph FROM commands
         WHERE bot_id = ? AND kind = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY id`,
      )
      .all(botId, kind) as Row[];
    const out: CommandRow[] = [];
    for (const r of rows) {
      const graph = parseJson(r.graph);
      if (!isGraph(graph)) continue;
      out.push({
        id: Number(r.id),
        kind: r.kind as CommandRow['kind'],
        name: String(r.name),
        description: String(r.description),
        builtin: r.builtin === 1,
        moduleKey: (r.module_key as string | null) ?? null,
        eventType: (r.event_type as string | null) ?? null,
        graph,
      });
    }
    return out;
  }

  /** Module keys switched off for a bot (default is on). */
  /** Switched on explicitly (a row with enabled = 1), like the dashboard shows it. */
  moduleOn(botId: number, key: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM bot_modules WHERE bot_id = ? AND module_key = ?').get(botId, key) as Row | undefined;
    return row !== undefined && Number(row.enabled) === 1;
  }

  disabledModules(botId: number): Set<string> {
    const rows = this.db.prepare('SELECT module_key FROM bot_modules WHERE bot_id = ? AND enabled = 0').all(botId) as Row[];
    return new Set(rows.map((r) => String(r.module_key)));
  }

  cooldownUntil(commandId: number, scopeKey: string): number {
    const row = this.db.prepare('SELECT until FROM command_cooldowns WHERE command_id = ? AND scope_key = ?').get(commandId, scopeKey) as Row | undefined;
    return row ? Date.parse(String(row.until)) : 0;
  }

  setCooldown(commandId: number, scopeKey: string, until: Date): void {
    this.db
      .prepare('INSERT INTO command_cooldowns (command_id, scope_key, until) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET until = excluded.until')
      .run(commandId, scopeKey, until.toISOString());
  }

  // ---------- timed events ----------

  /** Enabled timed events of a bot (table timed_events). */
  timedEvents(botId: number): TimedEvent[] {
    const rows = this.db.prepare('SELECT id, name, kind, interval_seconds, times, weekdays, last_run_at FROM timed_events WHERE bot_id = ? AND enabled = 1 ORDER BY id').all(botId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      kind: r.kind === 'schedule' ? 'schedule' : 'interval',
      intervalSeconds: r.interval_seconds === null ? null : Number(r.interval_seconds),
      times: stringList(parseJson(r.times)),
      weekdays: stringList(parseJson(r.weekdays)).map(Number).filter((d) => d >= 0 && d <= 6),
      lastRunAt: r.last_run_at ? Date.parse(String(r.last_run_at)) : null,
    }));
  }

  setTimedLastRun(id: number, at: Date): void {
    this.db.prepare('UPDATE timed_events SET last_run_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  /** Time zone ('' = process TZ) and default server of a bot. */
  timeSettings(botId: number): { timezone: string; defaultGuildId: string | null } {
    const r = this.db.prepare('SELECT timezone, default_guild_id FROM bots WHERE id = ?').get(botId) as Row | undefined;
    return { timezone: String(r?.timezone ?? ''), defaultGuildId: (r?.default_guild_id as string | null) ?? null };
  }

  /** bot_profiles.presence (JSON), undefined without a row. */
  presence(botId: number): unknown {
    const row = this.db.prepare('SELECT presence FROM bot_profiles WHERE bot_id = ?').get(botId) as Row | undefined;
    return row ? parseJson(row.presence) : undefined;
  }

  clearCooldown(commandId: number, scopeKey: string): void {
    this.db.prepare('DELETE FROM command_cooldowns WHERE command_id = ? AND scope_key = ?').run(commandId, scopeKey);
  }

  // ---------- logs ----------

  /** Log entry with a code from shared/log-codes.json (ERR-* = error, WAR-* = warning). */
  logCode(botId: number | null, code: string, params: Record<string, unknown> = {}): void {
    const level = code.startsWith('WAR') ? 'warning' : 'error';
    this.db.prepare("INSERT INTO logs (bot_id, level, code, key, params, source) VALUES (?, ?, ?, '', ?, 'bot')").run(botId, level, code, JSON.stringify(params));
  }

  /** Update entry (i18n key log.update.*), e.g. bot started. */
  logUpdate(botId: number | null, key: string, params: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (?, 'update', ?, ?, 'bot')").run(botId, key, JSON.stringify(params));
  }

  // ---------- variables ----------

  varStore(botId: number): VarStore {
    return {
      get: (scope, scopeId, name) => {
        const row = this.db.prepare('SELECT value FROM variables WHERE bot_id = ? AND scope = ? AND scope_id = ? AND name = ?').get(botId, scope, scopeId, name) as Row | undefined;
        return row ? String(row.value) : undefined;
      },
      set: (scope, scopeId, name, value) => {
        this.db
          .prepare(
            `INSERT INTO variables (bot_id, scope, scope_id, name, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(botId, scope, scopeId, name, value, now());
      },
      delete: (scope, scopeId, name) => {
        this.db.prepare('DELETE FROM variables WHERE bot_id = ? AND scope = ? AND scope_id = ? AND name = ?').run(botId, scope, scopeId, name);
      },
    };
  }

  // ---------- moderation: warnings ----------

  addWarning(botId: number, guildId: string, userId: string, moderatorId: string | null, reason: string): number {
    const r = this.db.prepare('INSERT INTO warnings (bot_id, guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?, ?)').run(botId, guildId, userId, moderatorId, reason);
    return Number(r.lastInsertRowid);
  }

  warnings(botId: number, guildId: string, userId: string): { id: number; reason: string; moderatorId: string | null; createdAt: string }[] {
    return (this.db.prepare('SELECT id, reason, moderator_id, created_at FROM warnings WHERE bot_id = ? AND guild_id = ? AND user_id = ? ORDER BY id').all(botId, guildId, userId) as Row[]).map((r) => ({
      id: Number(r.id),
      reason: String(r.reason),
      moderatorId: (r.moderator_id as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  /** Also closes the warning cases, so automatic punishments count from 0 again. */
  clearWarnings(botId: number, guildId: string, userId: string): number {
    return write(this.db, () => {
      this.db.prepare("UPDATE mod_cases SET removed_at = ? WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND action = 'warn' AND removed_at IS NULL").run(now(), botId, guildId, userId);
      return Number(this.db.prepare('DELETE FROM warnings WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(botId, guildId, userId).changes);
    });
  }

  // ---------- modules ----------

  /** bot_modules.config of a module (parsed JSON), {} without a row. */
  moduleConfig(botId: number, key: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT config FROM bot_modules WHERE bot_id = ? AND module_key = ?').get(botId, key) as Row | undefined;
    const v = row ? parseJson(row.config) : undefined;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }

  // ---------- moderation: cases and notes ----------

  /** New case with the next number of the server. */
  addCase(botId: number, c: { guildId: string; userId: string; moderatorId: string | null; action: CaseAction; reason: string; duration: string; auto: boolean }): number {
    return write(this.db, () => {
      const row = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM mod_cases WHERE bot_id = ? AND guild_id = ?').get(botId, c.guildId) as Row;
      const n = Number(row.n);
      this.db
        .prepare('INSERT INTO mod_cases (bot_id, guild_id, number, user_id, moderator_id, action, reason, duration, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(botId, c.guildId, n, c.userId, c.moderatorId, c.action, c.reason.slice(0, 512), c.duration.slice(0, 20), c.auto ? 1 : 0);
      // Overview: automatic cases (AutoMod, honeypot …) apart from moderators' commands.
      stats(this.db).add(botId, c.guildId, c.auto ? 'mod_automod' : 'mod_commands');
      stats(this.db).add(botId, c.guildId, `mod:${c.action}`);
      return n;
    });
  }

  modCase(botId: number, guildId: string, number: number): ModCase | undefined {
    const r = this.db.prepare('SELECT * FROM mod_cases WHERE bot_id = ? AND guild_id = ? AND number = ? AND removed_at IS NULL').get(botId, guildId, number) as Row | undefined;
    return r ? caseRow(r) : undefined;
  }

  removeCase(botId: number, guildId: string, number: number): boolean {
    return this.db.prepare('UPDATE mod_cases SET removed_at = ? WHERE bot_id = ? AND guild_id = ? AND number = ? AND removed_at IS NULL').run(now(), botId, guildId, number).changes > 0;
  }

  /** Cases of a member, oldest first. */
  cases(botId: number, guildId: string, userId: string): ModCase[] {
    return (this.db.prepare('SELECT * FROM mod_cases WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY number').all(botId, guildId, userId) as Row[]).map(caseRow);
  }

  clearCases(botId: number, guildId: string, userId: string): number {
    return Number(this.db.prepare('UPDATE mod_cases SET removed_at = ? WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND removed_at IS NULL').run(now(), botId, guildId, userId).changes);
  }

  countCases(botId: number, guildId: string, userId: string, action: CaseAction): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM mod_cases WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND action = ? AND removed_at IS NULL').get(botId, guildId, userId, action) as Row;
    return Number(r.n);
  }

  addNote(botId: number, guildId: string, userId: string, authorId: string | null, content: string): number {
    const r = this.db.prepare('INSERT INTO mod_notes (bot_id, guild_id, user_id, author_id, content) VALUES (?, ?, ?, ?, ?)').run(botId, guildId, userId, authorId, content.slice(0, 1000));
    return Number(r.lastInsertRowid);
  }

  removeNote(botId: number, guildId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM mod_notes WHERE bot_id = ? AND guild_id = ? AND id = ?').run(botId, guildId, id).changes > 0;
  }

  notes(botId: number, guildId: string, userId: string): { id: number; authorId: string | null; content: string; createdAt: string }[] {
    return (this.db.prepare('SELECT id, author_id, content, created_at FROM mod_notes WHERE bot_id = ? AND guild_id = ? AND user_id = ? ORDER BY id').all(botId, guildId, userId) as Row[]).map((r) => ({
      id: Number(r.id),
      authorId: (r.author_id as string | null) ?? null,
      content: String(r.content),
      createdAt: String(r.created_at),
    }));
  }

  // ---------- scheduled jobs (undo after a set time) ----------

  addJob(botId: number, kind: string, runAt: Date, payload: Record<string, unknown>, key: string | null = null): number {
    const r = this.db.prepare('INSERT INTO scheduled_jobs (bot_id, kind, key, run_at, payload) VALUES (?, ?, ?, ?, ?)').run(botId, kind, key, runAt.toISOString(), JSON.stringify(payload));
    return Number(r.lastInsertRowid);
  }

  /** Open jobs of a bot that are due. */
  dueJobs(botId: number, kinds: string[], at: Date): { id: number; kind: string; payload: Record<string, unknown> }[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, payload FROM scheduled_jobs WHERE bot_id = ? AND done_at IS NULL AND cancelled_at IS NULL AND run_at <= ?
         AND kind IN (SELECT value FROM json_each(?)) ORDER BY run_at LIMIT 50`,
      )
      .all(botId, at.toISOString(), JSON.stringify(kinds)) as Row[];
    return rows.map((r) => {
      const p = parseJson(r.payload);
      return { id: Number(r.id), kind: String(r.kind), payload: p && typeof p === 'object' ? (p as Record<string, unknown>) : {} };
    });
  }

  finishJob(id: number, errorKey: string | null = null): void {
    this.db.prepare('UPDATE scheduled_jobs SET done_at = ?, error_key = ? WHERE id = ?').run(now(), errorKey, id);
  }

  /** Cancels open jobs with this key (Cancel Job block, unban before the temp ban ends). */
  cancelJobs(botId: number, key: string): number {
    return Number(this.db.prepare('UPDATE scheduled_jobs SET cancelled_at = ? WHERE bot_id = ? AND key = ? AND done_at IS NULL AND cancelled_at IS NULL').run(now(), botId, key).changes);
  }

  // ---------- economy (currencies of the module settings; the first is the default) ----------

  private defaultCurrency(botId: number): number {
    const row = this.db.prepare('SELECT id FROM economy_currencies WHERE bot_id = ? AND is_default = 1').get(botId) as Row | undefined;
    if (row) return Number(row.id);
    const r = this.db.prepare("INSERT INTO economy_currencies (bot_id, key, name, symbol, is_default) VALUES (?, 'coins', 'Coins', '🪙', 1)").run(botId);
    return Number(r.lastInsertRowid);
  }

  /** The currency by key (empty: the default); throws economy.unknown_currency. */
  currencyId(botId: number, key?: string | null): number {
    if (!key) return this.defaultCurrency(botId);
    const row = this.db.prepare('SELECT id FROM economy_currencies WHERE bot_id = ? AND key = ?').get(botId, key.toLowerCase()) as Row | undefined;
    if (!row) throw new Error('economy.unknown_currency');
    return Number(row.id);
  }

  /** Currencies of the settings into the table (by key; the first is the default). Balances of removed ones stay. */
  syncCurrencies(botId: number, list: { key: string; name: string; emoji: string }[]): void {
    const clean = list.filter((c) => /^[a-z0-9]{1,32}$/.test(c.key ?? '') && String(c.name ?? '').trim());
    if (!clean.length) return;
    write(this.db, () => {
      this.db.prepare('UPDATE economy_currencies SET is_default = 0 WHERE bot_id = ?').run(botId);
      const upsert = this.db.prepare(
        `INSERT INTO economy_currencies (bot_id, key, name, symbol, is_default) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, key) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, is_default = excluded.is_default`,
      );
      clean.forEach((c, i) => upsert.run(botId, c.key, c.name.trim().slice(0, 40), String(c.emoji ?? '').slice(0, 64), i === 0 ? 1 : 0));
    });
  }

  balance(botId: number, guildId: string, userId: string, currency?: string | null): number {
    const row = this.db
      .prepare('SELECT balance FROM economy_balances WHERE currency_id = ? AND guild_id = ? AND user_id = ?')
      .get(this.currencyId(botId, currency), guildId, userId) as Row | undefined;
    return row ? Number(row.balance) : 0;
  }

  /** Changes a balance; mode "add" adds (negative removes), "set" replaces. Never below 0. */
  changeBalance(botId: number, guildId: string, userId: string, amount: number, mode: 'add' | 'set', currency?: string | null): number {
    return write(this.db, () => {
      const id = this.currencyId(botId, currency);
      const current = this.balance(botId, guildId, userId, currency);
      const next = Math.max(0, Math.trunc(mode === 'set' ? amount : current + amount));
      this.db
        .prepare(
          `INSERT INTO economy_balances (currency_id, guild_id, user_id, balance, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
        )
        .run(id, guildId, userId, next, now());
      return next;
    });
  }

  /** Moves balance between two members in one transaction. */
  pay(botId: number, guildId: string, from: string, to: string, amount: number, currency?: string | null): boolean {
    return write(this.db, () => {
      const id = this.currencyId(botId, currency);
      const have = this.balance(botId, guildId, from, currency);
      if (amount <= 0 || have < amount) return false;
      const set = this.db.prepare(
        `INSERT INTO economy_balances (currency_id, guild_id, user_id, balance, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
      );
      set.run(id, guildId, from, have - amount, now());
      set.run(id, guildId, to, this.balance(botId, guildId, to, currency) + amount, now());
      return true;
    });
  }

  leaderboard(botId: number, guildId: string, limit: number, currency?: string | null): { userId: string; balance: number }[] {
    return (
      this.db
        .prepare('SELECT user_id, balance FROM economy_balances WHERE currency_id = ? AND guild_id = ? ORDER BY balance DESC LIMIT ?')
        .all(this.currencyId(botId, currency), guildId, limit) as Row[]
    ).map((r) => ({ userId: String(r.user_id), balance: Number(r.balance) }));
  }

  /** Every currency with the member's balance (wallet), default first. */
  balances(botId: number, guildId: string, userId: string): { key: string; name: string; symbol: string; balance: number; bank: number }[] {
    this.defaultCurrency(botId);
    return (
      this.db
        .prepare(
          `SELECT c.key, c.name, c.symbol, COALESCE(b.balance, 0) AS balance, COALESCE(k.amount, 0) AS bank FROM economy_currencies c
           LEFT JOIN economy_balances b ON b.currency_id = c.id AND b.guild_id = ? AND b.user_id = ?
           LEFT JOIN economy_bank k ON k.currency_id = c.id AND k.guild_id = ? AND k.user_id = ?
           WHERE c.bot_id = ? ORDER BY c.is_default DESC, c.id`,
        )
        .all(guildId, userId, guildId, userId, botId) as Row[]
    ).map((r) => ({ key: String(r.key), name: String(r.name), symbol: String(r.symbol), balance: Number(r.balance), bank: Number(r.bank) }));
  }

}

function botRow(r: Row): BotRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    applicationId: (r.application_id as string | null) ?? null,
    autostart: r.autostart === 1,
    tokenEnc: (r.token_enc as Uint8Array | null) ?? null,
  };
}

function caseRow(r: Row): ModCase {
  return {
    number: Number(r.number),
    guildId: String(r.guild_id),
    userId: String(r.user_id),
    moderatorId: (r.moderator_id as string | null) ?? null,
    action: String(r.action) as CaseAction,
    reason: String(r.reason),
    duration: String(r.duration),
    auto: r.auto === 1,
    createdAt: String(r.created_at),
  };
}

function parseJson(v: unknown): unknown {
  try {
    return JSON.parse(String(v));
  } catch {
    return undefined;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
