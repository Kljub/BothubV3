// Auto Assign Roles (module "connection-roles"): roles for the Discord
// connections of a member (Steam, GitHub, Twitch, YouTube …).
//
// Discord never sends a bot the connections of a member, and there is no
// gateway event when they change. So members sign in once with the bot's own
// Discord application (scopes identify + connections) on the dashboard page
// /connect/<application ID> (link from /connections-link). The API stores the
// tokens encrypted and the connections in member_connections (migration
// 0048, dirty = 1). This module then:
//   - gives and takes the roles of the rules on every server of the bot,
//   - fires the custom event "connections_update" (the native replacement for
//     a "user updated connections" event) with what was added and removed,
//   - reads the connections again every few hours (refresh token) and marks
//     the member dirty when something changed,
//   - takes the rule roles from members who are no longer linked.

import type { Guild, GuildMember } from 'discord.js';
import { decrypt, encrypt } from '../core/secrets.js';
import { idIn, type ModuleContext } from './context.js';
import { assignable, warn } from './guard.js';
import { log } from '../core/log.js';

export const MODULE = 'connection-roles';
const DISCORD = 'https://discord.com/api/v10';
const REFRESH_PER_TICK = 10;
const MAX_FAILURES = 3;

export interface Conn {
  type: string;
  id: string;
  name: string;
  verified: boolean;
}

export interface Rule {
  connection?: string;
  role?: unknown;
  verified?: boolean;
  name?: string;
}

export interface ConnConfig {
  rules: Rule[];
  linkedRole: unknown;
  removeRoles: boolean;
  refreshHours: string;
  logChannel: unknown;
}

interface Row {
  user_id: string;
  user_name: string;
  connections: string;
  previous: string;
  access_enc: Uint8Array;
  refresh_enc: Uint8Array;
  expires_at: string;
  checked_at: string;
  failures: number;
}

export function parseConns(raw: string | null | undefined): Conn[] {
  try {
    const list = JSON.parse(raw ?? '[]');
    return Array.isArray(list) ? list.filter((c): c is Conn => !!c && typeof c.type === 'string') : [];
  } catch {
    return [];
  }
}

/** Does a connection fulfil a rule (type, verified when asked, name part)? */
export function matches(rule: Rule, c: Conn): boolean {
  if (!rule.connection || c.type !== rule.connection) return false;
  if (rule.verified !== false && !c.verified) return false;
  const part = (rule.name ?? '').trim().toLowerCase();
  return !part || c.name.toLowerCase().includes(part);
}

/**
 * The roles a member gets on a server and the rule roles taken away.
 * conns null: not linked (only takes).
 */
export function rolesFor(conns: Conn[] | null, cfg: Partial<ConnConfig>, guildId: string): { give: string[]; take: string[] } {
  const all = new Set<string>();
  const give = new Set<string>();
  for (const rule of cfg.rules ?? []) {
    const role = idIn(rule.role, guildId);
    if (!role) continue;
    all.add(role);
    if (conns?.some((c) => matches(rule, c))) give.add(role);
  }
  const linked = idIn(cfg.linkedRole, guildId);
  if (linked) {
    all.add(linked);
    if (conns) give.add(linked);
  }
  const take = cfg.removeRoles === false ? [] : [...all].filter((r) => !give.has(r));
  return { give: [...give], take };
}

const key = (c: Conn) => `${c.type}\u0000${c.id}\u0000${c.name}\u0000${c.verified ? 1 : 0}`;

/** What changed between two lists: "steam: Entity" texts. */
export function diff(before: Conn[], after: Conn[]): { added: Conn[]; removed: Conn[] } {
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));
  return { added: after.filter((c) => !b.has(key(c))), removed: before.filter((c) => !a.has(key(c))) };
}

export const label = (c: Conn) => (c.name ? `${c.type}: ${c.name}` : c.type);

/** Placeholders of the custom event "connections_update". */
export function eventVars(now: Conn[], before: Conn[]): Record<string, string> {
  const { added, removed } = diff(before, now);
  return {
    connections: now.map(label).join(', '),
    'connections.types': [...new Set(now.map((c) => c.type))].join(', '),
    'connections.count': String(now.length),
    'connections.added': added.map(label).join(', '),
    'connections.removed': removed.map(label).join(', '),
  };
}

/** Gives and takes the roles of one member on one server; true when something changed. */
export async function applyRoles(ctx: ModuleContext, member: GuildMember, conns: Conn[] | null): Promise<boolean> {
  const cfg = ctx.config<ConnConfig>(MODULE);
  const { give, take } = rolesFor(conns, cfg, member.guild.id);
  const add = assignable(ctx, MODULE, member.guild, give).filter((r) => !member.roles.cache.has(r));
  const remove = assignable(ctx, MODULE, member.guild, take).filter((r) => member.roles.cache.has(r));
  let changed = false;
  if (add.length) await member.roles.add(add, 'Auto Assign Roles: connections').then(() => (changed = true), () => undefined);
  if (remove.length) await member.roles.remove(remove, 'Auto Assign Roles: connection gone').then(() => (changed = true), () => undefined);
  return changed;
}

