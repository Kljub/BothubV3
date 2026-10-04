// Service "messages": ctx.message.send(channelId, message) ("discord.messages.send").
// message: a string or { content?, embeds?: [{ title, description, color,
// fields, footer, image_url, ... }] } like the "Send or Edit a Message"
// block. Returns the message ID. Mentions never ping; at most 5 messages
// per 5 seconds per plugin and bot.

/** Builds an embed message; empty parts are left out. */
export function embed({ title, text, color = '#5865f2', footer } = {}) {
  const e = { color, description: String(text ?? '').slice(0, 4096) };
  if (title) e.title = String(title).slice(0, 256);
  if (footer) e.footer = { text: String(footer).slice(0, 2048) };
  return { embeds: [e] };
}
