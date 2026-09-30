// Temp Voice Channels and Global Chat.

import { ChannelType, OverwriteType, type OverwriteResolvable, PermissionFlagsBits, type Message, type VoiceState, type Webhook, type TextChannel } from 'discord.js';
import { log } from '../core/log.js';
import { fill, idIn, idsIn, keywordFree, passes, reactionOf, type ModuleContext } from './context.js';
import { allow, warn } from './guard.js';

const MAX_TEMP_CHANNELS = 50;

// ---------- Temp Voice ----------

interface TempConfig { hub: unknown; category: unknown; name: string; userLimit: number; ownerManage: boolean; lock: string; deleteAfter: number; roleMode: string; roles: unknown }

export async function tempVoice(ctx: ModuleContext, before: VoiceState, after: VoiceState): Promise<void> {
  if (!ctx.enabled('temp-voice')) return;
  const guild = after.guild;
  const cfg = ctx.config<TempConfig>('temp-voice');
  const hub = idIn(cfg.hub, guild.id);

  // Left a temp channel: delete it when it stays empty.
  if (before.channelId && before.channelId !== after.channelId) {
    const owned = ctx.getState<string>('temp-voice', guild.id, `ch:${before.channelId}`);
    if (owned && before.channel && before.channel.members.size === 0) {
      const id = before.channelId;
      setTimeout(async () => {
        const ch = guild.channels.cache.get(id);
        if (ch && ch.isVoiceBased() && ch.members.size === 0) {
          await ch.delete('Temp voice channel empty').catch(() => undefined);
          ctx.deleteState('temp-voice', guild.id, `ch:${id}`);
        }
      }, Math.max(0, cfg.deleteAfter ?? 5) * 1000).unref();
    }
  }

  // Joined the hub: create a channel and move the member.
  const member = after.member;
  if (!hub || after.channelId !== hub || !member || member.user.bot) return;
  if (after.channel?.type !== ChannelType.GuildVoice) {
    warn(ctx, 'WAR-2008', { module: 'temp-voice', problem: 'the hub must be a voice channel' });
    return;
  }
  if (!passes(cfg.roleMode, idsIn(cfg.roles, guild.id), [...member.roles.cache.keys()])) return;
  // One temp channel per member: move them back into their existing one.
  const own = (ctx.db
    .prepare("SELECT key FROM module_state WHERE bot_id = ? AND module = 'temp-voice' AND guild_id = ? AND value = ?")
    .all(ctx.botId, guild.id, JSON.stringify(member.id)) as { key: string }[])
    .map((r) => guild.channels.cache.get(r.key.slice(3)))
    .find((c) => c?.isVoiceBased());
  if (own?.isVoiceBased()) {
    await member.voice.setChannel(own).catch(() => undefined);
    return;
  }
  const open = (ctx.db.prepare("SELECT COUNT(*) AS n FROM module_state WHERE bot_id = ? AND module = 'temp-voice' AND guild_id = ?").get(ctx.botId, guild.id) as { n: number }).n;
  if (Number(open) >= MAX_TEMP_CHANNELS) {
    warn(ctx, 'WAR-2008', { module: 'temp-voice', problem: `the limit of ${MAX_TEMP_CHANNELS} temp channels is reached` });
    return;
  }
  const categoryId = idIn(cfg.category, guild.id);
  const category = categoryId ? guild.channels.cache.get(categoryId) : null;
  if (categoryId && category?.type !== ChannelType.GuildCategory) warn(ctx, 'WAR-2008', { module: 'temp-voice', problem: 'the chosen category is not a category' });
  const parent = category?.type === ChannelType.GuildCategory ? category.id : (after.channel?.parentId ?? undefined);
  // The creator can always join their channel; managing it is optional.
  const overwrites: OverwriteResolvable[] = [
    { id: member.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, ...(cfg.ownerManage !== false ? [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] : [])] },
  ];
  if (cfg.lock === 'locked') overwrites.push({ id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.Connect] });
  if (cfg.lock === 'unlocked') overwrites.push({ id: guild.roles.everyone.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.Connect] });
  const channel = await guild.channels
    .create({
      name: fill(cfg.name || "🔊 {user}'s channel", { user: member.displayName, 'user.name': member.user.username }).slice(0, 100),
      type: ChannelType.GuildVoice,
      parent,
      userLimit: Math.min(99, Math.max(0, cfg.userLimit ?? 0)),
      permissionOverwrites: cfg.lock === 'server' ? [...(category?.type === ChannelType.GuildCategory ? category.permissionOverwrites.cache.values() : []), ...overwrites] : overwrites,
      reason: 'Temp voice channel',
    })
    .catch((err) => (log.debug('temp voice create failed', { err: String(err) }), null));
  if (!channel) return;
  ctx.setState('temp-voice', guild.id, `ch:${channel.id}`, member.id);
  await member.voice.setChannel(channel).catch(() => undefined);
}

