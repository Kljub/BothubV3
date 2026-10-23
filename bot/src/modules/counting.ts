// Counting (module "counting"): members count up together in a channel, one
// number each. The main rules hold for "channels"; "boards" are more
// channels with their own rules. Per channel in module_state "ch:<id>"
// (count, last member, record, saves), per member "m:<id>" (right and wrong
// numbers, for /count me and /count top).

import { PermissionFlagsBits, type Message } from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, fill, idIn, idsIn, reactionOf, type ModuleContext } from './context.js';
import { assignable, send, warn } from './guard.js';
import { canUseWebhook, forgetWebhook, ownWebhook } from '../discord/webhooks.js';

export interface CountState {
  count: number;
  lastUser: string | null;
  lastAt: number;
  /** Highest count the channel reached. */
  record?: number;
  /** Saves left; missing = the channel's starting saves. */
  saves?: number;
}

export interface CountRules {
  maths?: boolean;
  allowTwice?: boolean;
  /** Wait between two counts of the channel; 0 = none. */
  cooldownSeconds?: number;
  onFail?: 'reset' | 'checkpoint' | 'keep';
  checkpointEvery?: number;
  saves?: number;
  saveEvery?: number;
}

export interface CountBoard extends CountRules {
  channels?: unknown;
  mode?: string;
  react?: boolean;
  emoji?: string[];
  talk?: boolean;
  errors?: boolean;
  wrongMessage?: string;
  saveMessage?: string;
  twiceMessage?: string;
  cooldownMessage?: string;
  milestoneEvery?: number;
  milestoneMessage?: string;
  milestoneRole?: unknown;
  recordMessage?: string;
}

interface CountingConfig extends CountBoard {
  boards?: (CountBoard & { enabled?: boolean })[];
}

export type CountResult =
  | { kind: 'ignore' }
  | { kind: 'ok'; state: CountState; expected: number; milestone: boolean; record: boolean }
  | { kind: 'wrong' | 'saved' | 'twice' | 'cooldown'; state: CountState; expected: number; at: number };

const MAX_COUNT = 1e15;

/**
 * The number of a message: a whole number, with maths also a sum like 6*7.
 * null when the message is no count (normal chat).
 */
export function countValue(content: string, maths: boolean): number | null {
  const text = content.trim();
  if (/^-?\d{1,15}$/.test(text)) return Number(text);
  if (!maths || text.length > 60 || !/\d/.test(text) || !/^[\d\s+\-*/x×÷^%().,]+$/i.test(text)) return null;
  const value = evaluate(text);
  if (value === null || !Number.isFinite(value) || Math.abs(value) > MAX_COUNT) return null;
  const whole = Math.round(value);
  return Math.abs(value - whole) < 1e-9 ? whole : null;
}

/** Small maths parser: + - * / x × ÷ % ^ and brackets, no names, no calls. */
function evaluate(text: string): number | null {
  const tokens = text.replace(/,/g, '.').match(/\d+(\.\d+)?|[+\-*/x×÷^%()]/gi);
  if (!tokens || tokens.join('') !== text.replace(/,/g, '.').replace(/\s+/g, '')) return null;
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i]?.toLowerCase();
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    for (let op = peek(); op === '*' || op === 'x' || op === '×' || op === '/' || op === '÷' || op === '%'; op = peek()) {
      i++;
      const r = power();
      if ((op === '/' || op === '÷' || op === '%') && r === 0) throw new Error('division by zero');
      v = op === '/' || op === '÷' ? v / r : op === '%' ? v % r : v * r;
    }
    return v;
  };
  const power = (): number => {
    const base = unary();
    if (peek() !== '^') return base;
    i++;
    return base ** power();
  };
  const unary = (): number => {
    if (peek() === '-') {
      i++;
      return -unary();
    }
    if (peek() === '+') {
      i++;
      return unary();
    }
    if (peek() === '(') {
      i++;
      if (++depth > 10) throw new Error('too deep');
      const v = expr();
      if (tokens[i++] !== ')') throw new Error('missing )');
      depth--;
      return v;
    }
    const t = tokens[i++];
    if (t === undefined || !/^\d/.test(t)) throw new Error('number expected');
    return Number(t);
  };
  try {
    const v = expr();
    return i === tokens.length ? v : null;
  } catch {
    return null;
  }
}

