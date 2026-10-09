// Music (module "music", music blocks): one queue per server on top of the
// voice manager. Tracks are found with yt-dlp (links of YouTube, SoundCloud
// and the other sites yt-dlp knows, or a YouTube search) and played through
// ffmpeg (seek, filters) as raw PCM. yt-dlp resolves the stream URL right
// before a track plays, since those URLs expire.

import { spawn, type ChildProcess } from 'node:child_process';
import { StreamType, type AudioResource } from '@discordjs/voice';
import type { Client } from 'discord.js';
import { log } from '../core/log.js';
import type { VoiceManager } from './voice.js';
import { parseSpotify, spotifyTracks, type SpotifyKeys } from './spotify.js';

export interface Track {
  title: string;
  url: string;
  /** Seconds, 0 when unknown (live streams). */
  duration: number;
  author: string;
  requester: string | null;
  /** A radio stream: the URL plays as it is (no yt-dlp, no seeking). */
  live?: boolean;
  /**
   * A plugin's stream (music.enqueue, e.g. Plex): address and headers with the
   * admin's secret. Never shown anywhere; url is then empty or a public link.
   */
  stream?: { url: string; headers: Record<string, string> };
}

/** "[Title](link)" when the track has a public web link, else "**Title**". */
export function trackLink(t: Track): string {
  return /^https?:\/\//.test(t.url) && !t.stream ? `[${t.title}](${t.url})` : `**${t.title}**`;
}

export type LoopMode = 'off' | 'track' | 'queue';

export const FILTERS: Record<string, string> = {
  bassboost: 'bass=g=10',
  nightcore: 'asetrate=60000,aresample=48000',
  vaporwave: 'asetrate=38400,aresample=48000',
  '8d': 'apulsator=hz=0.08',
  karaoke: 'stereotools=mlev=0.03',
  tremolo: 'tremolo=f=6:d=0.5',
  vibrato: 'vibrato=f=6.5:d=0.5',
  lowpass: 'lowpass=f=500',
};

export class MusicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicError';
  }
}

const OWNER = 'music';
const MAX_QUEUE = 500;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

/** Runs yt-dlp and returns stdout lines (timeout 25 s). */
function ytdlp(args: string[], timeoutMs = 25_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ['--no-warnings', '--js-runtimes', 'node', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new MusicError(`yt-dlp is not available (${e.message}).`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.split('\n').filter(Boolean));
      else reject(new MusicError(errorText(err)));
    });
  });
}

/** A short, readable reason from yt-dlp's error output. */
export function errorText(stderr: string): string {
  const line = stderr.split('\n').reverse().find((l) => l.includes('ERROR')) ?? stderr.trim().split('\n').pop() ?? '';
  const text = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '').trim();
  if (/sign in to confirm|not a bot/i.test(text)) return 'YouTube blocked the request (bot check). Try again later or use another link.';
  return text ? text.slice(0, 300) : 'The track could not be loaded.';
}

/** One yt-dlp JSON line (--dump-json --flat-playlist) as a track. */
export function trackOf(line: string, requester: string | null): Track | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const url = String(j.webpage_url ?? j.original_url ?? j.url ?? '');
  const id = String(j.id ?? '');
  const full = url.startsWith('http') ? url : id && (j.ie_key === 'Youtube' || j.extractor_key === 'Youtube') ? `https://www.youtube.com/watch?v=${id}` : url;
  if (!full.startsWith('http')) return null;
  return {
    title: String(j.title ?? full).slice(0, 200),
    url: full,
    // Flat search results sometimes come without "duration", only "duration_string".
    duration: typeof j.duration === 'number' ? Math.round(j.duration) : parseClock(String(j.duration_string ?? '')),
    ...(j.live_status === 'is_live' || j.is_live === true ? { live: true } : {}),
    author: String(j.uploader ?? j.channel ?? j.artist ?? '').slice(0, 100),
    requester,
  };
}

/** A link, or a search on YouTube. Spotify links play from a YouTube search (spotify.ts). */
export async function findTracks(query: string, limit: number, requester: string | null, spotify: SpotifyKeys = { id: null, secret: null }): Promise<Track[]> {
  const q = query.trim();
  if (!q) throw new MusicError('Give a song name or a link.');
  const ref = parseSpotify(q);
  if (ref) return spotifyTracks(ref, spotify, requester, Math.min(MAX_QUEUE, 100));
  const target = /^https?:\/\//i.test(q) ? q : `ytsearch${Math.max(1, Math.min(50, limit))}:${q}`;
  const lines = await ytdlp(['--dump-json', '--flat-playlist', '--playlist-end', String(Math.min(MAX_QUEUE, 100)), target]);
  const tracks = lines.map((l) => trackOf(l, requester)).filter((t): t is Track => t !== null);
  if (!tracks.length) throw new MusicError('Nothing found.');
  return tracks;
}

