// Small server automations:
//   Auto Purge (module "auto-purge"): channels are cleared of messages older
//     than X hours, every Y hours (pinned ones stay when set).
//   Role Prefix (module "role-prefix"): the nickname starts with the prefix
//     of the member's first matching role, e.g. "[Mod] Ann".
//   Day & Night (module "day-night"): server icon (and banner) switch at the
//     day and night time (bot time zone).

import type { Guild, GuildMember, Message } from 'discord.js';
import type { localTime } from '../core/timed.js';
import { idIn, type ModuleContext } from './context.js';
import { warn } from './guard.js';

// ---------- Auto Purge ----------

interface PurgeEntry { channel: unknown; olderThan: number; every: number; keepPinned: boolean }

/** Which of a batch to delete: older than the cutoff, not pinned (when kept). */
export function purgeable(msgs: Array<Pick<Message, 'createdTimestamp' | 'pinned'>>, cutoff: number, keepPinned: boolean): typeof msgs {
  return msgs.filter((m) => m.createdTimestamp < cutoff && !(keepPinned && m.pinned));
}

const FOURTEEN_DAYS = 14 * 86_400_000 - 60_000;

export async function autoPurge(ctx: ModuleContext, guilds: Guild[], now = Date.now()): Promise<void> {
  if (!ctx.enabled('auto-purge')) return;
  for (const [i, e] of (ctx.config<{ channels: PurgeEntry[] }>('auto-purge').channels ?? []).entries()) {
    const guild = guilds.find((g) => idIn(e.channel, g.id));
    if (!guild) continue;
    const channelId = idIn(e.channel, guild.id)!;
    const everyMs = Math.max(1, Math.min(168, Number(e.every) || 24)) * 3_600_000;
    const key = `last:${channelId}:${i}`;
    if (now - (ctx.getState<number>('auto-purge', guild.id, key) ?? 0) < everyMs) continue;
    ctx.setState('auto-purge', guild.id, key, now);
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased() || !('bulkDelete' in channel)) {
      warn(ctx, 'WAR-2008', { module: 'auto-purge', problem: 'a channel is missing or not a text channel' });
      continue;
    }
    const cutoff = now - Math.max(1, Math.min(8760, Number(e.olderThan) || 24)) * 3_600_000;
    let before: string | undefined;
    let single = 20; // messages older than 14 days go one by one (Discord), a few per round
    for (let page = 0; page < 5; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch?.size) break;
      before = batch.last()?.id;
      const doomed = purgeable([...batch.values()], cutoff, e.keepPinned !== false) as Message[];
      const recent = doomed.filter((m) => now - m.createdTimestamp < FOURTEEN_DAYS);
      if (recent.length) await channel.bulkDelete(recent, true).catch(() => warn(ctx, 'WAR-2008', { module: 'auto-purge', problem: 'the bot lacks Manage Messages in a channel' }));
      for (const m of doomed.filter((x) => now - x.createdTimestamp >= FOURTEEN_DAYS)) {
        if (single-- <= 0) break;
        await m.delete().catch(() => undefined);
      }
      if (batch.size < 100) break;
    }
  }
}

// ---------- Role Prefix ----------

interface PrefixEntry { role: unknown; prefix: string }

/** The display name without any of the prefixes. */
export function basename(name: string, prefixes: string[]): string {
  let n = name;
  for (let changed = true; changed;) {
    changed = false;
    for (const p of prefixes) {
      if (p && n.startsWith(p)) {
        n = n.slice(p.length).trimStart();
        changed = true;
      }
    }
  }
  return n;
}

/** The nickname for a member: prefix of the first matching role + base name (max. 32). */
export function prefixedName(name: string, roleIds: string[], entries: Array<{ role: string | null; prefix: string }>): string {
  const prefixes = entries.map((e) => e.prefix).filter(Boolean);
  const base = basename(name, prefixes);
  const hit = entries.find((e) => e.role && e.prefix && roleIds.includes(e.role));
  return hit ? `${hit.prefix}${hit.prefix.endsWith(' ') ? '' : ' '}${base}`.slice(0, 32) : base;
}

export async function rolePrefix(ctx: ModuleContext, member: GuildMember): Promise<void> {
  if (!ctx.enabled('role-prefix') || member.user.bot || !member.manageable) return;
  const entries = (ctx.config<{ prefixes: PrefixEntry[] }>('role-prefix').prefixes ?? []).map((e) => ({ role: idIn(e.role, member.guild.id), prefix: String(e.prefix ?? '').slice(0, 12) }));
  if (!entries.length) return;
  const want = prefixedName(member.displayName, [...member.roles.cache.keys()], entries);
  if (want === member.displayName) return;
  // Without a prefix the nickname goes back to the account name when they match.
  const nick = want === (member.user.globalName ?? member.user.username) ? null : want;
  await member.setNickname(nick, 'Role prefix').catch(() => undefined);
}

// ---------- Day & Night ----------

interface DayNightConfig { dayTime: string; nightTime: string; dayIcon: string; nightIcon: string; dayBanner: string; nightBanner: string }

/** "day" between dayTime and nightTime (HH:MM, also over midnight), else "night". */
export function phaseAt(hms: string, dayTime: string, nightTime: string): 'day' | 'night' {
  const t = hms.slice(0, 5);
  const d = dayTime || '07:00';
  const n = nightTime || '20:00';
  return d <= n ? (t >= d && t < n ? 'day' : 'night') : (t >= d || t < n ? 'day' : 'night');
}

const https = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/\S{1,500}$/.test(v.trim()) ? v.trim() : null);

export async function dayNight(ctx: ModuleContext, guilds: Guild[], local: ReturnType<typeof localTime>): Promise<void> {
  if (!ctx.enabled('day-night')) return;
  const cfg = ctx.config<DayNightConfig>('day-night');
  const phase = phaseAt(local.hms, cfg.dayTime ?? '', cfg.nightTime ?? '');
  for (const guild of guilds) {
    if (ctx.getState<string>('day-night', guild.id, 'phase') === phase) continue;
    ctx.setState('day-night', guild.id, 'phase', phase);
    const icon = https(phase === 'day' ? cfg.dayIcon : cfg.nightIcon);
    const banner = https(phase === 'day' ? cfg.dayBanner : cfg.nightBanner);
    if (icon) await guild.setIcon(icon, `Day & Night: ${phase}`).catch(() => warn(ctx, 'WAR-2008', { module: 'day-night', problem: 'the server icon could not be changed (Manage Server, or the image link)' }));
    if (banner && guild.premiumTier >= 2) await guild.setBanner(banner, `Day & Night: ${phase}`).catch(() => undefined);
  }
}
