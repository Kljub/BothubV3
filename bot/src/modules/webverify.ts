// Web Verify (module "web-verify"): members verify on a dashboard page, so
// their IP address can be checked (Discord never gives a bot the address).
//   - The panel in the verify channel has a "Verify" button. A press makes a
//     one-time link <dashboard>/verify/<token> (web_verify_requests,
//     migration 0051; only the SHA-256 of the token is stored) and shows it
//     to the member alone. The dashboard address and the sign-in come from
//     Auto Assign Roles (bot_oauth_app).
//   - The member signs in with Discord there; the API checks Tor, VPN/proxy,
//     country and other accounts from the same address and writes the
//     result into the row (api/src/Internal/WebVerifyStore.php).
//   - webVerifyTick (every 5 seconds) applies the results: passed gets the
//     roles, review goes to the log channel with Approve / Kick / Ban,
//     blocked gets the block action. Old rows and address hashes are deleted
//     after the retention time.
// New members get the unverified role on join (optional).

import { createHash, randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
  type Guild, type GuildMember, type Interaction, type MessageCreateOptions,
} from 'discord.js';
import { baseVars, buildMessage, idIn, type MessageConfig, type ModuleContext } from './context.js';
import { assignable, send } from './guard.js';
import { ensurePanel } from './support.js';

export const MODULE = 'web-verify';
const LINK_MS = 30 * 60_000;
const LINKS_PER_10_MIN = 3;
const KEEP_REQUESTS_DAYS = 7;

export interface WebVerifyConfig {
  channel: unknown; panel: MessageConfig; buttonLabel: string; unverifiedRole: unknown; verifiedRole: unknown; logChannel: unknown;
  blockAction: 'kick' | 'ban' | 'none'; retentionDays: number;
}

interface RequestRow { id: number; guild_id: string; user_id: string; status: 'passed' | 'review' | 'blocked'; reasons: string; matches: string; country: string }

/** A link token: 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const REASONS: Record<string, string> = {
  tor: 'Tor exit',
  vpn: 'VPN, proxy or hosting network',
  alt: 'same address as another account',
  country: 'country not allowed',
  country_unknown: 'country unknown',
};

/** Reasons of the API in words, for the log. */
export function reasonText(reasons: string[]): string {
  return reasons.length ? reasons.map((r) => REASONS[r] ?? r).join(', ') : 'no findings';
}

export function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const cfgOf = (ctx: ModuleContext) => ctx.config<WebVerifyConfig>(MODULE);
const row = (...b: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...b);

/** The dashboard address for the link; null while the Discord sign-in is not set up. */
function publicUrl(ctx: ModuleContext): string | null {
  const r = ctx.db.prepare('SELECT a.public_url, b.application_id FROM bot_oauth_app a JOIN bots b ON b.id = a.bot_id WHERE a.bot_id = ?').get(ctx.botId) as { public_url: string; application_id: string | null } | undefined;
  return r?.application_id ? r.public_url : null;
}

async function log(ctx: ModuleContext, guild: Guild, payload: MessageCreateOptions): Promise<void> {
  const channel = guild.channels.cache.get(idIn(cfgOf(ctx).logChannel, guild.id) ?? '');
  if (channel?.isSendable()) await send(ctx, MODULE, channel, { allowedMentions: { parse: [] }, ...payload });
}

const embed = (color: number, title: string, description: string, fields: { name: string; value: string; inline?: boolean }[] = []) =>
  ({ color, title: `🌍 ${title}`.slice(0, 256), description: description.slice(0, 4000), fields, timestamp: new Date().toISOString() });

/** The panel with the Verify button in the verify channel. */
export async function ensureWebVerifyPanels(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled(MODULE)) return;
  const cfg = cfgOf(ctx);
  for (const g of guilds) {
    const channelId = idIn(cfg.channel, g.id);
    if (!channelId) continue;
    const payload = buildMessage(cfg.panel, baseVars(g, null)) ?? { content: '🌍 Verification' };
    payload.components = [row(new ButtonBuilder().setCustomId('bhm:webverify:start').setLabel((cfg.buttonLabel || 'Verify').slice(0, 80)).setEmoji('🌍').setStyle(ButtonStyle.Success))];
    await ensurePanel(ctx, MODULE, 'panel', g, channelId, payload);
  }
}

