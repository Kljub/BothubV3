// Node plugin.__ID__.announce: sends an embed, {Var.id} is the message ID.
import { embed } from '../services/messages.js';

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function announce(ctx, { config }) {
  const id = await ctx.message.send(String(config.channel), embed({ title: config.title, text: config.text, color: config.color }));
  return { results: { '.id': id } };
}
