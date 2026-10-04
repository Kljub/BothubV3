// Placeholder values from Discord objects. Names match the builder
// (PLACEHOLDERS in builder.js) and the event variables in shared/events.json.

import type { Guild, GuildMember, Message, PartialMessage, Role, User, PartialUser, Channel } from 'discord.js';

export type Vars = Record<string, string>;

export function userVars(user: User | PartialUser | null | undefined, member?: GuildMember | null, prefix = 'user'): Vars {
  if (!user) return {};
  const name = member?.displayName ?? user.globalName ?? user.username ?? '';
  return {
    [prefix]: name,
    [`${prefix}.id`]: user.id,
    [`${prefix}.name`]: user.username ?? name,
    [`${prefix}.mention`]: `<@${user.id}>`,
    [`${prefix}.avatar`]: member?.displayAvatarURL() ?? user.displayAvatarURL?.() ?? '',
    // Voice channel the member is in now (empty when none): for sound plugins and blocks.
    [`${prefix}.voice.channel.id`]: member?.voice?.channelId ?? '',
    [`${prefix}.voice.channel`]: member?.voice?.channel ? `<#${member.voice.channel.id}>` : '',
  };
}

export function guildVars(guild: Guild | null | undefined): Vars {
  if (!guild) return {};
  return {
    server: guild.name,
    'server.id': guild.id,
    'server.members': String(guild.memberCount),
    'server.owner_id': guild.ownerId,
    'server.name': guild.name,
    // Optional chaining: module tests pass plain objects as guilds.
    'server.icon': guild.iconURL?.() ?? '',
    'server.created': guild.createdTimestamp ? `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>` : '',
    'server.channels': String(guild.channels?.cache.size ?? 0),
    'server.roles': String(guild.roles?.cache.size ?? 0),
    'server.boosts': String(guild.premiumSubscriptionCount ?? 0),
    'server.boost_tier': String(guild.premiumTier),
    members: String(guild.memberCount),
  };
}

export function channelVars(channel: Channel | null | undefined, prefix = 'channel'): Vars {
  if (!channel) return {};
  const name = 'name' in channel && typeof channel.name === 'string' ? channel.name : '';
  return { [prefix]: name ? `#${name}` : '', [`${prefix}.id`]: channel.id, [`${prefix}.name`]: name, [`${prefix}.type`]: String(channel.type) };
}

export function messageVars(message: Message | PartialMessage | null | undefined): Vars {
  if (!message) return {};
  return {
    'message.id': message.id,
    'message.content': message.content ?? '',
    'message.url': message.url,
    content: message.content ?? '',
  };
}

export function roleVars(role: Role | null | undefined): Vars {
  if (!role) return {};
  return { role: role.name, 'role.id': role.id, 'role.name': role.name, 'role.color': role.hexColor };
}

export function botVars(user: User | null | undefined, servers: number): Vars {
  return user ? { 'bot.name': user.username, 'bot.id': user.id, 'bot.servers': String(servers) } : {};
}
