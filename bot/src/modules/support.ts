// Server management modules with buttons: Verification, Tickets, Modmail.
// Buttons and forms use the custom ID prefix "bhm:" (the graph runner only
// handles "bh:").

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import { log } from '../core/log.js';
import { baseVars, buildMessage, fill, idIn, idsIn, type MessageConfig, type ModuleContext } from './context.js';
import { assignable, Bucket, warn } from './guard.js';
import { giveawayButton } from './giveaway.js';

// ---------- pure helpers ----------

const CAPTCHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Code for captcha (letters and digits without look-alikes) or number mode. */
export function verificationCode(type: string, random = Math.random): string {
  const chars = type === 'number' ? '0123456789' : CAPTCHA;
  return Array.from({ length: type === 'number' ? 6 : 5 }, () => chars[Math.floor(random() * chars.length)]).join('');
}

export function codeMatches(expected: string, given: string): boolean {
  return expected.toUpperCase() === given.replace(/\s+/g, '').toUpperCase();
}

/** Splits long text into parts Discord accepts (no text is lost). */
export function chunks(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Plain-text transcript of messages (oldest first). */
export function transcript(messages: { at: Date; author: string; content: string; attachments: string[] }[]): string {
  return messages
    .map((m) => `[${m.at.toISOString().replace('T', ' ').slice(0, 19)}] ${m.author}: ${m.content}${m.attachments.length ? ` ${m.attachments.join(' ')}` : ''}`)
    .join('\n');
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

// ---------- panels ----------

interface VerifyConfig { channel: unknown; type: string; panel: MessageConfig; buttonLabel: string; role: unknown; removeRole: unknown; successMessage: string; failMessage: string }
interface TicketPanel { name: string; channel: unknown; panel: MessageConfig; buttonLabel: string; buttonEmoji: string[]; category: unknown; supportRoles: unknown; channelName: string; welcome: MessageConfig; pingSupport: boolean; maxPerUser: number }
export interface TicketConfig { panels: TicketPanel[]; logChannel: unknown; transcript: boolean; dmCreator: boolean }

/** Posts or updates a panel message; remembers it in module_state. */
export async function ensurePanel(ctx: ModuleContext, module: string, key: string, guild: Guild, channelId: string, payload: MessageCreateOptions): Promise<void> {
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isSendable()) return;
  const known = ctx.getState<{ channel: string; message: string }>(module, guild.id, key);
  if (known?.channel === channelId) {
    const edited = await channel.messages.edit(known.message, { content: payload.content ?? null, embeds: payload.embeds ?? [], components: payload.components ?? [] }).catch(() => null);
    if (edited) return;
  } else if (known) {
    const old = guild.channels.cache.get(known.channel);
    if (old?.isTextBased()) await old.messages.delete(known.message).catch(() => undefined);
  }
  const sent = await channel.send(payload).catch(() => null);
  if (sent) ctx.setState(module, guild.id, key, { channel: channelId, message: sent.id });
}

export async function ensurePanels(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  if (ctx.enabled('verification')) {
    const cfg = ctx.config<VerifyConfig>('verification');
    for (const g of guilds) {
      const channelId = idIn(cfg.channel, g.id);
      if (!channelId) continue;
      const payload = buildMessage(cfg.panel, baseVars(g, null)) ?? { content: 'Verification' };
      payload.components = [row(new ButtonBuilder().setCustomId('bhm:verify').setLabel((cfg.buttonLabel || 'Verify').slice(0, 80)).setStyle(ButtonStyle.Success))];
      await ensurePanel(ctx, 'verification', 'panel', g, channelId, payload);
    }
  }
  if (ctx.enabled('ticket')) {
    for (const [i, p] of (ctx.config<TicketConfig>('ticket').panels ?? []).entries()) {
      const g = guilds.find((x) => idIn(p.channel, x.id));
      if (!g) continue;
      await ensurePanel(ctx, 'ticket', `panel:${i}`, g, idIn(p.channel, g.id)!, ticketPanelPayload(p, i, g));
    }
  }
}

/** The message of a ticket panel with its "Open ticket" button. */
export function ticketPanelPayload(p: TicketPanel, index: number, guild: Guild): MessageCreateOptions {
  const payload = buildMessage(p.panel, baseVars(guild, null)) ?? { content: p.name || 'Tickets' };
  const button = new ButtonBuilder().setCustomId(`bhm:ticket:open:${index}`).setLabel((p.buttonLabel || 'Open ticket').slice(0, 80)).setStyle(ButtonStyle.Primary);
  const emoji = (p.buttonEmoji ?? [])[0];
  if (emoji) button.setEmoji(emoji);
  payload.components = [row(button)];
  return payload;
}

/** The panel with this name (case-insensitive), else the first one. */
export function ticketPanelIndex(cfg: Partial<TicketConfig>, name: string): number {
  const panels = cfg.panels ?? [];
  if (!panels.length) return -1;
  const i = name.trim() ? panels.findIndex((p) => (p.name ?? '').toLowerCase() === name.trim().toLowerCase()) : 0;
  return i;
}

// ---------- interactions ----------

const pendingCodes = new Map<string, { code: string; expires: number }>();
const verifyTries = new Map<string, { count: number; until: number }>();
const verifyRequests = new Map<string, number[]>();
// Expired codes and old counters are removed every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingCodes) if (v.expires < now) pendingCodes.delete(k);
  for (const [k, v] of verifyTries) if (v.until < now) verifyTries.delete(k);
  for (const [k, v] of verifyRequests) if (!v.some((t) => now - t < 600_000)) verifyRequests.delete(k);
}, 300_000).unref();
const ticketQueue = new Map<string, Promise<unknown>>();

