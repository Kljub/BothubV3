// Moderation module runtime: settings (bot_modules.config, same shape as
// api/src/Internal/ModerationConfig.php), cases, direct messages to the
// punished member, the log channel and automatic punishments. The action
// blocks call begin() before and finish() after their Discord call.

import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from 'discord.js';
import type { CaseAction, Repo } from '../core/repo.js';
import { inBlock } from './commands.js';
import { log } from '../core/log.js';
import { parseDuration } from '../graph/util.js';

export interface GuildRef {
  id: string;
  guild: string;
}

export interface AutoPunishment {
  trigger: 'warnings' | 'timeouts';
  count: number;
  action: 'timeout' | 'kick' | 'ban';
  duration: string;
}

/** Permissions block: who counts as moderator or admin (see inBlock). */
export interface RoleBlock {
  allowed_roles: GuildRef[];
  banned_roles: GuildRef[];
  required_permissions: string[];
  banned_channels: GuildRef[];
}

export interface ModerationConfig {
  moderators: RoleBlock;
  admins: RoleBlock;
  logEnabled: boolean;
  logChannels: GuildRef[];
  punishmentColor: string;
  logColor: string;
  dmEnabled: boolean;
  dmMode: 'text' | 'embed';
  dmMessage: string;
  banDeleteMessages: string;
  autoPunishments: AutoPunishment[];
}

/** Pseudo roles for the permissions block of a command. */
export const MODERATOR_ROLE = 'moderation:moderator';
export const ADMIN_ROLE = 'moderation:admin';

const block = (roles: GuildRef[], permissions: string[]): RoleBlock => ({
  allowed_roles: roles,
  banned_roles: [],
  required_permissions: permissions,
  banned_channels: [],
});

export const DEFAULT_CONFIG: ModerationConfig = {
  moderators: block([], ['manage_messages']),
  admins: block([], ['administrator']),
  logEnabled: false,
  logChannels: [],
  punishmentColor: '#ed4245',
  logColor: '#5865f2',
  dmEnabled: true,
  dmMode: 'embed',
  dmMessage: 'You received a **{action}** in **{server}**.\nModerator: {moderator}\nDuration: {time}\nCase: #{case}\nReason: {reason}',
  banDeleteMessages: 'none',
  autoPunishments: [],
};

const DELETE_MESSAGES = ['none', '1h', '6h', '12h', '24h', '3d', '7d'];
const RULE_DURATION = /^[1-9][0-9]{0,4}[smhd]$/;

const refs = (v: unknown): GuildRef[] =>
  Array.isArray(v) ? v.filter((r): r is GuildRef => !!r && typeof r.id === 'string' && typeof r.guild === 'string') : [];

function parseBlock(v: unknown, fallback: RoleBlock): RoleBlock {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fallback;
  const b = v as Record<string, unknown>;
  return {
    allowed_roles: refs(b.allowed_roles),
    banned_roles: refs(b.banned_roles),
    required_permissions: Array.isArray(b.required_permissions) ? b.required_permissions.filter((p): p is string => typeof p === 'string') : [],
    banned_channels: refs(b.banned_channels),
  };
}

/**
 * Stored config over the defaults; wrong types fall back to the default.
 * Configs from before the blocks (defaultPermissions, moderatorRoles,
 * adminRoles) are read into them, as ModerationConfig.php does.
 */
