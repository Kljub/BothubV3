// Economy module extras (settings shared/module-settings/economy.json):
// currencies of the dashboard, daily bonus, bank with daily interest,
// currency for messages, lottery, shop with items and inventory, economy
// roles (by wallet balance of the default currency). The builder blocks
// (discord/handlers-modules.ts) and the commands use these functions.

import type { Guild, GuildMember, Message } from 'discord.js';
import { write } from '../core/db.js';
import { idIn, idsIn, type ModuleContext } from './context.js';
import { assignable, send } from './guard.js';

export interface ShopItem {
  key: string; name: string; description: string; price: number; currency: string; limit: number;
  type: 'role' | 'usable' | 'static'; roles: unknown; destroyOnUse: boolean; allowMultiple: boolean; useOnBuy: boolean; unlisted: boolean; image: string;
}

export interface EconomyConfig {
  currencies: { key: string; name: string; emoji: string }[];
  dailyBonus: number;
  bankInterest: number;
  messageRewards: boolean;
  messageCooldown: number;
  messageAmount: number;
  lotteryChannel: unknown;
  lotteryPrice: number;
  lotteryTime: string;
  successColor: string;
  mainColor: string;
  alertColor: string;
  shop: ShopItem[];
  roles: { amount: number; role: unknown }[];
}

const DEFAULTS: EconomyConfig = {
  currencies: [], dailyBonus: 100, bankInterest: 1, messageRewards: false, messageCooldown: 1, messageAmount: 5,
  lotteryChannel: null, lotteryPrice: 100, lotteryTime: '20:00', successColor: '#22c55e', mainColor: '#5865f2', alertColor: '#f59e0b', shop: [], roles: [],
};

/** Error text a command shows ("❌ {error}"). */
export class EconomyError extends Error {}

export const config = (ctx: ModuleContext): EconomyConfig => ({ ...DEFAULTS, ...ctx.config<EconomyConfig>('economy') }) as EconomyConfig;

/** Writes the currencies of the settings into the table (after a save, at start). */
export function syncCurrencies(ctx: ModuleContext): void {
  ctx.repo.syncCurrencies(ctx.botId, config(ctx).currencies ?? []);
}

/** "🪙 1,250" (emoji or prefix of the currency, else its name). */
export function money(ctx: ModuleContext, n: number, currency = ''): string {
  const list = config(ctx).currencies ?? [];
  const c = (currency && list.find((x) => x.key === currency)) || list[0];
  const amount = Math.floor(n).toLocaleString('en-US');
  if (!c) return `🪙 ${amount}`;
  return c.emoji ? `${c.emoji} ${amount}` : `${amount} ${c.name}`;
}

// ---------- bank ----------

/** Interest for whole days at rate % per day (compound, rounded down). */
export function interest(amount: number, ratePct: number, days: number): number {
  if (amount <= 0 || ratePct <= 0 || days <= 0) return 0;
  return Math.floor(amount * ((1 + Math.min(5, ratePct) / 100) ** days - 1));
}

/** The bank amount after adding the interest of every full day since the last time. */
export function bank(ctx: ModuleContext, guild: string, user: string, now = Date.now()): number {
  const currency = ctx.repo.currencyId(ctx.botId);
  return write(ctx.db, () => {
    const row = ctx.db.prepare('SELECT amount, interest_at FROM economy_bank WHERE currency_id = ? AND guild_id = ? AND user_id = ?').get(currency, guild, user) as { amount: number; interest_at: string } | undefined;
    if (!row) return 0;
    const days = Math.floor((now - Date.parse(row.interest_at)) / 86_400_000);
    if (days < 1) return Number(row.amount);
    const amount = Number(row.amount) + interest(Number(row.amount), config(ctx).bankInterest, days);
    const at = new Date(Date.parse(row.interest_at) + days * 86_400_000).toISOString();
    ctx.db.prepare('UPDATE economy_bank SET amount = ?, interest_at = ? WHERE currency_id = ? AND guild_id = ? AND user_id = ?').run(amount, at, currency, guild, user);
    return amount;
  });
}

const amountOf = (v: string, all: number): number => {
  if (String(v).trim().toLowerCase() === 'all') return all;
  const n = Math.floor(Number(v));
  if (!(n >= 1)) throw new EconomyError('Name an amount (a number or "all").');
  return n;
};

export function deposit(ctx: ModuleContext, guild: string, user: string, raw: string): { moved: number; wallet: number; bank: number } {
  const current = bank(ctx, guild, user);
  const wallet = ctx.repo.balance(ctx.botId, guild, user);
  const n = amountOf(raw, wallet);
  if (n < 1 || n > wallet) throw new EconomyError(`You only have ${money(ctx, wallet)} in your wallet.`);
  const currency = ctx.repo.currencyId(ctx.botId);
  write(ctx.db, () => {
    ctx.repo.changeBalance(ctx.botId, guild, user, -n, 'add');
    ctx.db
      .prepare(`INSERT INTO economy_bank (currency_id, guild_id, user_id, amount) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET amount = economy_bank.amount + excluded.amount`)
      .run(currency, guild, user, n);
  });
  return { moved: n, wallet: wallet - n, bank: current + n };
}