export async function onModuleInteraction(ctx: ModuleContext, i: Interaction): Promise<void> {
  if (!('customId' in i) || typeof i.customId !== 'string' || !i.customId.startsWith('bhm:') || !i.inCachedGuild()) return;
  const [, module, action, arg] = i.customId.split(':');
  if (module === 'giveaway' && action === 'enter' && i.isButton()) return giveawayButton(ctx.repo, ctx.botId, i);

  if (module === 'verify') {
    const cfg = ctx.config<VerifyConfig>('verification');
    const vars = baseVars(i.guild, i.member);
    const grant = async (): Promise<string> => {
      const add = idIn(cfg.role, i.guildId);
      const remove = idIn(cfg.removeRole, i.guildId);
      // Success only when the roles really changed.
      if (add) {
        const ok = assignable(ctx, 'verification', i.guild, [add]).length === 1 && (await i.member.roles.add(add, 'Verified').then(() => true, () => false));
        if (!ok) return 'Verification is not set up correctly (the bot cannot give the role). Please tell the server team.';
      }
      if (remove && assignable(ctx, 'verification', i.guild, [remove]).length) await i.member.roles.remove(remove, 'Verified').catch(() => undefined);
      return fill(cfg.successMessage || 'You are verified.', vars);
    };
    const key = `${ctx.botId}:${i.guildId}:${i.user.id}`;
    if (i.isButton() && !action) {
      if ((cfg.type ?? 'button') === 'button') return void (await i.reply({ content: await grant(), flags: 64 }));
      const tries = verifyTries.get(key);
      if (tries && tries.count >= 3 && tries.until > Date.now()) {
        return void (await i.reply({ content: 'Too many wrong codes. Please try again in 10 minutes.', flags: 64 }));
      }
      // At most 5 new codes per 10 minutes per member.
      const asked = (verifyRequests.get(key) ?? []).filter((t) => Date.now() - t < 600_000);
      if (asked.length >= 5) return void (await i.reply({ content: 'Too many codes requested. Please try again in 10 minutes.', flags: 64 }));
      verifyRequests.set(key, [...asked, Date.now()]);
      const code = verificationCode(cfg.type ?? 'captcha');
      for (const [k, v] of pendingCodes) if (v.expires < Date.now()) pendingCodes.delete(k);
      pendingCodes.set(key, { code, expires: Date.now() + 5 * 60_000 });
      const shown = cfg.type === 'number' ? code.split('').join(' ') : code.split('').join('​');
      await i.reply({
        content: `Type this code: **\`${shown}\`**`,
        components: [row(new ButtonBuilder().setCustomId('bhm:verify:enter').setLabel('Enter code').setStyle(ButtonStyle.Primary))],
        flags: 64,
      });
      return;
    }
    if (i.isButton() && action === 'enter') {
      const modal = new ModalBuilder().setCustomId('bhm:verify:check').setTitle('Verification');
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('code').setLabel('Code').setStyle(TextInputStyle.Short).setMaxLength(12).setRequired(true)));
      await i.showModal(modal);
      return;
    }
    if (i.isModalSubmit() && action === 'check') {
      const p = pendingCodes.get(key);
      const ok = !!p && p.expires > Date.now() && codeMatches(p.code, i.fields.getTextInputValue('code'));
      pendingCodes.delete(key);
      if (ok) verifyTries.delete(key);
      else {
        const t = verifyTries.get(key);
        verifyTries.set(key, { count: t && t.until > Date.now() ? t.count + 1 : 1, until: Date.now() + 10 * 60_000 });
      }
      await i.reply({ content: ok ? await grant() : fill(cfg.failMessage || 'That was not correct.', vars), flags: 64 });
      return;
    }
  }

  if (module === 'ticket' && i.isButton()) {
    const cfg = ctx.config<TicketConfig>('ticket');
    if (action === 'open') {
      // Clicks of one server run one after another (limit and numbering).
      const key = `${ctx.botId}:${i.guildId}`;
      const run = (ticketQueue.get(key) ?? Promise.resolve()).then(() => openTicket(ctx, i, cfg, Number(arg)));
      const tail = run.catch(() => undefined);
      ticketQueue.set(key, tail);
      void tail.then(() => {
        if (ticketQueue.get(key) === tail) ticketQueue.delete(key);
      });
      return run;
    }
    if (action === 'close' || action === 'confirm') {
      const ticket = ctx.db.prepare("SELECT opener_id FROM tickets WHERE bot_id = ? AND channel_id = ? AND status = 'open'").get(ctx.botId, i.channelId) as { opener_id: string } | undefined;
      const support = (cfg.panels ?? []).flatMap((p) => idsIn(p.supportRoles, i.guildId));
      const mayClose = !ticket || ticket.opener_id === i.user.id || support.some((r) => i.member.roles.cache.has(r)) || i.memberPermissions.has(PermissionFlagsBits.ManageChannels);
      if (!mayClose) return void (await i.reply({ content: 'Only the ticket creator or the support team can close this ticket.', flags: 64 }));
    }
    if (action === 'close') {
      await i.reply({
        content: 'Close this ticket?',
        components: [row(new ButtonBuilder().setCustomId('bhm:ticket:confirm').setLabel('Close').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('bhm:ticket:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
        flags: 64,
      });
      return;
    }
    if (action === 'cancel') return void (await i.update({ content: 'Not closed.', components: [] }));
    if (action === 'confirm') return closeTicket(ctx, i, cfg);
  }
}

async function openTicket(ctx: ModuleContext, i: ButtonInteraction<'cached'>, cfg: Partial<TicketConfig>, index: number): Promise<void> {
  if (!(cfg.panels ?? [])[index]) return void (await i.reply({ content: 'This ticket panel no longer exists.', flags: 64 }));
  await i.deferReply({ flags: 64 });
  const res = await createTicket(ctx, i.guild, i.member, cfg, index);
  await i.editReply({ content: 'error' in res ? res.error : `Your ticket: <#${res.channelId}>` });
}

/**
 * Opens a ticket of a panel for a member: private channel (member, support
 * roles, bot), welcome message with the close button. Returns the channel or
 * the reason it did not work.
 */
export async function createTicket(ctx: ModuleContext, guild: Guild, member: GuildMember, cfg: Partial<TicketConfig>, index: number): Promise<{ channelId: string } | { error: string }> {
  const panel = (cfg.panels ?? [])[index];
  if (!panel) return { error: 'This ticket panel no longer exists.' };
  const open = ctx.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE bot_id = ? AND guild_id = ? AND opener_id = ? AND status = 'open'").get(ctx.botId, guild.id, member.id) as { n: number };
  if (Number(open.n) >= (panel.maxPerUser ?? 1)) return { error: 'You already have an open ticket.' };
  const number = (ctx.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE bot_id = ? AND guild_id = ?').get(ctx.botId, guild.id) as { n: number }).n;
  const support = idsIn(panel.supportRoles, guild.id).filter((r) => guild.roles.cache.has(r));
  const vars = { ...baseVars(guild, member), number: String(number), panel: panel.name ?? '' };
  const categoryId = idIn(panel.category, guild.id);
  if (categoryId && guild.channels.cache.get(categoryId)?.type !== ChannelType.GuildCategory) warn(ctx, 'WAR-2008', { module: 'ticket', problem: `panel "${panel.name}": the chosen category is not a category` });
  const channel = await guild.channels
    .create({
      name: fill(panel.channelName || 'ticket-{number}', { ...vars, user: member.user.username }).toLowerCase().replace(/\s+/g, '-').slice(0, 100),
      type: ChannelType.GuildText,
      parent: categoryId && guild.channels.cache.get(categoryId)?.type === ChannelType.GuildCategory ? categoryId : undefined,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
        ...support.map((id) => ({ id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] })),
      ],
      reason: `Ticket #${number}`,
    })
    .catch((err) => (log.debug('ticket create failed', { err: String(err) }), null));
  if (!channel) return { error: 'I could not create the ticket channel (missing permissions?).' };
  ctx.db.prepare('INSERT INTO tickets (bot_id, guild_id, number, channel_id, opener_id) VALUES (?, ?, ?, ?, ?)').run(ctx.botId, guild.id, number, channel.id, member.id);
  const welcome = buildMessage(panel.welcome, vars) ?? { content: `Ticket #${number}` };
  const pings = [`<@${member.id}>`, ...(panel.pingSupport !== false ? support.map((r) => `<@&${r}>`) : [])].join(' ');
  welcome.content = `${pings}${welcome.content ? `\n${welcome.content}` : ''}`.slice(0, 2000);
  welcome.allowedMentions = { users: [member.id], roles: panel.pingSupport !== false ? support : [] };
  welcome.components = [row(new ButtonBuilder().setCustomId('bhm:ticket:close').setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger))];
  await channel.send(welcome).catch(() => undefined);
  return { channelId: channel.id };
}

