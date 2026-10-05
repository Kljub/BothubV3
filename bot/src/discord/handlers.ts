// Blocks that talk to Discord. Every API call counts against the run limit.
// Blocks that are not here yet fail with error.run.unsupported_block and go
// to the error handler, so a graph never silently does half of its work.

import {
  EmbedBuilder,
  type GuildTextBasedChannel,
  MessageFlags,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type RepliableInteraction,
  type SendableChannels,
  type User,
} from 'discord.js';
import { GraphError, type Handler, type Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { parseDuration, snowflake, snowflakes } from '../graph/util.js';
import type { CaseAction, ModCase, Repo } from '../core/repo.js';
import { buildMessage, hasBody } from './message.js';
import { actionName, type CaseHandle, type Moderation } from './moderation.js';
import { ModuleContext } from '../modules/context.js';
import { clock, findTracks, musicOf, MusicError, type LoopMode } from './music.js';
import { lyricsOf } from './lyrics.js';
import { createTicket, finishTicket, modmailBlock, modmailClose, modmailReply, reopenTicket, ticketCounts, ticketMember, ticketPanelIndex, ticketPanelPayload, type TicketConfig } from '../modules/support.js';
import { countClick, findStations, stationLines, stationTrack } from './radio.js';
import { acrIdentify, icyTitle, RecognizeError, recordSample, splitStreamTitle, type Song } from './recognize.js';
import { freeGames, freeGamesText, gameEmbed, gameSales, gameSalesText, platformsOf, type FreeGamesConfig } from '../modules/freegames.js';
import { deleteGiveaway, endGiveaway, giveawayPayload, listGiveaways, loadGiveaway, saveGiveaway, type Giveaway } from '../modules/giveaway.js';

/** What a run knows about where it runs (run.data). */
/** An unknown currency key becomes a readable error of the run. */
function currencyRun<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.message === 'economy.unknown_currency') throw new GraphError('error.run.economy', { message: 'Unknown currency.' });
    throw err;
  }
}

export interface DiscordData {
  client: Client;
  botId: number;
  guild: Guild | null;
  channel: SendableChannels | null;
  member: GuildMember | null;
  user: User | null;
  interaction?: RepliableInteraction;
  /** Message that started the run (message events). */
  message?: Message;
  hideReplies?: boolean;
  /** A "thinking …" reply being sent for a slow command (instance.ts). */
  deferring?: Promise<unknown>;
  /** custom_id for a button or menu block of this run. */
  customId(component: GraphNode): string;
  /** Messages sent by this run, by block variable ({Var1}). */
  messages: Map<string, Message>;
}

export function data(run: Run): DiscordData {
  return run.data as unknown as DiscordData;
}

async function guildOf(run: Run, node: GraphNode): Promise<Guild> {
  const d = data(run);
  const id = run.str(node, 'guild').trim();
  if (id) {
    run.countDiscordCall();
    const g = await d.client.guilds.fetch(snowflake(id, 'guild')).catch(() => null);
    if (!g) throw new GraphError('error.run.server_not_found', { value: id });
    return g;
  }
  if (!d.guild) throw new GraphError('error.run.needs_server');
  return d.guild;
}

async function memberOf(run: Run, node: GraphNode, key = 'user'): Promise<GuildMember> {
  const guild = await guildOf(run, node);
  const id = snowflake(run.str(node, key), key);
  run.countDiscordCall();
  const m = await guild.members.fetch(id).catch(() => null);
  if (!m) throw new GraphError('error.run.member_not_found', { value: id });
  return m;
}

async function channelOf(run: Run, value: string, field: string): Promise<SendableChannels> {
  const d = data(run);
  run.countDiscordCall();
  const ch = await d.client.channels.fetch(snowflake(value, field)).catch(() => null);
  if (!ch || !ch.isSendable()) throw new GraphError('error.run.channel_not_found', { value });
  return ch;
}

/** A message reference: a block variable, a message link, "channel/message" or an ID in this channel. */
async function messageOf(run: Run, node: GraphNode, key: string): Promise<Message> {
  const d = data(run);
  const rawValue = String(run.raw(node, key) ?? '').trim();
  const known = d.messages.get(rawValue);
  if (known) return known;
  const value = run.render(rawValue);
  const link = /channels\/(?:\d+|@me)\/(\d{17,20})\/(\d{17,20})/.exec(value) ?? /^(\d{17,20})[/-](\d{17,20})$/.exec(value);
  let channel: SendableChannels | null = d.channel;
  let id = value;
  if (link) {
    channel = await channelOf(run, link[1]!, key);
    id = link[2]!;
  } else if (!d.message || value !== d.message.id) {
    id = snowflake(value, key);
  } else {
    return d.message;
  }
  if (!channel || !('messages' in channel)) throw new GraphError('error.run.message_not_found', { value });
  run.countDiscordCall();
  const msg = await channel.messages.fetch(id).catch(() => null);
  if (!msg) throw new GraphError('error.run.message_not_found', { value });
  return msg;
}

/** "**#12** Ban · <@123> · reason · 3 days ago" */
function caseLine(c: ModCase): string {
  const when = `<t:${Math.floor(Date.parse(c.createdAt) / 1000)}:R>`;
  const dur = c.duration ? ` (${c.duration})` : '';
  return `**#${c.number}** ${actionName(c.action, c.duration)}${dur} · <@${c.userId}> · ${c.reason || '–'} · ${when}`;
}

function reason(run: Run, node: GraphNode): string | undefined {
  return run.str(node, 'reason').slice(0, 512) || undefined;
}

/** Discord errors become run errors with the Discord message. */
async function discord<T>(run: Run, call: () => Promise<T>): Promise<T> {
  run.countDiscordCall();
  try {
    return await call();
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 50013) throw new GraphError('error.run.missing_permissions', { message: e.message });
    throw new GraphError('error.run.discord', { message: e.message ?? String(err), code: e.code });
  }
}

async function sendMessage(node: GraphNode, run: Run): Promise<void> {
  const d = data(run);
  const payload = buildMessage(run, node, d.customId) as Record<string, unknown> & { flags?: number };
  if (!hasBody(payload)) throw new GraphError('error.run.empty_message');
  if (run.bool(node, 'silent')) payload.flags = (payload.flags ?? 0) | MessageFlags.SuppressNotifications;
  const mentions = String(run.raw(node, 'mentions') ?? 'all');
  if (mentions !== 'all') payload.allowedMentions = mentions === 'none' ? { parse: [] } : { parse: ['users'] };
  const target = String(run.raw(node, 'target') ?? 'reply');

  let sent: Message | undefined;
  switch (target) {
    case 'reply': {
      const i = d.interaction;
      if (!i) throw new GraphError('error.run.no_interaction');
      const ephemeral = run.bool(node, 'ephemeral') || d.hideReplies;
      if (ephemeral) payload.flags = (payload.flags ?? 0) | MessageFlags.Ephemeral;
      await d.deferring;
      sent = await discord(run, async () => {
        // The first answer after "thinking …" replaces it.
        // Ephemeral was decided by the defer; an edit cannot change it.
        if (i.deferred && !i.replied) return i.editReply({ ...payload, flags: Number(payload.flags ?? 0) & ~Number(MessageFlags.Ephemeral) } as never) as Promise<Message>;
        if (i.replied || i.deferred) return i.followUp({ ...payload, fetchReply: true } as never) as Promise<Message>;
        const res = await i.reply({ ...payload, withResponse: true } as never);
        return (res as unknown as { resource?: { message?: Message } }).resource?.message as Message;
      });
      break;
    }
    case 'reply_message': {
      const to = await messageOf(run, node, 'reply_to');
      sent = await discord(run, () => to.reply(payload as never));
      break;
    }
    case 'command_channel':
      if (!d.channel) throw new GraphError('error.run.no_channel');
      sent = await discord(run, () => d.channel!.send(payload as never) as Promise<Message>);
      break;
    case 'channel': {
      const ch = await channelOf(run, run.str(node, 'channel'), 'channel');
      sent = await discord(run, () => ch.send(payload as never) as Promise<Message>);
      break;
    }
    case 'dm': {
      const id = snowflake(run.str(node, 'user'), 'user');
      const user = await discord(run, () => d.client.users.fetch(id));
      sent = await discord(run, () => user.send(payload as never));
      break;
    }
    case 'edit': {
      const msg = await messageOf(run, node, 'edit_message');
      sent = await discord(run, () => msg.edit(payload as never));
      break;
    }
    default:
      throw new GraphError('error.run.unsupported_option', { value: target });
  }

  if (sent) {
    const variable = typeof node.config.variable === 'string' ? node.config.variable : '';
    if (variable) d.messages.set(variable, sent);
    run.setResult(node, '', sent.id);
    run.setResult(node, '.id', sent.id);
    run.setResult(node, '.url', sent.url);
    const after = run.str(node, 'delete_after');
    if (after) {
      const msg = sent;
      setTimeout(() => void msg.delete().catch(() => undefined), Math.min(parseDuration(after), 24 * 3_600_000)).unref();
    }
  }
}