/** Decides one message of a counting channel. Messages that are no number are ignored. */
export function count(state: CountState, content: string, userId: string, now: number, rules: CountRules, milestoneEvery = 0): CountResult {
  const n = countValue(content, rules.maths === true);
  if (n === null) return { kind: 'ignore' };
  const expected = state.count + 1;
  const cooldown = Math.max(0, Number(rules.cooldownSeconds ?? 0)) * 1000;
  if (cooldown && now - state.lastAt < cooldown) return { kind: 'cooldown', state, expected, at: state.count };
  if (!rules.allowTwice && state.lastUser === userId) return { kind: 'twice', state, expected, at: state.count };
  const maxSaves = Math.max(0, Number(rules.saves ?? 0));
  const saves = Math.min(state.saves ?? maxSaves, maxSaves);
  if (n !== expected) {
    if (saves > 0) {
      const next = { ...state, saves: saves - 1 };
      return { kind: 'saved', state: next, expected, at: state.count };
    }
    const onFail = rules.onFail ?? 'reset';
    let back = state.count;
    if (onFail === 'reset') back = 0;
    if (onFail === 'checkpoint') {
      const every = Math.max(1, Number(rules.checkpointEvery ?? 100));
      back = Math.floor(state.count / every) * every;
    }
    const next: CountState = onFail === 'keep' ? state : { ...state, count: back, lastUser: null, lastAt: now };
    return { kind: 'wrong', state: next, expected: next.count + 1, at: state.count };
  }
  const record = state.record ?? 0;
  // A save comes back every saveEvery numbers, up to the starting saves.
  const every = Math.max(0, Number(rules.saveEvery ?? 0));
  const earned = every > 0 && n % every === 0 && saves < maxSaves ? saves + 1 : saves;
  const next: CountState = { count: n, lastUser: userId, lastAt: now, record: Math.max(record, n), saves: earned };
  return { kind: 'ok', state: next, expected: n + 1, milestone: milestoneEvery > 0 && n % milestoneEvery === 0, record: record > 0 && n === record + 1 };
}

const cfgOf = (ctx: ModuleContext): CountingConfig => ctx.config<CountingConfig>('counting');

/** The rules of a channel: the main rules, else the first active board with the channel; null = no counting channel. */
export function boardOf(cfg: CountingConfig, guildId: string, channelId: string): CountBoard | null {
  if (idsIn(cfg.channels, guildId).includes(channelId)) return cfg;
  return (cfg.boards ?? []).find((b) => b.enabled !== false && idsIn(b.channels, guildId).includes(channelId)) ?? null;
}

/** All counting channels of a server, main ones first. */
export function countingChannels(ctx: ModuleContext, guildId: string): string[] {
  const cfg = cfgOf(ctx);
  const out = idsIn(cfg.channels, guildId);
  for (const b of cfg.boards ?? []) if (b.enabled !== false) for (const id of idsIn(b.channels, guildId)) if (!out.includes(id)) out.push(id);
  return out;
}

interface MemberStats {
  ok: number;
  wrong: number;
}

const stateKey = (channelId: string) => `ch:${channelId}`;

function stateOf(ctx: ModuleContext, guildId: string, channelId: string, board: CountBoard): CountState {
  const s = ctx.getState<CountState>('counting', guildId, stateKey(channelId)) ?? { count: 0, lastUser: null, lastAt: 0 };
  return { ...s, record: s.record ?? s.count, saves: s.saves ?? Math.max(0, Number(board.saves ?? 0)) };
}

function addStats(ctx: ModuleContext, guildId: string, userId: string, field: keyof MemberStats): void {
  const s = ctx.getState<MemberStats>('counting', guildId, `m:${userId}`) ?? { ok: 0, wrong: 0 };
  s[field] = (s[field] ?? 0) + 1;
  ctx.setState('counting', guildId, `m:${userId}`, s);
}

