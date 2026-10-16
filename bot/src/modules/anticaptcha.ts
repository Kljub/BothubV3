// AntiControl captcha: members must prove they are human before they get
// access. Every new member (setting) or only those the join checks find
// suspicious (action "captcha" of AntiRaid, Account Age, Join Risk) get the
// quarantine role and must solve a picture captcha in the captcha channel:
// "I am human" → a picture with 5 distorted letters → "Enter code" (modal).
// Right: the quarantine role goes (and the verified role comes). Three wrong
// codes or the time limit: the fail action (kick, ban or nothing).
//
// module_state (anticontrol, per server): "cap:<user>" = { since, tries,
// code, expires }, "captcha" = the panel message.

import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  type Guild, type GuildMember, type Interaction,
} from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import { cardRenderer } from '../cards/cards.js';
import { baseVars, buildMessage, idIn, type MessageConfig, type ModuleContext } from './context.js';
import { assignable } from './guard.js';
import { codeMatches, ensurePanel } from './support.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_TRIES = 3;
const CODE_MS = 5 * 60_000;

export interface CaptchaConfig {
  captchaAll: boolean; captchaChannel: unknown; captchaPanel: MessageConfig; captchaMinutes: number;
  captchaFailAction: 'kick' | 'ban' | 'none'; captchaVerifiedRole: unknown; quarantineRole: unknown; logChannel: unknown;
}

interface Pending { since: number; tries: number; code?: string; expires?: number }

export function captchaCode(random = Math.random): string {
  return Array.from({ length: 5 }, () => LETTERS[Math.floor(random() * LETTERS.length)]).join('');
}

let fontFamily: Promise<string> | null = null;
/** A font of the card renderer (registered once); "sans-serif" when there is none. */
function font(): Promise<string> {
  fontFamily ??= cardRenderer().then((r) => r.FONTS[0]?.family ?? 'sans-serif', () => 'sans-serif');
  return fontFamily;
}

/** The captcha picture: letters turned and shifted, lines and dots across. */
export async function renderCaptcha(code: string, random = Math.random): Promise<Buffer> {
  const family = await font();
  const w = 260;
  const h = 90;
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#1e1f22';
  g.fillRect(0, 0, w, h);
  const hue = () => Math.floor(random() * 360);
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = `hsla(${hue()}, 70%, 60%, 0.55)`;
    g.lineWidth = 1 + random() * 2;
    g.beginPath();
    g.moveTo(random() * w, random() * h);
    g.bezierCurveTo(random() * w, random() * h, random() * w, random() * h, random() * w, random() * h);
    g.stroke();
  }
  g.textBaseline = 'middle';
  [...code].forEach((ch, i) => {
    g.save();
    g.translate(30 + i * 48 + random() * 10, h / 2 + (random() - 0.5) * 22);
    g.rotate((random() - 0.5) * 0.9);
    g.font = `bold ${38 + Math.floor(random() * 12)}px "${family}"`;
    g.fillStyle = `hsl(${hue()}, 80%, 72%)`;
    g.fillText(ch, -12, 0);
    g.restore();
  });
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `hsla(${hue()}, 60%, 70%, 0.6)`;
    g.fillRect(random() * w, random() * h, 2, 2);
  }
  return c.toBuffer('image/png');
}

const cfgOf = (ctx: ModuleContext) => ctx.config<CaptchaConfig>('anticontrol');
const row = (...b: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...b);

/** The panel with "I am human" in the captcha channel. */
export async function ensureCaptchaPanels(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (!ctx.enabled('anticontrol')) return;
  const cfg = cfgOf(ctx);
  for (const g of guilds) {
    const channelId = idIn(cfg.captchaChannel, g.id);
    if (!channelId) continue;
    const payload = buildMessage(cfg.captchaPanel, baseVars(g, null)) ?? { content: '🛡️ Verification' };
    payload.components = [row(new ButtonBuilder().setCustomId('bhm:anticaptcha:start').setLabel('I am human').setEmoji('🤖').setStyle(ButtonStyle.Success))];
    await ensurePanel(ctx, 'anticontrol', 'captcha', g, channelId, payload);
  }
}

/**
 * A member must solve the captcha: quarantine role, pending state, a DM
 * with the way. Returns what was done (for the log), or null when the
 * captcha cannot work (no quarantine role or captcha channel).
 */
export async function requireCaptcha(ctx: ModuleContext, member: GuildMember, reason: string): Promise<string | null> {
  const cfg = cfgOf(ctx);
  const role = idIn(cfg.quarantineRole, member.guild.id);
  const channel = idIn(cfg.captchaChannel, member.guild.id);
  if (!role || !channel || !assignable(ctx, 'anticontrol', member.guild, [role]).length) return null;
  const ok = await member.roles.add(role, `AntiControl: captcha (${reason})`.slice(0, 500)).then(() => true, () => false);
  if (!ok) return null;
  ctx.setState('anticontrol', member.guild.id, `cap:${member.id}`, { since: Date.now(), tries: 0 });
  const minutes = Number(cfg.captchaMinutes) || 0;
  await member
    .send({ content: `🛡️ **${member.guild.name}**: please confirm you are human in <#${channel}> (button "I am human")${minutes > 0 ? ` within ${minutes} minutes` : ''}.`, allowedMentions: { parse: [] } })
    .catch(() => undefined);
  return `must solve the captcha in <#${channel}>`;
}