// ---------- polls (Discord's own polls; known polls in module_state) ----------

interface KnownPoll { channel: string; question: string; expiresAt: string | null; url: string }

/** Remembers a poll so List Polls and the poll ID options find it again. */
function rememberPoll(repo: Repo, botId: number, msg: Message): void {
  if (!msg.guildId || !msg.poll) return;
  const value: KnownPoll = { channel: msg.channelId, question: msg.poll.question.text ?? '', expiresAt: msg.poll.expiresAt?.toISOString() ?? null, url: msg.url };
  repo.db
    .prepare(
      `INSERT INTO module_state (bot_id, module, guild_id, key, value, updated_at) VALUES (?, 'polls', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (bot_id, module, guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(botId, msg.guildId, `poll:${msg.id}`, JSON.stringify(value));
}

function forgetPoll(repo: Repo, botId: number, guildId: string, id: string): void {
  repo.db.prepare("DELETE FROM module_state WHERE bot_id = ? AND module = 'polls' AND guild_id = ? AND key = ?").run(botId, guildId, `poll:${id}`);
}

/** Known polls of a server, newest first; polls ended over 7 days ago are dropped. */
function knownPolls(repo: Repo, botId: number, guildId: string): (KnownPoll & { id: string })[] {
  const rows = repo.db.prepare("SELECT key, value FROM module_state WHERE bot_id = ? AND module = 'polls' AND guild_id = ? ORDER BY updated_at DESC").all(botId, guildId) as { key: string; value: string }[];
  const out: (KnownPoll & { id: string })[] = [];
  for (const r of rows) {
    const id = String(r.key).slice(5);
    let p: KnownPoll;
    try {
      p = JSON.parse(String(r.value)) as KnownPoll;
    } catch {
      continue;
    }
    if (p.expiresAt && Date.now() - Date.parse(p.expiresAt) > 7 * 86_400_000) {
      forgetPoll(repo, botId, guildId, id);
      continue;
    }
    out.push({ ...p, id });
  }
  return out;
}

/** Splits the answers: one per line or separated by |. */
export function pollAnswers(text: string): string[] {
  return text.split(/\r?\n|\|/).map((a) => a.trim()).filter(Boolean);
}

/** Poll length in hours (Discord: 1 hour to 32 days); empty = 24 hours. */
export function pollHours(duration: string): number {
  if (!duration.trim()) return 24;
  return Math.max(1, Math.min(768, Math.ceil(parseDuration(duration) / 3_600_000)));
}

/** "**Yes** — 3 votes (75 %)" lines, total and the leading answer ('' without votes or on a tie). */
export function pollSummary(answers: { text: string; votes: number }[]): { text: string; total: number; winner: string } {
  const total = answers.reduce((n, a) => n + a.votes, 0);
  const top = Math.max(0, ...answers.map((a) => a.votes));
  const leaders = answers.filter((a) => a.votes === top);
  const lines = answers.map((a) => `**${a.text}** — ${a.votes} ${a.votes === 1 ? 'vote' : 'votes'}${total ? ` (${Math.round((a.votes / total) * 100)} %)` : ''}`);
  return { text: lines.join('\n'), total, winner: top > 0 && leaders.length === 1 ? leaders[0]!.text : '' };
}

/** Answers the command (after "thinking …" too), else posts in the run's channel. */
async function answer(run: Run, payload: { content?: string; embeds?: unknown[] }): Promise<void> {
  const d = data(run);
  const i = d.interaction;
  if (!i) {
    if (!d.channel) throw new GraphError('error.run.no_channel');
    const ch = d.channel;
    await discord(run, (): Promise<unknown> => ch.send(payload as never));
    return;
  }
  await d.deferring;
  await discord(run, async () => {
    if (i.deferred && !i.replied) return i.editReply(payload as never);
    if (i.replied) return i.followUp({ ...payload, flags: d.hideReplies ? MessageFlags.Ephemeral : undefined } as never);
    return i.reply({ ...payload, flags: d.hideReplies ? MessageFlags.Ephemeral : undefined } as never);
  });
}

/** Who did it: the member who ran the command, else the bot. */
function moderatorOf(run: Run): string | null {
  const d = data(run);
  return d.interaction ? (d.user?.id ?? null) : (d.client.user?.id ?? null);
}

// ---------- music (discord/music.ts) ----------

/** Music problems and voice errors become run errors with a readable text. */
async function music<T>(run: Run, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MusicError) throw new GraphError('error.run.music', { message: err.message });
    const key = (err as { key?: string }).key;
    if (key === 'sdk.voice.busy') throw new GraphError('error.run.music', { message: 'Something else plays in this server right now.' });
    if (key === 'sdk.voice.join_failed' || key === 'sdk.voice.bad_channel') throw new GraphError('error.run.music', { message: 'I could not join that voice channel (missing permissions or not a voice channel).' });
    throw err;
  }
}

function musicHandlers(secret: (key: string) => string | null): [string, Handler][] {
  const player = async (run: Run, node: GraphNode) => {
    const guild = await guildOf(run, node);
    return { guild, m: musicOf(data(run).client).get(guild.id) };
  };
  const simple = (type: string, fn: (m: ReturnType<ReturnType<typeof musicOf>['get']>, run: Run, node: GraphNode) => Promise<unknown> | unknown): [string, Handler] => [
    type,
    async (node, run) => {
      const { m } = await player(run, node);
      await music(run, () => fn(m, run, node));
    },
  ];
  return [
    [
      'action.music_player',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const channel = run.str(node, 'channel').trim();
        if (!channel) throw new GraphError('error.run.music', { message: 'Join a voice channel first.' });
        const text = run.str(node, 'text_channel').trim();
        run.countDiscordCall();
        await music(run, () => musicOf(data(run).client).join(guild.id, snowflake(channel, 'channel'), text ? snowflake(text, 'text_channel') : null));
      },
    ],
    [
      'action.music_add',
      async (node, run) => {
        const { m } = await player(run, node);
        run.countDiscordCall();
        const tracks = await music(run, () => findTracks(run.str(node, 'query'), 1, data(run).user?.id ?? null));
        const isLink = /^https?:\/\//i.test(run.str(node, 'query').trim());
        const list = isLink ? tracks : tracks.slice(0, 1);
        const pos = await music(run, () => m.add(list, run.str(node, 'queue_position') === 'next' ? 'next' : 'end'));
        run.setResult(node, '', list.length === 1 ? list[0]!.title : `${list.length} tracks`);
        run.setResult(node, '.title', list.length === 1 ? list[0]!.title : `${list.length} tracks`);
        run.setResult(node, '.position', pos);
      },
    ],
    [
      'action.music_search',
      async (node, run) => {
        run.countDiscordCall();
        const tracks = await music(run, () => findTracks(run.str(node, 'query'), Math.max(1, Math.min(50, Math.trunc(run.num(node, 'limit') || 10))), data(run).user?.id ?? null));
        run.setResult(node, '.count', tracks.length);
        run.setResult(node, '.list', tracks.map((t, i) => `${i + 1}. [${t.title}](${t.url}) (${clock(t.duration)})`).join('\n'));
        run.setResult(node, '[0].title', tracks[0]?.title ?? '');
        run.setResult(node, '[0].url', tracks[0]?.url ?? '');
      },
    ],
    [
      'action.music_radio',
      async (node, run) => {
        const { m } = await player(run, node);
        run.countDiscordCall();
        const wish = { name: run.str(node, 'station'), tag: run.str(node, 'genre'), country: run.str(node, 'country') };
        const random = run.bool(node, 'random') || (!wish.name.trim() && !wish.tag.trim() && !wish.country.trim());
        const found = await music(run, () => findStations({ ...wish, random }, 6));
        const station = found[0];
        if (!station) throw new GraphError('error.run.music', { message: 'No radio station found. Try another name, genre or country.' });
        await music(run, async () => {
          if (run.str(node, 'mode') !== 'queue') m.stop();
          m.add([stationTrack(station, data(run).user?.id ?? null)], 'end');
          await m.play();
        });
        countClick(station.uuid);
        run.setResult(node, '', station.name);
        run.setResult(node, '.country', station.country);
        run.setResult(node, '.tags', station.tags);
        run.setResult(node, '.homepage', station.homepage);
        run.setResult(node, '.more', stationLines(found.slice(1)));
      },
    ],
    [
      'action.music_recognize',
      async (node, run) => {
        const { m } = await player(run, node);
        const track = m.current;
        if (!track || !m.playing) throw new GraphError('error.run.music', { message: 'Nothing is playing.' });
        run.countDiscordCall();
        const mode = run.str(node, 'mode') || 'auto';
        let song: Song | null = null;
        if (!track.live) song = { title: track.title, artist: track.author, album: '', link: track.url, source: 'radio' };
        if (!song && mode !== 'audio') {
          const parts = splitStreamTitle((await icyTitle(track.url)) ?? '');
          if (parts) song = { ...parts, album: '', link: '', source: 'radio' };
        }
        if (!song && mode !== 'radio') {
          const key = secret('ACRCLOUD_ACCESS_KEY');
          const sec = secret('ACRCLOUD_ACCESS_SECRET');
          if (key && sec) {
            try {
              song = await acrIdentify(await recordSample(track.url), { host: run.str(node, 'acr_host') || 'identify-eu-west-1.acrcloud.com', key, secret: sec });
            } catch (err) {
              if (err instanceof RecognizeError) throw new GraphError('error.run.music', { message: err.message });
              throw err;
            }
          } else if (mode === 'audio') {
            throw new GraphError('error.run.music', { message: 'Song recognition is not set up: an admin enters the ACRCloud keys under Admin → API / Secrets.' });
          }
        }
        if (!song) throw new GraphError('error.run.music', { message: 'The song could not be recognized (the station sends no title and no recognition is set up, or nothing matched).' });
        run.setResult(node, '', song.artist ? `${song.artist} – ${song.title}` : song.title);
        run.setResult(node, '.title', song.title);
        run.setResult(node, '.artist', song.artist);
        run.setResult(node, '.album', song.album);
        run.setResult(node, '.link', song.link);
        run.setResult(node, '.source', song.source);
        run.setResult(node, '.station', track.title);
      },
    ],
    [
      'action.radio_search',
      async (node, run) => {
        run.countDiscordCall();
        const list = await music(run, () => findStations({ name: run.str(node, 'station'), tag: run.str(node, 'genre'), country: run.str(node, 'country') }, Math.max(1, Math.min(25, Math.trunc(run.num(node, 'limit') || 10)))));
        run.setResult(node, '', stationLines(list) || 'No stations found.');
        run.setResult(node, '.count', list.length);
      },
    ],
    simple('action.music_play', (m) => m.play()),
    simple('action.music_pause', (m) => m.pause()),
    simple('action.music_resume', (m) => m.resume()),
    simple('action.music_skip', (m, run, node) => m.skip(Math.max(0, Math.trunc(run.num(node, 'to_position') || 0)))),
    simple('action.music_previous', (m) => m.previous()),
    simple('action.music_replay', (m) => m.replay()),
    simple('action.music_stop', (m) => m.stop()),
    simple('action.music_shuffle', (m) => m.shuffle()),
    simple('action.music_disconnect', (m) => m.disconnect()),
    simple('action.music_volume', (m, run, node) => m.setVolume(run.num(node, 'volume'))),
    simple('action.music_loop', (m, run, node) => {
      const raw = run.str(node, 'loop_mode').toLowerCase();
      const mode = raw === 'song' ? 'track' : raw;
      m.loop = (['off', 'track', 'queue'].includes(mode) ? mode : 'off') as LoopMode;
    }),
    simple('action.music_remove', (m, run, node) => m.remove(Math.trunc(run.num(node, 'from_position') || 1), Math.max(1, Math.min(100, Math.trunc(run.num(node, 'remove_count') || 1))))),
    simple('action.music_seek', (m, run, node) => m.seek(run.str(node, 'seek_mode') === 'relative' ? 'relative' : 'absolute', Math.trunc(run.num(node, 'seek_seconds')))),
    simple('action.music_filter', (m, run, node) => m.setFilter(run.str(node, 'filter') || 'bassboost')),
    simple('action.music_clear_filters', (m) => m.setFilter(null)),
    simple('action.music_autoleave', (m, run, node) => {
      m.autoleave = run.raw(node, 'autoleave') === undefined ? true : run.bool(node, 'autoleave');
      m.autoleaveDelay = Math.max(0, Math.min(3600, Math.trunc(run.num(node, 'autoleave_delay') || 0)));
    }),
    [
      'action.music_queue',
      async (node, run) => {
        const { m } = await player(run, node);
        const lines = m.queue.slice(0, 20).map((t, i) => `${i === m.index ? '▶' : `${i + 1}.`} [${t.title}](${t.url}) (${clock(t.duration)})`);
        if (m.queue.length > 20) lines.push(`… and ${m.queue.length - 20} more`);
        run.setResult(node, '', lines.join('\n') || 'The queue is empty.');
        run.setResult(node, '.count', m.queue.length);
        run.setResult(node, '.duration', clock(m.queue.reduce((n, t) => n + t.duration, 0)));
      },
    ],
    [
      'action.music_now',
      async (node, run) => {
        const { m } = await player(run, node);
        const t = m.playing ? m.current : null;
        const bar = (pos: number, len: number) => {
          if (!len) return '🔴 live';
          const at = Math.round((Math.min(pos, len) / len) * 15);
          return `${'▬'.repeat(at)}🔘${'▬'.repeat(15 - at)} ${clock(pos)} / ${clock(len)}`;
        };
        run.setResult(node, '', t ? `**[${t.title}](${t.url})**${m.paused ? ' (paused)' : ''}\n${bar(m.position, t.duration)}` : 'Nothing is playing.');
        run.setResult(node, '.title', t?.title ?? '');
        run.setResult(node, '.url', t?.url ?? '');
        run.setResult(node, '.author', t?.author ?? '');
        run.setResult(node, '.position', t ? clock(m.position) : '');
        run.setResult(node, '.duration', t ? clock(t.duration) : '');
        run.setResult(node, '.loop', m.loop);
        run.setResult(node, '.volume', m.volume);
      },
    ],
    [
      'action.music_lyrics',
      async (node, run) => {
        let query = run.str(node, 'query').trim();
        if (!query) {
          const guild = data(run).guild;
          const t = guild ? musicOf(data(run).client).get(guild.id).current : null;
          if (!t) throw new GraphError('error.run.music', { message: 'Nothing is playing; give a song name.' });
          query = t.title;
        }
        run.countDiscordCall();
        const found = await lyricsOf(query).catch(() => null);
        if (!found) throw new GraphError('error.run.music', { message: `No lyrics found for "${query.slice(0, 100)}".` });
        run.setResult(node, '', found.lyrics);
        run.setResult(node, '.title', found.title);
        run.setResult(node, '.artist', found.artist);
      },
    ],
  ];
}

export function discordHandlers(repo: Repo, mod?: Moderation, secret: (key: string) => string | null = () => null): Map<string, Handler> {
  /** Module helpers report problems as text: a run error with that text. */
  const check = (problem: string | null): void => {
    if (problem) throw new GraphError('error.run.module_failed', { message: problem });
  };
  /** A text channel of a server (ticket channels, modmail threads). */
  const guildChannel = async (run: Run, node: GraphNode, key = 'channel'): Promise<GuildTextBasedChannel> => {
    const value = run.str(node, key);
    const ch = value ? await channelOf(run, value, key) : data(run).channel;
    if (!ch || !('guild' in ch) || !ch.isTextBased()) throw new GraphError('error.run.needs_server');
    return ch as GuildTextBasedChannel;
  };
  const moduleCtx = (run: Run) => new ModuleContext(data(run).botId, repo);

  /** A giveaway: its message ID (any channel of the server) or a message link / block variable. */
  const giveawayOf = async (run: Run, node: GraphNode): Promise<{ guild: string; id: string; g: Giveaway }> => {
    const d = data(run);
    const value = run.str(node, 'giveaway').trim();
    let guild = d.guild?.id ?? '';
    let id = value;
    const known = d.messages.get(String(run.raw(node, 'giveaway') ?? '').trim());
    const link = /channels\/(\d{17,20})\/\d{17,20}\/(\d{17,20})/.exec(value);
    if (known) {
      guild = known.guildId ?? guild;
      id = known.id;
    } else if (link) {
      guild = link[1]!;
      id = link[2]!;
    } else {
      id = snowflake(value, 'giveaway');
    }
    const g = guild ? loadGiveaway(repo, d.botId, guild, id) : null;
    if (!g) throw new GraphError('error.run.giveaway_not_found', { value, message: 'There is no giveaway with this ID on this server.' });
    return { guild, id, g };
  };

  /** A poll message: a known poll's ID (any channel of the server), else any message reference. */
  const pollMessage = async (run: Run, node: GraphNode, key: string): Promise<Message> => {
    const d = data(run);
    const value = run.str(node, key).trim();
    const known = d.guild && /^\d{17,20}$/.test(value) ? knownPolls(repo, d.botId, d.guild.id).find((p) => p.id === value) : undefined;
    let msg: Message;
    if (known) {
      const channel = await channelOf(run, known.channel, key);
      if (!('messages' in channel)) throw new GraphError('error.run.message_not_found', { value });
      run.countDiscordCall();
      const found = await channel.messages.fetch(value).catch(() => null);
      if (!found) {
        forgetPoll(repo, d.botId, d.guild!.id, value);
        throw new GraphError('error.run.message_not_found', { value });
      }
      msg = found;
    } else {
      msg = await messageOf(run, node, key);
    }
    if (!msg.poll) throw new GraphError('error.run.not_a_poll', { value, message: 'That message is not a poll.' });
    return msg;
  };
  const guildId = (run: Run) => data(run).guild?.id ?? run.vars.get('server.id') ?? '';
  const NO_CASE: CaseHandle = { number: null, finish: async () => undefined, fail: () => undefined };

  /**
   * Runs a moderation action as a case (moderation module): case and direct
   * message first, the Discord call, then log and automatic punishments.
   * Role and voice changes only count when a command changes someone else.
   */
  async function asCase<T>(run: Run, node: GraphNode, guild: Guild, userId: string, action: CaseAction, duration: string, call: () => Promise<T>): Promise<T> {
    const d = data(run);
    const soft = action.startsWith('role_') || action.startsWith('voice_');
    const skip = !mod || (soft && (!d.interaction || d.user?.id === userId));
    const handle = skip ? NO_CASE : await mod.begin({ guild, userId, moderatorId: moderatorOf(run), action, reason: run.str(node, 'reason'), duration });
    let out: T;
    try {
      out = await call();
    } catch (err) {
      handle.fail();
      throw err;
    }
    if (handle.number !== null) run.setResult(node, '.case', handle.number);
    await handle.finish();
    return out;
  }

  /** undo_after of a block: a durable job (scheduled_jobs), runs after a restart too. */
  const undoAfter = (run: Run, node: GraphNode, payload: Record<string, unknown>, key: string | null): void => {
    const after = run.str(node, 'undo_after').trim();
    if (!after) return;
    if (key) repo.cancelJobs(data(run).botId, key);
    repo.addJob(data(run).botId, 'undo', new Date(Date.now() + parseDuration(after)), payload, key);
  };

  /** Economy add/remove/set: results {name} the new balance, {name.currency} "🪙 Coins". */
  const economyChange = (node: GraphNode, run: Run, amount: number, mode: 'add' | 'set'): void => {
    const user = snowflake(run.str(node, 'user') || (run.vars.get('user.id') ?? ''), 'user');
    const currency = run.str(node, 'currency') || null;
    const balance = currencyRun(() => repo.changeBalance(data(run).botId, guildId(run), user, amount, mode, currency));
    run.setResult(node, '', balance);
    run.setResult(node, '.currency', repo.currencyLabel(data(run).botId, currency));
  };

  return new Map<string, Handler>([
    ['action.send_message', sendMessage],
    [
      'action.delete_message',
      async (node, run) => {
        const msg = await messageOf(run, node, 'message');
        const delay = Number(run.raw(node, 'delay') ?? 0);
        if (delay > 0) await run.pause(Math.min(delay, 900) * 1000);
        await discord(run, () => msg.delete());
      },
    ],
    [
      'action.react_message',
      async (node, run) => {
        const msg = await messageOf(run, node, 'message');
        const emojis = run.str(node, 'emojis').split(/\s+/).filter(Boolean).slice(0, 20);
        const mode = String(run.raw(node, 'reaction_mode') ?? 'add');
        if (mode === 'remove_all') return void (await discord(run, () => msg.reactions.removeAll()));
        for (const e of emojis) {
          if (mode === 'add') await discord(run, () => msg.react(e));
          else {
            const reaction = msg.reactions.cache.find((r) => r.emoji.name === e || r.emoji.toString() === e || r.emoji.id === e);
            if (!reaction) continue;
            const who = mode === 'remove_bot' ? data(run).client.user!.id : snowflake(run.str(node, 'user'), 'user');
            await discord(run, () => reaction.users.remove(who));
          }
        }
      },
    ],
    [
      'action.pin_message',
      async (node, run) => {
        const msg = await messageOf(run, node, 'message');
        await discord(run, () => (run.bool(node, 'unpin') ? msg.unpin() : msg.pin()));
      },
    ],
    [
      'action.add_roles',
      async (node, run) => {
        const m = await memberOf(run, node);
        const roles = snowflakes(run.str(node, 'roles'), 'roles');
        await asCase(run, node, m.guild, m.id, 'role_add', run.str(node, 'undo_after'), () => discord(run, () => m.roles.add(roles, reason(run, node))));
        undoAfter(run, node, { op: 'remove_roles', guild: m.guild.id, user: m.id, roles }, `temprole:${m.guild.id}:${m.id}:${roles.join(',')}`);
      },
    ],
    [
      'action.remove_roles',
      async (node, run) => {
        const m = await memberOf(run, node);
        const roles = snowflakes(run.str(node, 'roles'), 'roles');
        await asCase(run, node, m.guild, m.id, 'role_remove', run.str(node, 'undo_after'), () => discord(run, () => m.roles.remove(roles, reason(run, node))));
        undoAfter(run, node, { op: 'add_roles', guild: m.guild.id, user: m.id, roles }, null);
      },
    ],
    [
      'action.kick',
      async (node, run) => {
        const m = await memberOf(run, node);
        await asCase(run, node, m.guild, m.id, 'kick', '', () => discord(run, () => m.kick(reason(run, node))));
      },
    ],
    [
      'action.ban',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = snowflake(run.str(node, 'user'), 'user');
        let del = String(run.raw(node, 'delete_messages') ?? 'none');
        if (del === 'none' && mod) del = mod.banDeleteDefault();
        const seconds = del === 'none' ? 0 : parseDuration(del) / 1000;
        const temp = run.str(node, 'undo_after').trim();
        await asCase(run, node, guild, id, 'ban', temp, () => discord(run, () => guild.members.ban(id, { reason: reason(run, node), deleteMessageSeconds: seconds })));
        undoAfter(run, node, { op: 'unban', guild: guild.id, user: id }, `tempban:${guild.id}:${id}`);
      },
    ],
    [
      'action.unban',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = snowflake(run.str(node, 'user'), 'user');
        await asCase(run, node, guild, id, 'unban', '', () => discord(run, () => guild.members.unban(id, reason(run, node))));
        repo.cancelJobs(data(run).botId, `tempban:${guild.id}:${id}`);
      },
    ],
    [
      'action.timeout',
      async (node, run) => {
        const m = await memberOf(run, node);
        const text = run.str(node, 'duration');
        const ms = text ? parseDuration(text) : null; // empty = remove the timeout
        if (ms !== null && ms > 28 * 86_400_000) throw new GraphError('error.run.timeout_too_long', { max: '28d' });
        await asCase(run, node, m.guild, m.id, ms === null ? 'untimeout' : 'timeout', text, () => discord(run, () => m.timeout(ms, reason(run, node))));
      },
    ],
    [
      'action.change_nickname',
      async (node, run) => {
        const m = await memberOf(run, node);
        await discord(run, () => m.setNickname(run.str(node, 'nickname').slice(0, 32) || null, reason(run, node)));
      },
    ],
    [
      'action.mute_member',
      async (node, run) => {
        const m = await memberOf(run, node);
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        const mute = run.bool(node, 'mute') || run.raw(node, 'mute') === undefined;
        await asCase(run, node, m.guild, m.id, mute ? 'voice_mute' : 'voice_unmute', run.str(node, 'undo_after'), () => discord(run, () => m.voice.setMute(mute, reason(run, node))));
        const after = run.str(node, 'undo_after');
        if (after) {
          // In-process timer like delete_after: lost on restart, max. 24 h.
          setTimeout(() => void m.voice.setMute(!mute).catch(() => undefined), Math.min(parseDuration(after), 24 * 3_600_000)).unref();
        }
      },
    ],
    [
      'action.voice_kick',
      async (node, run) => {
        const m = await memberOf(run, node);
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        await asCase(run, node, m.guild, m.id, 'voice_kick', '', () => discord(run, () => m.voice.disconnect(reason(run, node))));
      },
    ],
    [
      'action.deafen_member',
      async (node, run) => {
        const m = await memberOf(run, node);
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        const deaf = run.bool(node, 'deafen') || run.raw(node, 'deafen') === undefined;
        const after = run.str(node, 'undo_after');
        // Like BotGhost's voice deaf: server deafen and server mute together.
        await asCase(run, node, m.guild, m.id, deaf ? 'voice_deafen' : 'voice_undeafen', after, () =>
          discord(run, async () => {
            await m.voice.setDeaf(deaf, reason(run, node));
            return m.voice.setMute(deaf, reason(run, node));
          }),
        );
        undoAfter(run, node, { op: deaf ? 'undeafen' : 'deafen', guild: m.guild.id, user: m.id }, null);
      },
    ],
    [
      'action.edit_channel',
      async (node, run) => {
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = await data(run).client.channels.fetch(snowflake(value, 'channel')).catch(() => null);
        if (!ch || !('edit' in ch) || ch.isDMBased()) throw new GraphError('error.run.channel_not_found', { value });
        const edit: Record<string, unknown> = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 100);
        const topic = run.str(node, 'topic');
        if (topic) edit.topic = topic.slice(0, 1024);
        // Slowmode in seconds, or a duration like 10s / 5m / 1h.
        const slow = run.str(node, 'slowmode').trim();
        if (slow !== '') {
          const seconds = /^\d+$/.test(slow) ? Number(slow) : parseDuration(slow) / 1000;
          edit.rateLimitPerUser = Math.max(0, Math.min(21_600, Math.trunc(seconds)));
        }
        if (node.config.nsfw !== undefined) edit.nsfw = run.bool(node, 'nsfw');
        await discord(run, () => (ch as { edit(o: Record<string, unknown>): Promise<unknown> }).edit(edit));
      },
    ],
    [
      'action.create_channel',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const name = run.str(node, 'name').trim().slice(0, 100);
        if (!name) throw new GraphError('error.run.missing_value', { field: 'name' });
        const kind = String(run.raw(node, 'channel_type') ?? 'text');
        const type = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 }[kind] ?? 0;
        const opts: Record<string, unknown> = { name, type, reason: reason(run, node) };
        const parent = run.str(node, 'parent').trim();
        if (parent && type !== 4) opts.parent = snowflake(parent, 'parent');
        const topic = run.str(node, 'topic');
        if (topic && (type === 0 || type === 5 || type === 15)) opts.topic = topic.slice(0, 1024);
        if (type === 0 && node.config.nsfw !== undefined) opts.nsfw = run.bool(node, 'nsfw');
        const slow = Number(run.raw(node, 'slowmode') ?? 0);
        if (type === 0 && slow > 0) opts.rateLimitPerUser = Math.min(21_600, Math.trunc(slow));
        const everyone = guild.roles.everyone.id;
        const access = String(run.raw(node, 'access') ?? 'default');
        if (access === 'private') {
          opts.permissionOverwrites = [
            { id: everyone, deny: ['ViewChannel'] },
            { id: snowflake(run.str(node, 'user'), 'user'), allow: ['ViewChannel', 'SendMessages'] },
          ];
        } else if (access === 'staff') {
          opts.permissionOverwrites = [
            { id: everyone, deny: ['ViewChannel'] },
            { id: snowflake(run.str(node, 'staff_role'), 'staff_role'), allow: ['ViewChannel', 'SendMessages'] },
          ];
        } else if (access === 'read_only') {
          opts.permissionOverwrites = [{ id: everyone, deny: ['SendMessages'] }];
        } else if (access === 'hidden') {
          opts.permissionOverwrites = [{ id: everyone, deny: ['ViewChannel'] }];
        }
        const ch = await discord(run, () => guild.channels.create(opts as never));
        run.setResult(node, '', `<#${ch.id}>`);
        run.setResult(node, '.id', ch.id);
        run.setResult(node, '.name', ch.name);
      },
    ],
    [
      'action.delete_channel',
      async (node, run) => {
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = await data(run).client.channels.fetch(snowflake(value, 'channel')).catch(() => null);
        if (!ch || ch.isDMBased() || !('delete' in ch)) throw new GraphError('error.run.channel_not_found', { value });
        await discord(run, () => (ch as { delete(reason?: string): Promise<unknown> }).delete(reason(run, node)));
      },
    ],
    [
      'action.member_info',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = snowflake(run.str(node, 'user') || (run.vars.get('user.id') ?? ''), 'user');
        run.countDiscordCall();
        const member = await guild.members.fetch(id).catch(() => null);
        const user = member?.user ?? (await data(run).client.users.fetch(id).catch(() => null));
        if (!user) throw new GraphError('error.run.member_not_found', { value: id });
        const ts = (ms: number | null | undefined) => (ms ? `<t:${Math.floor(ms / 1000)}:D>` : '');
        run.setResult(node, '', member?.displayName ?? user.globalName ?? user.username);
        run.setResult(node, '.id', user.id);
        run.setResult(node, '.name', user.username);
        run.setResult(node, '.mention', `<@${user.id}>`);
        run.setResult(node, '.avatar', member?.displayAvatarURL({ size: 1024 }) ?? user.displayAvatarURL({ size: 1024 }));
        run.setResult(node, '.created', ts(user.createdTimestamp));
        run.setResult(node, '.joined', ts(member?.joinedTimestamp));
        const roles = member ? [...member.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position) : [];
        run.setResult(node, '.roles', roles.map((r) => `<@&${r.id}>`).join(' ') || '—');
        run.setResult(node, '.role_count', roles.length);
        run.setResult(node, '.bot', user.bot ? 'yes' : 'no');
      },
    ],
    [
      'action.automod_list',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const rules = await discord(run, () => guild.autoModerationRules.fetch());
        const list = [...rules.values()];
        run.setResult(node, '', list.map((r, i) => `${i + 1}. ${r.enabled ? '✅' : '⏸'} **${r.name}**`).join('\n') || '—');
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.list_bans',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const bans = await discord(run, () => guild.bans.fetch({ limit: 1000 }));
        const list = [...bans.values()];
        run.setResult(node, '', list.map((b, i) => `${i + 1}. ${b.user.username} (${b.user.id})${b.reason ? ` – ${b.reason}` : ''}`).join('\n'));
        run.setResult(node, '.count', list.length);
      },
    ],
    ...musicHandlers(secret),
    [
      'action.ticket_panel',
      async (node, run) => {
        const d = data(run);
        const channel = await guildChannel(run, node);
        const cfg = repo.moduleConfig(d.botId, 'ticket') as Partial<TicketConfig>;
        const index = ticketPanelIndex(cfg, run.str(node, 'panel'));
        if (index < 0) throw new GraphError('error.run.module_failed', { message: 'There is no such ticket panel. Set up the panels in the Ticket module first.' });
        const sent: Message = await discord(run, (): Promise<Message> => channel.send(ticketPanelPayload(cfg.panels![index]!, index, channel.guild)));
        const variable = typeof node.config.variable === 'string' ? node.config.variable : '';
        if (variable) d.messages.set(variable, sent);
        run.setResult(node, '.id', sent.id);
        run.setResult(node, '.url', sent.url);
      },
    ],
    [
      'action.ticket_create',
      async (node, run) => {
        const ctx = moduleCtx(run);
        const member = await memberOf(run, node);
        const cfg = ctx.config<TicketConfig>('ticket');
        const index = ticketPanelIndex(cfg, run.str(node, 'panel'));
        if (index < 0) throw new GraphError('error.run.module_failed', { message: 'There is no such ticket panel. Set up the panels in the Ticket module first.' });
        run.countDiscordCall();
        const res = await createTicket(ctx, member.guild, member, cfg, index);
        if ('error' in res) throw new GraphError('error.run.module_failed', { message: res.error });
        run.setResult(node, '', res.channelId);
        run.setResult(node, '.mention', `<#${res.channelId}>`);
      },
    ],
    [
      'action.ticket_close',
      async (node, run) => {
        run.countDiscordCall();
        check(await finishTicket(moduleCtx(run), await guildChannel(run, node), moderatorOf(run) ?? '', run.str(node, 'reason').slice(0, 500), 'close'));
      },
    ],
    [
      'action.ticket_delete',
      async (node, run) => {
        run.countDiscordCall();
        check(await finishTicket(moduleCtx(run), await guildChannel(run, node), moderatorOf(run) ?? '', run.str(node, 'reason').slice(0, 500), 'delete'));
      },
    ],
    [
      'action.ticket_reopen',
      async (node, run) => {
        run.countDiscordCall();
        check(await reopenTicket(moduleCtx(run), await guildChannel(run, node)));
      },
    ],
    [
      'action.ticket_add_member',
      async (node, run) => {
        run.countDiscordCall();
        check(await ticketMember(moduleCtx(run), await guildChannel(run, node), snowflake(run.str(node, 'user'), 'user'), true));
      },
    ],
    [
      'action.ticket_remove_member',
      async (node, run) => {
        run.countDiscordCall();
        check(await ticketMember(moduleCtx(run), await guildChannel(run, node), snowflake(run.str(node, 'user'), 'user'), false));
      },
    ],
    [
      'action.ticket_stats',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const c = ticketCounts(moduleCtx(run), guild.id);
        run.setResult(node, '', `Open: ${c.open} · Closed: ${c.closed} · All: ${c.total}`);
        run.setResult(node, '.open', c.open);
        run.setResult(node, '.closed', c.closed);
        run.setResult(node, '.total', c.total);
      },
    ],
    [
      'action.modmail_close',
      async (node, run) => {
        run.countDiscordCall();
        check(await modmailClose(moduleCtx(run), await guildChannel(run, node, '_'), moderatorOf(run) ?? '', run.str(node, 'reason').slice(0, 500)));
      },
    ],
    [
      'action.modmail_reply',
      async (node, run) => {
        const text = run.str(node, 'message').trim();
        if (!text) throw new GraphError('error.run.empty_message');
        run.countDiscordCall();
        check(await modmailReply(moduleCtx(run), await guildChannel(run, node, '_'), data(run).member, text.slice(0, 4000)));
      },
    ],
    [
      'action.modmail_block',
      async (node, run) => {
        const guild = await guildOf(run, node);
        modmailBlock(moduleCtx(run), guild.id, snowflake(run.str(node, 'user'), 'user'), moderatorOf(run), true);
      },
    ],
    [
      'action.modmail_unblock',
      async (node, run) => {
        const guild = await guildOf(run, node);
        modmailBlock(moduleCtx(run), guild.id, snowflake(run.str(node, 'user'), 'user'), moderatorOf(run), false);
      },
    ],
    [
      'action.free_games',
      async (node, run) => {
        run.countDiscordCall();
        const choice = run.str(node, 'platforms') || 'settings';
        const platforms =
          choice === 'settings' ? platformsOf(repo.moduleConfig(data(run).botId, 'free-games') as Partial<FreeGamesConfig>) : { epic: choice !== 'steam', steam: choice !== 'epic' };
        let games;
        try {
          games = await freeGames(platforms);
        } catch (err) {
          throw new GraphError('error.run.module_failed', { message: `The free games could not be loaded: ${(err as Error).message}` });
        }
        run.setResult(node, '', freeGamesText(games) || 'No free games right now.');
        run.setResult(node, '.count', games.length);
        if (run.raw(node, 'embeds') === undefined || run.bool(node, 'embeds')) {
          const embeds = games.slice(0, 10).map(gameEmbed);
          await answer(run, embeds.length ? { content: `🎮 **Free games right now (${games.length})**`, embeds } : { content: 'No free games right now.' });
        }
      },
    ],
    [
      'action.game_sales',
      async (node, run) => {
        run.countDiscordCall();
        const cfg = repo.moduleConfig(data(run).botId, 'free-games') as Partial<FreeGamesConfig>;
        const min = Math.max(0, Math.min(100, Math.trunc(Number(run.raw(node, 'min_discount') ?? 0)) || 0));
        const limit = Math.max(1, Math.min(25, Math.trunc(Number(run.raw(node, 'limit') ?? 20)) || 20));
        let sales;
        try {
          sales = (await gameSales(String(cfg.salesCountry || 'de').toLowerCase())).filter((s) => s.percent >= min).slice(0, limit);
        } catch (err) {
          throw new GraphError('error.run.module_failed', { message: `The Steam sales could not be loaded: ${(err as Error).message}` });
        }
        const text = gameSalesText(sales);
        run.setResult(node, '', text || 'No Steam sales right now.');
        run.setResult(node, '.count', sales.length);
        if (run.raw(node, 'reply') === undefined || run.bool(node, 'reply')) {
          const embed = new EmbedBuilder().setColor(0x1b2838).setTitle(`💸 Steam sales (${sales.length})`).setURL('https://store.steampowered.com/specials')
            .setDescription((text || 'No Steam sales right now.').slice(0, 4096));
          // Picture of the module settings (top right of the embed).
          if (/^https:\/\/\S{1,500}$/.test(String(cfg.salesImage ?? ''))) embed.setThumbnail(String(cfg.salesImage));
          await answer(run, { embeds: [embed] });
        }
      },
    ],
    [
      'action.giveaway_create',
      async (node, run) => {
        const d = data(run);
        const value = run.str(node, 'channel');
        const channel = value ? await channelOf(run, value, 'channel') : d.channel;
        if (!channel || !('guildId' in channel) || !channel.guildId) throw new GraphError('error.run.needs_server');
        const prize = run.str(node, 'prize').trim().slice(0, 200);
        if (!prize) throw new GraphError('error.run.giveaway_prize', { message: 'The giveaway needs a prize.' });
        const ms = parseDuration(run.str(node, 'duration') || '1d');
        if (ms < 60_000 || ms > 60 * 86_400_000) throw new GraphError('error.run.giveaway_duration', { message: 'A giveaway lasts 1 minute to 60 days (e.g. 30m, 2h, 7d).' });
        const winners = Math.max(1, Math.min(50, Math.trunc(run.num(node, 'winners') || 1)));
        const roleValue = run.str(node, 'role').trim();
        const g: Giveaway = {
          channel: channel.id, prize, winners, endsAt: new Date(Date.now() + ms).toISOString(), ended: false, winnerIds: [], entrants: [],
          role: roleValue ? snowflake(roleValue, 'role') : null, host: d.user?.id ?? null, url: '',
        };
        const sent: Message = await discord(run, (): Promise<Message> => channel.send(giveawayPayload(g)));
        g.url = sent.url;
        saveGiveaway(repo, d.botId, channel.guildId, sent.id, g);
        repo.addJob(d.botId, 'undo', new Date(g.endsAt), { op: 'giveaway_end', guild: channel.guildId, user: d.client.user?.id ?? '-', message: sent.id }, `giveaway:${sent.id}`);
        const variable = typeof node.config.variable === 'string' ? node.config.variable : '';
        if (variable) d.messages.set(variable, sent);
        run.setResult(node, '', sent.id);
        run.setResult(node, '.id', sent.id);
        run.setResult(node, '.url', sent.url);
      },
    ],
    [
      'action.giveaway_end',
      async (node, run) => {
        const d = data(run);
        const { guild, id } = await giveawayOf(run, node);
        repo.cancelJobs(d.botId, `giveaway:${id}`);
        run.countDiscordCall();
        const winners = (await endGiveaway(repo, d.botId, d.client, guild, id)) ?? [];
        run.setResult(node, '', winners.map((w) => `<@${w}>`).join(', '));
      },
    ],
    [
      'action.giveaway_reroll',
      async (node, run) => {
        const d = data(run);
        const { guild, id, g } = await giveawayOf(run, node);
        if (!g.ended) throw new GraphError('error.run.giveaway_running', { message: 'The giveaway is still running; end it first.' });
        run.countDiscordCall();
        const winners = (await endGiveaway(repo, d.botId, d.client, guild, id, Math.max(1, Math.min(50, Math.trunc(run.num(node, 'winners') || 1))))) ?? [];
        run.setResult(node, '', winners.map((w) => `<@${w}>`).join(', '));
      },
    ],
    [
      'action.giveaway_delete',
      async (node, run) => {
        const d = data(run);
        const { guild, id, g } = await giveawayOf(run, node);
        repo.cancelJobs(d.botId, `giveaway:${id}`);
        run.countDiscordCall();
        const ch = await d.client.channels.fetch(g.channel).catch(() => null);
        if (ch && ch.isTextBased() && 'messages' in ch) await ch.messages.delete(id).catch(() => undefined);
        deleteGiveaway(repo, d.botId, guild, id);
      },
    ],
    [
      'action.giveaway_list',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = listGiveaways(repo, data(run).botId, guild.id);
        const line = (g: Giveaway & { id: string }, i: number) => {
          const end = Math.floor(Date.parse(g.endsAt) / 1000);
          const state = g.ended ? `ended · ${g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>`).join(', ') : 'no winner'}` : `ends <t:${end}:R> · ${g.entrants.length} entries`;
          return `${i + 1}. [${g.prize}](${g.url}) · ${state} · ID ${g.id}`;
        };
        run.setResult(node, '', list.slice(0, 25).map(line).join('\n') || '—');
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.poll_create',
      async (node, run) => {
        const d = data(run);
        const value = run.str(node, 'channel');
        const channel = value ? await channelOf(run, value, 'channel') : d.channel;
        if (!channel) throw new GraphError('error.run.no_channel');
        const question = run.str(node, 'question').trim().slice(0, 300);
        const answers = pollAnswers(run.str(node, 'answers'));
        if (!question) throw new GraphError('error.run.poll_question', { message: 'The poll needs a question.' });
        if (answers.length < 2 || answers.length > 10 || answers.some((a) => a.length > 55)) throw new GraphError('error.run.poll_answers', { count: answers.length, message: 'A poll needs 2 to 10 answers of up to 55 characters (one per line or separated by |).' });
        const sent: Message = await discord(run, (): Promise<Message> =>
          channel.send({ poll: { question: { text: question }, answers: answers.map((text) => ({ text })), duration: pollHours(run.str(node, 'duration')), allowMultiselect: run.bool(node, 'multiple') } }),
        );
        rememberPoll(repo, d.botId, sent);
        const variable = typeof node.config.variable === 'string' ? node.config.variable : '';
        if (variable) d.messages.set(variable, sent);
        run.setResult(node, '', sent.id);
        run.setResult(node, '.id', sent.id);
        run.setResult(node, '.url', sent.url);
      },
    ],
    [
      'action.poll_register',
      async (node, run) => {
        const d = data(run);
        const msg = await pollMessage(run, node, 'message');
        rememberPoll(repo, d.botId, msg);
        const variable = typeof node.config.variable === 'string' ? node.config.variable : '';
        if (variable) d.messages.set(variable, msg);
        run.setResult(node, '.id', msg.id);
      },
    ],
    [
      'action.poll_results',
      async (node, run) => {
        const msg = await pollMessage(run, node, 'poll');
        const poll = msg.poll!;
        const answers = [...poll.answers.values()].map((a) => ({ text: a.text ?? '', votes: a.voteCount }));
        const sum = pollSummary(answers);
        const ended = poll.resultsFinalized || (poll.expiresAt !== null && poll.expiresAt.getTime() <= Date.now());
        if (msg.guildId) rememberPoll(repo, data(run).botId, msg);
        run.setResult(node, '', sum.text);
        run.setResult(node, '.question', poll.question.text ?? '');
        run.setResult(node, '.total', sum.total);
        run.setResult(node, '.winner', sum.winner);
        run.setResult(node, '.ended', ended);
        run.setResult(node, '.url', msg.url);
      },
    ],
    [
      'action.poll_list',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = knownPolls(repo, data(run).botId, guild.id);
        const now = Date.now();
        const line = (p: KnownPoll & { id: string }, i: number) => {
          const end = p.expiresAt ? Date.parse(p.expiresAt) : NaN;
          const when = Number.isNaN(end) ? '' : end > now ? ` · ends <t:${Math.floor(end / 1000)}:R>` : ' · ended';
          return `${i + 1}. [${p.question || p.id}](${p.url})${when} · ID ${p.id}`;
        };
        run.setResult(node, '', list.slice(0, 25).map(line).join('\n') || '—');
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.poll_delete',
      async (node, run) => {
        const msg = await pollMessage(run, node, 'poll');
        await discord(run, () => msg.delete());
        if (msg.guildId) forgetPoll(repo, data(run).botId, msg.guildId, msg.id);
      },
    ],
    [
      'action.purge_messages',
      async (node, run) => {
        const value = run.str(node, 'channel');
        const ch = value ? await channelOf(run, value, 'channel') : data(run).channel;
        if (!ch || !('bulkDelete' in ch)) throw new GraphError('error.run.no_channel');
        const amount = Math.max(1, Math.min(100, Math.trunc(run.num(node, 'amount'))));
        const fetched = await discord(run, () => ch.messages.fetch({ limit: 100 }));
        const from = run.str(node, 'from_user');
        const contains = run.str(node, 'contains').toLowerCase();
        const keepPinned = run.bool(node, 'keep_pinned') || run.raw(node, 'keep_pinned') === undefined;
        const list = [...fetched.values()]
          .filter((m) => !(keepPinned && m.pinned))
          .filter((m) => !from || m.author.id === from)
          .filter((m) => !run.bool(node, 'bots_only') || m.author.bot)
          .filter((m) => !contains || m.content.toLowerCase().includes(contains))
          .slice(0, amount);
        const deleted = await discord(run, () => ch.bulkDelete(list, true));
        run.setResult(node, '', deleted.size);
      },
    ],
    // --- moderation data ---
    [
      'action.warn',
      async (node, run) => {
        const m = await memberOf(run, node);
        // Stored inside the case, so automatic punishments count this warning.
        const id = await asCase(run, node, m.guild, m.id, 'warn', '', async () =>
          repo.addWarning(data(run).botId, m.guild.id, m.id, moderatorOf(run), run.str(node, 'reason')),
        );
        run.setResult(node, '', id);
        run.setResult(node, '.count', repo.warnings(data(run).botId, m.guild.id, m.id).length);
      },
    ],
    [
      'action.list_warnings',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = repo.warnings(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
        run.setResult(node, '', list.map((w, i) => `${i + 1}. ${w.reason || '–'}`).join('\n'));
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.clear_warnings',
      async (node, run) => {
        const guild = await guildOf(run, node);
        repo.clearWarnings(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
      },
    ],
    // --- moderation: cases and notes ---
    [
      'action.mod_case_get',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const n = Math.trunc(run.num(node, 'case'));
        const c = repo.modCase(data(run).botId, guild.id, n);
        if (!c) throw new GraphError('error.run.case_not_found', { value: n });
        run.setResult(node, '', caseLine(c));
        run.setResult(node, '.user', c.userId);
        run.setResult(node, '.moderator', c.moderatorId ?? '');
        run.setResult(node, '.action', actionName(c.action, c.duration));
        run.setResult(node, '.reason', c.reason);
        run.setResult(node, '.duration', c.duration);
        run.setResult(node, '.date', `<t:${Math.floor(Date.parse(c.createdAt) / 1000)}:f>`);
      },
    ],
    [
      'action.mod_case_remove',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const n = Math.trunc(run.num(node, 'case'));
        if (!repo.removeCase(data(run).botId, guild.id, n)) throw new GraphError('error.run.case_not_found', { value: n });
      },
    ],
    [
      'action.mod_history',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = repo.cases(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
        // Newest 25, so the text fits a message.
        run.setResult(node, '', list.slice(-25).map(caseLine).join('\n'));
        run.setResult(node, '.count', list.length);
        for (const a of ['warn', 'timeout', 'kick', 'ban'] as const) run.setResult(node, `.${a}s`, list.filter((c) => c.action === a).length);
      },
    ],
    [
      'action.mod_history_clear',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const user = snowflake(run.str(node, 'user'), 'user');
        const n = repo.clearCases(data(run).botId, guild.id, user);
        // Warnings belong to the history; automatic punishments start again from 0.
        repo.clearWarnings(data(run).botId, guild.id, user);
        run.setResult(node, '', n);
      },
    ],
    [
      'action.mod_note_add',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const text = run.str(node, 'note').trim();
        if (!text) throw new GraphError('error.run.empty_note');
        run.setResult(node, '', repo.addNote(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'), data(run).user?.id ?? null, text));
      },
    ],
    [
      'action.mod_note_remove',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = Math.trunc(run.num(node, 'note'));
        if (!repo.removeNote(data(run).botId, guild.id, id)) throw new GraphError('error.run.note_not_found', { value: id });
      },
    ],
    [
      'action.mod_notes',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = repo.notes(data(run).botId, guild.id, snowflake(run.str(node, 'user'), 'user'));
        run.setResult(node, '', list.map((n) => `**#${n.id}** ${n.content}${n.authorId ? ` – <@${n.authorId}>` : ''}`).join('\n'));
        run.setResult(node, '.count', list.length);
      },
    ],
    [
      'action.lock_channel',
      async (node, run) => {
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = await data(run).client.channels.fetch(snowflake(value, 'channel')).catch(() => null);
        if (!ch || ch.isDMBased() || !('permissionOverwrites' in ch)) throw new GraphError('error.run.channel_not_found', { value });
        const lock = run.bool(node, 'lock') || run.raw(node, 'lock') === undefined;
        // @everyone: deny Send Messages (and in threads), or back to "not set".
        const allow = lock ? false : null;
        await discord(run, () =>
          ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: allow, SendMessagesInThreads: allow, CreatePublicThreads: allow }, { reason: reason(run, node) }),
        );
      },
    ],
    // --- economy (currency of the block, else the default) ---
    ['action.economy_get', (node, run) => {
      const user = snowflake(run.str(node, 'user') || (run.vars.get('user.id') ?? ''), 'user');
      const all = currencyRun(() => repo.balances(data(run).botId, guildId(run), user));
      const cur = run.str(node, 'currency').toLowerCase();
      const one = (cur && all.find((c) => c.key === cur)) || all[0];
      run.setResult(node, '', one?.balance ?? 0);
      run.setResult(node, '.bank', one?.bank ?? 0);
      run.setResult(node, '.all', all.map((c) => `${c.symbol ? `${c.symbol} ` : ''}**${c.balance.toLocaleString('en-US')}** ${c.name}${c.bank ? ` · bank ${c.bank.toLocaleString('en-US')}` : ''}`).join('\n'));
    }],
    ['action.economy_add', (node, run) => economyChange(node, run, run.num(node, 'amount'), 'add')],
    ['action.economy_remove', (node, run) => economyChange(node, run, -run.num(node, 'amount'), 'add')],
    ['action.economy_set', (node, run) => economyChange(node, run, run.num(node, 'amount'), 'set')],
    [
      'action.economy_pay',
      (node, run) => {
        const ok = currencyRun(() => repo.pay(data(run).botId, guildId(run), snowflake(run.str(node, 'from_user'), 'from_user'), snowflake(run.str(node, 'to_user'), 'to_user'), Math.trunc(run.num(node, 'amount')), run.str(node, 'currency') || null));
        if (!ok) throw new GraphError('error.run.not_enough_balance');
        run.setResult(node, '.currency', currencyRun(() => repo.currencyLabel(data(run).botId, run.str(node, 'currency') || null)));
      },
    ],
    [
      'action.economy_leaderboard',
      (node, run) => {
        const limit = Math.max(1, Math.min(25, Math.trunc(Number(run.raw(node, 'limit') ?? 10))));
        const rows = currencyRun(() => repo.leaderboard(data(run).botId, guildId(run), limit, run.str(node, 'currency') || null));
        run.setResult(node, '', rows.map((r, i) => `${i + 1}. <@${r.userId}> – ${r.balance}`).join('\n'));
        run.setResult(node, '.currency', currencyRun(() => repo.currencyLabel(data(run).botId, run.str(node, 'currency') || null)));
      },
    ],
  ]);
}
