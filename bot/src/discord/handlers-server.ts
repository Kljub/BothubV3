// Blocks for the bot itself, channels, webhooks, members and servers:
// typing, avatar, clone / find / channel info, the voice member check,
// webhooks, find user, server info and edits, audit log, bans,
// integrations, server preview and prune.

import { AuditLogEvent, ChannelType, GuildVerificationLevel, MessageFlags, WebhookClient, type Channel, type Guild, type GuildBasedChannel, type Webhook } from 'discord.js';
import { GraphError, type Handler, type Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { snowflake, snowflakes } from '../graph/util.js';
import { attachCards, cardPlaceholders, data } from './handlers.js';
import type { Repo } from '../core/repo.js';
import { buildMessage, hasBody } from './message.js';

const TYPE_NAMES: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.PublicThread]: 'thread',
  [ChannelType.PrivateThread]: 'thread',
  [ChannelType.AnnouncementThread]: 'thread',
};

export function channelTypeName(type: ChannelType): string {
  return TYPE_NAMES[type] ?? 'other';
}

const VERIFICATION: Record<string, GuildVerificationLevel> = {
  none: GuildVerificationLevel.None,
  low: GuildVerificationLevel.Low,
  medium: GuildVerificationLevel.Medium,
  high: GuildVerificationLevel.High,
  very_high: GuildVerificationLevel.VeryHigh,
};

/** Audit log actions of the Get Audit Log Info block. */
const AUDIT: Record<string, AuditLogEvent> = {
  member_kick: AuditLogEvent.MemberKick,
  member_ban: AuditLogEvent.MemberBanAdd,
  member_unban: AuditLogEvent.MemberBanRemove,
  member_update: AuditLogEvent.MemberUpdate,
  member_roles: AuditLogEvent.MemberRoleUpdate,
  member_move: AuditLogEvent.MemberMove,
  member_disconnect: AuditLogEvent.MemberDisconnect,
  member_prune: AuditLogEvent.MemberPrune,
  channel_create: AuditLogEvent.ChannelCreate,
  channel_update: AuditLogEvent.ChannelUpdate,
  channel_delete: AuditLogEvent.ChannelDelete,
  role_create: AuditLogEvent.RoleCreate,
  role_update: AuditLogEvent.RoleUpdate,
  role_delete: AuditLogEvent.RoleDelete,
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  message_pin: AuditLogEvent.MessagePin,
  invite_create: AuditLogEvent.InviteCreate,
  webhook_create: AuditLogEvent.WebhookCreate,
  webhook_delete: AuditLogEvent.WebhookDelete,
  emoji_create: AuditLogEvent.EmojiCreate,
  server_update: AuditLogEvent.GuildUpdate,
};

/** "member_role_update" style name of an audit log action. */
function auditName(action: AuditLogEvent): string {
  const known = Object.entries(AUDIT).find(([, v]) => v === action);
  return known ? known[0] : String(AuditLogEvent[action] ?? action);
}

const ts = (ms: number | null | undefined, style = 'f') => (ms ? `<t:${Math.floor(ms / 1000)}:${style}>` : '');

/** "https://discord.com/api/webhooks/<id>/<token>" */
const WEBHOOK_URL = /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d{17,20})\/([\w-]{20,100})/;

/** Is a user in the voice channel? A state value: anyone, "humans", "bots" or member IDs. */
export function voiceMatch(members: { id: string; bot: boolean }[], value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'any' || v === 'anyone') return members.length > 0;
  if (v === 'humans' || v === 'people') return members.some((m) => !m.bot);
  if (v === 'bots') return members.some((m) => m.bot);
  const count = /^(>=|<=|>|<|=)?\s*(\d{1,3})$/.exec(v);
  if (count) {
    const n = members.filter((m) => !m.bot).length;
    const want = Number(count[2]);
    return { '>=': n >= want, '<=': n <= want, '>': n > want, '<': n < want, '=': n === want, '': n === want }[count[1] ?? '']!;
  }
  return v
    .split(',')
    .map((x) => x.replace(/[<@!>\s]/g, ''))
    .filter(Boolean)
    .some((id) => members.some((m) => m.id === id));
}

