// Bot Profile (module "bot-profile"): the bot's own nickname, bio, avatar
// and banner per server (Discord: Modify Current Member). One profile for
// every server, optionally with overrides per server ID. A profile is only
// sent to Discord when it changed (hash in module_state), so restarts and
// other settings changes do not run into Discord's rate limit.

import { createHash } from 'node:crypto';
import type { Guild } from 'discord.js';
import type { ModuleContext } from './context.js';
import { warn } from './guard.js';

export interface Profile {
  nick?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
}

interface ProfileConfig extends Profile {
  servers?: (Profile & { guildId?: string })[];
}

const MODULE = 'bot-profile';
const https = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/\S{1,500}$/.test(v.trim()) ? v.trim() : null);

/** The profile of one server: the override's filled fields over the default (pure). */
export function profileFor(cfg: ProfileConfig, guildId: string): { nick: string | null; bio: string | null; avatar: string | null; banner: string | null } {
  const o = (cfg.servers ?? []).find((s) => (s.guildId ?? '').trim() === guildId) ?? {};
  const pick = (k: keyof Profile) => ((o[k] ?? '').trim() || (cfg[k] ?? '').trim());
  return {
    nick: pick('nick').slice(0, 32) || null,
    bio: pick('bio').slice(0, 190) || null,
    avatar: https(pick('avatar')),
    banner: https(pick('banner')),
  };
}

/** Sends changed profiles to Discord; a module switched off resets what it had set. */
export async function syncBotProfiles(ctx: ModuleContext, guilds: Guild[]): Promise<void> {
  const on = ctx.enabled(MODULE);
  const cfg = on ? ctx.config<ProfileConfig>(MODULE) : {};
  for (const guild of guilds) {
    const known = ctx.getState<string>(MODULE, guild.id, 'hash');
    if (!on && !known) continue; // never set anything here
    const p = on ? profileFor(cfg, guild.id) : { nick: null, bio: null, avatar: null, banner: null };
    const hash = createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
    if (hash === known) continue;
    const me = guild.members.me;
    if (!me) continue;
    try {
      await me.edit({ nick: p.nick }).catch(() => undefined); // needs Change Nickname
      await guild.members.editMe({ avatar: p.avatar, banner: p.banner, bio: p.bio, reason: 'BotHub Bot Profile' });
      if (on) ctx.setState(MODULE, guild.id, 'hash', hash);
      else ctx.deleteState(MODULE, guild.id, 'hash');
    } catch (err) {
      // Wrong image link, too large file or Discord's rate limit: tried again with the next change.
      warn(ctx, 'WAR-2008', { module: MODULE, problem: `the profile in ${guild.name} could not be set: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  }
}