// ---------- blocks (/count next, /count top, /count me, /count-staff) ----------

export interface ChannelCount {
  channel: string;
  count: number;
  next: number;
  record: number;
  saves: number;
  lastUser: string | null;
}

/** The count of a counting channel, or null when the channel does not count. */
export function channelCount(ctx: ModuleContext, guildId: string, channelId: string): ChannelCount | null {
  const board = boardOf(cfgOf(ctx), guildId, channelId);
  if (!board) return null;
  const s = stateOf(ctx, guildId, channelId, board);
  return { channel: channelId, count: s.count, next: s.count + 1, record: s.record ?? s.count, saves: s.saves ?? 0, lastUser: s.lastUser };
}

/** Staff: sets the count (0 = start again). The next number is n + 1; the record stays. */
export function setCount(ctx: ModuleContext, guildId: string, channelId: string, n: number): ChannelCount | null {
  const board = boardOf(cfgOf(ctx), guildId, channelId);
  if (!board) return null;
  const s = stateOf(ctx, guildId, channelId, board);
  const value = Math.max(0, Math.min(MAX_COUNT, Math.trunc(n)));
  ctx.setState('counting', guildId, stateKey(channelId), { ...s, count: value, lastUser: null, lastAt: 0, record: Math.max(s.record ?? 0, value) });
  return channelCount(ctx, guildId, channelId);
}

