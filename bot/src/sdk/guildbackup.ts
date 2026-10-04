// SDK guild.snapshot / guild.restore (permissions discord.server.backup and
// discord.server.restore): a full copy of a server's structure as JSON
// (roles with permissions, channels with permission overwrites and their
// settings, emojis, bans, server settings), and building a server from such
// a copy (restore, or clone into another server the bot is on). The JSON
// never travels to the plugin (messages to plugins are small): it is a
// plugin file (storage.files), the plugin only names it.
//
// A plugin never hands out Administrator: restored roles and overwrites lose
// it. Managed roles (bots, boosts) are skipped. Everything runs best effort;
// what fails is listed in the report.

import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildChannel, type GuildChannelCreateOptions } from 'discord.js';

export const BACKUP_FORMAT = 'bothub-server-backup';
const PARTS = ['settings', 'roles', 'channels', 'emojis', 'bans'] as const;
export type Part = (typeof PARTS)[number];

export interface RoleCopy { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: string; position: number; everyone: boolean; managed: boolean }
export interface OverwriteCopy { id: string; type: 'role' | 'member'; allow: string; deny: string }
export interface ChannelCopy {
  id: string; type: string; name: string; parent: string | null; position: number; topic: string | null; nsfw: boolean;
  slowmode: number; bitrate: number | null; userLimit: number | null; overwrites: OverwriteCopy[];
}
export interface ServerBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  guild: { id: string; name: string };
  parts: Part[];
  settings?: { name: string; icon: string | null; verificationLevel: number; defaultMessageNotifications: number; explicitContentFilter: number; afkTimeout: number; afkChannel: string | null; systemChannel: string | null };
  roles?: RoleCopy[];
  channels?: ChannelCopy[];
  emojis?: { name: string; url: string; animated: boolean }[];
  bans?: { userId: string; reason: string | null }[] | { error: string };
}

export const partsOf = (v: unknown): Part[] => {
  const list = Array.isArray(v) ? v.filter((p): p is Part => (PARTS as readonly string[]).includes(p as string)) : [];
  return list.length ? [...new Set(list)] : ['settings', 'roles', 'channels', 'emojis'];
};

const ADMIN = PermissionFlagsBits.Administrator;
const noAdmin = (bits: string): bigint => BigInt(bits) & ~ADMIN;

/** The structure of a server (fresh from Discord). */
export async function snapshot(guild: Guild, parts: Part[]): Promise<ServerBackup> {
  await guild.roles.fetch().catch(() => undefined);
  await guild.channels.fetch().catch(() => undefined);
  await guild.emojis.fetch().catch(() => undefined);
  const out: ServerBackup = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), guild: { id: guild.id, name: guild.name }, parts };
  if (parts.includes('settings')) {
    out.settings = {
      name: guild.name, icon: guild.iconURL({ size: 1024 }), verificationLevel: guild.verificationLevel, defaultMessageNotifications: guild.defaultMessageNotifications,
      explicitContentFilter: guild.explicitContentFilter, afkTimeout: guild.afkTimeout, afkChannel: guild.afkChannelId, systemChannel: guild.systemChannelId,
    };
  }
  if (parts.includes('roles')) {
    out.roles = [...guild.roles.cache.values()].sort((a, b) => a.position - b.position).map((r) => ({
      id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position, everyone: r.id === guild.id, managed: r.managed,
    }));
  }
  if (parts.includes('channels')) {
    out.channels = [...guild.channels.cache.values()]
      .filter((c) => !c.isThread())
      .map((c) => c as unknown as GuildChannel)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({
        id: c.id, type: ChannelType[c.type] ?? String(c.type), name: c.name, parent: c.parentId, position: c.rawPosition,
        topic: 'topic' in c ? ((c.topic as string | null) ?? null) : null, nsfw: 'nsfw' in c ? Boolean(c.nsfw) : false,
        slowmode: 'rateLimitPerUser' in c ? Number(c.rateLimitPerUser ?? 0) : 0,
        bitrate: 'bitrate' in c ? Number(c.bitrate) : null, userLimit: 'userLimit' in c ? Number(c.userLimit) : null,
        overwrites: [...c.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type === OverwriteType.Role ? 'role' : 'member', allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })),
      }));
  }
  if (parts.includes('emojis')) out.emojis = [...guild.emojis.cache.values()].map((e) => ({ name: e.name ?? 'emoji', url: e.imageURL(), animated: e.animated === true }));
  if (parts.includes('bans')) {
    try {
      const bans = await guild.bans.fetch();
      out.bans = [...bans.values()].map((b) => ({ userId: b.user.id, reason: b.reason ?? null }));
    } catch {
      out.bans = { error: 'The bot may not read bans (Ban Members).' };
    }
  }
  return out;
}

export function counts(b: ServerBackup): Record<string, number> {
  return { roles: b.roles?.length ?? 0, channels: b.channels?.length ?? 0, emojis: b.emojis?.length ?? 0, bans: Array.isArray(b.bans) ? b.bans.length : 0 };
}

/** Reads and checks a backup file. */
export function parseBackup(text: string): ServerBackup | null {
  try {
    const b = JSON.parse(text) as ServerBackup;
    return b && b.format === BACKUP_FORMAT && b.version === 1 ? b : null;
  } catch {
    return null;
  }
}

const TYPES: Record<string, ChannelType> = {
  GuildText: ChannelType.GuildText, GuildVoice: ChannelType.GuildVoice, GuildCategory: ChannelType.GuildCategory,
  GuildAnnouncement: ChannelType.GuildAnnouncement, GuildStageVoice: ChannelType.GuildStageVoice, GuildForum: ChannelType.GuildForum, GuildMedia: ChannelType.GuildMedia,
};