interface TicketRow { id: number; number: number; opener_id: string; status: string }

/** The ticket of a channel (open or closed). */
export function ticketOf(ctx: ModuleContext, channelId: string): TicketRow | undefined {
  return ctx.db.prepare("SELECT id, number, opener_id, status FROM tickets WHERE bot_id = ? AND channel_id = ? AND status IN ('open', 'closed')").get(ctx.botId, channelId) as TicketRow | undefined;
}

/** Up to 500 messages of a channel, oldest first, as a text file. */
async function transcriptFile(channel: GuildTextBasedChannel, number: number): Promise<AttachmentBuilder> {
  const all: Message[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  const list = all.reverse().map((m: Message) => ({ at: m.createdAt, author: m.author.username, content: m.content || (m.embeds[0]?.description ?? ''), attachments: [...m.attachments.values()].map((a) => a.url) }));
  return new AttachmentBuilder(Buffer.from(transcript(list), 'utf8'), { name: `ticket-${number}.txt` });
}

/**
 * Closes (locks: the creator can read but not write) or deletes a ticket.
 * Both log the ticket with the transcript (settings). Returns an error text or null.
 */
export async function finishTicket(ctx: ModuleContext, channel: GuildTextBasedChannel, closerId: string, reason: string, mode: 'close' | 'delete'): Promise<string | null> {
  const ticket = ticketOf(ctx, channel.id);
  if (!ticket) return 'This is not a ticket channel.';
  if (mode === 'close' && ticket.status === 'closed') return 'This ticket is already closed.';
  const cfg = ctx.config<TicketConfig>('ticket');
  const guild = channel.guild;
  ctx.db
    .prepare("UPDATE tickets SET status = ?, closed_by = ?, close_reason = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(mode === 'close' ? 'closed' : 'deleted', closerId, reason || null, ticket.id);
  const file = cfg.transcript !== false ? await transcriptFile(channel, ticket.number) : undefined;
  const embed = new EmbedBuilder()
    .setTitle(`🔒 Ticket #${ticket.number} ${mode === 'close' ? 'closed' : 'deleted'}`)
    .setColor(0xf87171)
    .addFields({ name: 'Opened by', value: `<@${ticket.opener_id}>`, inline: true }, { name: 'Closed by', value: `<@${closerId}>`, inline: true })
    .setTimestamp(new Date());
  if (reason) embed.addFields({ name: 'Reason', value: reason.slice(0, 1000) });
  const logChannel = guild.channels.cache.get(idIn(cfg.logChannel, guild.id) ?? '');
  if (logChannel?.isSendable()) await logChannel.send({ embeds: [embed], files: file ? [file] : [] }).catch(() => undefined);
  if (cfg.dmCreator) {
    const opener = await guild.client.users.fetch(ticket.opener_id).catch(() => null);
    await opener?.send({ embeds: [embed], files: file ? [new AttachmentBuilder(file.attachment as Buffer, { name: file.name ?? 'ticket.txt' })] : [] }).catch(() => undefined);
  }
  if (mode === 'delete') {
    setTimeout(() => void channel.delete(`Ticket #${ticket.number} deleted`).catch(() => undefined), 5000).unref();
    return null;
  }
  if ('permissionOverwrites' in channel) {
    await channel.permissionOverwrites.edit(ticket.opener_id, { SendMessages: false }, { reason: `Ticket #${ticket.number} closed` }).catch(() => undefined);
  }
  await channel.send({ content: `🔒 Ticket closed by <@${closerId}>.${reason ? ` Reason: ${reason.slice(0, 500)}` : ''}`, allowedMentions: { parse: [] } }).catch(() => undefined);
  return null;
}

/** Opens a closed ticket again: the creator can write again. */
export async function reopenTicket(ctx: ModuleContext, channel: GuildTextBasedChannel): Promise<string | null> {
  const ticket = ticketOf(ctx, channel.id);
  if (!ticket) return 'This is not a ticket channel.';
  if (ticket.status === 'open') return 'This ticket is open.';
  ctx.db.prepare("UPDATE tickets SET status = 'open', closed_by = NULL, close_reason = NULL, closed_at = NULL WHERE id = ?").run(ticket.id);
  if ('permissionOverwrites' in channel) {
    await channel.permissionOverwrites.edit(ticket.opener_id, { ViewChannel: true, SendMessages: true }, { reason: `Ticket #${ticket.number} reopened` }).catch(() => undefined);
  }
  return null;
}

/** Adds a member to a ticket (or removes them again). */
export async function ticketMember(ctx: ModuleContext, channel: GuildTextBasedChannel, userId: string, add: boolean): Promise<string | null> {
  const ticket = ticketOf(ctx, channel.id);
  if (!ticket) return 'This is not a ticket channel.';
  if (!add && userId === ticket.opener_id) return 'The ticket creator cannot be removed.';
  if (!('permissionOverwrites' in channel)) return 'This is not a ticket channel.';
  const ok = add
    ? await channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, AttachFiles: true, ReadMessageHistory: true }).then(() => true, () => false)
    : await channel.permissionOverwrites.delete(userId).then(() => true, () => false);
  return ok ? null : 'I could not change the channel permissions (missing Manage Channels?).';
}