// ---------- Global Chat ----------

interface GlobalConfig { channels: unknown; cooldown: number; attachments: boolean; showServer: boolean; reaction: string[]; blockedWords: string[]; blacklist: unknown }

const lastGlobal = new Map<string, number>();
const hooks = new Map<string, Webhook>();

async function hookFor(channel: TextChannel): Promise<Webhook | null> {
  const cached = hooks.get(channel.id);
  if (cached) return cached;
  const list = await channel.fetchWebhooks().catch(() => null);
  const hook = list?.find((h) => h.owner?.id === channel.client.user.id && h.name === 'BotHub Global Chat') ?? (await channel.createWebhook({ name: 'BotHub Global Chat' }).catch(() => null));
  if (hook) hooks.set(channel.id, hook);
  return hook;
}

export async function globalChat(ctx: ModuleContext, msg: Message): Promise<void> {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId || !ctx.enabled('global-chat')) return;
  const cfg = ctx.config<GlobalConfig>('global-chat');
  const refs = Array.isArray(cfg.channels) ? (cfg.channels as { id: string; guild: string }[]) : [];
  if (!refs.some((r) => r.id === msg.channelId && r.guild === msg.guildId)) return;
  if (msg.member && idsIn(cfg.blacklist, msg.guildId).some((r) => msg.member!.roles.cache.has(r))) return;
  const files = cfg.attachments !== false ? [...msg.attachments.values()].slice(0, 5).map((a) => a.url) : [];
  if (!msg.content.trim() && !files.length) return; // nothing to forward: no cooldown used
  if (!keywordFree(msg.content, cfg.blockedWords ?? [])) {
    await msg.react('🚫').catch(() => undefined);
    return;
  }
  const key = `${ctx.botId}:${msg.author.id}`;
  if (Date.now() - (lastGlobal.get(key) ?? 0) < (cfg.cooldown ?? 3) * 1000) {
    await msg.react('⏳').catch(() => undefined);
    return;
  }
  lastGlobal.set(key, Date.now());
  const name = `${msg.member?.displayName ?? msg.author.username}${cfg.showServer !== false ? ` · ${msg.guild.name}` : ''}`.slice(0, 80);
  // Edits and deletions are not mirrored; only new messages are copied.
  for (const r of refs) {
    if (r.id === msg.channelId) continue;
    const channel = msg.client.channels.cache.get(r.id);
    if (!channel || channel.type !== ChannelType.GuildText || !allow(ctx, 'global-chat', channel.id)) continue;
    const hook = await hookFor(channel);
    if (!hook) continue;
    await hook.send({ content: msg.content.slice(0, 2000) || undefined, files, username: name, avatarURL: msg.author.displayAvatarURL(), allowedMentions: { parse: [] } }).catch(() => hooks.delete(channel.id));
  }
  const reaction = (cfg.reaction ?? [])[0];
  if (reaction) await msg.react(reactionOf(reaction)).catch(() => undefined);
}