/** "3:05" or "1:02:03" -> seconds; 0 when it is not a time. */
export function parseClock(text: string): number {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text.trim())) return 0;
  return text.trim().split(':').reduce((n, part) => n * 60 + Number(part), 0);
}

/** Length of a track for lists: "3:05", "live" for streams, "?:??" when unknown. */
export function trackLength(t: Pick<Track, 'duration' | 'live'>): string {
  if (t.live) return 'live';
  return t.duration > 0 ? clock(t.duration) : '?:??';
}

/** "0:00", "3:05", "1:02:03". */
export function clock(seconds: number): string {
  seconds = Math.max(0, seconds || 0);
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** The ffmpeg arguments: stream URL from the start position, filters, raw PCM out. */
export function ffmpegArgs(streamUrl: string, seek: number, filters: string[], headers: Record<string, string> = {}): string[] {
  const af = filters.map((f) => FILTERS[f]).filter(Boolean);
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return [
    ...(head ? ['-headers', head] : []),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    '-i', streamUrl,
    ...(af.length ? ['-af', af.join(',')] : []),
    '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'error', 'pipe:1',
  ];
}

/** What comes after the current track: the next index, or -1 at the end. */
export function nextIndex(index: number, length: number, loop: LoopMode, skip = false): number {
  if (loop === 'track' && !skip) return index;
  if (index + 1 < length) return index + 1;
  return loop === 'queue' && length > 0 ? 0 : -1;
}

class GuildMusic {
  queue: Track[] = [];
  index = -1;
  loop: LoopMode = 'off';
  volume = 100;
  filters: string[] = [];
  paused = false;
  textChannel: string | null = null;
  autoleave = true;
  autoleaveDelay = 60;
  private proc: ChildProcess | null = null;
  private resource: AudioResource | null = null;
  private seekBase = 0;
  private leaveTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Set while we replace the track ourselves: the idle event is ours, not the end. */
  private replacing = false;

  constructor(
    private readonly guildId: string,
    private readonly voice: () => VoiceManager | undefined,
    private readonly client: Client,
  ) {}

  guildIdOf(): string {
    return this.guildId;
  }

  get current(): Track | null {
    return this.queue[this.index] ?? null;
  }

  /** Seconds played of the current track. */
  get position(): number {
    return this.seekBase + Math.floor((this.resource?.playbackDuration ?? 0) / 1000);
  }

  /** The bot is in a voice channel of this server. */
  get connected(): boolean {
    return Boolean(this.voice()?.state(this.guildId).channelId);
  }

  get playing(): boolean {
    return this.voice()?.state(this.guildId).owner === OWNER;
  }

  private v(): VoiceManager {
    const v = this.voice();
    if (!v || !v.state(this.guildId).channelId) throw new MusicError('The bot is not in a voice channel. Use the music player block (join) first.');
    return v;
  }

  watch(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.v().onIdle(this.guildId, () => {
      if (this.replacing) return;
      this.killProc();
      musicEvent(this.client, this.guildId, 'music_track_end', trackVars(this.current, this.queue.length));
      void this.advance(false);
    });
  }

  private killProc(): void {
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }

  /** Plays the track at index from a position (seconds). */
  async start(index: number, seek = 0): Promise<void> {
    const track = this.queue[index];
    if (!track) throw new MusicError('There is no track at this position.');
    const v = this.v();
    this.watch();
    this.cancelLeave();
    const [streamUrl] = track.stream ? [track.stream.url] : track.live ? [track.url] : await ytdlp(['-f', 'bestaudio/best', '--get-url', '--no-playlist', track.url]);
    if (!streamUrl) throw new MusicError('The track could not be loaded.');
    this.replacing = true;
    try {
      this.killProc();
      const proc = spawn('ffmpeg', ffmpegArgs(streamUrl, seek, this.filters, track.stream?.headers), { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.on('error', (e) => log.warn('ffmpeg failed', { guildId: this.guildId, err: String(e) }));
      this.proc = proc;
      this.index = index;
      this.seekBase = seek;
      this.paused = false;
      this.resource = v.play(this.guildId, proc.stdout, { owner: OWNER, label: track.title, volume: this.volume / 100, inputType: StreamType.Raw });
    } finally {
      // The player emits Idle for the replaced resource on the next tick.
      setTimeout(() => (this.replacing = false), 250).unref();
    }
    if (seek === 0) {
      musicEvent(this.client, this.guildId, 'music_track_start', trackVars(track, this.queue.length), track.requester);
      await this.announce(track);
    }
  }

  private async announce(t: Track): Promise<void> {
    if (!this.textChannel) return;
    const ch = await this.client.channels.fetch(this.textChannel).catch(() => null);
    if (ch?.isSendable()) await ch.send({ content: t.live ? `📻 Now playing: **${t.title}**${t.author ? ` · ${t.author}` : ''}${t.requester ? ` · requested by <@${t.requester}>` : ''}` : `🎶 Now playing: **${t.title}** (${trackLength(t)})${t.requester ? ` · requested by <@${t.requester}>` : ''}`, allowedMentions: { parse: [] } }).catch(() => undefined);
  }

  /** After a track: next one (loop modes), or stop and leave later. */
  async advance(skip: boolean): Promise<void> {
    const next = nextIndex(this.index, this.queue.length, this.loop, skip);
    if (next < 0) {
      this.index = this.queue.length; // after the end: "play" starts again from the top
      this.resource = null;
      musicEvent(this.client, this.guildId, 'music_queue_end', { 'queue.size': String(this.queue.length) });
      this.scheduleLeave();
      return;
    }
    await this.start(next).catch(async (err) => {
      log.warn('music track failed', { guildId: this.guildId, err: String(err) });
      musicEvent(this.client, this.guildId, 'music_track_error', { ...trackVars(this.queue[next] ?? null, this.queue.length), error: String((err as Error)?.message ?? err).slice(0, 300) });
      // A broken track is skipped (once around the queue at most).
      this.queue.splice(next, 1);
      if (next <= this.index) this.index--;
      if (this.queue.length) await this.advance(true);
    });
  }

  add(tracks: Track[], position: 'end' | 'next'): number {
    const room = MAX_QUEUE - this.queue.length;
    if (room <= 0) throw new MusicError(`The queue is full (${MAX_QUEUE} tracks).`);
    const list = tracks.slice(0, room);
    const at = position === 'next' && this.index >= 0 && this.index < this.queue.length ? this.index + 1 : this.queue.length;
    this.queue.splice(at, 0, ...list);
    return at + 1;
  }

  async play(): Promise<void> {
    if (this.playing) {
      if (this.paused) this.resume();
      return;
    }
    if (!this.queue.length) throw new MusicError('The queue is empty.');
    await this.start(this.index >= 0 && this.index < this.queue.length ? this.index : 0);
  }

  pause(): void {
    if (!this.voice()?.pause(this.guildId, OWNER)) throw new MusicError('Nothing is playing.');
    this.paused = true;
  }

  resume(): void {
    if (!this.voice()?.resume(this.guildId, OWNER)) throw new MusicError('Nothing is paused.');
    this.paused = false;
  }

  async skip(to: number): Promise<void> {
    if (!this.queue.length) throw new MusicError('The queue is empty.');
    if (to > 0) {
      if (to > this.queue.length) throw new MusicError(`The queue has only ${this.queue.length} tracks.`);
      await this.start(to - 1);
      return;
    }
    const next = nextIndex(this.index, this.queue.length, this.loop, true);
    if (next < 0) {
      this.stopPlayback();
      return;
    }
    await this.start(next);
  }

  async previous(): Promise<void> {
    if (this.index <= 0) throw new MusicError('There is no previous track.');
    await this.start(this.index - 1);
  }

  async replay(): Promise<void> {
    if (!this.current) throw new MusicError('Nothing is playing.');
    await this.start(this.index);
  }

  async seek(mode: 'absolute' | 'relative', seconds: number): Promise<void> {
    if (this.queue[this.index]?.live) throw new MusicError('A radio stream cannot be seeked.');
    const t = this.current;
    if (!t || !this.playing) throw new MusicError('Nothing is playing.');
    let to = mode === 'relative' ? this.position + seconds : seconds;
    to = Math.max(0, t.duration ? Math.min(to, t.duration - 1) : to);
    await this.start(this.index, to);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(200, Math.round(v)));
    this.resource?.volume?.setVolume(this.volume / 100);
  }

  async setFilter(name: string | null): Promise<void> {
    if (name && !FILTERS[name]) throw new MusicError('Unknown filter.');
    this.filters = name ? (this.filters.includes(name) ? this.filters.filter((f) => f !== name) : [...this.filters, name]) : [];
    // Filters apply from the current position on.
    if (this.playing && this.current) await this.start(this.index, this.position);
  }

  shuffle(): void {
    const head = this.queue.slice(0, this.index + 1);
    const rest = this.queue.slice(this.index + 1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j]!, rest[i]!];
    }
    this.queue = [...head, ...rest];
  }

  remove(from: number, count: number): number {
    if (from < 1 || from > this.queue.length) throw new MusicError(`The queue has ${this.queue.length} tracks.`);
    const removed = this.queue.splice(from - 1, count).length;
    if (from - 1 < this.index) this.index -= Math.min(removed, this.index - (from - 1));
    else if (from - 1 === this.index) {
      // The current track was removed: play what is there now.
      this.index--;
      if (this.playing) void this.advance(true);
    }
    return removed;
  }

  stopPlayback(): void {
    this.replacing = true;
    this.voice()?.stop(this.guildId, OWNER);
    this.killProc();
    this.resource = null;
    setTimeout(() => (this.replacing = false), 250).unref();
    this.scheduleLeave();
  }

  /** Stops and clears the queue. */
  stop(): void {
    this.stopPlayback();
    this.queue = [];
    this.index = -1;
  }

  disconnect(reason = 'disconnect'): void {
    const channelId = this.voice()?.state(this.guildId).channelId ?? null;
    this.stop();
    this.cancelLeave();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.voice()?.leave(this.guildId);
    if (channelId) {
      const vars = { channel: `<#${channelId}>`, 'channel.id': channelId, 'channel.name': (this.client.channels.cache.get(channelId) as { name?: string } | undefined)?.name ?? '', reason };
      musicEvent(this.client, this.guildId, 'music_voice_leave', vars);
      musicEvent(this.client, this.guildId, 'music_player_destroy', vars);
    }
  }

  private scheduleLeave(): void {
    this.cancelLeave();
    if (!this.autoleave) return;
    this.leaveTimer = setTimeout(() => {
      if (!this.playing) this.disconnect('autoleave');
    }, this.autoleaveDelay * 1000);
    this.leaveTimer.unref();
  }

  private cancelLeave(): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }
}