/** Open, closed and all tickets of a server. */
export function ticketCounts(ctx: ModuleContext, guildId: string): { open: number; closed: number; total: number } {
  const rows = ctx.db.prepare('SELECT status, COUNT(*) AS n FROM tickets WHERE bot_id = ? AND guild_id = ? GROUP BY status').all(ctx.botId, guildId) as { status: string; n: number }[];
  const n = (st: string) => Number(rows.find((r) => r.status === st)?.n ?? 0);
  return { open: n('open'), closed: n('closed'), total: rows.reduce((t, r) => t + Number(r.n), 0) };
}

async function closeTicket(ctx: ModuleContext, i: ButtonInteraction<'cached'>, _cfg: Partial<TicketConfig>): Promise<void> {
  const ticket = ticketOf(ctx, i.channelId);
  if (!ticket || !i.channel) return void (await i.update({ content: 'This is not an open ticket.', components: [] }));
  await i.update({ content: 'Closing the ticket …', components: [] });
  // The close button deletes the ticket (as before); the ticket commands can also only lock it.
  await finishTicket(ctx, i.channel, i.user.id, '', 'delete');
}

// ---------- Modmail ----------

const dmBuckets = new Map<string, Bucket>();

interface ModmailConfig { channel: unknown; supportRoles: unknown; pingSupport: boolean; greeting: MessageConfig; closeMessage: string; anonymousStaff: boolean }

