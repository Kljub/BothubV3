// Event guildMemberAdd ("discord.events.members"). Each event in bothub.json
// "events" has its file events/<event>.js; the bot calls it like a node
// (10 s timeout) with a plain JSON payload in the builder's variable names,
// never a Discord object:
//   { 'server.id', 'server.name', 'server.members', 'user.id', 'user.name', 'user.mention', 'user.bot' }
// Available events: "discord.events.members" in the SDK API (sdk/API.md).
import { fill, setting } from '../services/util.js';

/** @param {import('@bothub/sdk').PluginContext} ctx */
export default async function guildMemberAdd(ctx, payload) {
  if (payload['user.bot'] === true) return;
  const channel = setting(ctx, 'welcome_channel', null);
  // Only a channel of the server the member joined.
  if (!channel?.id || channel.guild !== payload['server.id']) return;
  const text = fill(setting(ctx, 'welcome_text', 'Welcome {user}!'), {
    user: payload['user.mention'] ?? payload['user.name'] ?? '',
    server: payload['server.name'] ?? '',
    count: payload['server.members'] ?? '',
  });
  await ctx.message.send(channel.id, text);
}
