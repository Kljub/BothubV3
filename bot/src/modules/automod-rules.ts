// Automod → own rules: checks Discord's AutoMod cannot do (caps, emojis,
// repeated messages, attachments, new accounts …), run by the bot on new
// and edited messages. A rule matches when one of its triggers fires and
// every condition passes; then all its effects run.

import { PermissionFlagsBits, type GuildMember, type Message, type PartialMessage } from 'discord.js';
import { baseVars, fill, idsIn, passes, type ModuleContext } from './context.js';
import { warn } from './guard.js';
import { tempNotice } from './messages.js';

export interface FilterRule {
  _id?: string;
  name: string;
  triggers: string[]; // words, regex, links, invites, attachments, caps, emojis, mentions, repeat, newlines
  words: string[];
  pattern: string;
  allowedDomains: string[];
  threshold: number;
  repeatSeconds: number;
  maxAccountDays: number; // 0: any account
  maxMemberDays: number; // 0: any member
  channelMode: string;
  channels: unknown;
  exemptRoles: unknown;
  effects: string[]; // delete, warn, timeout, kick, ban, notice, alert
  timeoutMinutes: number;
  notice: string;
  countHit: boolean;
  checkStaff: boolean;
}

/** The parts of a message a rule looks at. */
export interface RuleInput {
  content: string;
  attachments: number;
  mentions: number;
  /** Seconds since the same text was sent by the same member, newest first (repeat trigger). */
  sameBefore: number[];
}