function modmailGuild(ctx: ModuleContext, client: Client): { guild: Guild; channelId: string; cfg: Partial<ModmailConfig> } | null {
  if (!ctx.enabled('modmail')) return null;
  const cfg = ctx.config<ModmailConfig>('modmail');
  for (const guild of client.guilds.cache.values()) {
    const channelId = idIn(cfg.channel, guild.id);
    if (channelId) return { guild, channelId, cfg };
  }
  return null;
}

export async function modmailMessage(ctx: ModuleContext, msg: Message): Promise<void> {
  if (msg.author.bot) return;
  // Direct message from a member: forward into the member's thread.
  if (!msg.guild) {
    const target = modmailGuild(ctx, msg.client);
    if (!target) return;
    let bucket = dmBuckets.get(msg.author.id);
    if (!bucket) dmBuckets.set(msg.author.id, (bucket = new Bucket(5, 30_000)));
    if (!bucket.take()) {
      await msg.react('⏳').catch(() => undefined);
      return;
    }
    const { guild, channelId, cfg } = target;
    const blocked = ctx.db.prepare('SELECT 1 FROM modmail_blocks WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(ctx.botId, guild.id, msg.author.id);
    if (blocked) return;
    let row = ctx.db.prepare("SELECT id, thread_id FROM modmail_threads WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND status = 'open'").get(ctx.botId, guild.id, msg.author.id) as { id: number; thread_id: string | null } | undefined;
    let thread = row?.thread_id ? await guild.channels.fetch(row.thread_id).catch(() => null) : null;
    if (!thread || !thread.isThread()) {
      const staff = guild.channels.cache.get(channelId);
      if (!staff || staff.type !== ChannelType.GuildText) return;
      const support = idsIn(cfg.supportRoles, guild.id);
      const start = await staff.send({
        content: `📬 New modmail from <@${msg.author.id}> (${msg.author.username})${cfg.pingSupport !== false && support.length ? `\n${support.map((r) => `<@&${r}>`).join(' ')}` : ''}\nReply in the thread; write \`!close\` to close it.`,
        allowedMentions: { roles: cfg.pingSupport !== false ? support : [] },
      });
      thread = await start.startThread({ name: `📬 ${msg.author.username}`.slice(0, 100) }).catch(() => null);
      if (!thread) return;
      if (row) ctx.db.prepare('UPDATE modmail_threads SET thread_id = ? WHERE id = ?').run(thread.id, row.id);
      else ctx.db.prepare('INSERT INTO modmail_threads (bot_id, guild_id, user_id, thread_id) VALUES (?, ?, ?, ?)').run(ctx.botId, guild.id, msg.author.id, thread.id);
      const greet = buildMessage(cfg.greeting, baseVars(guild, null, { user: msg.author.username }));
      if (greet) await msg.author.send(greet).catch(() => undefined);
    }
    const parts = chunks(msg.content, 4000);
    for (const [n, part] of parts.entries()) {
      const embed = new EmbedBuilder().setAuthor({ name: msg.author.username, iconURL: msg.author.displayAvatarURL() }).setDescription(part || '*(no text)*').setColor(0x60a5fa).setTimestamp(msg.createdAt);
      await thread.send({ embeds: [embed], files: n === parts.length - 1 ? [...msg.attachments.values()].slice(0, 5).map((a) => a.url) : [] }).catch(() => undefined);
    }
    await msg.react('📨').catch(() => undefined);
    return;
  }
  // Staff reply inside a modmail thread.
  if (!msg.channel.isThread() || !ctx.enabled('modmail')) return;
  const row = ctx.db.prepare("SELECT id, user_id FROM modmail_threads WHERE bot_id = ? AND thread_id = ? AND status = 'open'").get(ctx.botId, msg.channelId) as { id: number; user_id: string } | undefined;
  if (!row) return;
  const cfg = ctx.config<ModmailConfig>('modmail');
  // Only the team answers: support roles or Manage Messages.
  const staff = idsIn(cfg.supportRoles, msg.guildId!).some((r) => msg.member?.roles.cache.has(r)) || (msg.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false);
  if (!staff) return;
  const user = await msg.client.users.fetch(row.user_id).catch(() => null);
  if (msg.content.trim().toLowerCase() === '!close') {
    await modmailClose(ctx, msg.channel, msg.author.id, '');
    return;
  }
  if (msg.content.startsWith('!')) return; // staff notes
  const sent = await sendToUser(cfg, user, msg.member, msg.guild!.name, msg.content, [...msg.attachments.values()].map((a) => a.url));
  await msg.react(sent ? '✅' : '⚠️').catch(() => undefined);
}

/** A staff answer to the member, as embeds (anonymous when set). */
async function sendToUser(cfg: Partial<ModmailConfig>, user: import('discord.js').User | null, member: GuildMember | null, serverName: string, text: string, files: string[]): Promise<boolean> {
  if (!user) return false;
  let sent = null;
  const parts = chunks(text, 4000);
  for (const [n, part] of parts.entries()) {
    const embed = new EmbedBuilder().setDescription(part || '*(no text)*').setColor(0xa78bfa).setTimestamp(new Date()).setFooter({ text: serverName });
    if (!cfg.anonymousStaff && member) embed.setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() });
    sent = await user.send({ embeds: [embed], files: n === parts.length - 1 ? files.slice(0, 5) : [] }).catch(() => null);
    if (!sent) break;
  }
  return sent !== null;
}

