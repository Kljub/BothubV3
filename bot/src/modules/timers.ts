// Time-driven modules: Timed Messages, Statistic Channels, Birthdays,
// Question of the Day, Free Games. tick() runs every 30 seconds per bot; times and days
// use the bot's time zone (Timed Events settings).

import { ChannelType, type Client, type Guild } from 'discord.js';
import { localTime } from '../core/timed.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, fill, idIn, idsIn, reactionOf, type MessageConfig, type ModuleContext } from './context.js';
import { allow, assignable, send, warn } from './guard.js';
import { postFreeGames } from './freegames.js';

// ---------- pure helpers ----------

export function intervalMs(m: { days?: number; hours?: number; minutes?: number }): number {
  return ((m.days ?? 0) * 1440 + (m.hours ?? 0) * 60 + (m.minutes ?? 0)) * 60_000;
}

/** Statistic of a server for a statistic channel. */
export function statValue(guild: Pick<Guild, 'memberCount' | 'premiumSubscriptionCount' | 'premiumTier'> & { channels: { cache: { size: number } }; roles: { cache: { size: number } }; members: { cache: { filter(fn: (m: { user: { bot: boolean }; presence: { status: string } | null }) => boolean): { size: number } } } }, stat: string): number {
  switch (stat) {
    case 'humans':
      return guild.members.cache.filter((m) => !m.user.bot).size;
    case 'bots':
      return guild.members.cache.filter((m) => m.user.bot).size;
    case 'online':
      return guild.members.cache.filter((m) => !!m.presence && m.presence.status !== 'offline').size;
    case 'channels':
      return guild.channels.cache.size;
    case 'roles':
      return Math.max(0, guild.roles.cache.size - 1);
    case 'boosts':
      return guild.premiumSubscriptionCount ?? 0;
    case 'boost_level':
      return guild.premiumTier;
    default:
      return guild.memberCount;
  }
}

/** Next question: the first not asked yet (or all again once every one was asked). */
export function nextQuestion(questions: string[], asked: string[], skipAsked: boolean, random = Math.random): string | null {
  const list = questions.filter((q) => q.trim());
  if (!list.length) return null;
  const open = skipAsked ? list.filter((q) => !asked.includes(q)) : list;
  const pool = open.length ? open : list;
  return pool[Math.floor(random() * pool.length)]!;
}

/** Age on a birthday, '' when the year is unknown. */
export function age(year: number | null, now: { year: number }): string {
  return year ? String(now.year - year) : '';
}

export interface Video {
  id: string;
  title: string;
  author: string;
  url: string;
}