/** New members get the unverified role (when set). */
export async function webVerifyJoin(ctx: ModuleContext, member: GuildMember): Promise<void> {
  if (!ctx.enabled(MODULE) || member.user.bot) return;
  const role = idIn(cfgOf(ctx).unverifiedRole, member.guild.id);
  if (role && assignable(ctx, MODULE, member.guild, [role]).length) await member.roles.add(role, 'Web Verify: not verified yet').catch(() => undefined);
}

/** The member passed: unverified role off, verified role on. */
async function grant(ctx: ModuleContext, member: GuildMember, why: string): Promise<boolean> {
  const cfg = cfgOf(ctx);
  const off = idIn(cfg.unverifiedRole, member.guild.id);
  const on = idIn(cfg.verifiedRole, member.guild.id);
  if (off && member.roles.cache.has(off)) {
    const ok = await member.roles.remove(off, why).then(() => true, () => false);
    if (!ok) return false;
  }
  if (on && assignable(ctx, MODULE, member.guild, [on]).length) {
    const ok = await member.roles.add(on, why).then(() => true, () => false);
    if (!ok) return false;
  }
  return true;
}

async function punish(member: GuildMember, action: string, why: string): Promise<string> {
  if (action === 'kick' && member.kickable) return member.kick(why).then(() => 'kicked', () => 'could not kick');
  if (action === 'ban' && member.bannable) return member.ban({ reason: why }).then(() => 'banned', () => 'could not ban');
  return action === 'none' ? 'stays unverified' : `could not ${action}`;
}

const asked = new Map<string, number[]>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of asked) if (!v.some((t) => now - t < 600_000)) asked.delete(k);
}, 300_000).unref();

/** Buttons: bhm:webverify:start (panel) and approve|kick|ban:<request ID> (log). */
export async function webVerifyInteraction(ctx: ModuleContext, i: Interaction): Promise<void> {
  if (!i.isButton() || !i.customId.startsWith('bhm:webverify:') || !i.inCachedGuild()) return;
  const [, , action, arg] = i.customId.split(':');
  const reply = (content: string) => i.reply({ content, flags: 64 }).then(() => undefined);
  if (!ctx.enabled(MODULE)) return reply('Verification is switched off.');
  const cfg = cfgOf(ctx);

  if (action === 'start') {
    const on = idIn(cfg.verifiedRole, i.guildId);
    const off = idIn(cfg.unverifiedRole, i.guildId);
    if ((on && i.member.roles.cache.has(on)) || (!on && off && !i.member.roles.cache.has(off))) return reply('✅ You are verified already.');
    const base = publicUrl(ctx);
    if (!base) return reply('Verification is not set up yet (Discord sign-in missing). Please tell the server team.');
    const key = `${ctx.botId}:${i.guildId}:${i.user.id}`;
    const times = (asked.get(key) ?? []).filter((t) => Date.now() - t < 600_000);
    if (times.length >= LINKS_PER_10_MIN) return reply('Too many links requested. Please try again in 10 minutes.');
    asked.set(key, [...times, Date.now()]);
    const token = newToken();
    // One open link per member: a new press replaces the old one.
    ctx.db.prepare("DELETE FROM web_verify_requests WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND status = 'open'").run(ctx.botId, i.guildId, i.user.id);
    ctx.db
      .prepare('INSERT INTO web_verify_requests (bot_id, guild_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(ctx.botId, i.guildId, i.user.id, tokenHash(token), new Date(Date.now() + LINK_MS).toISOString());
    await i.reply({
      content: 'Open the page, sign in with Discord and come back here. The link is only for you and works for 30 minutes.',
      components: [row(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`${base}/verify/${token}`).setLabel('Open verification'))],
      flags: 64,
    });
    return;
  }

  // Review buttons in the log channel: the server team decides.
  if (!['approve', 'kick', 'ban'].includes(action ?? '') || !/^\d+$/.test(arg ?? '')) return;
  const need = action === 'ban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
  if (!i.memberPermissions.has(need)) return reply(`You need the permission ${action === 'ban' ? 'Ban Members' : 'Kick Members'}.`);
  const req = ctx.db.prepare('SELECT user_id FROM web_verify_requests WHERE id = ? AND bot_id = ? AND guild_id = ?').get(Number(arg), ctx.botId, i.guildId) as { user_id: string } | undefined;
  if (!req) return reply('This verification is no longer stored.');
  const member = await i.guild.members.fetch(req.user_id).catch(() => null);
  if (!member) return void (await i.update({ components: [] }).catch(() => undefined));
  const who = `${i.user.tag}`;
  let done: string;
  if (action === 'approve') done = (await grant(ctx, member, `Web Verify: approved by ${who}`)) ? 'approved' : 'could not change the roles';
  else done = await punish(member, action!, `Web Verify: ${action} by ${who}`);
  ctx.db.prepare("UPDATE web_verify_requests SET status = ? WHERE id = ?").run(action === 'approve' ? 'passed' : 'blocked', Number(arg));
  await i.update({ components: [], content: `${done} by <@${i.user.id}>` }).catch(() => undefined);
}

