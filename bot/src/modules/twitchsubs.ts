// Twitch sub roles (module "twitch-alerts"): members who subscribe to the
// signed-in Twitch channel get a Discord role per sub tier (1, 2, 3, plus
// one for any tier); the roles go again when the sub ends.
//
// A member links their Twitch account with /twitch-link <name>: the bot
// answers with a code, the member puts it into their Twitch bio ("About")
// and runs /twitch-link again; the bot reads the bio (Helix users) and
// remembers the link. The subscribers are read with the channel owner's
// sign-in (scope channel:read:subscriptions), every 30 minutes and right
// after a new sub (Twitch Alerts).
//
// module_state (per server): "link:<discord id>" = { id, login },
// "code:<discord id>" = { login, code, at }.

import { randomBytes } from 'node:crypto';
import type { Guild } from 'discord.js';
import { appToken } from './feeds.js';
import { idIn, type ModuleContext } from './context.js';
import { assignable, warn } from './guard.js';
import { twitchUserToken } from './twitch-alerts.js';

const HELIX = 'https://api.twitch.tv/helix';
const CODE_MS = 30 * 60_000;

interface SubRolesConfig { tier1Role: unknown; tier2Role: unknown; tier3Role: unknown; anySubRole: unknown; subRolesRemove: boolean }
export interface Link { id: string; login: string }

/** The roles a subscriber of a tier gets ("1000", "2000", "3000"); the others are taken away. */
export function rolesFor(tier: string | null, cfg: Partial<SubRolesConfig>, guildId: string): { give: string[]; take: string[] } {
  const byTier: Record<string, string | null> = { '1000': idIn(cfg.tier1Role, guildId), '2000': idIn(cfg.tier2Role, guildId), '3000': idIn(cfg.tier3Role, guildId) };
  const any = idIn(cfg.anySubRole, guildId);
  const all = [...new Set([...Object.values(byTier), any].filter((r): r is string => !!r))];
  const give = tier ? [byTier[tier], any].filter((r): r is string => !!r) : [];
  return { give: [...new Set(give)], take: all.filter((r) => !give.includes(r)) };
}

