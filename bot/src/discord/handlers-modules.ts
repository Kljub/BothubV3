// Builder blocks of the ready-made modules: Leveling, Birthdays, Invite
// Tracker, Suggestions. They use the same tables and settings as the
// modules (bot/src/modules), so a command built from these blocks and the
// module itself see the same data.

import type { Guild, GuildMember } from 'discord.js';
import type { Repo } from '../core/repo.js';
import { GraphError, type Handler, type Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { snowflake } from '../graph/util.js';
import { createSuggestion, decideSuggestion, levelFor } from '../modules/community.js';
import { ModuleContext } from '../modules/context.js';
import * as eco from '../modules/economy.js';
import { afkOf, clearAfk, setAfk } from '../modules/afk.js';
import { giveThanks, thanksOf, thanksRank, thanksTop, ThanksError } from '../modules/thanks.js';
import type { DiscordData } from './handlers.js';

function guildOf(run: Run): Guild {
  const guild = (run.data as unknown as DiscordData).guild;
  if (!guild) throw new GraphError('error.run.no_server');
  return guild;
}

function userOf(run: Run, node: GraphNode, key = 'user'): string {
  return snowflake(run.str(node, key) || (run.vars.get('user.id') ?? ''), key);
}

function memberOf(run: Run): GuildMember {
  const member = (run.data as unknown as DiscordData).member;
  if (!member) throw new GraphError('error.run.no_server');
  return member;
}

/** Economy errors become the text of {error} ("❌ {error}" in the presets). */
async function econ(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof eco.EconomyError) throw new GraphError('error.run.economy', { message: err.message });
    if (err instanceof Error && err.message === 'economy.unknown_currency') throw new GraphError('error.run.economy', { message: 'Unknown currency.' });
    throw err;
  }
}

function limitOf(run: Run, node: GraphNode): number {
  return Math.min(50, Math.max(1, Math.floor(Number(run.str(node, 'limit')) || 10)));
}

/** "24.12.", "24.12.1990", "1990-12-24", "24/12", "24/12/1990" -> {day, month, year}. */
export function parseBirthday(text: string, now = new Date()): { day: number; month: number; year: number | null } {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  let day: number, month: number, year: number | null;
  if (m) [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{1,2})[./](\d{1,2})\.?(?:[./](\d{4}))?$/.exec(t);
    if (!m) throw new GraphError('error.run.bad_date', { value: text });
    [day, month, year] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null];
  }
  const probe = new Date(Date.UTC(year ?? 2000, month - 1, day)); // 2000 is a leap year: 29.02. is fine
  if (month < 1 || month > 12 || probe.getUTCDate() !== day || (year !== null && (year < 1900 || year > now.getUTCFullYear()))) {
    throw new GraphError('error.run.bad_date', { value: text });
  }
  return { day, month, year };
}

/** Days from today to the next birthday (0 = today). */
export function daysUntil(month: number, day: number, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let next = Date.UTC(now.getUTCFullYear(), month - 1, day);
  if (next < today) next = Date.UTC(now.getUTCFullYear() + 1, month - 1, day);
  return Math.round((next - today) / 86_400_000);
}

