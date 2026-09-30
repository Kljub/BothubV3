// Builder blocks of the ready-made modules: Leveling, Birthdays, Invite
// Tracker, Suggestions. They use the same tables and settings as the
// modules (bot/src/modules), so a command built from these blocks and the
// module itself see the same data.

import type { Guild } from 'discord.js';
import type { Repo } from '../core/repo.js';
import { GraphError, type Handler, type Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { snowflake } from '../graph/util.js';
import { createSuggestion, decideSuggestion, levelFor } from '../modules/community.js';
import { ModuleContext } from '../modules/context.js';
import type { DiscordData } from './handlers.js';

function guildOf(run: Run): Guild {
  const guild = (run.data as unknown as DiscordData).guild;
  if (!guild) throw new GraphError('error.run.no_server');
  return guild;
}

function userOf(run: Run, node: GraphNode, key = 'user'): string {
  return snowflake(run.str(node, key) || (run.vars.get('user.id') ?? ''), key);
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
  const levelCfg = () => ctx.config<{ baseXp: number; stepXp: number; maxLevel: number }>('leveling');
  const inviteStats = (guildId: string, userId: string) =>
    db
      .prepare(
        `SELECT SUM(CASE WHEN fake = 0 AND left_at IS NULL THEN 1 ELSE 0 END) AS total, SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END) AS gone
         FROM invite_joins WHERE bot_id = ? AND guild_id = ? AND inviter_id = ? AND reset_at IS NULL`,
      )
      .get(botId, guildId, userId) as { total: number | null; gone: number | null };

  return new Map<string, Handler>([
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
