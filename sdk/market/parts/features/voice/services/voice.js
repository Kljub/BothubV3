// Service "voice" ("discord.voice.connect", "discord.voice.speak"). The plugin plays files of its own
// folder, never URLs; the core streams them into Discord:
//   ctx.voice.join(guildId, channelId)        connects (one player per server)
//   ctx.voice.play(guildId, 'sounds/x.ogg', { volume: 0..1 })
//   ctx.voice.stop(guildId) / ctx.voice.leave(guildId)
//   ctx.voice.state(guildId) -> { channelId | null, playing, file | null }
// File names: sounds/<a-z 0-9 _ -, max 64>.ogg|mp3|wav, at most 2 MB each
// (zip limit). Ogg/Opus needs the least CPU on the bot.
import { setting } from './util.js';

export const SOUNDS = { chime: 'sounds/chime.wav', ding: 'sounds/ding.wav' };
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The voice channel to play in: a channel ID from the node (default
 * {user.voice.channel.id}, the channel of the member), else the one of the
 * settings page when it belongs to this server. '' when there is none.
 */
export function pickChannel(ctx, guildId, fromNode) {
  if (SNOWFLAKE.test(String(fromNode ?? ''))) return String(fromNode);
  const fromSettings = setting(ctx, 'voice_channel', null);
  return fromSettings?.guild === guildId ? fromSettings.id : '';
}

/** Joins the channel when needed and plays a sound with the page volume. */
export async function play(ctx, guildId, channelId, file) {
  const volume = Math.min(100, Math.max(0, Number(setting(ctx, 'volume', 80)))) / 100;
  const state = await ctx.voice.state(guildId);
  if (state.channelId !== channelId) await ctx.voice.join(guildId, channelId);
  await ctx.voice.play(guildId, file, { volume });
}

/** Stops; leaves the channel unless "stay connected" is on. */
export async function stop(ctx, guildId) {
  await ctx.voice.stop(guildId);
  if (!setting(ctx, 'stay_connected', false)) await ctx.voice.leave(guildId);
}