/** Custom event name for music (events.ts turns it into music_* event types). */
export const MUSIC_EVENT = 'bothubMusic';

export interface MusicEvent {
  type: string;
  guildId: string;
  userId?: string | null;
  vars: Record<string, string>;
}

/** Placeholders of a track ({track.title}, …, {queue.size}). */
export function trackVars(t: Track | null, queueSize: number): Record<string, string> {
  return { 'track.title': t?.title ?? '', 'track.url': t?.url ?? '', 'track.author': t?.author ?? '', 'track.duration': t ? trackLength(t) : '', 'queue.size': String(queueSize) };
}

/** Starts the music_* custom events of a server. */
export function musicEvent(client: Client, guildId: string, type: string, vars: Record<string, string> = {}, userId: string | null = null): void {
  client.emit(MUSIC_EVENT as never, { type, guildId, userId, vars } satisfies MusicEvent as never);
}

export class MusicManager {
  private readonly guilds = new Map<string, GuildMusic>();

  constructor(
    private readonly client: Client,
    private readonly voice: () => VoiceManager | undefined,
  ) {}

  get(guildId: string): GuildMusic {
    let g = this.guilds.get(guildId);
    if (!g) this.guilds.set(guildId, (g = new GuildMusic(guildId, this.voice, this.client)));
    return g;
  }