export function withdraw(ctx: ModuleContext, guild: string, user: string, raw: string): { moved: number; wallet: number; bank: number } {
  const current = bank(ctx, guild, user);
  const n = amountOf(raw, current);
  if (n < 1 || n > current) throw new EconomyError(`You only have ${money(ctx, current)} in the bank.`);
  const currency = ctx.repo.currencyId(ctx.botId);
  let wallet = 0;
  write(ctx.db, () => {
    ctx.db.prepare('UPDATE economy_bank SET amount = amount - ? WHERE currency_id = ? AND guild_id = ? AND user_id = ?').run(n, currency, guild, user);
    wallet = ctx.repo.changeBalance(ctx.botId, guild, user, n, 'add');
  });
  return { moved: n, wallet, bank: current - n };
}

// ---------- daily ----------

/** The daily bonus once per 24 hours. */
export function daily(ctx: ModuleContext, guild: string, user: string, now = Date.now()): { amount: number; balance: number } {
  const last = ctx.getState<number>('economy', guild, `daily:${user}`) ?? 0;
  if (now - last < 86_400_000) throw new EconomyError(`You already claimed your daily bonus. Next one <t:${Math.floor((last + 86_400_000) / 1000)}:R>.`);
  const amount = Math.max(0, Math.floor(config(ctx).dailyBonus));
  ctx.setState('economy', guild, `daily:${user}`, now);
  return { amount, balance: ctx.repo.changeBalance(ctx.botId, guild, user, amount, 'add') };
}

// ---------- currency for messages ----------

export async function messageReward(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('economy')) return;
  const c = config(ctx);
  if (!c.messageRewards || c.messageAmount <= 0) return;
  const key = `msg:${msg.author.id}`;
  const last = ctx.getState<number>('economy', msg.guildId, key) ?? 0;
  if (Date.now() - last < Math.max(1, c.messageCooldown) * 60_000) return;
  ctx.setState('economy', msg.guildId, key, Date.now());
  ctx.repo.changeBalance(ctx.botId, msg.guildId, msg.author.id, Math.floor(c.messageAmount), 'add');
  if (msg.member) await syncRoles(ctx, msg.member);
}

// ---------- economy roles ----------

/** Roles by wallet balance: given at their amount, taken below it. */
export async function syncRoles(ctx: ModuleContext, member: GuildMember): Promise<void> {
  const list = (config(ctx).roles ?? []).map((r) => ({ amount: Number(r.amount) || 0, role: idIn(r.role, member.guild.id) })).filter((r) => r.role);
  if (!list.length) return;
  const balance = ctx.repo.balance(ctx.botId, member.guild.id, member.id);
  for (const r of list) {
    if (!assignable(ctx, 'economy', member.guild, [r.role!]).length) continue;
    const has = member.roles.cache.has(r.role!);
    if (balance >= r.amount && !has) await member.roles.add(r.role!, 'Economy role').catch(() => undefined);
    if (balance < r.amount && has) await member.roles.remove(r.role!, 'Economy role').catch(() => undefined);
  }
}

// ---------- shop and inventory ----------

export function items(ctx: ModuleContext, withUnlisted = false): ShopItem[] {
  return (config(ctx).shop ?? []).filter((i) => i && i.key && (withUnlisted || !i.unlisted));
}

export function findItem(ctx: ModuleContext, name: string): ShopItem | undefined {
  const n = String(name ?? '').trim().toLowerCase();
  return items(ctx, true).find((i) => i.key.toLowerCase() === n || i.name.toLowerCase() === n);
}

export function owned(ctx: ModuleContext, guild: string, user: string): { item: string; qty: number }[] {
  return (ctx.db.prepare('SELECT item, qty FROM economy_inventory WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND qty > 0 ORDER BY item').all(ctx.botId, guild, user) as { item: string; qty: number }[])
    .map((r) => ({ item: r.item, qty: Number(r.qty) }));
}

const qtyOf = (ctx: ModuleContext, guild: string, user: string, item: string): number =>
  Number((ctx.db.prepare('SELECT qty FROM economy_inventory WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND item = ?').get(ctx.botId, guild, user, item) as { qty: number } | undefined)?.qty ?? 0);

const setQty = (ctx: ModuleContext, guild: string, user: string, item: string, qty: number) =>
  ctx.db.prepare('INSERT INTO economy_inventory (bot_id, guild_id, user_id, item, qty) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET qty = excluded.qty').run(ctx.botId, guild, user, item, Math.max(0, qty));