export function parseConfig(raw: Record<string, unknown>): ModerationConfig {
  const c = { ...DEFAULT_CONFIG };
  const bool = (k: 'logEnabled' | 'dmEnabled') => {
    if (typeof raw[k] === 'boolean') c[k] = raw[k] as boolean;
  };
  bool('logEnabled');
  bool('dmEnabled');
  const legacy = 'moderatorRoles' in raw || 'adminRoles' in raw || 'defaultPermissions' in raw;
  const defaults = raw.defaultPermissions !== false;
  c.moderators = 'moderators' in raw ? parseBlock(raw.moderators, DEFAULT_CONFIG.moderators)
    : legacy ? block(refs(raw.moderatorRoles), defaults ? ['manage_messages'] : []) : DEFAULT_CONFIG.moderators;
  c.admins = 'admins' in raw ? parseBlock(raw.admins, DEFAULT_CONFIG.admins)
    : legacy ? block(refs(raw.adminRoles), defaults ? ['administrator'] : []) : DEFAULT_CONFIG.admins;
  c.logChannels = refs(raw.logChannels);
  for (const k of ['punishmentColor', 'logColor'] as const) if (typeof raw[k] === 'string' && /^#[0-9a-f]{6}$/i.test(raw[k] as string)) c[k] = raw[k] as string;
  if (raw.dmMode === 'text' || raw.dmMode === 'embed') c.dmMode = raw.dmMode;
  if (typeof raw.dmMessage === 'string' && raw.dmMessage.trim()) c.dmMessage = raw.dmMessage;
  if (typeof raw.banDeleteMessages === 'string' && DELETE_MESSAGES.includes(raw.banDeleteMessages)) c.banDeleteMessages = raw.banDeleteMessages;
  // Same rules as ModerationConfig.php; an invalid rule is skipped, so parseDuration() never throws later.
  c.autoPunishments = Array.isArray(raw.autoPunishments)
    ? (raw.autoPunishments as AutoPunishment[]).filter(
        (r) =>
          !!r &&
          ['warnings', 'timeouts'].includes(r.trigger) &&
          ['timeout', 'kick', 'ban'].includes(r.action) &&
          Number.isInteger(r.count) &&
          r.count > 0 &&
          r.count <= 100 &&
          typeof r.duration === 'string' &&
          (r.duration === '' ? r.action !== 'timeout' : RULE_DURATION.test(r.duration)),
      )
    : [];
  return c;
}

const ACTION_NAMES: Record<CaseAction, string> = {
  warn: 'Warning',
  timeout: 'Timeout',
  untimeout: 'Timeout removed',
  kick: 'Kick',
  ban: 'Ban',
  unban: 'Unban',
  role_add: 'Role added',
  role_remove: 'Role removed',
  voice_mute: 'Voice mute',
  voice_unmute: 'Voice unmute',
  voice_deafen: 'Voice deafen',
  voice_undeafen: 'Voice undeafen',
  voice_kick: 'Voice kick',
};

/** Actions that tell the member by direct message. */
const DM_ACTIONS = new Set<CaseAction>(['warn', 'timeout', 'kick', 'ban']);

export function actionName(a: CaseAction, duration = ''): string {
  if (a === 'ban' && duration) return 'Temporary ban';
  return ACTION_NAMES[a] ?? a;
}

/** Replaces {action} {moderator} {time} {case} {reason} {server}. */
export function renderTemplate(text: string, v: Record<string, string>): string {
  return text.replace(/\{(action|moderator|time|case|reason|server)\}/g, (_, k: string) => v[k] ?? '');
}

const colorInt = (hex: string) => Number.parseInt(hex.slice(1), 16);

export interface CaseInput {
  guild: Guild;
  userId: string;
  moderatorId: string | null;
  action: CaseAction;
  reason: string;
  duration: string;
  auto?: boolean;
}

/** Returned by begin(); finish() after the Discord call worked, fail() when it did not. */
export interface CaseHandle {
  number: number | null;
  finish(): Promise<void>;
  fail(): void;
}

const NOOP: CaseHandle = { number: null, finish: async () => undefined, fail: () => undefined };

export class Moderation {
  enabled = true;
  config: ModerationConfig = DEFAULT_CONFIG;

  constructor(
    private readonly botId: number,
    private readonly repo: Repo,
    private readonly client: () => Client | null,
  ) {}

  reload(disabled: Set<string>): void {
    this.enabled = !disabled.has('moderation');
    this.config = parseConfig(this.repo.moduleConfig(this.botId, 'moderation'));
  }

  /**
   * Pseudo roles of the permissions block: true/false for MODERATOR_ROLE and
   * ADMIN_ROLE, undefined for any other role ID. Discord's Administrator is
   * always an admin; admins are moderators too.
   */
  hasPseudoRole(id: string, member: GuildMember, channelId: string | null = null): boolean | undefined {
    if (id !== MODERATOR_ROLE && id !== ADMIN_ROLE) return undefined;
    const c = this.config;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (inBlock(c.admins, member, channelId)) return true;
    if (id === ADMIN_ROLE) return false;
    return inBlock(c.moderators, member, channelId);
  }

  /** Message deletion for ban blocks that keep "none". */
  banDeleteDefault(): string {
    return this.enabled ? this.config.banDeleteMessages : 'none';
  }

  /** Records the case and sends the direct message (before a kick or ban, so it still arrives). */
  async begin(input: CaseInput): Promise<CaseHandle> {
    if (!this.enabled) return NOOP;
    const number = this.repo.addCase(this.botId, {
      guildId: input.guild.id,
      userId: input.userId,
      moderatorId: input.moderatorId,
      action: input.action,
      reason: input.reason,
      duration: input.duration,
      auto: input.auto ?? false,
    });
    // Counted right after the insert, without an await in between: two
    // parallel warnings each see their own number, so no threshold is skipped.
    const counted = input.action === 'warn' || input.action === 'timeout' ? this.repo.countCases(this.botId, input.guild.id, input.userId, input.action) : 0;
    if (this.config.dmEnabled && DM_ACTIONS.has(input.action)) await this.sendDm(input, number);
    return {
      number,
      finish: async () => {
        await this.sendLog(input, number);
        if (!input.auto && counted > 0) await this.autoPunish(input, counted);
      },
      fail: () => void this.repo.removeCase(this.botId, input.guild.id, number),
    };
  }

  private vars(input: CaseInput, number: number): Record<string, string> {
    return {
      action: actionName(input.action, input.duration),
      moderator: input.moderatorId ? `<@${input.moderatorId}>` : 'Automatic',
      time: input.duration || 'Permanent',
      case: String(number),
      reason: input.reason || 'No reason given',
      server: input.guild.name,
    };
  }

  private async sendDm(input: CaseInput, number: number): Promise<void> {
    const client = this.client();
    if (!client) return;
    const text = renderTemplate(this.config.dmMessage, this.vars(input, number)).slice(0, 4000);
    const payload = this.config.dmMode === 'embed' ? { embeds: [{ description: text, color: colorInt(this.config.punishmentColor) }] } : { content: text.slice(0, 2000) };
    try {
      const user = await client.users.fetch(input.userId);
      await user.send(payload);
    } catch {
      // DMs closed: the punishment still happens.
    }
  }

  private async sendLog(input: CaseInput, number: number): Promise<void> {
    if (!this.config.logEnabled) return;
    const ref = this.config.logChannels.find((c) => c.guild === input.guild.id);
    if (!ref) return;
    const v = this.vars(input, number);
    try {
      const ch = await input.guild.channels.fetch(ref.id);
      if (!ch?.isSendable()) return;
      await ch.send({
        embeds: [
          {
            title: `Case #${number} | ${v.action}`,
            color: colorInt(this.config.logColor),
            fields: [
              { name: 'Member', value: `<@${input.userId}> (${input.userId})`, inline: true },
              { name: 'Moderator', value: v.moderator!, inline: true },
              ...(input.duration ? [{ name: 'Duration', value: input.duration, inline: true }] : []),
              { name: 'Reason', value: v.reason!.slice(0, 1024) },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      this.repo.logCode(this.botId, 'ERR-1008', { event: 'moderation log', reason: (err as Error).message });
    }
  }

  /** Rule whose count the member has just reached (the highest one wins). */
  ruleFor(trigger: AutoPunishment['trigger'], count: number): AutoPunishment | undefined {
    return this.config.autoPunishments.filter((r) => r.trigger === trigger && r.count === count).at(-1);
  }

  /** count: warning or timeout cases of the member including this one. */
  private async autoPunish(input: CaseInput, count: number): Promise<void> {
    const trigger = input.action === 'warn' ? 'warnings' : 'timeouts';
    const rule = this.ruleFor(trigger, count);
    if (!rule) return;
    const reason = `Automatic punishment: ${count} ${trigger}`;
    const auto: CaseInput = { guild: input.guild, userId: input.userId, moderatorId: this.client()?.user?.id ?? null, action: rule.action, reason, duration: rule.duration, auto: true };
    const handle = await this.begin(auto);
    try {
      if (rule.action === 'ban') {
        const seconds = this.config.banDeleteMessages === 'none' ? 0 : parseDuration(this.config.banDeleteMessages) / 1000;
        await input.guild.members.ban(input.userId, { reason, deleteMessageSeconds: seconds });
        if (rule.duration) this.scheduleUnban(input.guild.id, input.userId, parseDuration(rule.duration));
      } else {
        const member = await input.guild.members.fetch(input.userId);
        if (rule.action === 'kick') await member.kick(reason);
        else await member.timeout(Math.min(parseDuration(rule.duration), 28 * 86_400_000), reason);
      }
      await handle.finish();
    } catch (err) {
      handle.fail();
      this.repo.logCode(this.botId, 'ERR-1008', { event: 'automatic punishment', reason: (err as Error).message });
      log.warn('automatic punishment failed', { botId: this.botId, err });
    }
  }

  /** Temporary ban: unban job; a manual unban cancels it (key). */
  scheduleUnban(guildId: string, userId: string, ms: number): void {
    const key = `tempban:${guildId}:${userId}`;
    this.repo.cancelJobs(this.botId, key);
    this.repo.addJob(this.botId, 'undo', new Date(Date.now() + ms), { op: 'unban', guild: guildId, user: userId }, key);
  }
}
