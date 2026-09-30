// Shared runtime of the ready-made modules (settings from
// shared/module-settings, stored in bot_modules.config). Each module is a
// file in this folder with a small pure core (tested) and a Discord handler.

import type { APIEmbed, Guild, GuildMember, MessageCreateOptions } from 'discord.js';
import type { Db } from '../core/db.js';
import type { Repo } from '../core/repo.js';

/** A channel or role picked in the dashboard: IDs are per server. */
export interface Ref {
  id: string;
  guild: string;
}

/** Message field of a settings page. */
export interface MessageConfig {
  mode?: 'text' | 'embed';
  content?: string;
  title?: string;
  description?: string;
  color?: string;
  image?: string;
  footer?: string;
}

const CACHE_MS = 5000;

export class ModuleContext {
  private configCache = new Map<string, { at: number; value: Record<string, unknown> }>();
  private disabledCache: { at: number; value: Set<string> } | null = null;

  constructor(
    readonly botId: number,
    readonly repo: Repo,
  ) {}

  get db(): Db {
    return this.repo.db;
  }

  /**
   * Module switched on (default on) AND set up: settings saved at least once
   * on its page. Without that a module never acts, so switching a new module
   * on does nothing until it is configured. Cached for a few seconds.
   */
  enabled(key: string): boolean {
    const now = Date.now();
    if (!this.disabledCache || now - this.disabledCache.at > CACHE_MS) this.disabledCache = { at: now, value: this.repo.disabledModules(this.botId) };
    return !this.disabledCache.value.has(key) && Object.keys(this.config(key)).length > 0;
  }

  /** Stored settings ({} when never saved). Cached for a few seconds. */
  config<T = Record<string, unknown>>(key: string): Partial<T> {
    const now = Date.now();
    const hit = this.configCache.get(key);
    if (hit && now - hit.at <= CACHE_MS) return hit.value as Partial<T>;
    const value = this.repo.moduleConfig(this.botId, key);
    this.configCache.set(key, { at: now, value });
    return value as Partial<T>;
  }

  /** Called after settings changed (e.g. reaction roles add their reactions). */
  onChange: (() => void) | null = null;

  /** Drops cached settings (after module.changed). */
  invalidate(): void {
    this.configCache.clear();
    this.disabledCache = null;
    this.onChange?.();
  }

  // ---------- module_state (migration 0009) ----------

  getState<T>(module: string, guildId: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM module_state WHERE bot_id = ? AND module = ? AND guild_id = ? AND key = ?').get(this.botId, module, guildId, key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  setState(module: string, guildId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO module_state (bot_id, module, guild_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (bot_id, module, guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(this.botId, module, guildId, key, JSON.stringify(value));
  }

  deleteState(module: string, guildId: string, key: string): void {
    this.db.prepare('DELETE FROM module_state WHERE bot_id = ? AND module = ? AND guild_id = ? AND key = ?').run(this.botId, module, guildId, key);
  }
}

// ---------- helpers ----------

/** IDs of the refs that belong to a server. */
export function idsIn(refs: unknown, guildId: string): string[] {
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is Ref => !!r && typeof r === 'object' && (r as Ref).guild === guildId && typeof (r as Ref).id === 'string').map((r) => r.id);
}

/** The ID of a single ref when it belongs to the server. */
export function idIn(ref: unknown, guildId: string): string | null {
  return ref && typeof ref === 'object' && (ref as Ref).guild === guildId && typeof (ref as Ref).id === 'string' ? (ref as Ref).id : null;
}

/** all / except / only: does the id pass the filter? */
export function passes(mode: unknown, selected: string[], ids: string | string[]): boolean {
  const list = Array.isArray(ids) ? ids : [ids];
  const hit = list.some((id) => selected.includes(id));
  if (mode === 'only') return hit;
  if (mode === 'except') return !hit;
  return true;
}

/** Replaces {name} placeholders; unknown ones stay. */
export function fill(text: string | undefined, vars: Record<string, string>): string {
  return (text ?? '').replace(/\{([A-Za-z0-9_.:-]{1,100})\}/g, (whole, name: string) => vars[name] ?? whole);
}

function color(hex: string | undefined): number | undefined {
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : undefined;
}

/** Discord message from a settings message field, placeholders filled. null when empty. */
export function buildMessage(m: MessageConfig | undefined, vars: Record<string, string>): MessageCreateOptions | null {
  if (!m) return null;
  const content = fill(m.content, vars).slice(0, 2000);
  if (m.mode !== 'embed') return content.trim() ? { content, allowedMentions: { parse: ['users'] } } : null;
  const embed: APIEmbed = {};
  const title = fill(m.title, vars).slice(0, 256);
  const description = fill(m.description, vars).slice(0, 4000);
  const footer = fill(m.footer, vars).slice(0, 2048);
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (footer) embed.footer = { text: footer };
  const c = color(m.color);
  if (c !== undefined) embed.color = c;
  const image = fill(m.image, vars);
  if (/^https:\/\//.test(image)) embed.image = { url: image };
  if (!title && !description && !footer && !embed.image && !content.trim()) return null;
  return { content: content.trim() ? content : undefined, embeds: [embed], allowedMentions: { parse: ['users'] } };
}

/** Placeholders every module message understands. */
export function baseVars(guild: Guild | null, member: GuildMember | null, extra: Record<string, string> = {}): Record<string, string> {
  const user = member?.user;
  const vars: Record<string, string> = {};
  if (guild) Object.assign(vars, { server: guild.name, 'server.id': guild.id, members: String(guild.memberCount), 'server.members': String(guild.memberCount) });
  if (user) {
    Object.assign(vars, {
      user: member?.displayName ?? user.username,
      'user.id': user.id,
      'user.name': user.username,
      'user.mention': `<@${user.id}>`,
      'user.avatar': member?.displayAvatarURL() ?? user.displayAvatarURL(),
    });
  }
  return Object.assign(vars, extra);
}

/** Unicode emoji or <:name:id> / <a:name:id> in the form discord.js reacts with. */
export function reactionOf(emoji: string): string {
  const m = /^<a?:([A-Za-z0-9_]+):(\d+)>$/.exec(emoji.trim());
  return m ? `${m[1]}:${m[2]}` : emoji.trim();
}

/** Does a reaction emoji (message reaction) match a configured emoji? */
export function sameEmoji(configured: string, reaction: { id: string | null; name: string | null }): boolean {
  const m = /^<a?:[A-Za-z0-9_]+:(\d+)>$/.exec(configured.trim());
  return m ? reaction.id === m[1] : reaction.name === configured.trim();
}

/** True when the text contains none of the words (case-insensitive). */
export function keywordFree(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return !words.some((w) => w.trim() && t.includes(w.toLowerCase().trim()));
}