const URL_RE = /https?:\/\/([^\s/?#<>]+)[^\s<>]*/gi;
const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/i;
const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;

function domainAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return allowed.some((a) => {
    const d = a.trim().toLowerCase().replace(/^\*?\.?/, '').replace(/^www\./, '');
    return !!d && (h === d || h.endsWith(`.${d}`));
  });
}

/**
 * Builds a regex from "/pattern/flags" or a plain pattern (case does not
 * matter); null when invalid, too long or with a nested quantifier such as
 * (a+)+ that can hang the bot on a long message.
 */
export function ruleRegex(pattern: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern.trim());
  try {
    if (pattern.length > 300 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern)) return null;
    return m ? new RegExp(m[1]!, m[2]!.replace(/[^imsu]/g, '')) : new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Which triggers of the rule fire for this message (pure). */
export function firedTriggers(rule: Partial<FilterRule>, m: RuleInput): string[] {
  const text = m.content;
  const lower = text.toLowerCase();
  const n = Math.max(1, rule.threshold ?? 1);
  const fired: string[] = [];
  for (const t of rule.triggers ?? []) {
    let hit = false;
    if (t === 'words') {
      hit = (rule.words ?? []).some((w) => {
        const word = w.trim().toLowerCase();
        if (!word) return false;
        // "*" at the ends: part of a word; otherwise the whole word.
        const core = word.replace(/^\*|\*$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`${word.startsWith('*') ? '' : '(?<![\\p{L}\\p{N}])'}${core}${word.endsWith('*') ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu');
        return re.test(lower);
      });
    } else if (t === 'regex') hit = !!rule.pattern && !!ruleRegex(rule.pattern)?.test(text);
    else if (t === 'links') hit = [...text.matchAll(URL_RE)].some((x) => !domainAllowed(x[1]!, rule.allowedDomains ?? []));
    else if (t === 'invites') hit = INVITE_RE.test(text);
    else if (t === 'attachments') hit = m.attachments >= n;
    else if (t === 'mentions') hit = m.mentions >= n;
    else if (t === 'emojis') hit = (text.match(EMOJI_RE) ?? []).length >= n;
    else if (t === 'newlines') hit = text.split('\n').length - 1 >= n;
    else if (t === 'caps') {
      // n is a percentage of the letters; short messages do not count.
      const letters = text.replace(/<[^>]+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
      const upper = letters.filter((c) => c !== c.toLowerCase()).length;
      hit = letters.length >= 10 && (upper / letters.length) * 100 >= Math.min(100, n);
    } else if (t === 'repeat') {
      const within = Math.max(5, rule.repeatSeconds ?? 60);
      hit = m.sameBefore.filter((s) => s <= within).length + 1 >= Math.max(2, n);
    }
    if (hit) fired.push(t);
  }
  return fired;
}

/** Conditions on the member (pure): account and membership age. */
export function memberConditions(rule: Partial<FilterRule>, accountAgeDays: number, memberDays: number): boolean {
  if ((rule.maxAccountDays ?? 0) > 0 && accountAgeDays >= rule.maxAccountDays!) return false;
  if ((rule.maxMemberDays ?? 0) > 0 && memberDays >= rule.maxMemberDays!) return false;
  return true;
}

// Recent texts per member for the repeat trigger: text hash → times.
const recent = new Map<string, { text: string; at: number }[]>();

function remember(key: string, text: string, now: number): number[] {
  const list = (recent.get(key) ?? []).filter((x) => now - x.at < 600_000);
  const before = list.filter((x) => x.text === text).map((x) => (now - x.at) / 1000).reverse();
  list.push({ text, at: now });
  recent.set(key, list.slice(-20));
  return before;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recent) if (!v.some((x) => now - x.at < 600_000)) recent.delete(k);
}, 300_000).unref();

const day = 86_400_000;

/**
 * Runs the own rules on a message. Returns true when a rule deleted it.
 * countHit: the module's hit counter (punishments after repeated hits).
 */
export async function automodRules(ctx: ModuleContext, msg: Message | PartialMessage, countHit: (userId: string) => Promise<void>, alert: (text: string) => Promise<void>): Promise<boolean> {
  if (msg.partial || !msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('automod')) return false;
  const rules = (ctx.config<{ rules: FilterRule[] }>('automod').rules ?? []).filter((r) => (r.triggers ?? []).length && (r.effects ?? []).length);
  if (!rules.length) return false;
  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!member) return false;
  const guildId = msg.guildId;
  const now = Date.now();
  const sameBefore = msg.editedTimestamp ? [] : remember(`${ctx.botId}:${guildId}:${member.id}`, msg.content.trim().toLowerCase(), now);
  const input: RuleInput = { content: msg.content, attachments: msg.attachments.size, mentions: msg.mentions.users.size + msg.mentions.roles.size + (msg.mentions.everyone ? 1 : 0), sameBefore };
  const channels = [msg.channelId, ...(msg.channel.isThread() && msg.channel.parentId ? [msg.channel.parentId] : [])];
  const staff = member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator);
  for (const rule of rules) {
    if (staff && !rule.checkStaff) continue;
    if (!passes(rule.channelMode, idsIn(rule.channels, guildId), channels)) continue;
    if (idsIn(rule.exemptRoles, guildId).some((r) => member.roles.cache.has(r))) continue;
    if (!memberConditions(rule, (now - member.user.createdTimestamp) / day, member.joinedTimestamp ? (now - member.joinedTimestamp) / day : 0)) continue;
    const fired = firedTriggers(rule, input);
    if (!fired.length) continue;
    const deleted = await applyEffects(ctx, msg, member, rule, fired, countHit, alert);
    if (deleted) return true;
  }
  return false;
}

async function applyEffects(ctx: ModuleContext, msg: Message<true>, member: GuildMember, rule: FilterRule, fired: string[], countHit: (userId: string) => Promise<void>, alert: (text: string) => Promise<void>): Promise<boolean> {
  const effects = new Set(rule.effects);
  const reason = `Automod rule "${rule.name || 'rule'}" (${fired.join(', ')})`.slice(0, 500);
  const auto = { guildId: msg.guildId, userId: member.id, moderatorId: msg.client.user.id, reason, auto: true };
  let deleted = false;
  if (effects.has('delete')) {
    deleted = await msg.delete().then(() => true, () => false);
    if (!deleted) warn(ctx, 'WAR-2008', { module: 'automod', problem: `rule "${rule.name}": cannot delete messages in #${'name' in msg.channel ? msg.channel.name : msg.channelId} (needs Manage Messages)` });
  }
  if (effects.has('warn')) {
    ctx.repo.addWarning(ctx.botId, msg.guildId, member.id, msg.client.user.id, reason);
    ctx.repo.addCase(ctx.botId, { ...auto, action: 'warn', duration: '' });
  }
  if (effects.has('ban') && member.bannable) {
    if (await member.ban({ reason, deleteMessageSeconds: 3600 }).then(() => true, () => false)) ctx.repo.addCase(ctx.botId, { ...auto, action: 'ban', duration: '' });
  } else if (effects.has('kick') && member.kickable) {
    if (await member.kick(reason).then(() => true, () => false)) ctx.repo.addCase(ctx.botId, { ...auto, action: 'kick', duration: '' });
  } else if (effects.has('timeout') && member.moderatable) {
    const minutes = Math.min(40320, Math.max(1, rule.timeoutMinutes ?? 10));
    if (await member.timeout(minutes * 60_000, reason).then(() => true, () => false)) ctx.repo.addCase(ctx.botId, { ...auto, action: 'timeout', duration: `${minutes}m` });
  }
  const vars = { ...baseVars(msg.guild, member), rule: rule.name ?? '', trigger: fired.join(', ') };
  if (effects.has('notice') && msg.channel.isSendable()) {
    await tempNotice(ctx, 'automod', msg.channel, fill(rule.notice || '{user.mention}, your message broke the rule "{rule}".', vars), 10_000);
  }
  if (effects.has('alert')) {
    await alert(`🛡️ **${rule.name || 'Automod rule'}** · <@${member.id}> in <#${msg.channelId}> · ${fired.join(', ')}${deleted ? ' · deleted' : ''}\n>>> ${msg.content.slice(0, 900) || '(no text)'}`);
  }
  if (rule.countHit) await countHit(member.id);
  return deleted;
}