  /** Joins a voice channel (and remembers the text channel for "now playing"). */
  async join(guildId: string, channelId: string, textChannel: string | null): Promise<void> {
    const v = this.voice();
    if (!v) throw new MusicError('The bot is not running.');
    const before = v.state(guildId).channelId;
    await v.join(guildId, channelId);
    const g = this.get(guildId);
    if (textChannel) g.textChannel = textChannel;
    g.watch();
    if (before !== channelId) {
      const vars = { channel: `<#${channelId}>`, 'channel.id': channelId, 'channel.name': (this.client.channels.cache.get(channelId) as { name?: string } | undefined)?.name ?? '' };
      if (!before) musicEvent(this.client, guildId, 'music_player_create', vars);
      musicEvent(this.client, guildId, 'music_voice_join', vars);
    }
  }

  destroyAll(): void {
    for (const g of this.guilds.values()) g.disconnect('shutdown');
    this.guilds.clear();
  }
}

const managers = new WeakMap<Client, MusicManager>();

export function setMusic(client: Client, m: MusicManager | undefined): void {
  if (m) managers.set(client, m);
  else managers.delete(client);
}

export function musicOrNull(client: Client): MusicManager | undefined {
  return managers.get(client);
}

export function musicOf(client: Client): MusicManager {
  const m = managers.get(client);
  if (!m) throw new MusicError('Music is not available right now.');
  return m;
}
