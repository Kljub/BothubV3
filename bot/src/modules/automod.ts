// Discord Automod: BotHub keeps Discord's own AutoMod rules (names start
// with "BotHub · ") in line with the settings, in every server of the bot.
// Extra punishments count the hits per member over 24 hours.

import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  type AutoModerationActionExecution,
  type AutoModerationActionOptions,
  type Guild,
} from 'discord.js';
import { log } from '../core/log.js';
import { idIn, idsIn, type ModuleContext } from './context.js';
import { warn } from './guard.js';

export const PREFIX = 'BotHub · ';

export interface AutomodConfig {
  words: string[]; allowed: string[]; profanity: boolean; sexual: boolean; slurs: boolean; invites: boolean; links: boolean;
  mentionLimit: number; spam: boolean; blockMessage: string; alertChannel: unknown; timeoutSeconds: number;
  exemptRoles: unknown; exemptChannels: unknown; punishments: { count: number; action: string; minutes: number }[];
}

export interface WantedRule {
  name: string;
  triggerType: AutoModerationRuleTriggerType;
  triggerMetadata: Record<string, unknown>;
  actions: AutoModerationActionOptions[];
}

const INVITE = String.raw`(discord\.gg|discord(app)?\.com/invite)/[A-Za-z0-9-]+`;
const LINK = String.raw`https?://\S+`;

/** The rules a server should have (pure; one per trigger type). */
export function wantedRules(cfg: Partial<AutomodConfig>, alertChannel: string | null): WantedRule[] {
  const actions = (timeout: boolean): AutoModerationActionOptions[] => {
    const list: AutoModerationActionOptions[] = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: (cfg.blockMessage ?? '').slice(0, 150) || undefined } }];
    if (alertChannel) list.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChannel } });
    if (timeout && (cfg.timeoutSeconds ?? 0) > 0) list.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: Math.min(2419200, cfg.timeoutSeconds!) } });
    return list;
  };
  const rules: WantedRule[] = [];
  const words = (cfg.words ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 1000);
  const regex = [...(cfg.invites ? [INVITE] : []), ...(cfg.links ? [LINK] : [])];
  if (words.length || regex.length) {
    rules.push({ name: `${PREFIX}Words`, triggerType: AutoModerationRuleTriggerType.Keyword, triggerMetadata: { keywordFilter: words, regexPatterns: regex, allowList: (cfg.allowed ?? []).slice(0, 100) }, actions: actions(true) });
  }
  const presets = [
    ...(cfg.profanity ? [AutoModerationRuleKeywordPresetType.Profanity] : []),
    ...(cfg.sexual ? [AutoModerationRuleKeywordPresetType.SexualContent] : []),
    ...(cfg.slurs ? [AutoModerationRuleKeywordPresetType.Slurs] : []),
  ];
  if (presets.length) rules.push({ name: `${PREFIX}Filters`, triggerType: AutoModerationRuleTriggerType.KeywordPreset, triggerMetadata: { presets, allowList: (cfg.allowed ?? []).slice(0, 100) }, actions: actions(false) });
  if ((cfg.mentionLimit ?? 0) > 0) rules.push({ name: `${PREFIX}Mentions`, triggerType: AutoModerationRuleTriggerType.MentionSpam, triggerMetadata: { mentionTotalLimit: cfg.mentionLimit }, actions: actions(true) });
  if (cfg.spam) rules.push({ name: `${PREFIX}Spam`, triggerType: AutoModerationRuleTriggerType.Spam, triggerMetadata: {}, actions: actions(false) });
  return rules;
}

/** Creates, updates or deletes the BotHub rules of one server. */
export async function syncAutomod(ctx: ModuleContext, guild: Guild): Promise<void> {
  const on = ctx.enabled('automod');
  const cfg = on ? ctx.config<AutomodConfig>('automod') : {};
  const wanted = on ? wantedRules(cfg, idIn(cfg.alertChannel, guild.id)) : [];
  const rules = await guild.autoModerationRules.fetch().catch((err) => (log.debug('automod fetch failed', { guildId: guild.id, err: String(err) }), null));
  if (!rules) return;
  const ours = [...rules.values()].filter((r) => r.name.startsWith(PREFIX) && r.creatorId === guild.client.user.id);
  const exemptRoles = idsIn(cfg.exemptRoles, guild.id).filter((r) => guild.roles.cache.has(r)).slice(0, 20);
  const exemptChannels = idsIn(cfg.exemptChannels, guild.id).filter((c) => guild.channels.cache.has(c)).slice(0, 50);
  const ids: string[] = [];
  for (const w of wanted) {
    const existing = ours.find((r) => r.triggerType === w.triggerType);
    const data = { name: w.name, eventType: AutoModerationRuleEventType.MessageSend, triggerMetadata: w.triggerMetadata, actions: w.actions, enabled: true, exemptRoles, exemptChannels, reason: 'BotHub Automod settings' };
    try {
      if (existing) {
        const { triggerType: _t, ...edit } = { triggerType: w.triggerType, ...data };
        await existing.edit(edit);
        ids.push(existing.id);
      } else {
        const created = await guild.autoModerationRules.create({ ...data, triggerType: w.triggerType });
        ids.push(created.id);
      }
    } catch (err) {
      // e.g. Discord allows only one spam rule, or the bot lacks Manage Server.
      log.debug('automod rule failed', { guildId: guild.id, rule: w.name, err: String(err) });
      warn(ctx, 'WAR-2008', { module: 'automod', problem: `rule "${w.name}" in ${guild.name}: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  }
  for (const r of ours) if (!ids.includes(r.id)) await r.delete('BotHub Automod settings').catch(() => undefined);
  ctx.setState('automod', guild.id, 'rules', ids);
}

/** Extra punishments after repeated hits (counted once per blocked message). */
export async function automodHit(ctx: ModuleContext, e: AutoModerationActionExecution): Promise<void> {
  if (!ctx.enabled('automod') || e.action.type !== AutoModerationActionType.BlockMessage) return;
  const ours = ctx.getState<string[]>('automod', e.guild.id, 'rules') ?? [];
  if (!ours.includes(e.ruleId)) return;
  const cfg = ctx.config<AutomodConfig>('automod');
  const key = `hits:${e.userId}`;
  const now = Date.now();
  const hits = [...(ctx.getState<number[]>('automod', e.guild.id, key) ?? []).filter((t) => now - t < 86_400_000), now].slice(-100);
  ctx.setState('automod', e.guild.id, key, hits);
  const p = (cfg.punishments ?? []).find((x) => x.count === hits.length);
  if (!p) return;
  const member = await e.guild.members.fetch(e.userId).catch(() => null);
  if (!member) return;
  const reason = `Automod: ${hits.length} violations in 24 hours`;
  if (p.action === 'ban') await member.ban({ reason }).catch(() => undefined);
  else if (p.action === 'kick') await member.kick(reason).catch(() => undefined);
  else await member.timeout(Math.min(40320, p.minutes ?? 60) * 60_000, reason).catch(() => undefined);
}
