// Blocks of the palette that had no handler yet (they failed with
// error.run.unsupported_block): roles, threads and forum tags, scheduled
// events, invites, emojis, voice, pages, component edits, transcripts, bot
// status and control, IFTTT, jobs.

import { randomBytes } from 'node:crypto';
import { ActivityType, ChannelType, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventRecurrenceRuleFrequency, GuildScheduledEventStatus, type Guild, type GuildScheduledEvent, type Message, type ThreadChannel } from 'discord.js';
import type { Repo } from '../core/repo.js';
import { GraphError, type Handler, type Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';
import { parseDuration, snowflake, snowflakes } from '../graph/util.js';
import { transcript } from '../modules/support.js';
import { data } from './handlers.js';

/** "#ff0000", "ff0000", "red"-free: hex only; empty = no colour. */
export function hexColor(text: string): number | undefined {
  const t = text.trim().replace(/^#/, '');
  if (!t) return undefined;
  if (!/^[0-9a-f]{6}$/i.test(t)) throw new GraphError('error.run.bad_color', { value: text, message: `"${text}" is not a colour; use a hex code like #5865f2.` });
  return parseInt(t, 16);
}

/** UTC offset (ms) of a time zone at a moment. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(ms / 1000) * 1000;
}

/**
 * A date and time: "2026-12-24 18:00", "24.12.2026 18:00", ISO, Unix
 * seconds, <t:…> or a duration from now ("2h", "in 30m"). Without a time
 * zone in the text the given one counts (UTC when empty or unknown).
 */
export function parseDateTime(text: string, timeZone = '', now = Date.now()): number {
  const t = text.trim();
  const fail = () => new GraphError('error.run.bad_date', { value: text });
  if (!t) throw fail();
  const stamp = /^<t:(\d{1,12})(?::[a-zA-Z])?>$/.exec(t) ?? /^(\d{9,12})$/.exec(t);
  if (stamp) return Number(stamp[1]) * 1000;
  const rel = /^(?:in\s+)?((?:\d+[smhdw])+)$/i.exec(t);
  if (rel) return now + parseDuration(rel[1]!);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  let y: number, mo: number, d: number, h = 0, mi = 0;
  if (m) [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?$/.exec(t))) [d, mo, y, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
  else {
    const iso = Date.parse(t);
    if (Number.isFinite(iso) && /\d{4}-\d{2}-\d{2}T/.test(t)) return iso;
    throw fail();
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const probe = new Date(guess);
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) throw fail();
  let zone = 'UTC';
  try {
    if (timeZone) new Intl.DateTimeFormat('en-US', { timeZone });
    zone = timeZone || 'UTC';
  } catch {
    zone = 'UTC';
  }
  return guess - zoneOffset(guess - zoneOffset(guess, zone), zone);
}

/** Pages of a Go to Page block: separated by a line with --- . */
export function splitPages(text: string): string[] {
  return text.split(/\r?\n-{3,}\r?\n/).map((p) => p.trim()).filter(Boolean);
}

/** The page to show: 0-based, kept in range. */
export function nextPage(action: string, current: number, count: number, page: number): number {
  const last = Math.max(0, count - 1);
  const to = action === 'previous' ? current - 1 : action === 'first' ? 0 : action === 'last' ? last : action === 'page' ? page - 1 : current + 1;
  return Math.max(0, Math.min(last, to));
}

/** Discord component JSON: the one with this custom_id (or ending in :<block id>), label or URL; all when the ID is empty. */
export function editComponents(rows: Record<string, any>[], id: string, change: { label?: string; disabled: boolean }): number {
  let hits = 0;
  const visit = (c: Record<string, any>) => {
    if (Array.isArray(c.components)) c.components.forEach(visit);
    if (c.type !== 2 && c.type !== 3 && c.type !== 5 && c.type !== 6 && c.type !== 7 && c.type !== 8) return;
    const cid = String(c.custom_id ?? '');
    if (id && cid !== id && !cid.endsWith(`:${id}`) && c.label !== id && c.url !== id) return;
    hits++;
    c.disabled = change.disabled;
    if (change.label && c.type === 2) c.label = change.label.slice(0, 80);
  };
  rows.forEach(visit);
  return hits;
}

interface FormField {
  type: string;
  variable: string;
  label: string;
  description?: string;
  required?: boolean;
  style?: string;
  placeholder?: string;
  min_length?: number;
  max_length?: number;
  default?: string;
  min_values?: number;
  max_values?: number;
  options?: { label: string; value: string; description?: string }[];
}

const FORM_TYPES: Record<string, number> = { select: 3, user: 5, role: 6, mentionable: 7, channel: 8, file: 19 };

/** Modal JSON of a Send Form block: one labelled component per field (custom_id f0 … f4). */
export function modalOf(run: Pick<Run, 'render'>, customId: string, title: string, fields: FormField[]): Record<string, unknown> {
  const s = (v: string | undefined, max: number) => (v ? run.render(v).slice(0, max) : undefined);
  return {
    custom_id: customId,
    title: (s(title, 45) || 'Form').trim() || 'Form',
    components: fields.map((f, n) => {
      const cid = `f${n}`;
      const required = f.required === true;
      let inner: Record<string, unknown>;
      if (f.type === 'text' || !FORM_TYPES[f.type]) {
        inner = { type: 4, custom_id: cid, style: f.style === 'paragraph' ? 2 : 1, required, placeholder: s(f.placeholder, 100) || undefined, min_length: f.min_length, max_length: f.max_length, value: s(f.default, 4000) || undefined };
      } else {
        const min = Math.max(required ? 1 : 0, Math.min(25, f.min_values ?? (required ? 1 : 0)));
        inner = { type: FORM_TYPES[f.type], custom_id: cid, required, min_values: min, max_values: Math.max(min || 1, Math.min(25, f.max_values ?? 1)) };
        if (f.type === 'select') {
          // Same rules as menus: no duplicate values, trimmed, at most 25.
          const seen = new Set<string>();
          const options = (f.options ?? []).map((o) => ({ label: run.render(o.label).trim().slice(0, 100) || '–', value: run.render(o.value).trim().slice(0, 100), description: s(o.description, 100) || undefined })).filter((o) => o.value && !seen.has(o.value) && seen.add(o.value)).slice(0, 25);
          const list = options.length ? options : [{ label: '–', value: '-', description: undefined }];
          inner.options = list;
          inner.max_values = Math.min(inner.max_values as number, list.length);
          inner.min_values = Math.min(inner.min_values as number, inner.max_values as number);
          if (f.placeholder) inner.placeholder = s(f.placeholder, 100);
        }
        if (f.type === 'file') inner.max_values = Math.min(10, inner.max_values as number);
      }
      return { type: 18, label: (s(f.label, 45) || `Field ${n + 1}`).trim(), description: s(f.description, 100) || undefined, component: inner };
    }),
  };
}

/** The answer of one form field: text, picked values (IDs) or file URLs, comma separated. */
export function formValue(field: { value?: unknown; values?: unknown; attachments?: { values(): Iterable<{ url: string }> } | null } | undefined): string {
  if (!field) return '';
  if (typeof field.value === 'string') return field.value;
  if (field.attachments) return [...field.attachments.values()].map((a) => a.url).join(', ');
  if (Array.isArray(field.values)) return field.values.map(String).join(', ');
  return '';
}

export interface ExtraDeps {
  repo: Repo;
  secret: (key: string) => string | null;
}

export function extraHandlers({ repo, secret }: ExtraDeps): [string, Handler][] {
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
  const call = async <T>(run: Run, fn: () => Promise<T>): Promise<T> => {
    run.countDiscordCall();
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === 50013) throw new GraphError('error.run.missing_permissions', { message: e.message, code: 50013 });
      throw new GraphError('error.run.discord', { message: e.message ?? String(err), code: e.code });
    }
  };
  const reason = (run: Run, node: GraphNode) => run.str(node, 'reason').slice(0, 512) || undefined;
  const roleOf = async (run: Run, node: GraphNode, key = 'role') => {
    const guild = await guildOf(run, node);
    const value = run.str(node, key);
    const id = snowflake(value, key);
    run.countDiscordCall();
    const role = await guild.roles.fetch(id).catch(() => null);
    if (!role) throw new GraphError('error.run.not_found', { value });
    return role;
  };
  const threadOf = async (run: Run, node: GraphNode): Promise<ThreadChannel> => {
    const d = data(run);
    const raw = run.str(node, 'thread').trim();
    const value = raw || (d.channel && 'isThread' in d.channel && d.channel.isThread() ? d.channel.id : '');
    run.countDiscordCall();
    const ch = value ? await d.client.channels.fetch(snowflake(value, 'thread')).catch(() => null) : null;
    if (!ch || !ch.isThread()) throw new GraphError('error.run.channel_not_found', { value: raw || '–' });
    return ch;
  };
  const eventOf = async (run: Run, node: GraphNode): Promise<GuildScheduledEvent> => {
    const guild = await guildOf(run, node);
    const value = run.str(node, 'event').trim();
    const id = /events\/\d+\/(\d{17,20})/.exec(value)?.[1] ?? snowflake(value, 'event');
    run.countDiscordCall();
    const ev = await guild.scheduledEvents.fetch(id).catch(() => null);
    if (!ev) throw new GraphError('error.run.not_found', { value });
    return ev;
  };
  /** The message of a block reference (block variable, link, ID in this channel). */
  const messageOf = async (run: Run, node: GraphNode, key = 'message'): Promise<Message> => {
    const d = data(run);
    const raw = String(run.raw(node, key) ?? '').trim();
    const known = d.messages.get(raw);
    if (known) return known;
    const value = run.render(raw);
    if (!value && d.interaction?.isMessageComponent()) return d.interaction.message;
    const link = /channels\/(?:\d+|@me)\/(\d{17,20})\/(\d{17,20})/.exec(value);
    run.countDiscordCall();
    const ch = link ? await d.client.channels.fetch(link[1]!).catch(() => null) : d.channel;
    if (!ch || !('messages' in ch)) throw new GraphError('error.run.message_not_found', { value });
    const msg = await ch.messages.fetch(link ? link[2]! : snowflake(value, key)).catch(() => null);
    if (!msg) throw new GraphError('error.run.message_not_found', { value });
    return msg;
  };
  /** Add/Remove roles to all members: empty role fields are skipped, not an error. */
  const rolesToAll = async (node: GraphNode, run: Run, add: boolean): Promise<void> => {
    const guild = await guildOf(run, node);
    const roles = snowflakes(run.str(node, 'roles'), 'roles');
    run.setResult(node, '.changed', 0);
    run.setResult(node, '.skipped', 0);
    run.setResult(node, '.errors', 0);
    if (!roles.length) return;
    run.countDiscordCall();
    const members = await guild.members.fetch();
    let changed = 0;
    let skipped = 0;
    let errors = 0;
    const bots = run.bool(node, 'include_bots');
    // Many members: one Discord call each, slowly (rate limits), not counted against the run limit.
    for (const m of members.values()) {
      if (m.user.bot && !bots && add) {
        skipped++;
        continue;
      }
      const todo = roles.filter((r) => m.roles.cache.has(r) !== add);
      if (!todo.length) {
        skipped++;
        continue;
      }
      try {
        await (add ? m.roles.add(todo, reason(run, node)) : m.roles.remove(todo, reason(run, node)));
        changed++;
      } catch (err) {
        errors++;
        if ((err as { code?: number }).code === 50013 && changed === 0) throw new GraphError('error.run.missing_permissions', { message: (err as Error).message, code: 50013 });
      }
    }
    run.setResult(node, '.changed', changed);
    run.setResult(node, '.skipped', skipped);
    run.setResult(node, '.errors', errors);
  };
  const setTags = async (node: GraphNode, run: Run, add: boolean): Promise<void> => {
    const thread = await threadOf(run, node);
    const parent = thread.parent;
    if (!parent || (parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildMedia)) throw new GraphError('error.run.module_failed', { message: 'Tags exist only on posts of forum channels.' });
    const wanted = run.str(node, 'tags').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const ids = parent.availableTags.filter((t) => wanted.includes(t.id) || wanted.includes(t.name.toLowerCase())).map((t) => t.id);
    if (wanted.length && !ids.length) throw new GraphError('error.run.not_found', { value: run.str(node, 'tags') });
    const next = add ? [...new Set([...thread.appliedTags, ...ids])].slice(0, 5) : thread.appliedTags.filter((t) => !ids.includes(t));
    await call(run, () => thread.setAppliedTags(next, reason(run, node)));
  };
  const eventInfo = (run: Run, node: GraphNode, ev: GuildScheduledEvent) => {
    run.setResult(node, '.id', ev.id);
    run.setResult(node, '.url', ev.url);
    run.setResult(node, '.name', ev.name);
    run.setResult(node, '.start', ev.scheduledStartTimestamp ? `<t:${Math.floor(ev.scheduledStartTimestamp / 1000)}:F>` : '');
    run.setResult(node, '.status', ['', 'scheduled', 'active', 'completed', 'canceled'][ev.status] ?? '');
  };
  const control = (run: Run, op: 'stop' | 'restart'): void => {
    const c = data(run).control;
    if (!c) throw new GraphError('error.run.unsupported_block', { type: `action.${op}_bot` });
    // After the reply of this run went out.
    setTimeout(() => c(op), 1500).unref();
  };
  const timeZone = (run: Run, node: GraphNode) => run.str(node, 'timezone').trim() || run.vars.get('bot.timezone') || '';

  return [
    ['action.add_roles_all', (node, run) => rolesToAll(node, run, true)],
    ['action.remove_roles_all', (node, run) => rolesToAll(node, run, false)],
    [
      'action.create_role',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const name = run.str(node, 'name').trim().slice(0, 100) || 'new role';
        const role = await call(run, () => guild.roles.create({ name, color: hexColor(run.str(node, 'color')), hoist: run.bool(node, 'hoist'), mentionable: run.bool(node, 'mentionable'), reason: reason(run, node) }));
        run.setResult(node, '', `<@&${role.id}>`);
        run.setResult(node, '.id', role.id);
        run.setResult(node, '.name', role.name);
        const after = run.str(node, 'undo_after').trim();
        if (after) repo.addJob(data(run).botId, 'undo', new Date(Date.now() + parseDuration(after)), { op: 'delete_role', guild: guild.id, role: role.id }, null);
      },
    ],
    [
      'action.edit_role',
      async (node, run) => {
        const role = await roleOf(run, node);
        const edit: Record<string, unknown> = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 100);
        const color = hexColor(run.str(node, 'color'));
        if (color !== undefined) edit.color = color;
        if (node.config.hoist !== undefined) edit.hoist = run.bool(node, 'hoist');
        if (node.config.mentionable !== undefined) edit.mentionable = run.bool(node, 'mentionable');
        await call(run, () => role.edit(edit));
      },
    ],
    [
      'action.delete_role',
      async (node, run) => {
        const role = await roleOf(run, node);
        await call(run, () => role.delete(reason(run, node)));
      },
    ],
    [
      'action.role_info',
      async (node, run) => {
        const role = await roleOf(run, node, 'role');
        run.setResult(node, '', role.name);
        run.setResult(node, '.name', role.name);
        run.setResult(node, '.color', role.hexColor);
        run.setResult(node, '.members', role.members.size);
        run.setResult(node, '.id', role.id);
        run.setResult(node, '.position', role.position);
      },
    ],
    [
      'action.role_list',
      async (node, run) => {
        const guild = await guildOf(run, node);
        run.countDiscordCall();
        const roles = [...(await guild.roles.fetch()).values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
        run.setResult(node, '', roles.map((r) => `<@&${r.id}>`).join('\n').slice(0, 4000));
        run.setResult(node, '.names', roles.map((r) => r.name).join(', ').slice(0, 4000));
        run.setResult(node, '.ids', roles.map((r) => r.id).join(','));
        run.setResult(node, '.count', roles.length);
      },
    ],
    [
      'action.create_thread',
      async (node, run) => {
        const d = data(run);
        const name = run.str(node, 'name').trim().slice(0, 100) || 'Thread';
        const start = String(run.raw(node, 'start_message') ?? '').trim();
        let thread: ThreadChannel;
        if (start) {
          const msg = await messageOf(run, node, 'start_message');
          thread = await call(run, () => msg.startThread({ name, reason: reason(run, node) }));
        } else {
          const value = run.str(node, 'channel');
          run.countDiscordCall();
          const ch = value ? await d.client.channels.fetch(snowflake(value, 'channel')).catch(() => null) : d.channel;
          if (!ch || !('threads' in ch) || ch.isThread()) throw new GraphError('error.run.channel_not_found', { value });
          const forum = ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia;
          thread = (await call(run, () =>
            forum
              ? (ch.threads as any).create({ name, message: { content: name }, reason: reason(run, node) })
              : (ch.threads as any).create({ name, type: run.bool(node, 'private') ? ChannelType.PrivateThread : ChannelType.PublicThread, reason: reason(run, node) }),
          )) as ThreadChannel;
        }
        run.setResult(node, '', `<#${thread.id}>`);
        run.setResult(node, '.id', thread.id);
        run.setResult(node, '.name', thread.name);
        run.setResult(node, '.archived', thread.archived ? 'true' : 'false');
        const after = run.str(node, 'undo_after').trim();
        if (after) repo.addJob(d.botId, 'undo', new Date(Date.now() + parseDuration(after)), { op: 'delete_channel', guild: thread.guildId, channel: thread.id }, null);
      },
    ],
    [
      'action.edit_thread',
      async (node, run) => {
        const thread = await threadOf(run, node);
        const edit: Record<string, unknown> = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 100);
        if (node.config.locked !== undefined) edit.locked = run.bool(node, 'locked');
        if (node.config.archived !== undefined) edit.archived = run.bool(node, 'archived');
        // An archived thread has to be opened before anything else can change.
        if (thread.archived && edit.archived !== true && Object.keys(edit).length > 1) await call(run, () => thread.setArchived(false));
        await call(run, () => thread.edit(edit));
      },
    ],
    [
      'action.delete_thread',
      async (node, run) => {
        const thread = await threadOf(run, node);
        await call(run, () => thread.delete(reason(run, node)));
      },
    ],
    ['action.forum_add_tags', (node, run) => setTags(node, run, true)],
    ['action.forum_remove_tags', (node, run) => setTags(node, run, false)],
    [
      'action.create_invite',
      async (node, run) => {
        const d = data(run);
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = value ? await d.client.channels.fetch(snowflake(value, 'channel')).catch(() => null) : d.channel;
        if (!ch || !('createInvite' in ch)) throw new GraphError('error.run.channel_not_found', { value });
        const hours = Math.max(0, Math.min(168, Number(run.raw(node, 'max_age') ?? 24) || 0));
        const uses = Math.max(0, Math.min(100, Math.trunc(Number(run.raw(node, 'max_uses') ?? 0) || 0)));
        const inv = await call(run, () => (ch as { createInvite(o: object): Promise<{ url: string; code: string }> }).createInvite({ maxAge: hours * 3600, maxUses: uses, unique: true }));
        run.setResult(node, '', inv.url);
        run.setResult(node, '.code', inv.code);
      },
    ],
    [
      'action.leave_server',
      async (node, run) => {
        const guild = await guildOf(run, node);
        await call(run, () => guild.leave());
      },
    ],
    [
      'action.add_emoji',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const name = run.str(node, 'name').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
        if (name.length < 2) throw new GraphError('error.run.missing_value', { field: 'name' });
        const url = run.str(node, 'image_url').trim();
        if (!/^https:\/\//.test(url)) throw new GraphError('error.run.bad_url', { value: url });
        const emoji = await call(run, () => guild.emojis.create({ attachment: url, name, reason: reason(run, node) }));
        run.setResult(node, '', emoji.toString());
        run.setResult(node, '.id', emoji.id);
      },
    ],
    [
      'action.delete_emoji',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const value = run.str(node, 'emoji').trim();
        const id = /(\d{17,20})>?$/.exec(value)?.[1];
        run.countDiscordCall();
        const emoji = id ? await guild.emojis.fetch(id).catch(() => null) : (await guild.emojis.fetch()).find((e) => e.name === value.replace(/:/g, '')) ?? null;
        if (!emoji) throw new GraphError('error.run.not_found', { value });
        await call(run, () => emoji.delete(reason(run, node)));
      },
    ],
    [
      'action.voice_move',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const user = snowflake(run.str(node, 'user'), 'user');
        run.countDiscordCall();
        const m = await guild.members.fetch(user).catch(() => null);
        if (!m) throw new GraphError('error.run.member_not_found', { value: user });
        if (!m.voice.channelId) throw new GraphError('error.run.not_in_voice', { value: m.id });
        const target = run.str(node, 'channel').trim();
        await call(run, () => m.voice.setChannel(target ? snowflake(target, 'channel') : null, reason(run, node)));
      },
    ],
    [
      'action.join_voice',
      async (node, run) => {
        const d = data(run);
        const guild = await guildOf(run, node);
        const value = run.str(node, 'channel').trim() || d.member?.voice.channelId || '';
        if (!value) throw new GraphError('error.run.not_in_voice', { value: d.user?.id ?? '' });
        if (!d.voice) throw new GraphError('error.run.music', { message: 'Voice is not available right now.' });
        run.countDiscordCall();
        try {
          await d.voice.join(guild.id, snowflake(value, 'channel'));
        } catch (err) {
          throw new GraphError('error.run.music', { message: `I could not join that voice channel: ${(err as Error).message}` });
        }
      },
    ],
    [
      'action.leave_voice',
      async (node, run) => {
        const guild = await guildOf(run, node);
        data(run).voice?.leave(guild.id);
      },
    ],
    [
      'action.publish_message',
      async (node, run) => {
        const msg = await messageOf(run, node);
        if (msg.channel.type !== ChannelType.GuildAnnouncement) throw new GraphError('error.run.module_failed', { message: 'Only messages in announcement channels can be published.' });
        if (!msg.crosspostable) return; // already published
        await call(run, () => msg.crosspost());
      },
    ],
    [
      'action.edit_component',
      async (node, run) => {
        const msg = await messageOf(run, node);
        const rows = msg.components.map((r) => r.toJSON() as unknown as Record<string, any>);
        const id = run.str(node, 'component_id').trim();
        const hits = editComponents(rows, id, { label: run.str(node, 'label').trim(), disabled: run.bool(node, 'disabled') });
        if (!hits) throw new GraphError('error.run.not_found', { value: id || '–' });
        await call(run, () => msg.edit({ components: rows as never }));
      },
    ],
    [
      'action.go_to_page',
      async (node, run) => {
        const msg = await messageOf(run, node);
        const pages = splitPages(run.str(node, 'pages'));
        if (!pages.length) throw new GraphError('error.run.missing_value', { field: 'pages' });
        const key = `page.${msg.id}`;
        const current = Number(run.vars.get(key) ?? 0) || 0;
        const to = nextPage(String(run.raw(node, 'page_action') ?? 'next'), current, pages.length, Number(run.raw(node, 'page') ?? 1) || 1);
        run.vars.set(key, String(to));
        run.vars.set('page', String(to + 1));
        run.vars.set('page.count', String(pages.length));
        const text = `${pages[to]}`.replaceAll('{page}', String(to + 1)).replaceAll('{pages}', String(pages.length));
        // Only the text changes: images, cards and buttons of the message stay (no "attachments" sent).
        const embeds = msg.embeds.map((e) => e.toJSON());
        if (embeds.length && !msg.content) {
          embeds[0] = { ...embeds[0], description: text.slice(0, 4096) };
          await call(run, () => msg.edit({ embeds }));
        } else {
          await call(run, () => msg.edit({ content: text.slice(0, 2000) }));
        }
        const i = data(run).interaction;
        if (i?.isMessageComponent() && !i.replied && !i.deferred && i.message.id === msg.id) await i.deferUpdate().catch(() => undefined);
      },
    ],
    [
      'action.create_transcript',
      async (node, run) => {
        const d = data(run);
        const value = run.str(node, 'channel');
        run.countDiscordCall();
        const ch = value ? await d.client.channels.fetch(snowflake(value, 'channel')).catch(() => null) : d.channel;
        if (!ch || !('messages' in ch)) throw new GraphError('error.run.channel_not_found', { value });
        const limit = Math.max(1, Math.min(5000, Math.trunc(Number(run.raw(node, 'limit') ?? 500)) || 500));
        const all: Message[] = [];
        let before: string | undefined;
        while (all.length < limit) {
          const batch = await ch.messages.fetch({ limit: Math.min(100, limit - all.length), ...(before ? { before } : {}) }).catch(() => null);
          if (!batch?.size) break;
          all.push(...batch.values());
          before = batch.last()?.id;
          if (batch.size < 100) break;
        }
        all.reverse();
        const text = transcript(all.map((m) => ({ at: m.createdAt, author: m.author.tag, content: m.content, attachments: [...m.attachments.values()].map((a) => a.url) })));
        // Attached to the next message that names {var} (like image cards).
        const name = `transcript-${randomBytes(4).toString('hex')}.txt`;
        d.files ??= new Map();
        d.files.set(name, Buffer.from(text, 'utf8'));
        run.setResult(node, '', `attachment://${name}`);
        run.setResult(node, '.download_url', `attachment://${name}`);
        run.setResult(node, '.count', all.length);
      },
    ],
    [
      'action.event_create',
      async (node, run) => {
        const guild = await guildOf(run, node);
        const name = run.str(node, 'name').trim().slice(0, 100);
        if (!name) throw new GraphError('error.run.missing_value', { field: 'name' });
        const tz = timeZone(run, node);
        const start = parseDateTime(run.str(node, 'start'), tz);
        const endText = run.str(node, 'end').trim();
        const end = endText ? parseDateTime(endText, tz) : undefined;
        const where = String(run.raw(node, 'location_type') ?? 'voice');
        const opts: Record<string, unknown> = {
          name,
          description: run.str(node, 'description').slice(0, 1000) || undefined,
          scheduledStartTime: new Date(start),
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          reason: reason(run, node),
        };
        if (where === 'external') {
          opts.entityType = GuildScheduledEventEntityType.External;
          opts.entityMetadata = { location: run.str(node, 'location').slice(0, 100) || '–' };
          opts.scheduledEndTime = new Date(end ?? start + 3_600_000); // external events need an end
        } else {
          opts.entityType = where === 'stage' ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice;
          opts.channel = snowflake(run.str(node, 'channel'), 'channel');
          if (end) opts.scheduledEndTime = new Date(end);
        }
        const image = run.str(node, 'image_url').trim();
        if (image) opts.image = image;
        const repeat = String(run.raw(node, 'repeat') ?? 'none');
        if (repeat !== 'none') {
          const day = (new Date(start).getUTCDay() + 6) % 7; // Discord: 0 = Monday
          const F = GuildScheduledEventRecurrenceRuleFrequency;
          opts.recurrenceRule =
            repeat === 'weekdays' ? { startAt: new Date(start), frequency: F.Daily, interval: 1, byWeekday: [0, 1, 2, 3, 4] }
            : repeat === 'monthly' ? { startAt: new Date(start), frequency: F.Monthly, interval: 1, byNWeekday: [{ n: Math.min(5, Math.ceil(new Date(start).getUTCDate() / 7)), day }] }
            : repeat === 'yearly' ? { startAt: new Date(start), frequency: F.Yearly, interval: 1, byMonth: [new Date(start).getUTCMonth() + 1], byMonthDay: [new Date(start).getUTCDate()] }
            : { startAt: new Date(start), frequency: F.Weekly, interval: repeat === 'biweekly' ? 2 : 1, byWeekday: [day] };
        }
        const ev = await call(run, () => guild.scheduledEvents.create(opts as never));
        eventInfo(run, node, ev);
        if (run.bool(node, 'invite_link')) {
          const link = await ev.createInviteURL().catch(() => '');
          run.setResult(node, '.invite_url', link);
        }
      },
    ],
    [
      'action.event_edit',
      async (node, run) => {
        const ev = await eventOf(run, node);
        const edit: Record<string, unknown> = { reason: reason(run, node) };
        const name = run.str(node, 'name').trim();
        if (name) edit.name = name.slice(0, 100);
        const desc = run.str(node, 'description');
        if (desc) edit.description = desc.slice(0, 1000);
        const tz = run.vars.get('bot.timezone') ?? '';
        if (run.str(node, 'start').trim()) edit.scheduledStartTime = new Date(parseDateTime(run.str(node, 'start'), tz));
        if (run.str(node, 'end').trim()) edit.scheduledEndTime = new Date(parseDateTime(run.str(node, 'end'), tz));
        await call(run, () => ev.edit(edit));
      },
    ],
    [
      'action.event_delete',
      async (node, run) => {
        const ev = await eventOf(run, node);
        await call(run, () => ev.delete());
      },
    ],
    [
      'action.event_get',
      async (node, run) => {
        const ev = await eventOf(run, node);
        run.setResult(node, '', ev.name);
        eventInfo(run, node, ev);
      },
    ],
    [
      'action.event_status',
      async (node, run) => {
        const ev = await eventOf(run, node);
        const action = String(run.raw(node, 'event_action') ?? 'start');
        const S = GuildScheduledEventStatus;
        const status = action === 'end' ? S.Completed : action === 'cancel' ? S.Canceled : S.Active;
        await call(run, () => ev.setStatus(status as never, reason(run, node)));
      },
    ],
    [
      'action.change_bot_status',
      (node, run) => {
        const me = data(run).client.user;
        if (!me) return;
        const status = String(run.raw(node, 'status') ?? 'online') as 'online' | 'idle' | 'dnd' | 'invisible';
        const kind = String(run.raw(node, 'activity_type') ?? 'playing');
        const text = run.str(node, 'activity').trim().slice(0, 128);
        const types: Record<string, ActivityType> = { playing: ActivityType.Playing, streaming: ActivityType.Streaming, listening: ActivityType.Listening, watching: ActivityType.Watching, competing: ActivityType.Competing, custom: ActivityType.Custom };
        run.countDiscordCall();
        me.setPresence({ status, activities: text ? [kind === 'custom' ? { name: text, state: text, type: ActivityType.Custom } : { name: text, type: types[kind] ?? ActivityType.Playing }] : [] });
      },
    ],
    ['action.stop_bot', (_node, run) => control(run, 'stop')],
    ['action.restart_bot', (_node, run) => control(run, 'restart')],
    [
      'action.cancel_job',
      (node, run) => {
        const job = run.str(node, 'job').trim();
        if (!job) throw new GraphError('error.run.missing_value', { field: 'job' });
        const n = /^\d+$/.test(job) ? repo.cancelJobById(data(run).botId, Number(job)) : repo.cancelJobs(data(run).botId, job);
        run.setResult(node, '', n);
      },
    ],
    [
      'action.economy_reset',
      (node, run) => {
        const d = data(run);
        if (!d.guild) throw new GraphError('error.run.needs_server');
        const user = snowflake(run.str(node, 'user') || (run.vars.get('user.id') ?? ''), 'user');
        repo.resetBalances(d.botId, d.guild.id, user);
      },
    ],
    [
      'action.send_form',
      async (node, run) => {
        const d = data(run);
        const i = d.interaction;
        if (!i || i.isModalSubmit() || !('showModal' in i)) throw new GraphError('error.run.no_interaction');
        if (i.replied || i.deferred) throw new GraphError('error.run.form_too_late', { message: 'A form has to be the first answer of a command or button: put Send Form before any reply, wait or slow block.' });
        const form = (run.raw(node, 'form') ?? {}) as { title?: string; fields?: FormField[] };
        const fields = (form.fields ?? []).slice(0, 5);
        if (!fields.length) throw new GraphError('error.run.missing_value', { field: 'form' });
        const id = `bhf:${randomBytes(6).toString('hex')}`;
        run.countDiscordCall();
        await call(run, () => (i as unknown as { showModal(m: unknown): Promise<void> }).showModal(modalOf(run, id, form.title ?? 'Form', fields)));
        const seconds = Math.max(30, Math.min(900, Number(run.raw(node, 'timeout') ?? 300) || 300));
        const submit = await run.waitFor(i.awaitModalSubmit({ time: seconds * 1000, filter: (s) => s.customId === id && s.user.id === i.user.id })).catch(() => null);
        if (!submit) throw new GraphError('error.run.form_timeout', { message: `Nobody sent the form within ${seconds} seconds.` });
        // Later replies of the run answer the form.
        d.interaction = submit;
        fields.forEach((f, n) => {
          const name = f.variable;
          if (!name) return;
          const v = formValue(submit.fields.fields.get(`f${n}`));
          run.vars.set(name, v);
          run.vars.set(`form.${name}`, v);
        });
      },
    ],
    [
      'action.ifttt',
      async (node, run) => {
        const key = secret('IFTTT_KEY');
        if (!key) throw new GraphError('error.run.unknown_secret', { value: 'IFTTT_KEY', message: 'Add your IFTTT Webhooks key as the secret IFTTT_KEY (Secrets) and share it with this bot.' });
        const event = run.str(node, 'event').trim();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(event)) throw new GraphError('error.run.missing_value', { field: 'event' });
        run.countDiscordCall();
        const res = await fetch(`https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/with/key/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value1: run.str(node, 'value1'), value2: run.str(node, 'value2'), value3: run.str(node, 'value3') }),
          signal: AbortSignal.timeout(10_000),
        }).catch((err: Error) => {
          throw new GraphError('error.run.http_failed', { message: err.message });
        });
        if (!res.ok) throw new GraphError('error.run.http_failed', { message: `IFTTT answered ${res.status}` });
      },
    ],
  ];
}
