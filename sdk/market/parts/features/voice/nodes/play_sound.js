// Node plugin.__ID__.play_sound: plays a sound in the voice channel of the
// member (or of the node / settings page). Port "no_channel" when there is
// none (member not in a voice channel, nothing set).
import { pickChannel, play, SOUNDS } from '../services/voice.js';

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function playSound(ctx, { config, vars }) {
  const guildId = vars['server.id'];
  const channelId = guildId ? pickChannel(ctx, guildId, config.channel) : '';
  if (!channelId) return { port: 'no_channel' };
  const file = SOUNDS[config.sound] ?? SOUNDS.chime;
  await play(ctx, guildId, channelId, file);
  return { results: { '': file } };
}
