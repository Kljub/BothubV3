// Twitch Alerts: follows, subs (new, resub, gifts), bits and raids of the
// bot owner's Twitch channel, posted in a Discord channel. The channel owner
// signed in once in the dashboard (table bot_twitch_auth, tokens encrypted);
// this file keeps the user token fresh and listens through EventSub over a
// WebSocket (no public address needed). Checked every 30 seconds by the
// module timers: settings or sign-in changed → the connection is rebuilt.

import type { Guild } from 'discord.js';
import { decrypt, encrypt } from '../core/secrets.js';
import type { Db } from '../core/db.js';
import { lookupTwitch, twitchVars } from '../discord/twitch-lookup.js';
import { appToken, getJson } from './feeds.js';
import { syncSubRoles } from './twitchsubs.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, idIn, idsIn, type MessageConfig, type ModuleContext } from './context.js';
import { send, warn } from './guard.js';

interface AlertsConfig {
  channel: unknown; mentionRoles: unknown;
  followEnabled: boolean; followMessage: MessageConfig;
  subEnabled: boolean; subMessage: MessageConfig; resubEnabled: boolean; resubMessage: MessageConfig;
  giftEnabled: boolean; giftMessage: MessageConfig;
  bitsEnabled: boolean; bitsMinimum: number; bitsMessage: MessageConfig;
  raidEnabled: boolean; raidMinimum: number; raidMessage: MessageConfig;
}

interface AuthRow {
  twitch_id: string; login: string; display_name: string; access_enc: Uint8Array; refresh_enc: Uint8Array; expires_at: string; connected_at: string;
}

const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX = 'https://api.twitch.tv/helix';

/** The EventSub subscriptions a configuration needs. */
export function wantedSubscriptions(cfg: Partial<AlertsConfig>, twitchId: string): { type: string; version: string; condition: Record<string, string> }[] {
  const b = { broadcaster_user_id: twitchId };
  const out: { type: string; version: string; condition: Record<string, string> }[] = [];
  if (cfg.followEnabled !== false) out.push({ type: 'channel.follow', version: '2', condition: { ...b, moderator_user_id: twitchId } });
  if (cfg.subEnabled !== false) out.push({ type: 'channel.subscribe', version: '1', condition: b });
  if (cfg.resubEnabled !== false) out.push({ type: 'channel.subscription.message', version: '1', condition: b });
  if (cfg.giftEnabled !== false) out.push({ type: 'channel.subscription.gift', version: '1', condition: b });
  if (cfg.bitsEnabled !== false) out.push({ type: 'channel.cheer', version: '1', condition: b });
  if (cfg.raidEnabled !== false) out.push({ type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: twitchId } });
  return out;
}

const tier = (t: unknown) => String(Math.max(1, Math.round(Number(t) / 1000) || 1));
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Which message and placeholders an EventSub notification gives (null: not posted). */
export function alertFor(type: string, ev: Record<string, unknown>, cfg: Partial<AlertsConfig>, channelLogin: string): { message: MessageConfig | undefined; vars: Record<string, string> } | null {
  const channel = { channel: channelLogin, 'channel.url': `https://twitch.tv/${channelLogin}` };
  const anon = 'Anonymous';
  const user = { user: str(ev.user_name) || anon, 'user.login': str(ev.user_login) };
  switch (type) {
    case 'channel.follow':
      return { message: cfg.followMessage, vars: { ...user, ...channel } };
    case 'channel.subscribe':
      if (ev.is_gift === true) return null; // the gift event posts these
      return { message: cfg.subMessage, vars: { ...user, ...channel, tier: tier(ev.tier), months: '1', streak: '1', message: '' } };
    case 'channel.subscription.message':
      return {
        message: cfg.resubMessage,
        vars: { ...user, ...channel, tier: tier(ev.tier), months: str(ev.cumulative_months || 1), streak: str(ev.streak_months ?? ''), message: str((ev.message as { text?: string } | undefined)?.text).slice(0, 500) },
      };
    case 'channel.subscription.gift':
      return {
        message: cfg.giftMessage,
        vars: { ...(ev.is_anonymous ? { user: anon, 'user.login': '' } : user), ...channel, count: str(ev.total || 1), tier: tier(ev.tier), total: str(ev.cumulative_total ?? '') },
      };
    case 'channel.cheer':
      if (Number(ev.bits ?? 0) < Math.max(1, cfg.bitsMinimum ?? 1)) return null;
      return { message: cfg.bitsMessage, vars: { ...(ev.is_anonymous ? { user: anon, 'user.login': '' } : user), ...channel, bits: str(ev.bits), message: str(ev.message).slice(0, 500) } };
    case 'channel.raid':
      if (Number(ev.viewers ?? 0) < Math.max(1, cfg.raidMinimum ?? 1)) return null;
      return {
        message: cfg.raidMessage,
        vars: { raider: str(ev.from_broadcaster_user_name), 'raider.login': str(ev.from_broadcaster_user_login), 'raider.url': `https://twitch.tv/${str(ev.from_broadcaster_user_login)}`, viewers: str(ev.viewers), ...channel },
      };
  }
  return null;
}