export function moduleHandlers(repo: Repo, botId: number): Map<string, Handler> {
  const ctx = new ModuleContext(botId, repo);
  const db = repo.db;
  // Economy roles after a change by a block.
  const syncMember = async (run: Run) => {
    const member = (run.data as unknown as DiscordData).member;
    if (member) await eco.syncRoles(ctx, member);
  };
  const levelCfg = () => ctx.config<{ baseXp: number; stepXp: number; maxLevel: number }>('leveling');
  const inviteStats = (guildId: string, userId: string) =>
    db
      .prepare(
        `SELECT SUM(CASE WHEN fake = 0 AND left_at IS NULL THEN 1 ELSE 0 END) AS total, SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END) AS gone
         FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND inviter_id = ? AND reset_at IS NULL`,
      )
      .get(botId, guildId, userId) as { total: number | null; gone: number | null };

  return new Map<string, Handler>([
    // --- economy extras (modules/economy.ts): readable errors for "❌ {error}" ---
    ['action.economy_daily', (node, run) => econ(() => {
      const r = eco.daily(ctx, guildOf(run).id, userOf(run, node));
      run.setResult(node, '', eco.money(ctx, r.amount));
      run.setResult(node, '.balance', eco.money(ctx, r.balance));
      return syncMember(run);
    })],
    ['action.economy_bank', (node, run) => econ(() => {
      const guild = guildOf(run).id;
      const user = userOf(run, node);
      const mode = run.str(node, 'mode') || 'show';
      const r = mode === 'deposit' ? eco.deposit(ctx, guild, user, run.str(node, 'amount'))
        : mode === 'withdraw' ? eco.withdraw(ctx, guild, user, run.str(node, 'amount'))
          : { moved: 0, wallet: repo.balance(botId, guild, user), bank: eco.bank(ctx, guild, user) };
      run.setResult(node, '', eco.money(ctx, r.moved));
      run.setResult(node, '.wallet', eco.money(ctx, r.wallet));
      run.setResult(node, '.bank', eco.money(ctx, r.bank));
      run.setResult(node, '.interest', `${eco.config(ctx).bankInterest} %`);
      return syncMember(run);
    })],
    ['action.economy_shop', (node, run) => {
      const list = eco.items(ctx);
      run.setResult(node, '', list.map((i) => `**${i.name}** (\`${i.key}\`) · ${eco.money(ctx, i.price, i.currency)}${i.description ? `\n${i.description}` : ''}`).join('\n\n') || 'The shop is empty.');
      run.setResult(node, '.count', list.length);
    }],
    ['action.economy_buy', async (node, run) => econ(async () => {
      const guild = guildOf(run);
      const member = memberOf(run);
      const r = await eco.buy(ctx, guild, member, run.str(node, 'item'), Number(run.str(node, 'amount')) || 1);
      run.setResult(node, '', r.item.name);
      run.setResult(node, '.qty', r.qty);
      run.setResult(node, '.cost', eco.money(ctx, r.cost, r.item.currency));
      run.setResult(node, '.balance', eco.money(ctx, r.balance, r.item.currency));
      run.setResult(node, '.used', r.used);
    })],
    ['action.economy_inventory', (node, run) => {
      const guild = guildOf(run).id;
      const names = new Map(eco.items(ctx, true).map((i) => [i.key, i.name]));
      const list = eco.owned(ctx, guild, userOf(run, node));
      run.setResult(node, '', list.map((r) => `${r.qty} × **${names.get(r.item) ?? r.item}**`).join('\n') || 'Nothing yet.');
      run.setResult(node, '.count', list.reduce((s, r) => s + r.qty, 0));
    }],
    ['action.economy_use', async (node, run) => econ(async () => {
      run.setResult(node, '', await eco.use(ctx, guildOf(run), memberOf(run), run.str(node, 'item')));
    })],
    ['action.economy_give_item', (node, run) => econ(() => {
      const guild = guildOf(run).id;
      const r = eco.giveItem(ctx, guild, userOf(run, node, 'from_user'), userOf(run, node, 'to_user'), run.str(node, 'item'), Number(run.str(node, 'amount')) || 1);
      run.setResult(node, '', r.item.name);
      run.setResult(node, '.qty', r.qty);
    })],
    ['action.economy_stats', (node, run) => {
      const r = eco.stats(ctx, guildOf(run).id, userOf(run, node));
      run.setResult(node, '', r.text);
      run.setResult(node, '.total', r.total);
      run.setResult(node, '.items', r.items);
      run.setResult(node, '.tickets', r.tickets);
    }],
    ['action.economy_cooldowns', (node, run) => {
      const r = eco.cooldowns(ctx, guildOf(run).id, userOf(run, node));
      run.setResult(node, '', r.text);
      run.setResult(node, '.daily', r.daily);
      run.setResult(node, '.message', r.message);
    }],
    ['action.economy_lottery', (node, run) => econ(() => {
      const guild = guildOf(run).id;
      const user = userOf(run, node);
      const c = eco.config(ctx);
      if (run.str(node, 'mode') === 'buy') {
        const r = eco.buyTickets(ctx, guild, user, Number(run.str(node, 'tickets')) || 1);
        run.setResult(node, '.balance', eco.money(ctx, r.balance));
      }
      const l = eco.lottery(ctx, guild);
      const total = Object.values(l.tickets).reduce((s, n) => s + n, 0);
      run.setResult(node, '', `Pot: **${eco.money(ctx, l.pot)}** · ${total} tickets · you hold ${l.tickets[user] ?? 0} · draw daily at ${c.lotteryTime} · ticket ${eco.money(ctx, c.lotteryPrice)}`);
      run.setResult(node, '.pot', eco.money(ctx, l.pot));
      run.setResult(node, '.tickets', total);
      run.setResult(node, '.mine', l.tickets[user] ?? 0);
    })],

    [
      'action.leveling_get_rank',
      (node, run) => {
        const guild = guildOf(run);
        const user = userOf(run, node);
        const row = db.prepare('SELECT xp, level FROM leveling_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(botId, guild.id, user) as { xp: number; level: number } | undefined;
        const xp = row?.xp ?? 0;
        const rank = (db.prepare('SELECT COUNT(*) AS n FROM leveling_members WHERE bot_id = ? AND guild_id = ? AND xp > ?').get(botId, guild.id, xp) as { n: number }).n + 1;
        run.setResult(node, '.level', row?.level ?? 0);
        run.setResult(node, '.xp', xp);
        run.setResult(node, '.rank', row ? rank : 0);
      },
    ],
    [
      'action.leveling_leaderboard',
      (node, run) => {
        const guild = guildOf(run);
        const rows = db.prepare('SELECT user_id, xp, level FROM leveling_members WHERE bot_id = ? AND guild_id = ? ORDER BY xp DESC LIMIT ?').all(botId, guild.id, limitOf(run, node)) as { user_id: string; xp: number; level: number }[];
        run.setResult(node, '', rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> · Level ${r.level} · ${r.xp} XP`).join('\n') || '—');
      },
    ],
    [
      'action.leveling_edit_xp',
      (node, run) => {
        const guild = guildOf(run);
        const user = userOf(run, node);
        const amount = Math.max(0, Math.floor(run.num(node, 'amount')));
        const cur = (db.prepare('SELECT xp FROM leveling_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(botId, guild.id, user) as { xp: number } | undefined)?.xp ?? 0;
        const mode = String(run.raw(node, 'xp_mode') ?? 'add');
        const xp = Math.max(0, mode === 'set' ? amount : mode === 'remove' ? cur - amount : cur + amount);
        const cfg = levelCfg();
        const level = levelFor(xp, cfg.baseXp ?? 100, cfg.stepXp ?? 50, cfg.maxLevel ?? 0);
        db.prepare(
          `INSERT INTO leveling_members (bot_id, guild_id, user_id, xp, level) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (bot_id, guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level`,
        ).run(botId, guild.id, user, xp, level);
      },
    ],
    ['action.leveling_reset', (_node, run) => void db.prepare('DELETE FROM leveling_members WHERE bot_id = ? AND guild_id = ?').run(botId, guildOf(run).id)],
    [
      'action.birthday_set',
      (node, run) => {
        const guild = guildOf(run);
        const { day, month, year } = parseBirthday(run.str(node, 'date'));
        db.prepare(
          `INSERT INTO birthdays (bot_id, guild_id, user_id, month, day, year) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (bot_id, guild_id, user_id) DO UPDATE SET month = excluded.month, day = excluded.day, year = excluded.year, last_announced_year = NULL`,
        ).run(botId, guild.id, userOf(run, node), month, day, year);
      },
    ],
    // --- AFK ---
    [
      'action.afk_set',
      async (node, run) => {
        const guild = guildOf(run);
        const member = await guild.members.fetch(userOf(run, node)).catch(() => null);
        if (!member) throw new GraphError('error.run.member_not_found', { value: userOf(run, node) });
        const state = await setAfk(ctx, member, run.str(node, 'reason'));
        run.setResult(node, '', state.reason);
      },
    ],
    [
      'action.afk_clear',
      async (node, run) => {
        const guild = guildOf(run);
        const member = await guild.members.fetch(userOf(run, node)).catch(() => null);
        const was = member ? await clearAfk(ctx, member) : null;
        run.setResult(node, '', was ? 'true' : 'false');
      },
    ],
    [
      'action.afk_get',
      (node, run) => {
        const state = afkOf(ctx, guildOf(run).id, userOf(run, node));
        run.setResult(node, '', state ? 'true' : 'false');
        run.setResult(node, '.reason', state?.reason ?? '');
        run.setResult(node, '.since', state ? `<t:${Math.floor(state.since / 1000)}:R>` : '');
      },
    ],
    // --- Thanks ---
    [
      'action.thanks_give',
      async (node, run) => {
        const guild = guildOf(run);
        const member = await guild.members.fetch(userOf(run, node)).catch(() => null);
        if (!member) throw new GraphError('error.run.member_not_found', { value: userOf(run, node) });
        try {
          const n = await giveThanks(ctx, guild, userOf(run, node, 'from_user'), member);
          run.setResult(node, '', n);
        } catch (err) {
          if (err instanceof ThanksError) throw new GraphError('error.run.economy', { message: err.message });
          throw err;
        }
      },
    ],
    [
      'action.thanks_get',
      (node, run) => {
        const guild = guildOf(run).id;
        const user = userOf(run, node);
        run.setResult(node, '', thanksOf(ctx, guild, user));
        run.setResult(node, '.rank', thanksRank(ctx, guild, user) || '—');
        run.setResult(node, '.user', user);
      },
    ],
    [
      'action.thanks_leaderboard',
      (node, run) => {
        const rows = thanksTop(ctx, guildOf(run).id, limitOf(run, node));
        const medal = ['🥇', '🥈', '🥉'];
        run.setResult(node, '', rows.map((r, i) => `${medal[i] ?? `**${i + 1}.**`} <@${r.userId}> · ${r.n} 🙏`).join('\n') || 'No thanks yet.');
      },
    ],
    ['action.birthday_remove', (node, run) => void db.prepare('DELETE FROM birthdays WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(botId, guildOf(run).id, userOf(run, node))],
    [
      'action.birthday_list',
      (node, run) => {
        const guild = guildOf(run);
        const now = new Date();
        const rows = (db.prepare('SELECT user_id, month, day, year FROM birthdays WHERE bot_id = ? AND guild_id = ?').all(botId, guild.id) as { user_id: string; month: number; day: number; year: number | null }[])
          .map((r) => ({ ...r, in: daysUntil(r.month, r.day, now) }))
          .sort((a, b) => a.in - b.in)
          .slice(0, limitOf(run, node));
        const pad = (n: number) => String(n).padStart(2, '0');
        run.setResult(node, '', rows.map((r) => `<@${r.user_id}> · ${pad(r.day)}.${pad(r.month)}.${r.in === 0 ? ' 🎂' : ` (in ${r.in} d)`}`).join('\n') || '—');
      },
    ],
    [
      'action.invites_get',
      (node, run) => {
        const s = inviteStats(guildOf(run).id, userOf(run, node));
        run.setResult(node, '.total', s.total ?? 0);
        run.setResult(node, '.left', s.gone ?? 0);
      },
    ],
    [
      'action.invites_leaderboard',
      (node, run) => {
        const rows = db
          .prepare(
            `SELECT inviter_id, COUNT(*) AS n FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND inviter_id IS NOT NULL AND fake = 0 AND left_at IS NULL AND reset_at IS NULL
             GROUP BY inviter_id ORDER BY n DESC LIMIT ?`,
          )
          .all(botId, guildOf(run).id, limitOf(run, node)) as { inviter_id: string; n: number }[];
        run.setResult(node, '', rows.map((r, i) => `**${i + 1}.** <@${r.inviter_id}> · ${r.n} invites`).join('\n') || '—');
      },
    ],
    [
      'action.invites_reset',
      (node, run) =>
        void db
          .prepare("UPDATE invite_joins SET reset_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bot_id = ? AND guild_id = ? AND inviter_id = ? AND reset_at IS NULL")
          .run(botId, guildOf(run).id, userOf(run, node)),
    ],
    [
      'action.suggestion_create',
      async (node, run) => {
        const data = run.data as unknown as DiscordData;
        const guild = guildOf(run);
        const member = data.member ?? (await guild.members.fetch(run.vars.get('user.id') ?? '').catch(() => null));
        const text = run.str(node, 'content').trim();
        if (!member || !text) throw new GraphError('error.run.missing_value', { field: 'content' });
        run.countDiscordCall();
        const res = await createSuggestion(ctx, guild, member, text);
        if (!res) throw new GraphError('error.run.module_not_set_up', { module: 'suggestions' });
        run.setResult(node, '', res.number);
        run.setResult(node, '.id', res.message.id);
        run.setResult(node, '.url', res.message.url);
      },
    ],
    [
      'action.suggestion_decide',
      async (node, run) => {
        const guild = guildOf(run);
        const ref = run.str(node, 'suggestion').trim().replace(/^#/, '');
        const verdict = run.raw(node, 'decision') === 'reject' ? 'rejected' : 'approved';
        run.countDiscordCall();
        if (!(await decideSuggestion(ctx, guild, ref, verdict, run.vars.get('user.id') ?? '', run.str(node, 'reason')))) {
          throw new GraphError('error.run.not_found', { value: ref });
        }
      },
    ],
    [
      'action.suggestion_list',
      (node, run) => {
        const status = String(run.raw(node, 'suggestion_status') ?? 'pending');
        const rows = db
          .prepare(`SELECT number, content, status FROM suggestions WHERE bot_id = ? AND guild_id = ? ${status === 'all' ? '' : 'AND status = ?'} ORDER BY number DESC LIMIT 20`)
          .all(...([botId, guildOf(run).id, ...(status === 'all' ? [] : [status])] as [number, string])) as { number: number; content: string; status: string }[];
        const icon = { pending: '⏳', approved: '✅', rejected: '❌' } as Record<string, string>;
        run.setResult(node, '', rows.map((r) => `${icon[r.status] ?? ''} **#${r.number}** ${r.content.slice(0, 80)}`).join('\n') || '—');
      },
    ],
  ]);
}