async function fail(ctx: ModuleContext, member: GuildMember, why: string): Promise<string> {
  const action = cfgOf(ctx).captchaFailAction ?? 'kick';
  ctx.deleteState('anticontrol', member.guild.id, `cap:${member.id}`);
  const reason = `AntiControl: captcha ${why}`;
  if (action === 'kick' && member.kickable) return member.kick(reason).then(() => 'kicked', () => 'could not kick');
  if (action === 'ban' && member.bannable) return member.ban({ reason }).then(() => 'banned', () => 'could not ban');
  return 'stays in quarantine';
}

async function pass(ctx: ModuleContext, member: GuildMember): Promise<boolean> {
  const cfg = cfgOf(ctx);
  const q = idIn(cfg.quarantineRole, member.guild.id);
  const v = idIn(cfg.captchaVerifiedRole, member.guild.id);
  if (q && member.roles.cache.has(q)) {
    const ok = await member.roles.remove(q, 'AntiControl: captcha solved').then(() => true, () => false);
    if (!ok) return false;
  }
  if (v && assignable(ctx, 'anticontrol', member.guild, [v]).length) await member.roles.add(v, 'AntiControl: captcha solved').catch(() => undefined);
  ctx.deleteState('anticontrol', member.guild.id, `cap:${member.id}`);
  return true;
}

/** Buttons and the modal of the captcha (custom IDs bhm:anticaptcha:start|enter|check). */
export async function captchaInteraction(ctx: ModuleContext, i: Interaction, log: (guild: Guild, title: string, text: string, color?: number) => Promise<void>): Promise<void> {
  if (!('customId' in i) || !String(i.customId).startsWith('bhm:anticaptcha:') || !i.inCachedGuild()) return;
  const action = String(i.customId).split(':')[2];
  const key = `cap:${i.user.id}`;
  const state = ctx.getState<Pending>('anticontrol', i.guildId, key);
  const reply = (content: string) => (i.isRepliable() ? i.reply({ content, flags: 64 }).then(() => undefined) : Promise.resolve());
  if (!state) return reply('✅ You do not need to verify.');
  if (i.isButton() && action === 'start') {
    const code = captchaCode();
    ctx.setState('anticontrol', i.guildId, key, { ...state, code, expires: Date.now() + CODE_MS });
    const file = new AttachmentBuilder(await renderCaptcha(code), { name: 'captcha.png' });
    await i.reply({
      content: `Type the 5 characters of the picture (${MAX_TRIES - state.tries} tries left).`,
      files: [file],
      components: [row(new ButtonBuilder().setCustomId('bhm:anticaptcha:enter').setLabel('Enter code').setStyle(ButtonStyle.Primary))],
      flags: 64,
    });
    return;
  }
  if (i.isButton() && action === 'enter') {
    const modal = new ModalBuilder().setCustomId('bhm:anticaptcha:check').setTitle('Captcha');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('code').setLabel('Code').setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(12).setRequired(true)));
    await i.showModal(modal);
    return;
  }
  if (i.isModalSubmit() && action === 'check') {
    const ok = !!state.code && (state.expires ?? 0) > Date.now() && codeMatches(state.code, i.fields.getTextInputValue('code'));
    if (ok) {
      const done = await pass(ctx, i.member);
      await reply(done ? '✅ Thank you, you are verified.' : 'The bot cannot take the quarantine role away. Please tell the server team.');
      if (done) await log(i.guild, 'Captcha solved', `<@${i.user.id}> (${i.user.tag}) solved the captcha.`, 0x22c55e);
      return;
    }
    const tries = state.tries + 1;
    if (tries >= MAX_TRIES) {
      await reply('❌ Wrong code, no tries left.');
      const done = await fail(ctx, i.member, 'failed three times');
      await log(i.guild, 'Captcha failed', `<@${i.user.id}> (${i.user.tag}) gave ${MAX_TRIES} wrong codes: ${done}.`, 0xef4444);
      return;
    }
    ctx.setState('anticontrol', i.guildId, key, { since: state.since, tries });
    await reply(`❌ Wrong code. Press "I am human" for a new picture (${MAX_TRIES - tries} tries left).`);
  }
}

/** Every 30 seconds: members who did not solve the captcha in time get the fail action. */
export async function captchaTick(ctx: ModuleContext, guilds: Guild[], log: (guild: Guild, title: string, text: string, color?: number) => Promise<void>, now = Date.now()): Promise<void> {
  const minutes = Number(cfgOf(ctx).captchaMinutes) || 0;
  if (minutes <= 0) return;
  const rows = ctx.db.prepare("SELECT guild_id, key, value FROM module_state WHERE bot_id = ? AND module = 'anticontrol' AND key LIKE 'cap:%'").all(ctx.botId) as { guild_id: string; key: string; value: string }[];
  for (const r of rows) {
    let s: Pending;
    try {
      s = JSON.parse(r.value) as Pending;
    } catch {
      continue;
    }
    if (now - s.since < minutes * 60_000) continue;
    const guild = guilds.find((g) => g.id === r.guild_id);
    if (!guild) continue;
    const member = await guild.members.fetch(r.key.slice(4)).catch(() => null);
    if (!member) {
      ctx.deleteState('anticontrol', guild.id, r.key);
      continue;
    }
    const done = await fail(ctx, member, `not solved within ${minutes} minutes`);
    await log(guild, 'Captcha timed out', `<@${member.id}> (${member.user.tag}) did not solve the captcha within ${minutes} minutes: ${done}.`, 0xf59e0b);
  }
}