class Connection {
  ws: WebSocket | null = null;
  closed = false;
  private watchdog: NodeJS.Timeout | undefined;
  private seen: string[] = [];

  constructor(
    private readonly ctx: ModuleContext,
    readonly sig: string,
    private readonly auth: () => Promise<{ token: string; clientId: string } | null>,
    private readonly twitchId: string,
    private readonly login: string,
    private readonly guilds: () => Guild[],
  ) {}

  open(url = WS_URL, resubscribe = true): void {
    if (this.closed) return;
    const ws = new WebSocket(url);
    ws.addEventListener('message', (e) => void this.onMessage(ws, String(e.data), resubscribe).catch((err) => log.debug('twitch alerts message failed', { err: String(err) })));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null; // the next check opens a new one
    });
    ws.addEventListener('error', () => ws.close());
  }

  private alive(seconds: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.ws?.close(), (seconds + 15) * 1000);
    this.watchdog.unref();
  }

  get up(): boolean {
    return !!this.ws && this.ws.readyState <= 1;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.watchdog);
    this.ws?.close();
    this.ws = null;
  }

  private async onMessage(ws: WebSocket, raw: string, resubscribe: boolean): Promise<void> {
    const msg = JSON.parse(raw) as { metadata?: { message_type?: string; message_id?: string; subscription_type?: string }; payload?: Record<string, any> };
    const kind = msg.metadata?.message_type;
    if (kind === 'session_welcome') {
      const old = this.ws;
      this.ws = ws;
      if (old && old !== ws) old.close(); // reconnect: the new socket took over
      this.alive(Number(msg.payload?.session?.keepalive_timeout_seconds ?? 10));
      if (resubscribe) await this.subscribe(String(msg.payload?.session?.id ?? ''));
      return;
    }
    this.alive(30);
    if (kind === 'session_reconnect') {
      const url = String(msg.payload?.session?.reconnect_url ?? '');
      if (url.startsWith('wss://')) this.open(url, false); // subscriptions move along
      return;
    }
    if (kind === 'revocation') {
      warn(this.ctx, 'WAR-2008', { module: 'twitch-alerts', problem: `Twitch ended ${String(msg.payload?.subscription?.type)} (${String(msg.payload?.subscription?.status)}): sign in with Twitch again` });
      return;
    }
    if (kind !== 'notification') return;
    const id = msg.metadata?.message_id ?? '';
    if (id && this.seen.includes(id)) return; // Twitch may send a notification twice
    this.seen = [...this.seen.slice(-199), id];
    await this.post(String(msg.payload?.subscription?.type ?? ''), (msg.payload?.event ?? {}) as Record<string, unknown>);
  }

  private async subscribe(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const cfg = this.ctx.config<AlertsConfig>('twitch-alerts');
    for (const sub of wantedSubscriptions(cfg, this.twitchId)) {
      const a = await this.auth();
      if (!a) return;
      const res = await fetch(`${HELIX}/eventsub/subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.token}`, 'Client-Id': a.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub, transport: { method: 'websocket', session_id: sessionId } }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (res && res.status !== 202 && res.status !== 409) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        warn(this.ctx, 'WAR-2008', { module: 'twitch-alerts', problem: `Twitch refused ${sub.type}: ${String(body?.message ?? res.status).slice(0, 160)}` });
      }
    }
  }

  /** {twitch_name}, {twitch_follower} … of the user of the event (follower, subscriber, cheerer, raider). */
  private async userVars(type: string, ev: Record<string, unknown>, vars: Record<string, string>): Promise<Record<string, string>> {
    const login = String(type === 'channel.raid' ? ev.from_broadcaster_user_login ?? '' : ev.user_login ?? '');
    const extra = { sub: vars.tier ? `Tier ${vars.tier}` : undefined, bits: vars.bits };
    const a = login && /^[A-Za-z0-9_]{2,25}$/.test(login) ? await this.auth() : null;
    const id = this.ctx.secret('TWITCH_CLIENT_ID');
    const secret = this.ctx.secret('TWITCH_CLIENT_SECRET');
    const app = a && id && secret ? await appToken('https://id.twitch.tv/oauth2/token', id, secret) : null;
    if (!a || !app) return {};
    const p = await lookupTwitch(login, { clientId: a.clientId, appToken: app, userToken: a.token }, (url, headers) => getJson(url, { headers })).catch(() => null);
    return p ? twitchVars(p, extra) : {};
  }

  private async post(type: string, ev: Record<string, unknown>): Promise<void> {
    const cfg = this.ctx.config<AlertsConfig>('twitch-alerts');
    const alert = alertFor(type, ev, cfg, this.login);
    if (!alert) return;
    const guild = this.guilds().find((g) => idIn(cfg.channel, g.id));
    const channel = guild?.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
    if (!guild || !channel?.isSendable()) {
      warn(this.ctx, 'WAR-2008', { module: 'twitch-alerts', problem: 'the alert channel is missing or the bot cannot write there' });
      return;
    }
    const payload = buildMessage(alert.message, { ...baseVars(guild, null), ...(await this.userVars(type, ev, alert.vars)), ...alert.vars });
    if (!payload) return;
    const roles = idsIn(cfg.mentionRoles, guild.id);
    if (roles.length) {
      payload.content = `${roles.map((r) => `<@&${r}>`).join(' ')} ${payload.content ?? ''}`.trim();
      payload.allowedMentions = { roles };
    } else payload.allowedMentions = { parse: [] };
    await send(this.ctx, 'twitch-alerts', channel, payload);
    // A new sub: the sub roles follow at once (Twitch lists it a moment later).
    if (type.startsWith('channel.subscri')) setTimeout(() => void syncSubRoles(this.ctx, this.guilds()).catch(() => undefined), 30_000).unref();
  }
}