/** The open modmail of a thread. */
function modmailOf(ctx: ModuleContext, threadId: string): { id: number; user_id: string } | undefined {
  return ctx.db.prepare("SELECT id, user_id FROM modmail_threads WHERE bot_id = ? AND thread_id = ? AND status = 'open'").get(ctx.botId, threadId) as { id: number; user_id: string } | undefined;
}

/** Closes the modmail of a thread: close message to the member, thread archived. */
export async function modmailClose(ctx: ModuleContext, thread: GuildTextBasedChannel, closerId: string, reason: string): Promise<string | null> {
  const row = modmailOf(ctx, thread.id);
  if (!row) return 'This is not an open modmail thread.';
  const cfg = ctx.config<ModmailConfig>('modmail');
  ctx.db.prepare("UPDATE modmail_threads SET status = 'closed', closed_by = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(closerId, row.id);
  const user = await thread.client.users.fetch(row.user_id).catch(() => null);
  const text = [cfg.closeMessage ? fill(cfg.closeMessage, baseVars(thread.guild, null)) : '', reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n');
  if (text) await user?.send({ content: text.slice(0, 2000) }).catch(() => undefined);
  await thread.send(`🔒 Closed by <@${closerId}>.${reason ? ` Reason: ${reason.slice(0, 500)}` : ''}`).catch(() => undefined);
  if (thread.isThread()) await thread.setArchived(true, 'Modmail closed').catch(() => undefined);
  return null;
}

/** Sends a staff answer from a modmail thread to the member. */
export async function modmailReply(ctx: ModuleContext, thread: GuildTextBasedChannel, member: GuildMember | null, text: string): Promise<string | null> {
  const row = modmailOf(ctx, thread.id);
  if (!row) return 'This is not an open modmail thread.';
  const user = await thread.client.users.fetch(row.user_id).catch(() => null);
  const ok = await sendToUser(ctx.config<ModmailConfig>('modmail'), user, member, thread.guild.name, text, []);
  if (!ok) return 'The member does not accept direct messages.';
  const embed = new EmbedBuilder().setDescription(text.slice(0, 4000)).setColor(0xa78bfa).setFooter({ text: 'Sent to the member' }).setTimestamp(new Date());
  if (member) embed.setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() });
  await thread.send({ embeds: [embed] }).catch(() => undefined);
  return null;
}

/** Blocks a member from modmail of a server (or unblocks them). */
export function modmailBlock(ctx: ModuleContext, guildId: string, userId: string, by: string | null, block: boolean): boolean {
  if (block) return ctx.db.prepare('INSERT OR IGNORE INTO modmail_blocks (bot_id, guild_id, user_id, blocked_by) VALUES (?, ?, ?, ?)').run(ctx.botId, guildId, userId, by).changes > 0;
  return ctx.db.prepare('DELETE FROM modmail_blocks WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(ctx.botId, guildId, userId).changes > 0;
}