export function memberCount(ctx: ModuleContext, guildId: string, userId: string): MemberStats & { rank: number } {
  const s = ctx.getState<MemberStats>('counting', guildId, `m:${userId}`) ?? { ok: 0, wrong: 0 };
  if (!s.ok) return { ok: 0, wrong: s.wrong ?? 0, rank: 0 };
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS c FROM module_state WHERE bot_id = ? AND module = 'counting' AND guild_id = ? AND key LIKE 'm:%' AND json_extract(value, '$.ok') > ?`)
    .get(ctx.botId, guildId, s.ok) as { c: number };
  return { ok: s.ok, wrong: s.wrong ?? 0, rank: Number(row.c) + 1 };
}

/** Members with the most right numbers. */
export function countTop(ctx: ModuleContext, guildId: string, limit: number): { userId: string; ok: number }[] {
  return (
    ctx.db
      .prepare(
        `SELECT key, json_extract(value, '$.ok') AS ok FROM module_state WHERE bot_id = ? AND module = 'counting' AND guild_id = ? AND key LIKE 'm:%'
         AND json_extract(value, '$.ok') > 0 ORDER BY ok DESC, updated_at ASC LIMIT ?`,
      )
      .all(ctx.botId, guildId, Math.max(1, Math.min(50, limit))) as { key: string; ok: number }[]
  ).map((r) => ({ userId: r.key.slice(2), ok: Number(r.ok) || 0 }));
}

// ---------- messages ----------

const countQueue = new Map<string, Promise<unknown>>();

/** Counting runs one message after another per channel. */
export function onCountingMessage(ctx: ModuleContext, msg: Message): void {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('counting')) return;
  const board = boardOf(cfgOf(ctx), msg.guildId, msg.channelId);
  if (!board) return;
  const key = `${ctx.botId}:${msg.channelId}`;
  const run = (countQueue.get(key) ?? Promise.resolve()).then(() => handle(ctx, msg as Message<true>, board));
  const tail = run.catch((err) => log.debug('counting failed', { err: String(err) }));
  countQueue.set(key, tail);
  void tail.then(() => {
    if (countQueue.get(key) === tail) countQueue.delete(key);
  });
}

async function handle(ctx: ModuleContext, msg: Message<true>, board: CountBoard): Promise<void> {
  const state = stateOf(ctx, msg.guildId, msg.channelId, board);
  const res = count(state, msg.content, msg.author.id, Date.now(), board, Math.max(0, Number(board.milestoneEvery ?? 0)));
  if (res.kind === 'ignore') {
    // "Members may talk" off: chat is deleted, except for members who manage messages.
    if (board.talk === false && !msg.member?.permissionsIn(msg.channel).has(PermissionFlagsBits.ManageMessages)) await msg.delete().catch(() => undefined);
    return;
  }
  ctx.setState('counting', msg.guildId, stateKey(msg.channelId), res.state);
  const vars = {
    ...baseVars(msg.guild, msg.member),
    count: String(res.kind === 'ok' ? res.state.count : res.at),
    'count.next': String(res.expected),
    record: String(res.state.record ?? 0),
    saves: String(res.state.saves ?? 0),
  };

  if (res.kind === 'ok') {
    addStats(ctx, msg.guildId, msg.author.id, 'ok');
    if (!(board.mode === 'webhook' && (await repost(ctx, msg)))) {
      if (board.react !== false) await msg.react(reactionOf((board.emoji ?? [])[0] || '✅')).catch(() => undefined);
    }
    if (res.milestone) await milestone(ctx, msg, board, vars);
    if (res.record && board.recordMessage?.trim()) await send(ctx, 'counting', msg.channel, { content: fill(board.recordMessage, vars).slice(0, 2000), allowedMentions: { parse: [] } });
    return;
  }

  if (res.kind === 'wrong' || res.kind === 'saved') addStats(ctx, msg.guildId, msg.author.id, 'wrong');
  // A wrong number stays visible (with ❌) where the count broke; else it is removed.
  const keepMessage = res.kind === 'saved' || (res.kind === 'wrong' && board.onFail !== 'keep');
  await (keepMessage ? msg.react('❌').catch(() => undefined) : msg.delete().catch(() => undefined));
  if (board.errors === false) return;
  const text = res.kind === 'wrong' ? board.wrongMessage : res.kind === 'saved' ? board.saveMessage : res.kind === 'twice' ? board.twiceMessage : board.cooldownMessage;
  const sent = text?.trim() ? await send(ctx, 'counting', msg.channel, { content: fill(text, vars).slice(0, 2000), allowedMentions: { parse: ['users'] } }) : null;
  if (sent) setTimeout(() => void sent.delete().catch(() => undefined), 5000).unref();
}

/** Webhook mode: the count is posted again with the member's name and picture. False = could not, keep the message. */
async function repost(ctx: ModuleContext, msg: Message<true>): Promise<boolean> {
  const canDelete = msg.guild.members.me?.permissionsIn(msg.channel).has(PermissionFlagsBits.ManageMessages) ?? false;
  if (!canDelete || !canUseWebhook(msg.channel)) {
    warn(ctx, 'WAR-2008', { module: 'counting', problem: 'webhook mode needs Manage Webhooks and Manage Messages; counting falls back to normal mode' });
    return false;
  }
  const target = await ownWebhook(msg.channel).catch(() => null);
  if (!target) return false;
  const post = { content: msg.content, username: msg.member?.displayName ?? msg.author.username, avatarURL: msg.member?.displayAvatarURL() ?? msg.author.displayAvatarURL(), allowedMentions: { parse: [] }, threadId: target.threadId };
  const sent = await target.hook.send(post).catch((err: { code?: number }) => {
    if (err.code === 10015) forgetWebhook(target.hook.channelId);
    return null;
  });
  if (!sent) return false;
  await msg.delete().catch(() => undefined);
  return true;
}

async function milestone(ctx: ModuleContext, msg: Message<true>, board: CountBoard, vars: Record<string, string>): Promise<void> {
  if (board.milestoneMessage?.trim()) await send(ctx, 'counting', msg.channel, { content: fill(board.milestoneMessage, vars).slice(0, 2000), allowedMentions: { parse: ['users'] } });
  const role = idIn(board.milestoneRole, msg.guildId);
  if (!role || !msg.member || msg.member.roles.cache.has(role)) return;
  const roles = assignable(ctx, 'counting', msg.guild, [role]);
  if (roles.length) await msg.member.roles.add(roles, `Counting milestone ${vars.count}`).catch(() => undefined);
}