/** Every 5 seconds: results of the page get roles, kick/ban and the log. */
export async function webVerifyTick(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled(MODULE)) return;
  const cfg = cfgOf(ctx);
  const rows = ctx.db
    .prepare("SELECT id, guild_id, user_id, status, reasons, matches, country FROM web_verify_requests WHERE bot_id = ? AND applied = 0 AND status <> 'open' LIMIT 25")
    .all(ctx.botId) as RequestRow[];
  for (const r of rows) {
    ctx.db.prepare('UPDATE web_verify_requests SET applied = 1 WHERE id = ?').run(r.id);
    const guild = guilds.find((g) => g.id === r.guild_id);
    const member = guild ? await guild.members.fetch(r.user_id).catch(() => null) : null;
    if (!guild || !member) continue;
    const reasons = parseList(r.reasons);
    const matches = parseList(r.matches);
    const fields = [{ name: 'Findings', value: reasonText(reasons) }];
    if (r.country) fields.push({ name: 'Country', value: r.country });
    if (matches.length) {
      const banned = await Promise.all(matches.slice(0, 5).map((id) => guild.bans.fetch(id).then(() => true, () => false)));
      fields.push({ name: 'Same address as', value: matches.slice(0, 5).map((id, n) => `<@${id}> (${id})${banned[n] ? ' **banned**' : ''}`).join('\n') });
    }
    const user = `<@${member.id}> (${member.user.tag})`;
    if (r.status === 'passed') {
      const ok = await grant(ctx, member, 'Web Verify: passed');
      await log(ctx, guild, { embeds: [embed(ok ? 0x22c55e : 0xf59e0b, ok ? 'Verified' : 'Verified, roles failed', `${user} passed the verification.${ok ? '' : ' The bot could not change the roles.'}`, fields)] });
    } else if (r.status === 'review') {
      await log(ctx, guild, {
        embeds: [embed(0xf59e0b, 'Review needed', `${user} needs a check by the server team.`, fields)],
        components: [row(
          new ButtonBuilder().setCustomId(`bhm:webverify:approve:${r.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`bhm:webverify:kick:${r.id}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`bhm:webverify:ban:${r.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
        )],
      });
    } else {
      const done = await punish(member, cfg.blockAction ?? 'kick', `Web Verify: ${reasonText(reasons)}`.slice(0, 500));
      await log(ctx, guild, { embeds: [embed(0xef4444, 'Verification refused', `${user}: ${done}.`, fields)] });
    }
  }
}

/** Every 10 minutes: old links and address hashes go (retention time of the module). */
export function webVerifyCleanup(ctx: ModuleContext, now = Date.now()): void {
  const days = Math.min(365, Math.max(1, Number(cfgOf(ctx).retentionDays) || 30));
  ctx.db.prepare('DELETE FROM web_verify_ips WHERE bot_id = ? AND seen_at < ?').run(ctx.botId, new Date(now - days * 86_400_000).toISOString());
  ctx.db.prepare('DELETE FROM web_verify_requests WHERE bot_id = ? AND created_at < ?').run(ctx.botId, new Date(now - KEEP_REQUESTS_DAYS * 86_400_000).toISOString());
}
