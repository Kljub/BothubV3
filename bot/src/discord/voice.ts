// Voice per guild and bot: one connection and one audio player. Used by the
// plugin SDK (voice.* calls, files of the plugin folder) and by music
// (discord/music.ts: a queue as a layer above, onIdle to advance).
//
// A play has an owner ("plugin:<id>", "music", ...). Another owner cannot
// replace a running play (voice.busy); the same owner can.

import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type StreamType,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';

/** Errors carry a key like the SDK's (sdk.voice.*). */
export class VoiceError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = 'VoiceError';
  }
}

export interface VoiceState {
  channelId: string | null;
  playing: boolean;
  /** Label of the current play (e.g. the file), null when idle. */
  label: string | null;
  owner: string | null;
}

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
  label: string | null;
  owner: string | null;
  idle: Set<() => void>;
}

export class VoiceManager {
  private readonly guilds = new Map<string, GuildVoice>();

  constructor(private readonly client: Client) {}

  /** Joins a voice channel of a server the bot is in (moves when already connected). */
  async join(guildId: string, channelId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new VoiceError('sdk.voice.bad_guild');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) throw new VoiceError('sdk.voice.bad_channel');
    const old = this.guilds.get(guildId);
    if (old && old.channelId === channelId) return;
    const connection = joinVoiceChannel({ guildId, channelId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      connection.destroy();
      throw new VoiceError('sdk.voice.join_failed');
    }
    if (old) {
      // Same player, new connection.
      old.connection.destroy();
      old.connection = connection;
      old.channelId = channelId;
      connection.subscribe(old.player);
      return;
    }
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    const gv: GuildVoice = { connection, player, channelId, label: null, owner: null, idle: new Set() };
    player.on(AudioPlayerStatus.Idle, () => {
      gv.label = null;
      gv.owner = null;
      for (const fn of gv.idle) fn();
    });
    player.on('error', () => undefined); // a broken file ends the play (Idle follows)
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Kicked or channel deleted: give up the guild.
      if (this.guilds.get(guildId) === gv) this.leave(guildId);
    });
    connection.subscribe(player);
    this.guilds.set(guildId, gv);
  }

  leave(guildId: string): void {
    const gv = this.guilds.get(guildId);
    if (!gv) return;
    this.guilds.delete(guildId);
    gv.player.stop(true);
    gv.connection.destroy();
  }

  /**
   * Plays a file path or a stream. volume 0..1. Another owner's running play
   * is not replaced (sdk.voice.busy).
   */
  play(guildId: string, input: string | Readable, options: { owner: string; label?: string; volume?: number; inputType?: StreamType }): AudioResource {
    const gv = this.guilds.get(guildId);
    if (!gv) throw new VoiceError('sdk.voice.not_connected');
    if (gv.player.state.status !== AudioPlayerStatus.Idle && gv.owner && gv.owner !== options.owner) throw new VoiceError('sdk.voice.busy');
    const resource = createAudioResource(input, { inlineVolume: true, ...(options.inputType ? { inputType: options.inputType } : {}) });
    resource.volume?.setVolume(options.volume ?? 1);
    gv.owner = options.owner;
    gv.label = options.label ?? null;
    gv.player.play(resource);
    return resource;
  }

  /** Pauses the play of this owner; false when it does not play. */
  pause(guildId: string, owner: string): boolean {
    const gv = this.guilds.get(guildId);
    if (!gv || gv.owner !== owner || gv.player.state.status !== AudioPlayerStatus.Playing) return false;
    return gv.player.pause(true);
  }

  resume(guildId: string, owner: string): boolean {
    const gv = this.guilds.get(guildId);
    if (!gv || gv.owner !== owner || gv.player.state.status !== AudioPlayerStatus.Paused) return false;
    return gv.player.unpause();
  }

  /** Stops the current play; with owner only when that owner plays. */
  stop(guildId: string, owner?: string): void {
    const gv = this.guilds.get(guildId);
    if (!gv) return;
    if (owner && gv.owner && gv.owner !== owner) throw new VoiceError('sdk.voice.busy');
    gv.player.stop(true);
  }

  state(guildId: string): VoiceState {
    const gv = this.guilds.get(guildId);
    if (!gv) return { channelId: null, playing: false, label: null, owner: null };
    return { channelId: gv.channelId, playing: gv.player.state.status === AudioPlayerStatus.Playing, label: gv.label, owner: gv.owner };
  }

  /** Called whenever the player becomes idle (queues advance here); returns an unsubscribe. */
  onIdle(guildId: string, fn: () => void): () => void {
    const gv = this.guilds.get(guildId);
    if (!gv) throw new VoiceError('sdk.voice.not_connected');
    gv.idle.add(fn);
    return () => gv.idle.delete(fn);
  }

  destroyAll(): void {
    for (const id of [...this.guilds.keys()]) this.leave(id);
  }
}