const connections = new Map<number, Connection>();

/** Every 30 seconds: open, keep or close the EventSub connection of this bot. */
export async function twitchAlertsTick(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  const current = connections.get(ctx.botId);
  const key = ctx.secretKey;
  const row = key ? (ctx.db.prepare('SELECT twitch_id, login, display_name, access_enc, refresh_enc, expires_at, connected_at FROM bot_twitch_auth WHERE bot_id = ?').get(ctx.botId) as AuthRow | undefined) : undefined;
  const clientId = ctx.secret('TWITCH_CLIENT_ID');
  const clientSecret = ctx.secret('TWITCH_CLIENT_SECRET');
  const cfg = ctx.config<AlertsConfig>('twitch-alerts');
  if (!ctx.enabled('twitch-alerts') || !row || !key || !clientId || !clientSecret) {
    current?.close();
    connections.delete(ctx.botId);
    if (ctx.enabled('twitch-alerts') && !row) warn(ctx, 'WAR-2008', { module: 'twitch-alerts', problem: 'no Twitch channel is connected (Modules → Twitch Alerts → Sign in with Twitch)' });
    return;
  }
  const sig = JSON.stringify([row.twitch_id, row.connected_at, wantedSubscriptions(cfg, row.twitch_id).map((s) => s.type)]);
  if (current && current.sig === sig && current.up) return;
  current?.close();
  const conn = new Connection(ctx, sig, () => userToken(ctx, key, clientId, clientSecret), row.twitch_id, row.login, () => (guilds[0] ? [...guilds[0].client.guilds.cache.values()] : guilds));
  connections.set(ctx.botId, conn);
  conn.open();
}

async function userToken(ctx: ModuleContext, key: () => Buffer, clientId: string, clientSecret: string): Promise<{ token: string; clientId: string } | null> {
  const token = await twitchUserToken(ctx.db, ctx.botId, key, clientId, clientSecret);
  if (token === undefined) warn(ctx, 'WAR-2008', { module: 'twitch-alerts', problem: 'Twitch did not renew the sign-in: sign in with Twitch again' });
  return token ? { token, clientId } : null;
}

/**
 * The user token of the bot's signed-in Twitch channel, refreshed (and
 * stored again) when it ends within 10 minutes. null: no channel signed in;
 * undefined: Twitch refused to renew it.
 */
export async function twitchUserToken(db: Db, botId: number, key: () => Buffer, clientId: string, clientSecret: string): Promise<string | null | undefined> {
  const row = db.prepare('SELECT access_enc, refresh_enc, expires_at FROM bot_twitch_auth WHERE bot_id = ?').get(botId) as AuthRow | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) - Date.now() > 10 * 60_000) return decrypt(key(), row.access_enc);
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(key(), row.refresh_enc), client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null) : null;
  if (!body?.access_token || !body.refresh_token) return undefined;
  db
    .prepare("UPDATE bot_twitch_auth SET access_enc = ?, refresh_enc = ?, expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bot_id = ?")
    .run(encrypt(key(), body.access_token), encrypt(key(), body.refresh_token), new Date(Date.now() + Math.max(60, body.expires_in ?? 3600) * 1000).toISOString(), botId);
  return body.access_token;
}

/** Closes the connection of a bot (bot stopped). */
export function stopTwitchAlerts(botId: number): void {
  connections.get(botId)?.close();
  connections.delete(botId);
}