/** The stored connections of a member; null when not linked. */
export function linkedConns(ctx: ModuleContext, userId: string): Conn[] | null {
  const row = ctx.db.prepare('SELECT connections FROM member_connections WHERE bot_id = ? AND user_id = ?').get(ctx.botId, userId) as { connections: string } | undefined;
  return row ? parseConns(row.connections) : null;
}

/** A new member who linked before (on another server of the bot) gets the roles at once. */
export async function connectionsJoin(ctx: ModuleContext, member: GuildMember): Promise<void> {
  if (!ctx.enabled(MODULE) || member.user.bot) return;
  const conns = linkedConns(ctx, member.id);
  if (conns) await applyRoles(ctx, member, conns);
}

/** The member link of /connections-link; null when the module is not set up in the dashboard. */
export function linkUrl(ctx: ModuleContext): string | null {
  const row = ctx.db.prepare('SELECT a.public_url, b.application_id FROM bot_oauth_app a JOIN bots b ON b.id = a.bot_id WHERE a.bot_id = ?').get(ctx.botId) as { public_url: string; application_id: string | null } | undefined;
  return row?.application_id ? `${row.public_url}/connect/${row.application_id}` : null;
}

/** /connections-unlink: forgets the member (revokes the token) and takes the roles on this server. */
export async function unlinkMember(ctx: ModuleContext, member: GuildMember | null, userId: string): Promise<boolean> {
  const row = ctx.db.prepare('SELECT refresh_enc FROM member_connections WHERE bot_id = ? AND user_id = ?').get(ctx.botId, userId) as { refresh_enc: Uint8Array } | undefined;
  if (!row) return false;
  ctx.db.prepare('DELETE FROM member_connections WHERE bot_id = ? AND user_id = ?').run(ctx.botId, userId);
  const app = oauthApp(ctx);
  if (app && ctx.secretKey) {
    const token = decrypt(ctx.secretKey(), row.refresh_enc);
    void fetch(`${DISCORD}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: app.id, client_secret: app.secret }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
  if (member) await applyRoles(ctx, member, null);
  return true;
}

function oauthApp(ctx: ModuleContext): { id: string; secret: string } | null {
  if (!ctx.secretKey) return null;
  const row = ctx.db.prepare('SELECT a.client_secret_enc, b.application_id FROM bot_oauth_app a JOIN bots b ON b.id = a.bot_id WHERE a.bot_id = ?').get(ctx.botId) as { client_secret_enc: Uint8Array; application_id: string | null } | undefined;
  if (!row?.application_id) return null;
  try {
    return { id: row.application_id, secret: decrypt(ctx.secretKey(), row.client_secret_enc) };
  } catch {
    return null;
  }
}

type Fetch = typeof fetch;

/**
 * Reads the connections of one member again (renews the token first when it
 * ends within an hour). Returns the new list; null when Discord refused.
 */
export async function readConnections(ctx: ModuleContext, row: Row, app: { id: string; secret: string }, f: Fetch = fetch): Promise<Conn[] | null> {
  const k = ctx.secretKey!();
  let access = decrypt(k, row.access_enc);
  if (Date.parse(row.expires_at) - Date.now() < 3_600_000) {
    const res = await f(`${DISCORD}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(k, row.refresh_enc), client_id: app.id, client_secret: app.secret }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null) : null;
    if (!body?.access_token || !body.refresh_token) return null;
    access = body.access_token;
    ctx.db
      .prepare('UPDATE member_connections SET access_enc = ?, refresh_enc = ?, expires_at = ? WHERE bot_id = ? AND user_id = ?')
      .run(encrypt(k, body.access_token), encrypt(k, body.refresh_token), new Date(Date.now() + Math.max(60, body.expires_in ?? 604_800) * 1000).toISOString(), ctx.botId, row.user_id);
  }
  const res = await f(`${DISCORD}/users/@me/connections`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as unknown;
  return Array.isArray(raw) ? cleanConns(raw) : null;
}

/** Discord's connection objects without revoked ones (same as the API's ConnectionStore::clean). */
export function cleanConns(raw: unknown[]): Conn[] {
  const out: Conn[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || c.revoked === true || typeof c.type !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(c.type)) continue;
    out.push({ type: c.type, id: String(c.id ?? '').slice(0, 100), name: String(c.name ?? '').slice(0, 100), verified: c.verified === true });
    if (out.length >= 50) break;
  }
  return out;
}

/** Emits the custom event of a member on a server (set by the bot instance). */
export type ConnEmit = (member: GuildMember, vars: Record<string, string>) => void;