function xmlText(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** Videos of a YouTube channel feed, newest first. */
export function parseFeed(xml: string): Video[] {
  const out: Video[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const id = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1];
    if (!id) continue;
    out.push({
      id,
      title: xmlText(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? ''),
      author: xmlText(/<author>\s*<name>([\s\S]*?)<\/name>/.exec(e)?.[1] ?? ''),
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  }
  return out;
}

/** Videos newer than the last one seen (oldest first, at most 3). */
export function newVideos(videos: Video[], lastSeen: string | undefined): Video[] {
  if (!lastSeen) return [];
  const i = videos.findIndex((v) => v.id === lastSeen);
  return (i < 0 ? videos.slice(0, 1) : videos.slice(0, i)).slice(0, 3).reverse();
}

/** Stable key of a list entry (not its position, so reordering keeps the state). */
export function entryKey(parts: string[]): string {
  let h = 5381;
  for (const c of parts.join('|')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

const MAX_TRIES = 5;

// ---------- runtime ----------

interface TimedMessage { _id?: string; name: string; channel: unknown; days: number; hours: number; minutes: number; message: MessageConfig; skipStacked: boolean }

export class ModuleTimers {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly timezone: () => string,
  ) {}

  start(client: Client): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(client), 30_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(client: Client, now = Date.now()): Promise<void> {
    if (this.busy || !client.isReady()) return;
    this.busy = true;
    try {
      const guilds = [...client.guilds.cache.values()];
      await this.timedMessages(guilds, now);
      if (Math.floor(now / 600_000) !== Math.floor((now - 30_000) / 600_000)) await this.statChannels(guilds);
      if (Math.floor(now / 300_000) !== Math.floor((now - 30_000) / 300_000)) await this.youtube(guilds);
      const local = localTime(now, this.timezone());
      await this.birthdays(guilds, local);
      await this.qotd(guilds, local);
      if (this.ctx.enabled('free-games')) {
        const check = Math.floor(now / 1_800_000) !== Math.floor((now - 30_000) / 1_800_000);
        for (const g of guilds) await postFreeGames(this.ctx, g, local, check);
      }
    } catch (err) {
      log.warn('module timers failed', { botId: this.ctx.botId, err: String(err) });
    } finally {
      this.busy = false;
    }
  }

  private async timedMessages(guilds: Guild[], now: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.enabled('timed-messages')) return;
    for (const [i, m] of (ctx.config<{ messages: TimedMessage[] }>('timed-messages').messages ?? []).entries()) {
      const every = intervalMs(m);
      if (every < 60_000) continue;
      const guild = guilds.find((g) => idIn(m.channel, g.id));
      const channel = guild?.channels.cache.get(idIn(m.channel, guild.id) ?? '');
      if (!guild || !channel?.isSendable()) {
        warn(ctx, 'WAR-2008', { module: 'timed-messages', problem: `"${m.name || i + 1}" has no channel the bot can write in` });
        continue;
      }
      // Stable entry ID from the API; older entries fall back to name + channel.
      const key = `last:${m._id ?? entryKey([m.name ?? '', channel.id])}`;
      const last = ctx.getState<{ at: number; message: string }>('timed-messages', guild.id, key);
      if (!last) {
        ctx.setState('timed-messages', guild.id, key, { at: now, message: '' }); // first run after one interval
        continue;
      }
      if (now - last.at < every) continue;
      if (m.skipStacked !== false && last.message && 'lastMessageId' in channel && channel.lastMessageId === last.message) {
        ctx.setState('timed-messages', guild.id, key, { ...last, at: now });
        continue;
      }
      const payload = buildMessage(m.message, baseVars(guild, null));
      if (!payload) continue;
      const sent = await send(ctx, 'timed-messages', channel, payload);
      ctx.setState('timed-messages', guild.id, key, { at: now, message: sent?.id ?? last.message });
    }
  }

  private async youtube(guilds: Guild[]): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.enabled('youtube-notifs')) return;
    let budget = 10; // feed requests per 5-minute round
    for (const f of ctx.config<{ feeds: { youtubeChannel: string; channel: unknown; mentionRoles: unknown; message: string }[] }>('youtube-notifs').feeds ?? []) {
      if (!/^UC[A-Za-z0-9_-]{22}$/.test(f.youtubeChannel ?? '')) continue;
      const guild = guilds.find((g) => idIn(f.channel, g.id));
      const channel = guild?.channels.cache.get(idIn(f.channel, guild.id) ?? '');
      if (!guild || !channel?.isSendable()) continue;
      const failKey = `fail:${f.youtubeChannel}`;
      const fail = ctx.getState<{ count: number; until: number }>('youtube-notifs', guild.id, failKey);
      if (fail && Date.now() < fail.until) continue; // back off after failed requests
      if (budget-- <= 0) break;
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${f.youtubeChannel}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!res?.ok) {
        const count = (fail?.count ?? 0) + 1;
        ctx.setState('youtube-notifs', guild.id, failKey, { count, until: Date.now() + Math.min(6 * 3600_000, 300_000 * 2 ** count) });
        if (count >= 3) warn(ctx, 'WAR-2008', { module: 'youtube-notifs', problem: `the feed of ${f.youtubeChannel} cannot be read (HTTP ${res?.status ?? 'error'})` });
        continue;
      }
      if (fail) ctx.deleteState('youtube-notifs', guild.id, failKey);
      const videos = parseFeed(await res.text());
      if (!videos.length) continue;
      const key = `yt:${f.youtubeChannel}:${channel.id}`;
      const fresh = newVideos(videos, ctx.getState<string>('youtube-notifs', guild.id, key));
      if (!fresh.length) ctx.setState('youtube-notifs', guild.id, key, videos[0]!.id);
      const roles = idsIn(f.mentionRoles, guild.id);
      for (const v of fresh) {
        const text = fill(f.message || '{video.title} {video.url}', { ...baseVars(guild, null), 'video.title': v.title, 'video.author': v.author, 'video.url': v.url, 'video.id': v.id });
        const mentions = roles.map((r) => `<@&${r}>`).join(' ');
        const content = (mentions ? `${mentions}\n${text}` : text).slice(0, 2000);
        // The last seen video moves on only after a successful post.
        if (!(await send(ctx, 'youtube-notifs', channel, { content, allowedMentions: { roles } }))) break;
        ctx.setState('youtube-notifs', guild.id, key, v.id);
      }
    }
  }

  private async statChannels(guilds: Guild[]): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.enabled('statistic-channels')) return;
    for (const c of ctx.config<{ counters: { channel: unknown; stat: string; name: string }[] }>('statistic-channels').counters ?? []) {
      const guild = guilds.find((g) => idIn(c.channel, g.id));
      const channel = guild?.channels.cache.get(idIn(c.channel, guild.id) ?? '');
      if (!guild || !channel || !('setName' in channel)) continue;
      const name = fill(c.name || '{count}', { ...baseVars(guild, null), count: statValue(guild as never, c.stat).toLocaleString('en-US') }).slice(0, 100);
      if (channel.name !== name) await channel.setName(name, 'Statistic channel').catch((err) => log.debug('stat channel rename failed', { err: String(err) }));
    }
  }

  private async birthdays(guilds: Guild[], local: ReturnType<typeof localTime>): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.enabled('birthday')) return;
    const cfg = ctx.config<{ time: string; channel: unknown; message: MessageConfig; messageNoYear: MessageConfig; reactions: string[]; thread: boolean; role: unknown }>('birthday');
    const [month, day, year] = [Number(local.date.slice(5, 7)), Number(local.date.slice(8, 10)), Number(local.date.slice(0, 4))];
    const today = `${local.date}`;
    for (const guild of guilds) {
      const roleId = idIn(cfg.role, guild.id);
      // Birthday role: taken back from the members the module gave it to
      // (roles given by hand stay).
      const given = ctx.getState<{ day: string; role: string; users: string[] }>('birthday', guild.id, 'given');
      if (given && given.day !== today) {
        for (const id of given.users) {
          const m = await guild.members.fetch(id).catch(() => null);
          await m?.roles.remove(given.role, 'Birthday over').catch(() => undefined);
        }
        ctx.deleteState('birthday', guild.id, 'given');
      }
      if (local.hms.slice(0, 5) < (cfg.time || '09:00')) continue;
      const rows = ctx.db
        .prepare('SELECT user_id, year FROM birthdays WHERE bot_id = ? AND guild_id = ? AND month = ? AND day = ? AND (last_announced_year IS NULL OR last_announced_year < ?)')
        .all(ctx.botId, guild.id, month, day, year) as { user_id: string; year: number | null }[];
      const done = (userId: string) => {
        ctx.db.prepare('UPDATE birthdays SET last_announced_year = ? WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(year, ctx.botId, guild.id, userId);
        ctx.deleteState('birthday', guild.id, `try:${userId}`);
      };
      for (const r of rows) {
        const member = await guild.members.fetch(r.user_id).catch(() => null);
        if (!member) {
          done(r.user_id); // left the server: nothing to announce
          continue;
        }
        const channelId = idIn(cfg.channel, guild.id);
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        const payload = buildMessage(r.year ? cfg.message : cfg.messageNoYear, { ...baseVars(guild, member), age: age(r.year, { year }) });
        let sent = null;
        // No channel chosen (or an empty message): only the role is given.
        // A chosen channel that cannot be used counts as a failed try.
        if (channelId && payload) {
          sent = channel?.isSendable() ? await send(ctx, 'birthday', channel, payload) : null;
          if (!sent) {
            // Not sent: try again on the next tick, at most 5 times.
            const tries = (ctx.getState<number>('birthday', guild.id, `try:${r.user_id}`) ?? 0) + 1;
            ctx.setState('birthday', guild.id, `try:${r.user_id}`, tries);
            if (tries < MAX_TRIES) continue;
            warn(ctx, 'WAR-2008', { module: 'birthday', problem: `the birthday message could not be sent in <#${channelId}>` });
          }
        }
        done(r.user_id);
        if (roleId && assignable(ctx, 'birthday', guild, [roleId]).length && !member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, 'Birthday').catch(() => undefined);
          const g = ctx.getState<{ day: string; role: string; users: string[] }>('birthday', guild.id, 'given') ?? { day: today, role: roleId, users: [] };
          ctx.setState('birthday', guild.id, 'given', { ...g, users: [...new Set([...g.users, member.id])] });
        }
        for (const e of cfg.reactions ?? []) if (sent && allow(ctx, 'birthday', sent.channelId)) await sent.react(reactionOf(e)).catch(() => undefined);
        if (sent && cfg.thread && channel?.type === ChannelType.GuildText) await sent.startThread({ name: `🎂 ${member.displayName}`.slice(0, 100) }).catch(() => undefined);
      }
    }
  }

  private async qotd(guilds: Guild[], local: ReturnType<typeof localTime>): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.enabled('qotd')) return;
    const cfg = ctx.config<{ channel: unknown; time: string; mentionRoles: unknown; message: MessageConfig; thread: boolean; threadName: string; questions: string[]; skipAsked: boolean }>('qotd');
    if (local.hms.slice(0, 5) < (cfg.time || '12:00')) return;
    const guild = guilds.find((g) => idIn(cfg.channel, g.id));
    const channel = guild?.channels.cache.get(idIn(cfg.channel, guild.id) ?? '');
    if (!guild || !channel) return;
    if (ctx.getState<string>('qotd', guild.id, 'day') === local.date) return;
    const okType = channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
    if (!okType) {
      warn(ctx, 'WAR-2008', { module: 'qotd', problem: 'the channel must be a text, announcement or forum channel' });
      return;
    }
    const asked = ctx.getState<string[]>('qotd', guild.id, 'asked') ?? [];
    const question = nextQuestion(cfg.questions ?? [], asked, cfg.skipAsked !== false);
    if (!question) {
      ctx.setState('qotd', guild.id, 'day', local.date);
      return;
    }
    const number = (ctx.getState<number>('qotd', guild.id, 'number') ?? 0) + 1;
    // Marked as done only after the question was posted (or after 5 failed tries).
    const finish = (posted: boolean) => {
      const tries = posted ? 0 : (ctx.getState<number>('qotd', guild.id, 'tries') ?? 0) + 1;
      if (!posted && tries < MAX_TRIES) {
        ctx.setState('qotd', guild.id, 'tries', tries);
        return;
      }
      ctx.deleteState('qotd', guild.id, 'tries');
      ctx.setState('qotd', guild.id, 'day', local.date);
      if (!posted) {
        warn(ctx, 'WAR-2008', { module: 'qotd', problem: 'the question of the day could not be posted' });
        return;
      }
      ctx.setState('qotd', guild.id, 'number', number);
      const all = [...new Set([...asked, question])];
      ctx.setState('qotd', guild.id, 'asked', all.length >= (cfg.questions ?? []).length ? [question] : all);
    };
    const vars = { ...baseVars(guild, null), question, number: String(number) };
    const payload = buildMessage(cfg.message, vars) ?? { content: question };
    const mentions = idsIn(cfg.mentionRoles, guild.id).map((r) => `<@&${r}>`).join(' ');
    if (mentions) {
      payload.content = `${mentions}${payload.content ? `\n${payload.content}` : ''}`.slice(0, 2000);
      payload.allowedMentions = { roles: idsIn(cfg.mentionRoles, guild.id) };
    }
    if (channel.type === ChannelType.GuildForum) {
      finish(!!(await channel.threads.create({ name: fill(cfg.threadName || 'QOTD #{number}', vars).slice(0, 100), message: payload }).catch(() => null)));
      return;
    }
    if (!channel.isSendable()) return;
    const sent = await send(ctx, 'qotd', channel, payload);
    finish(!!sent);
    if (sent && cfg.thread && channel.type === ChannelType.GuildText) await sent.startThread({ name: fill(cfg.threadName || 'QOTD #{number}', vars).slice(0, 100) }).catch(() => undefined);
  }
}