export interface RestoreReport {
  mode: string;
  created: { roles: number; channels: number; emojis: number; bans: number };
  deleted: { roles: number; channels: number };
  failed: string[];
}

/**
 * Builds the backup into a server. mode "add" creates everything next to
 * what is there; "replace" first deletes the server's channels and the roles
 * the bot may manage. bans are only restored when "bans" is in parts.
 */
export async function restore(guild: Guild, b: ServerBackup, mode: 'add' | 'replace', parts: Part[]): Promise<RestoreReport> {
  const report: RestoreReport = { mode, created: { roles: 0, channels: 0, emojis: 0, bans: 0 }, deleted: { roles: 0, channels: 0 }, failed: [] };
  const fail = (what: string, err: unknown) => {
    if (report.failed.length < 30) report.failed.push(`${what}: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  };
  const me = guild.members.me;
  const top = me?.roles.highest.position ?? 0;

  if (mode === 'replace') {
    if (parts.includes('channels')) {
      for (const c of [...guild.channels.cache.values()]) {
        await c.delete('Server backup: replace').then(() => report.deleted.channels++, (e) => fail(`delete #${c.name}`, e));
      }
    }
    if (parts.includes('roles')) {
      for (const r of [...guild.roles.cache.values()]) {
        if (r.id === guild.id || r.managed || r.position >= top) continue;
        await r.delete('Server backup: replace').then(() => report.deleted.roles++, (e) => fail(`delete role ${r.name}`, e));
      }
    }
  }

  // Roles: lowest first; old ID -> new ID for the overwrites.
  const roleMap = new Map<string, string>();
  if (b.guild.id) roleMap.set(b.guild.id, guild.id);
  if (parts.includes('roles') && b.roles) {
    for (const r of b.roles) {
      if (r.managed) continue;
      if (r.everyone) {
        await guild.roles.everyone.setPermissions(noAdmin(r.permissions), 'Server backup').catch((e) => fail('@everyone permissions', e));
        continue;
      }
      try {
        const role = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: noAdmin(r.permissions), reason: 'Server backup' });
        roleMap.set(r.id, role.id);
        report.created.roles++;
      } catch (e) {
        fail(`role ${r.name}`, e);
      }
    }
  }

  // Channels: categories first, then the rest with their category.
  const channelMap = new Map<string, string>();
  if (parts.includes('channels') && b.channels) {
    const ordered = [...b.channels.filter((c) => c.type === 'GuildCategory'), ...b.channels.filter((c) => c.type !== 'GuildCategory')];
    for (const c of ordered) {
      const type = TYPES[c.type];
      if (type === undefined) continue;
      const overwrites = c.overwrites
        .map((o) => ({ id: o.type === 'role' ? roleMap.get(o.id) : o.id, type: o.type === 'role' ? OverwriteType.Role : OverwriteType.Member, allow: noAdmin(o.allow), deny: BigInt(o.deny) }))
        .filter((o): o is { id: string; type: OverwriteType; allow: bigint; deny: bigint } => !!o.id && (o.type === OverwriteType.Role || guild.members.cache.has(o.id)));
      const options: GuildChannelCreateOptions = { name: c.name, type: type as never, permissionOverwrites: overwrites, reason: 'Server backup' };
      if (c.parent && channelMap.has(c.parent)) options.parent = channelMap.get(c.parent);
      if (c.topic) options.topic = c.topic.slice(0, 1024);
      if (c.nsfw) options.nsfw = true;
      if (c.slowmode) options.rateLimitPerUser = c.slowmode;
      if (c.bitrate) options.bitrate = Math.min(c.bitrate, guild.maximumBitrate);
      if (c.userLimit) options.userLimit = c.userLimit;
      try {
        const made = await guild.channels.create(options as GuildChannelCreateOptions & { type: ChannelType.GuildText });
        channelMap.set(c.id, made.id);
        report.created.channels++;
      } catch (e) {
        // Announcement, stage and forum channels need a Community server: try a text or voice channel.
        const fallback = type === ChannelType.GuildAnnouncement || type === ChannelType.GuildForum || type === ChannelType.GuildMedia ? ChannelType.GuildText : type === ChannelType.GuildStageVoice ? ChannelType.GuildVoice : null;
        if (fallback === null) {
          fail(`#${c.name}`, e);
          continue;
        }
        try {
          const made = await guild.channels.create({ ...options, type: fallback } as GuildChannelCreateOptions);
          channelMap.set(c.id, made.id);
          report.created.channels++;
        } catch (e2) {
          fail(`#${c.name}`, e2);
        }
      }
    }
  }

  if (parts.includes('emojis') && b.emojis) {
    for (const e of b.emojis) {
      await guild.emojis.create({ attachment: e.url, name: e.name, reason: 'Server backup' }).then(() => report.created.emojis++, (err) => fail(`emoji ${e.name}`, err));
    }
  }

  if (parts.includes('settings') && b.settings) {
    const s = b.settings;
    await guild
      .edit({
        name: s.name, icon: s.icon ?? undefined, verificationLevel: s.verificationLevel, defaultMessageNotifications: s.defaultMessageNotifications,
        explicitContentFilter: s.explicitContentFilter, afkTimeout: s.afkTimeout,
        afkChannel: s.afkChannel ? channelMap.get(s.afkChannel) ?? null : null, systemChannel: s.systemChannel ? channelMap.get(s.systemChannel) ?? null : null,
        reason: 'Server backup',
      })
      .catch((e) => fail('server settings', e));
  }

  if (parts.includes('bans') && Array.isArray(b.bans)) {
    for (const ban of b.bans) {
      await guild.bans.create(ban.userId, { reason: ban.reason ?? 'Server backup' }).then(() => report.created.bans++, (e) => fail(`ban ${ban.userId}`, e));
    }
  }
  return report;
}
