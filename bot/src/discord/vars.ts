// Placeholder values from Discord objects. Names match the builder
// (PLACEHOLDERS in builder.js) and the event variables in shared/events.json.

import type { Guild, GuildMember, Message, PartialMessage, Role, User, PartialUser, Channel } from 'discord.js';

export type Vars = Record<string, string>;

export function userVars(user: User | PartialUser | null | undefined, member?: GuildMember | null, prefix = 'user', now = Date.now()): Vars {
  if (!user) return {};
  const name = member?.displayName ?? user.globalName ?? user.username ?? '';
  const stamp = (ms: number | null | undefined, style: string) => (ms ? `<t:${Math.floor(ms / 1000)}:${style}>` : '');
  const days = (ms: number | null | undefined) => (ms ? String(Math.max(0, Math.floor((now - ms) / 86_400_000))) : '');
  const created = user.createdTimestamp;
  const joined = member?.joinedTimestamp;
  return {
    // Account age and membership: a date, a relative time Discord shows in the reader's language, and whole days.
    [`${prefix}.created`]: stamp(created, 'D'),
    [`${prefix}.account_age`]: stamp(created, 'R'),
    [`${prefix}.account_days`]: days(created),
    [`${prefix}.joined`]: stamp(joined, 'D'),
    [`${prefix}.member_since`]: stamp(joined, 'R'),
    [`${prefix}.member_days`]: days(joined),
    [prefix]: name,
    [`${prefix}.id`]: user.id,
    [`${prefix}.name`]: user.username ?? name,
    [`${prefix}.mention`]: `<@${user.id}>`,
    [`${prefix}.avatar`]: member?.displayAvatarURL() ?? user.displayAvatarURL?.() ?? '',
    // Banner: known only after a forced fetch (fillBanners); empty when there is none, so an embed leaves the image out.
    [`${prefix}.banner`]: member?.bannerURL?.({ size: 1024 }) ?? user.bannerURL?.({ size: 1024 }) ?? '',
    // Voice channel the member is in now (empty when none): for sound plugins and blocks.
    [`${prefix}.voice.channel.id`]: member?.voice?.channelId ?? '',
    [`${prefix}.voice.channel`]: member?.voice?.channel ? `<#${member.voice.channel.id}>` : '',
  };
}

/** Prefixes whose banner a graph uses ({user.banner}, {target.banner} …), per graph. */
const bannerUse = new WeakMap<object, string[]>();

export function bannerPrefixes(graph: object): string[] {
  let found = bannerUse.get(graph);
  if (!found) {
    found = [...new Set([...JSON.stringify(graph).matchAll(/\{([a-z_]+)\.banner\}/g)].map((m) => m[1]!))];
    bannerUse.set(graph, found);
  }
  return found;
}

/**
 * Discord sends the banner of a user only on a forced fetch: load it for
 * the prefixes the graph uses. No banner (or no such user) leaves "".
 */
export async function fillBanners(client: { users: { fetch(id: string, o: { force: boolean }): Promise<User> } }, graph: object, vars: Vars): Promise<void> {
  await Promise.all(
    bannerPrefixes(graph).map(async (p) => {
      const id = vars[`${p}.id`];
      if (!id) {
        vars[`${p}.banner`] ??= '';
        return;
      }
      if (vars[`${p}.banner`]) return; // the member's own server banner
      const user = await client.users.fetch(id, { force: true }).catch(() => null);
      vars[`${p}.banner`] = user?.bannerURL({ size: 1024 }) ?? '';
    }),
  );
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
  if (!user) return {};
  return {
    'bot.name': user.username,
    'bot.id': user.id,
    'bot.servers': String(servers),
    'bot.mention': `<@${user.id}>`,
    'bot.avatar': user.displayAvatarURL?.({ size: 1024 }) ?? '',
    'bot.created': user.createdTimestamp ? `<t:${Math.floor(user.createdTimestamp / 1000)}:D>` : '',
  };
}