export function serverHandlers(repo: Repo): [string, Handler][] {
  const call = async <T>(run: Run, fn: () => Promise<T>): Promise<T> => {
    run.countDiscordCall();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GraphError) throw err;
      const e = err as { code?: number; message?: string };
      if (e.code === 50013) throw new GraphError('error.run.missing_permissions', { message: e.message, code: 50013 });
      throw new GraphError('error.run.discord', { message: e.message ?? String(err), code: e.code });
    }
  };
  const reason = (run: Run, node: GraphNode) => run.str(node, 'reason').slice(0, 512) || undefined;
  const guildOf = async (run: Run, node: GraphNode): Promise<Guild> => {
    const d = data(run);
    const id = run.str(node, 'guild').trim();
    if (id) {
      run.countDiscordCall();
      const g = await d.client.guilds.fetch(snowflake(id, 'guild')).catch(() => null);
      if (!g) throw new GraphError('error.run.server_not_found', { value: id });
      return g;
    }
    if (!d.guild) throw new GraphError('error.run.needs_server');
    return d.guild;
  };
  const channelOf = async (run: Run, node: GraphNode, key = 'channel'): Promise<Channel> => {
    const value = run.str(node, key).trim() || (data(run).channel?.id ?? '');
    run.countDiscordCall();
    const ch = await data(run).client.channels.fetch(snowflake(value, key)).catch(() => null);
    if (!ch) throw new GraphError('error.run.channel_not_found', { value });
    return ch;
  };
  const guildChannelOf = async (run: Run, node: GraphNode, key = 'channel'): Promise<GuildBasedChannel> => {
    const ch = await channelOf(run, node, key);
    if (ch.isDMBased()) throw new GraphError('error.run.channel_not_found', { value: ch.id });
    return ch;
  };
  const webhookOf = async (run: Run, node: GraphNode): Promise<Webhook> => {
    const value = run.str(node, 'webhook').trim();
    if (!value) throw new GraphError('error.run.missing_value', { field: 'webhook' });
    const url = WEBHOOK_URL.exec(value);
    const hook = await call(run, () => (url ? data(run).client.fetchWebhook(url[1]!, url[2]!) : data(run).client.fetchWebhook(snowflake(value, 'webhook')))).catch(() => null);
    if (!hook) throw new GraphError('error.run.webhook_not_found', { value: url ? url[1]! : value });
    return hook;
  };
  const webhookResults = (run: Run, node: GraphNode, hook: Webhook) => {
    run.setResult(node, '', hook.url ?? hook.id);
    run.setResult(node, '.id', hook.id);
    run.setResult(node, '.name', hook.name);
    run.setResult(node, '.url', hook.token ? hook.url : '');
    run.setResult(node, '.avatar', hook.avatarURL({ size: 512 }) ?? '');
    run.setResult(node, '.channel', hook.channelId ? `<#${hook.channelId}>` : '');
    run.setResult(node, '.channel_id', hook.channelId ?? '');
    run.setResult(node, '.creator', hook.owner && 'id' in hook.owner ? `<@${hook.owner.id}>` : '');
    run.setResult(node, '.created', ts(hook.createdTimestamp, 'D'));
  };
  const channelResults = (run: Run, node: GraphNode, ch: GuildBasedChannel) => {
    run.setResult(node, '', `<#${ch.id}>`);
    run.setResult(node, '.id', ch.id);
    run.setResult(node, '.name', ch.name);
  };

  return [
    // ---------- bot ----------
    [
      'action.bot_typing',
      async (node, run) => {
        const ch = await channelOf(run, node);
        if (!ch.isSendable()) throw new GraphError('error.run.channel_not_found', { value: ch.id });
        await call(run, () => ch.sendTyping());
      },
    ],
    [
      'action.change_bot_avatar',
      async (node, run) => {
        const avatar = run.str(node, 'avatar').trim();
        const banner = run.str(node, 'banner').trim();
        if (!avatar && !banner) throw new GraphError('error.run.missing_value', { field: 'avatar' });
        const edit: { avatar?: string; banner?: string } = {};
        if (avatar) edit.avatar = avatar;
        if (banner) edit.banner = banner;
        if (run.raw(node, 'where') === 'everywhere') {
          const me = data(run).client.user;
          if (!me) throw new GraphError('error.run.needs_server');
          await call(run, () => me.edit(edit));
        } else {
          const guild = await guildOf(run, node);
          await call(run, () => guild.members.editMe({ ...edit, reason: reason(run, node) }));
        }
      },
    ],

    // ---------- channels ----------
    [
      'action.clone_channel',
      async (node, run) => {
        const ch = await guildChannelOf(run, node);
        if (ch.isThread() || !('clone' in ch)) throw new GraphError('error.run.channel_not_found', { value: ch.id });
        const name = run.str(node, 'name').trim().slice(0, 100);
        const copy = (await call(run, () => (ch as { clone(o: object): Promise<GuildBasedChannel> }).clone({ ...(name ? { name } : {}), reason: reason(run, node) }))) as GuildBasedChannel;
        channelResults(run, node, copy);
      },
    ],
    [
      'action.find_channel',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const wanted = run.str(node, 'name').trim().replace(/^#/, '').toLowerCase();
        if (!wanted) throw new GraphError('error.run.missing_value', { field: 'name' });
        const kind = String(run.raw(node, 'channel_type') ?? 'any');
        const exact = run.raw(node, 'match') !== 'contains';
        const all = await call(run, () => guild.channels.fetch());
        const found = [...all.values()]
          .filter((c): c is NonNullable<typeof c> => !!c)
          .filter((c) => kind === 'any' || channelTypeName(c.type) === kind)
          .filter((c) => (exact ? c.name.toLowerCase() === wanted : c.name.toLowerCase().includes(wanted)))
          .sort((a, b) => a.rawPosition - b.rawPosition);
        const first = found[0];
        if (!first) throw new GraphError('error.run.not_found', { value: wanted });
        channelResults(run, node, first);
        run.setResult(node, '.type', channelTypeName(first.type));
        run.setResult(node, '.count', found.length);
        run.setResult(node, '.ids', found.map((c) => c.id).join(','));
      },
    ],
    [
      'action.channel_info',
      async (node, run) => {
        const ch = await guildChannelOf(run, node);
        channelResults(run, node, ch);
        run.setResult(node, '.mention', `<#${ch.id}>`);
        run.setResult(node, '.type', channelTypeName(ch.type));
        run.setResult(node, '.url', ch.url);
        run.setResult(node, '.created', ts(ch.createdTimestamp, 'D'));
        run.setResult(node, '.category', ch.parent?.name ?? '');
        run.setResult(node, '.category_id', ch.parentId ?? '');
        run.setResult(node, '.position', 'position' in ch ? ch.position : '');
        run.setResult(node, '.topic', 'topic' in ch ? (ch.topic ?? '') : '');
        run.setResult(node, '.nsfw', 'nsfw' in ch && ch.nsfw ? 'true' : 'false');
        run.setResult(node, '.slowmode', 'rateLimitPerUser' in ch ? (ch.rateLimitPerUser ?? 0) : 0);
        const voice = ch.isVoiceBased() ? ch : null;
        run.setResult(node, '.bitrate', voice ? Math.round(voice.bitrate / 1000) : '');
        run.setResult(node, '.user_limit', voice ? voice.userLimit : '');
        const members = voice ? [...voice.members.values()] : [];
        run.setResult(node, '.members', members.length);
        run.setResult(node, '.member_list', members.map((m) => `<@${m.id}>`).join(' '));
        run.setResult(node, '.channels', ch.type === ChannelType.GuildCategory ? ch.children.cache.size : '');
      },
    ],

    // ---------- webhooks ----------
    [
      'action.create_webhook',
      async (node, run) => {
        const ch = await guildChannelOf(run, node);
        if (!('createWebhook' in ch)) throw new GraphError('error.run.channel_not_found', { value: ch.id });
        const name = run.str(node, 'name').trim().slice(0, 80) || 'BotHub';
        const avatar = run.str(node, 'avatar').trim();
        const hook = await call(run, () => ch.createWebhook({ name, ...(avatar ? { avatar } : {}), reason: reason(run, node) }));
        webhookResults(run, node, hook);
      },
    ],
    [
      'action.edit_webhook',
      async (node, run) => {
        const hook = await webhookOf(run, node);
        const edit: { name?: string; avatar?: string | null; channel?: string; reason?: string } = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 80);
        const avatar = run.str(node, 'avatar').trim();
        if (avatar) edit.avatar = avatar;
        const channel = run.str(node, 'channel').trim();
        if (channel) edit.channel = snowflake(channel, 'channel');
        const done = await call(run, () => hook.edit(edit));
        webhookResults(run, node, done);
      },
    ],
    [
      'action.delete_webhook',
      async (node, run) => {
        const hook = await webhookOf(run, node);
        await call(run, () => hook.delete(reason(run, node)));
      },
    ],
    [
      'action.find_webhook',
      async (node, run) => {
        const wanted = run.str(node, 'name').trim().toLowerCase();
        const channel = run.str(node, 'channel').trim();
        let hooks: Webhook[];
        if (channel) {
          const ch = await guildChannelOf(run, node);
          if (!('fetchWebhooks' in ch)) throw new GraphError('error.run.channel_not_found', { value: ch.id });
          hooks = [...(await call(run, () => ch.fetchWebhooks())).values()];
        } else {
          const guild = await guildOf(run, node);
          hooks = [...(await call(run, () => guild.fetchWebhooks())).values()];
        }
        const found = hooks.filter((h) => !wanted || h.name.toLowerCase() === wanted || (run.raw(node, 'match') === 'contains' && h.name.toLowerCase().includes(wanted)));
        const first = found[0];
        if (!first) throw new GraphError('error.run.webhook_not_found', { value: wanted || channel });
        webhookResults(run, node, first);
        run.setResult(node, '.count', found.length);
        run.setResult(node, '.list', found.map((h) => `${h.name} (${h.id})${h.channelId ? ` <#${h.channelId}>` : ''}`).join('\n').slice(0, 4000));
      },
    ],
    [
      'action.webhook_info',
      async (node, run) => webhookResults(run, node, await webhookOf(run, node)),
    ],
    [
      'action.send_webhook_message',
      async (node, run) => {
        const d = data(run);
        const value = run.str(node, 'webhook').trim();
        await cardPlaceholders(repo, run, node.config.message);
        const payload = buildMessage(run, node, d.customId) as Record<string, unknown> & { flags?: number };
        // Webhooks of other apps may not carry buttons or menus of this bot.
        delete payload.components;
        if (payload.flags !== undefined && (payload.flags & MessageFlags.IsComponentsV2) === 0) delete payload.flags;
        attachCards(payload, d.files);
        if (!hasBody(payload) && !(payload.files as unknown[] | undefined)?.length) throw new GraphError('error.run.empty_message');
        const username = run.str(node, 'username').trim().slice(0, 80);
        const avatarURL = run.str(node, 'avatar').trim();
        const thread = run.str(node, 'thread').trim();
        const options = { ...payload, ...(username ? { username } : {}), ...(avatarURL ? { avatarURL } : {}), ...(thread ? { threadId: snowflake(thread, 'thread') } : {}) };
        const url = WEBHOOK_URL.exec(value);
        let sent: { id: string; channel_id?: string; channelId?: string };
        if (url) {
          const client = new WebhookClient({ id: url[1]!, token: url[2]! });
          try {
            sent = (await call(run, () => client.send(options as never))) as typeof sent;
          } finally {
            client.destroy();
          }
        } else {
          const hook = await webhookOf(run, node);
          if (!hook.token) throw new GraphError('error.run.webhook_not_found', { value: hook.id });
          sent = (await call(run, () => hook.send(options as never))) as typeof sent;
        }
        const channel = sent.channelId ?? sent.channel_id ?? '';
        run.setResult(node, '', sent.id);
        run.setResult(node, '.id', sent.id);
        run.setResult(node, '.url', channel ? `https://discord.com/channels/${d.guild?.id ?? '@me'}/${channel}/${sent.id}` : '');
      },
    ],

    // ---------- members ----------
    [
      'action.find_user',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const query = run.str(node, 'query').trim().replace(/^@/, '');
        if (!query) throw new GraphError('error.run.missing_value', { field: 'query' });
        const id = /^<@!?(\d{17,20})>$|^(\d{17,20})$/.exec(query);
        let found = id ? [await call(run, () => guild.members.fetch(id[1] ?? id[2]!)).catch(() => null)].filter((m) => !!m) : [];
        if (!id) {
          const list = [...(await call(run, () => guild.members.search({ query: query.slice(0, 100), limit: 25 }))).values()];
          const lower = query.toLowerCase();
          const exact = list.filter((m) => [m.user.username, m.displayName, m.user.globalName ?? ''].some((n) => n.toLowerCase() === lower));
          found = exact.length ? exact : list;
        }
        const m = found[0];
        if (!m) throw new GraphError('error.run.member_not_found', { value: query });
        run.setResult(node, '', `<@${m.id}>`);
        run.setResult(node, '.id', m.id);
        run.setResult(node, '.name', m.user.username);
        run.setResult(node, '.display_name', m.displayName);
        run.setResult(node, '.mention', `<@${m.id}>`);
        run.setResult(node, '.count', found.length);
      },
    ],

    // ---------- servers ----------
    [
      'action.server_info',
      async (node, run) => {
        const guild = await guildOf(run, node);
        run.setResult(node, '', guild.name);
        run.setResult(node, '.id', guild.id);
        run.setResult(node, '.name', guild.name);
        run.setResult(node, '.description', guild.description ?? '');
        run.setResult(node, '.owner', `<@${guild.ownerId}>`);
        run.setResult(node, '.owner_id', guild.ownerId);
        run.setResult(node, '.members', guild.memberCount);
        run.setResult(node, '.created', ts(guild.createdTimestamp, 'D'));
        run.setResult(node, '.icon', guild.iconURL({ size: 1024 }) ?? '');
        run.setResult(node, '.banner', guild.bannerURL({ size: 1024 }) ?? '');
        run.setResult(node, '.boosts', guild.premiumSubscriptionCount ?? 0);
        run.setResult(node, '.boost_tier', guild.premiumTier);
        run.setResult(node, '.channels', guild.channels.cache.size);
        run.setResult(node, '.roles', guild.roles.cache.size);
        run.setResult(node, '.emojis', guild.emojis.cache.size);
        run.setResult(node, '.stickers', guild.stickers.cache.size);
        run.setResult(node, '.verification', Object.entries(VERIFICATION).find(([, v]) => v === guild.verificationLevel)?.[0] ?? '');
        run.setResult(node, '.vanity', guild.vanityURLCode ?? '');
        run.setResult(node, '.language', guild.preferredLocale);
        run.setResult(node, '.afk_channel', guild.afkChannelId ? `<#${guild.afkChannelId}>` : '');
        run.setResult(node, '.system_channel', guild.systemChannelId ? `<#${guild.systemChannelId}>` : '');
        run.setResult(node, '.rules_channel', guild.rulesChannelId ? `<#${guild.rulesChannelId}>` : '');
      },
    ],
    [
      'action.edit_server',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const edit: Record<string, unknown> = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 100);
        const description = run.str(node, 'description').trim();
        if (description) edit.description = description.slice(0, 120);
        for (const key of ['icon', 'banner', 'splash'] as const) {
          const url = run.str(node, key).trim();
          if (url) edit[key] = url;
        }
        const level = String(run.raw(node, 'verification') ?? 'keep');
        if (VERIFICATION[level] !== undefined) edit.verificationLevel = VERIFICATION[level];
        for (const [key, field] of [['afk_channel', 'afkChannel'], ['system_channel', 'systemChannel'], ['rules_channel', 'rulesChannel']] as const) {
          const v = run.str(node, key).trim();
          if (v) edit[field] = snowflake(v, key);
        }
        const afk = String(run.raw(node, 'afk_timeout') ?? 'keep');
        if (afk !== 'keep') edit.afkTimeout = Number(afk);
        await call(run, () => guild.edit(edit));
      },
    ],
    [
      'action.find_server',
      async (node, run) => {
        const wanted = run.str(node, 'name').trim().toLowerCase();
        if (!wanted) throw new GraphError('error.run.missing_value', { field: 'name' });
        const all = [...data(run).client.guilds.cache.values()];
        const exact = all.filter((g) => g.id === wanted || g.name.toLowerCase() === wanted);
        const found = exact.length ? exact : all.filter((g) => g.name.toLowerCase().includes(wanted));
        const g = found[0];
        if (!g) throw new GraphError('error.run.server_not_found', { value: wanted });
        run.setResult(node, '', g.name);
        run.setResult(node, '.id', g.id);
        run.setResult(node, '.name', g.name);
        run.setResult(node, '.members', g.memberCount);
        run.setResult(node, '.count', found.length);
      },
    ],
    [
      'action.audit_log',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const action = AUDIT[String(run.raw(node, 'audit_action') ?? 'any')];
        const who = run.str(node, 'user').trim();
        const limit = Math.max(1, Math.min(25, Math.trunc(Number(run.str(node, 'limit')) || 5)));
        const logs = await call(run, () => guild.fetchAuditLogs({ limit, ...(action !== undefined ? { type: action } : {}), ...(who ? { user: snowflake(who, 'user') } : {}) }));
        const list = [...logs.entries.values()];
        const target = (e: (typeof list)[number]) => e.targetId ?? '';
        run.setResult(node, '', list.map((e, i) => `${i + 1}. ${auditName(e.action)} · ${e.executorId ? `<@${e.executorId}>` : '?'}${target(e) ? ` → ${target(e)}` : ''}${e.reason ? ` · ${e.reason}` : ''} · ${ts(e.createdTimestamp, 'R')}`).join('\n').slice(0, 4000) || '—');
        run.setResult(node, '.count', list.length);
        const first = list[0];
        run.setResult(node, '.action', first ? auditName(first.action) : '');
        run.setResult(node, '.user', first?.executorId ? `<@${first.executorId}>` : '');
        run.setResult(node, '.user_id', first?.executorId ?? '');
        run.setResult(node, '.target_id', first ? target(first) : '');
        run.setResult(node, '.reason', first?.reason ?? '');
        run.setResult(node, '.created', first ? ts(first.createdTimestamp) : '');
      },
    ],
    [
      'action.ban_info',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const id = snowflake(run.str(node, 'user'), 'user');
        const ban = await call(run, () => guild.bans.fetch({ user: id, force: true })).catch((err: unknown) => {
          if (err instanceof GraphError && Number(err.params.code) === 10026) return null;
          throw err;
        });
        run.setResult(node, '', ban ? 'true' : 'false');
        run.setResult(node, '.banned', ban ? 'true' : 'false');
        run.setResult(node, '.reason', ban?.reason ?? '');
        run.setResult(node, '.user', ban ? ban.user.username : '');
      },
    ],
    [
      'action.server_integrations',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const list = [...(await call(run, () => guild.fetchIntegrations())).values()];
        run.setResult(node, '', list.map((x, i) => `${i + 1}. ${x.name} (${x.type})${x.enabled === false ? ' – off' : ''}`).join('\n') || '—');
        run.setResult(node, '.count', list.length);
        run.setResult(node, '.names', list.map((x) => x.name).join(', '));
        run.setResult(node, '.ids', list.map((x) => x.application?.id ?? x.id).join(','));
      },
    ],
    [
      'action.server_preview',
      async (node, run) => {
        const id = run.str(node, 'guild').trim() || data(run).guild?.id || '';
        if (!id) throw new GraphError('error.run.missing_value', { field: 'guild' });
        const p = await call(run, () => data(run).client.fetchGuildPreview(snowflake(id, 'guild'))).catch(() => null);
        if (!p) throw new GraphError('error.run.server_not_found', { value: id });
        run.setResult(node, '', p.name);
        run.setResult(node, '.id', p.id);
        run.setResult(node, '.name', p.name);
        run.setResult(node, '.description', p.description ?? '');
        run.setResult(node, '.members', p.approximateMemberCount);
        run.setResult(node, '.online', p.approximatePresenceCount);
        run.setResult(node, '.emojis', p.emojis.size);
        run.setResult(node, '.stickers', p.stickers.size);
        run.setResult(node, '.icon', p.iconURL({ size: 1024 }) ?? '');
        run.setResult(node, '.features', p.features.join(', '));
      },
    ],
    [
      'action.prune_members',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const days = Math.max(1, Math.min(30, Math.trunc(Number(run.str(node, 'days')) || 7)));
        const roles = run.str(node, 'roles').trim();
        const dry = run.bool(node, 'dry_run');
        const n = await call(run, () => guild.members.prune({ days, dry, count: true, ...(roles ? { roles: snowflakes(roles, 'roles') } : {}), reason: reason(run, node) }));
        run.setResult(node, '', n ?? 0);
      },
    ],
  ];
}