async function helix(ctx: ModuleContext, path: string, user: boolean): Promise<any | null> {
  const id = ctx.secret('TWITCH_CLIENT_ID');
  const secret = ctx.secret('TWITCH_CLIENT_SECRET');
  if (!id || !secret) return null;
  const token = user ? (ctx.secretKey ? await twitchUserToken(ctx.db, ctx.botId, ctx.secretKey, id, secret) : null) : await appToken('https://id.twitch.tv/oauth2/token', id, secret);
  if (!token) return null;
  const res = await fetch(`${HELIX}${path}`, { headers: { 'Client-Id': id, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return res?.ok ? res.json() : null;
}

/** Step 1 or 2 of /twitch-link; the text for the member. */
export async function linkTwitch(ctx: ModuleContext, guildId: string, discordId: string, input: string): Promise<{ text: string; linked: boolean }> {
  const login = input.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/^@/, '').split(/[/?#]/)[0]!.toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(login)) return { text: 'Give your Twitch name, e.g. /twitch-link kljub.', linked: false };
  const key = `code:${discordId}`;
  const pending = ctx.getState<{ login: string; code: string; at: number }>('twitch-alerts', guildId, key);
  if (!pending || pending.login !== login || Date.now() - pending.at > CODE_MS) {
    const code = `bothub-${randomBytes(3).toString('hex')}`;
    ctx.setState('twitch-alerts', guildId, key, { login, code, at: Date.now() });
    return { text: `1. Put **${code}** into your Twitch bio (twitch.tv → Settings → Profile → Bio).\n2. Run **/twitch-link ${login}** again within 30 minutes.\nYou can remove the code afterwards.`, linked: false };
  }
  const users = await helix(ctx, `/users?login=${encodeURIComponent(login)}`, false);
  const u = users?.data?.[0];
  if (!u) return { text: 'Twitch could not be asked (or there is no such account). Try again in a moment.', linked: false };
  if (!String(u.description ?? '').includes(pending.code)) return { text: `The code **${pending.code}** is not in the bio of **${u.display_name}** yet. Save the bio on Twitch, then run /twitch-link ${login} again.`, linked: false };
  // One Twitch account per member and per server.
  const taken = ctx.db.prepare("SELECT key FROM module_state WHERE bot_id = ? AND module = 'twitch-alerts' AND guild_id = ? AND key LIKE 'link:%' AND json_extract(value, '$.id') = ?").get(ctx.botId, guildId, String(u.id)) as { key: string } | undefined;
  if (taken && taken.key !== `link:${discordId}`) return { text: `**${u.display_name}** is already linked to another member.`, linked: false };
  ctx.setState('twitch-alerts', guildId, `link:${discordId}`, { id: String(u.id), login: String(u.login) } satisfies Link);
  ctx.deleteState('twitch-alerts', guildId, key);
  return { text: `✅ Linked with **${u.display_name}**. Sub roles are given within 30 minutes.`, linked: true };
}

export function unlinkTwitch(ctx: ModuleContext, guildId: string, discordId: string): boolean {
  const had = !!ctx.getState<Link>('twitch-alerts', guildId, `link:${discordId}`);
  ctx.deleteState('twitch-alerts', guildId, `link:${discordId}`);
  return had;
}

/** The subscribers of the signed-in channel: Twitch user ID → tier; null when they cannot be read. */
export async function subscribers(ctx: ModuleContext): Promise<Map<string, string> | null> {
  const row = ctx.db.prepare('SELECT twitch_id FROM bot_twitch_auth WHERE bot_id = ?').get(ctx.botId) as { twitch_id: string } | undefined;
  if (!row) return null;
  const out = new Map<string, string>();
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const r = await helix(ctx, `/subscriptions?broadcaster_id=${row.twitch_id}&first=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, true);
    if (!r) return page ? out : null;
    for (const s of r.data ?? []) if (String(s.user_id) !== row.twitch_id) out.set(String(s.user_id), String(s.tier));
    cursor = r.pagination?.cursor ?? '';
    if (!cursor) break;
  }
  return out;
}

/** Gives and takes the sub roles of all linked members. */
export async function syncSubRoles(ctx: ModuleContext, guilds: Guild[]): Promise<number> {
  if (!ctx.enabled('twitch-alerts')) return 0;
  const cfg = ctx.config<SubRolesConfig>('twitch-alerts');
  if (![cfg.tier1Role, cfg.tier2Role, cfg.tier3Role, cfg.anySubRole].some(Boolean)) return 0;
  const subs = await subscribers(ctx);
  if (!subs) {
    warn(ctx, 'WAR-2008', { module: 'twitch-alerts', problem: 'the subscribers could not be read: sign in with Twitch again (sub roles need the channel owner)' });
    return 0;
  }
  let changed = 0;
  const links = ctx.db.prepare("SELECT guild_id, key, value FROM module_state WHERE bot_id = ? AND module = 'twitch-alerts' AND key LIKE 'link:%'").all(ctx.botId) as { guild_id: string; key: string; value: string }[];
  for (const l of links) {
    const guild = guilds.find((g) => g.id === l.guild_id);
    if (!guild) continue;
    let link: Link;
    try {
      link = JSON.parse(l.value) as Link;
    } catch {
      continue;
    }
    const member = await guild.members.fetch(l.key.slice(5)).catch(() => null);
    if (!member) continue;
    const { give, take } = rolesFor(subs.get(link.id) ?? null, cfg, guild.id);
    const add = assignable(ctx, 'twitch-alerts', guild, give).filter((r) => !member.roles.cache.has(r));
    const remove = cfg.subRolesRemove === false ? [] : assignable(ctx, 'twitch-alerts', guild, take).filter((r) => member.roles.cache.has(r));
    if (add.length) await member.roles.add(add, 'Twitch sub').then(() => changed++, () => undefined);
    if (remove.length) await member.roles.remove(remove, 'Twitch sub ended or changed').then(() => changed++, () => undefined);
  }
  return changed;
}
