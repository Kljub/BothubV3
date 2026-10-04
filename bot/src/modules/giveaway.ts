// Giveaways (blocks Create/End/Reroll/Delete/List Giveaway): a giveaway is a
// components-v2 message with an "Enter" button; entries, winners and the end
// time live in module_state (module "giveaway", key "gw:<message id>"). The
// end is a scheduled job (kind "undo", op "giveaway_end"), so a restart of the
// bot does not lose it.

import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Client,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import { randomInt } from 'node:crypto';
import type { Repo } from '../core/repo.js';

export interface Giveaway {
  channel: string;
  prize: string;
  winners: number;
  endsAt: string;
  ended: boolean;
  winnerIds: string[];
  entrants: string[];
  role: string | null;
  host: string | null;
  url: string;
}

const MAX_ENTRANTS = 50_000;

export function loadGiveaway(repo: Repo, botId: number, guildId: string, id: string): Giveaway | null {
  const row = repo.db.prepare("SELECT value FROM module_state WHERE bot_id = ? AND module = 'giveaway' AND guild_id = ? AND key = ?").get(botId, guildId, `gw:${id}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(String(row.value)) as Giveaway;
  } catch {
    return null;
  }
}

export function saveGiveaway(repo: Repo, botId: number, guildId: string, id: string, g: Giveaway): void {
  repo.db
    .prepare(
      `INSERT INTO module_state (bot_id, module, guild_id, key, value, updated_at) VALUES (?, 'giveaway', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (bot_id, module, guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(botId, guildId, `gw:${id}`, JSON.stringify(g));
}

export function deleteGiveaway(repo: Repo, botId: number, guildId: string, id: string): void {
  repo.db.prepare("DELETE FROM module_state WHERE bot_id = ? AND module = 'giveaway' AND guild_id = ? AND key = ?").run(botId, guildId, `gw:${id}`);
}

/** Giveaways of a server, newest first; ended ones are dropped after 30 days. */
export function listGiveaways(repo: Repo, botId: number, guildId: string): (Giveaway & { id: string })[] {
  const rows = repo.db.prepare("SELECT key, value FROM module_state WHERE bot_id = ? AND module = 'giveaway' AND guild_id = ? ORDER BY updated_at DESC").all(botId, guildId) as { key: string; value: string }[];
  const out: (Giveaway & { id: string })[] = [];
  for (const r of rows) {
    const id = String(r.key).slice(3);
    try {
      const g = JSON.parse(String(r.value)) as Giveaway;
      if (g.ended && Date.now() - Date.parse(g.endsAt) > 30 * 86_400_000) deleteGiveaway(repo, botId, guildId, id);
      else out.push({ ...g, id });
    } catch {
      continue;
    }
  }
  return out;
}

/** n different entrants at random (all of them when there are fewer). */
export function drawWinners(entrants: string[], n: number, rand: (max: number) => number = (max) => randomInt(max)): string[] {
  const pool = [...new Set(entrants)];
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(rand(pool.length), 1)[0]!);
  return out;
}

/** The giveaway message: prize, end, winners, entries and the Enter button (off when ended). */
export function giveawayPayload(g: Giveaway): MessageCreateOptions {
  const end = Math.floor(Date.parse(g.endsAt) / 1000);
  const lines = [`## 🎉 ${g.prize}`];
  if (g.ended) {
    lines.push(g.winnerIds.length ? `**Winner${g.winnerIds.length > 1 ? 's' : ''}:** ${g.winnerIds.map((w) => `<@${w}>`).join(', ')}` : '**No winner:** nobody entered.');
    lines.push(`Ended <t:${end}:R> · ${g.entrants.length} ${g.entrants.length === 1 ? 'entry' : 'entries'}`);
  } else {
    lines.push(`Ends <t:${end}:R> (<t:${end}:f>)`, `**Winners:** ${g.winners} · **Entries:** ${g.entrants.length}`);
    if (g.role) lines.push(`Only for members with <@&${g.role}>.`);
  }
  if (g.host) lines.push(`Hosted by <@${g.host}>`);
  const box = new ContainerBuilder()
    .setAccentColor(g.ended ? 0x5865f2 : 0xa78bfa)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addActionRowComponents((row) =>
      row.addComponents(new ButtonBuilder().setCustomId('bhm:giveaway:enter').setStyle(ButtonStyle.Success).setEmoji('🎉').setLabel(g.ended ? 'Ended' : 'Enter').setDisabled(g.ended)),
    );
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

async function fetchMessage(client: Client, g: Giveaway, id: string): Promise<Message | null> {
  const ch = await client.channels.fetch(g.channel).catch(() => null);
  if (!ch || !ch.isTextBased() || !('messages' in ch)) return null;
  return ch.messages.fetch(id).catch(() => null);
}

/** Updates the message after a change (entries, end). */
export async function refreshGiveaway(client: Client, g: Giveaway, id: string): Promise<void> {
  const msg = await fetchMessage(client, g, id);
  if (msg) await msg.edit({ components: giveawayPayload(g).components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }).catch(() => undefined);
}

/**
 * Ends a giveaway (or draws again with reroll): picks the winners, edits the
 * message and announces them. Returns the winners; null when unknown.
 */
export async function endGiveaway(repo: Repo, botId: number, client: Client, guildId: string, id: string, reroll?: number): Promise<string[] | null> {
  const g = loadGiveaway(repo, botId, guildId, id);
  if (!g) return null;
  if (g.ended && reroll === undefined) return g.winnerIds;
  const n = reroll ?? g.winners;
  // A reroll draws from the entrants who have not won yet.
  const pool = reroll === undefined ? g.entrants : g.entrants.filter((e) => !g.winnerIds.includes(e));
  const winners = drawWinners(pool, n);
  g.ended = true;
  g.winnerIds = reroll === undefined ? winners : [...g.winnerIds, ...winners];
  if (reroll === undefined) g.endsAt = new Date(Math.min(Date.now(), Date.parse(g.endsAt))).toISOString();
  saveGiveaway(repo, botId, guildId, id, g);
  await refreshGiveaway(client, g, id);
  const msg = await fetchMessage(client, g, id);
  if (msg) {
    const text = winners.length
      ? `🎉 ${reroll === undefined ? 'Congratulations' : 'New draw'} ${winners.map((w) => `<@${w}>`).join(', ')}! You won **${g.prize}**.`
      : `Nobody ${reroll === undefined ? 'entered' : 'else entered'} the giveaway for **${g.prize}**.`;
    await msg.reply({ content: text, allowedMentions: { users: winners } }).catch(() => undefined);
  }
  return winners;
}

/** The Enter button: enters, or leaves again on a second press. */
export async function giveawayButton(repo: Repo, botId: number, i: ButtonInteraction<'cached'>): Promise<void> {
  const g = loadGiveaway(repo, botId, i.guildId, i.message.id);
  if (!g || g.ended) {
    await i.reply({ content: 'This giveaway has ended.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  if (g.role && !i.member.roles.cache.has(g.role)) {
    await i.reply({ content: `Only members with <@&${g.role}> can enter.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => undefined);
    return;
  }
  const inside = g.entrants.includes(i.user.id);
  if (!inside && g.entrants.length >= MAX_ENTRANTS) {
    await i.reply({ content: 'This giveaway is full.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  g.entrants = inside ? g.entrants.filter((e) => e !== i.user.id) : [...g.entrants, i.user.id];
  saveGiveaway(repo, botId, i.guildId, i.message.id, g);
  await i.update({ components: giveawayPayload(g).components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }).catch(() => undefined);
  await i.followUp({ content: inside ? 'You left the giveaway.' : '🎉 You entered the giveaway. Press again to leave.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
}