/** Buys an item (several when it allows that); "use on buy" uses it at once. */
export async function buy(ctx: ModuleContext, guild: Guild, member: GuildMember, name: string, count = 1): Promise<{ item: ShopItem; qty: number; cost: number; balance: number; used: string }> {
  const item = findItem(ctx, name);
  if (!item || item.unlisted) throw new EconomyError('This item is not in the shop. See /shop view.');
  const qty = Math.max(1, Math.floor(count) || 1);
  const have = qtyOf(ctx, guild.id, member.id, item.key);
  if (!item.allowMultiple && have + qty > 1) throw new EconomyError(`You can own only one ${item.name}.`);
  if (item.limit > 0 && have + qty > item.limit) throw new EconomyError(`You can own at most ${item.limit} × ${item.name}.`);
  const cost = Math.max(0, Math.floor(item.price)) * qty;
  const wallet = ctx.repo.balance(ctx.botId, guild.id, member.id, item.currency || null);
  if (wallet < cost) throw new EconomyError(`${item.name} costs ${money(ctx, cost, item.currency)}; you have ${money(ctx, wallet, item.currency)}.`);
  const balance = write(ctx.db, () => {
    setQty(ctx, guild.id, member.id, item.key, have + qty);
    return ctx.repo.changeBalance(ctx.botId, guild.id, member.id, -cost, 'add', item.currency || null);
  });
  const used = item.useOnBuy && item.type !== 'static' ? await use(ctx, guild, member, item.key) : '';
  await syncRoles(ctx, member);
  return { item, qty, cost, balance, used };
}

/** Uses an owned item: role and usable items give their roles; "destroy on use" takes one. */
export async function use(ctx: ModuleContext, guild: Guild, member: GuildMember, name: string): Promise<string> {
  const item = findItem(ctx, name);
  if (!item) throw new EconomyError('Unknown item.');
  if (qtyOf(ctx, guild.id, member.id, item.key) < 1) throw new EconomyError(`You do not own ${item.name}.`);
  if (item.type === 'static') throw new EconomyError(`${item.name} cannot be used.`);
  const roles = assignable(ctx, 'economy', guild, idsIn(item.roles, guild.id));
  for (const r of roles) await member.roles.add(r, `Economy item ${item.name}`).catch(() => undefined);
  if (item.destroyOnUse) setQty(ctx, guild.id, member.id, item.key, qtyOf(ctx, guild.id, member.id, item.key) - 1);
  return `${item.name} used${roles.length ? `: ${roles.map((r) => `<@&${r}>`).join(' ')}` : ''}.`;
}

// ---------- lottery ----------

interface Lottery { tickets: Record<string, number>; pot: number }

export function lottery(ctx: ModuleContext, guild: string): Lottery {
  return ctx.getState<Lottery>('economy', guild, 'lottery') ?? { tickets: {}, pot: 0 };
}

export function buyTickets(ctx: ModuleContext, guild: string, user: string, count: number): Lottery & { mine: number; balance: number } {
  const c = config(ctx);
  if (!idIn(c.lotteryChannel, guild)) throw new EconomyError('There is no lottery on this server.');
  const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
  const cost = Math.max(0, Math.floor(c.lotteryPrice)) * n;
  const wallet = ctx.repo.balance(ctx.botId, guild, user);
  if (wallet < cost) throw new EconomyError(`${n} ticket(s) cost ${money(ctx, cost)}; you have ${money(ctx, wallet)}.`);
  const balance = ctx.repo.changeBalance(ctx.botId, guild, user, -cost, 'add');
  const l = lottery(ctx, guild);
  l.tickets[user] = (l.tickets[user] ?? 0) + n;
  l.pot += cost;
  ctx.setState('economy', guild, 'lottery', l);
  return { ...l, mine: l.tickets[user], balance };
}

/** The winner: chance by tickets. */
export function drawWinner(tickets: Record<string, number>, rng = Math.random): string | null {
  const entries = Object.entries(tickets).filter(([, n]) => n > 0);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  let r = rng() * total;
  for (const [user, n] of entries) {
    if (r < n) return user;
    r -= n;
  }
  return entries.at(-1)![0];
}

/** Daily draw at lotteryTime (bot time zone): pays the pot and announces the winner. */
export async function lotteryDraw(ctx: ModuleContext, guilds: Guild[], local: { date: string; hms: string }): Promise<void> {
  if (!ctx.enabled('economy')) return;
  const c = config(ctx);
  if (local.hms.slice(0, 5) < (c.lotteryTime || '20:00')) return;
  for (const guild of guilds) {
    const channelId = idIn(c.lotteryChannel, guild.id);
    if (!channelId || ctx.getState<string>('economy', guild.id, 'lottery_day') === local.date) continue;
    ctx.setState('economy', guild.id, 'lottery_day', local.date);
    const l = lottery(ctx, guild.id);
    const winner = drawWinner(l.tickets);
    if (!winner) continue;
    ctx.repo.changeBalance(ctx.botId, guild.id, winner, l.pot, 'add');
    ctx.deleteState('economy', guild.id, 'lottery');
    const channel = guild.channels.cache.get(channelId);
    if (channel?.isSendable()) {
      const tickets = Object.values(l.tickets).reduce((s, n) => s + n, 0);
      await send(ctx, 'economy', channel, { embeds: [{ color: parseInt(c.successColor.slice(1), 16) || 0x22c55e, title: '🎟️ Lottery', description: `<@${winner}> wins the pot of **${money(ctx, l.pot)}**! (${tickets} tickets)` }], allowedMentions: { users: [winner] } });
    }
  }
}