/**
 * One round (every 30 s, ModuleTimers): roles and events for changed
 * members, then a few refreshes, and every 30 minutes a full check of the
 * rule roles (members unlinked in the dashboard lose them).
 */
export async function connectionsTick(ctx: ModuleContext, guilds: Guild[], emit: ConnEmit | null, now = Date.now(), f: Fetch = fetch): Promise<void> {
  if (!ctx.enabled(MODULE)) return;
  const cfg = ctx.config<ConnConfig>(MODULE);

  // 1. Changed members: roles on every server, the event, the log line.
  const dirty = ctx.db.prepare('SELECT user_id, user_name, connections, previous FROM member_connections WHERE bot_id = ? AND dirty = 1 LIMIT 50').all(ctx.botId) as Row[];
  for (const row of dirty) {
    ctx.db.prepare('UPDATE member_connections SET dirty = 0 WHERE bot_id = ? AND user_id = ?').run(ctx.botId, row.user_id);
    const conns = parseConns(row.connections);
    const vars = eventVars(conns, parseConns(row.previous));
    for (const guild of guilds) {
      const member = await guild.members.fetch(row.user_id).catch(() => null);
      if (!member) continue;
      await applyRoles(ctx, member, conns);
      emit?.(member, vars);
      const channel = idIn(cfg.logChannel, guild.id);
      const ch = channel ? guild.channels.cache.get(channel) : null;
      if (ch?.isSendable()) {
        const parts = [vars['connections.added'] && `➕ ${vars['connections.added']}`, vars['connections.removed'] && `➖ ${vars['connections.removed']}`].filter(Boolean);
        await ch.send({ content: `🔗 <@${row.user_id}>: ${parts.join(' · ') || vars.connections || '—'}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => undefined);
      }
    }
  }

  // 2. Read a few members again whose last check is older than the interval.
  const hours = Math.max(1, Number(cfg.refreshHours) || 12);
  const due = new Date(now - hours * 3_600_000).toISOString();
  const rows = ctx.db.prepare('SELECT * FROM member_connections WHERE bot_id = ? AND checked_at < ? ORDER BY checked_at LIMIT ?').all(ctx.botId, due, REFRESH_PER_TICK) as Row[];
  const app = rows.length ? oauthApp(ctx) : null;
  if (rows.length && !app) warn(ctx, 'WAR-2008', { module: MODULE, problem: 'the client secret of the bot application is missing: set it on the module page' });
  for (const row of app ? rows : []) {
    const fresh = await readConnections(ctx, row, app!, f);
    const stamp = new Date(now).toISOString();
    if (!fresh) {
      if (row.failures + 1 >= MAX_FAILURES) {
        // The member revoked the app or the token died: forget them (the full check takes the roles).
        ctx.db.prepare('DELETE FROM member_connections WHERE bot_id = ? AND user_id = ?').run(ctx.botId, row.user_id);
        log.info('connection link dropped', { botId: ctx.botId, user: row.user_id });
      } else {
        ctx.db.prepare('UPDATE member_connections SET failures = failures + 1, checked_at = ? WHERE bot_id = ? AND user_id = ?').run(stamp, ctx.botId, row.user_id);
      }
      continue;
    }
    const before = parseConns(row.connections);
    const { added, removed } = diff(before, fresh);
    if (added.length || removed.length) {
      ctx.db
        .prepare('UPDATE member_connections SET previous = connections, connections = ?, dirty = 1, failures = 0, checked_at = ? WHERE bot_id = ? AND user_id = ?')
        .run(JSON.stringify(fresh), stamp, ctx.botId, row.user_id);
    } else {
      ctx.db.prepare('UPDATE member_connections SET failures = 0, checked_at = ? WHERE bot_id = ? AND user_id = ?').run(stamp, ctx.botId, row.user_id);
    }
  }

  // 3. Every 30 minutes: members with a rule role who are not linked lose it.
  if (cfg.removeRoles !== false && Math.floor(now / 1_800_000) !== Math.floor((now - 30_000) / 1_800_000)) {
    for (const guild of guilds) await sweepRoles(ctx, guild, cfg);
  }
}

/** Takes the rule roles from cached members who are not linked (any more). */
export async function sweepRoles(ctx: ModuleContext, guild: Guild, cfg: Partial<ConnConfig>): Promise<number> {
  const roles = new Set([...(cfg.rules ?? []).map((r) => idIn(r.role, guild.id)), idIn(cfg.linkedRole, guild.id)].filter((r): r is string => !!r));
  const seen = new Set<string>();
  let n = 0;
  for (const roleId of roles) {
    for (const member of guild.roles.cache.get(roleId)?.members.values() ?? []) {
      if (seen.has(member.id) || member.user.bot) continue;
      seen.add(member.id);
      if (await applyRoles(ctx, member, linkedConns(ctx, member.id))) n++;
    }
  }
  return n;
}
