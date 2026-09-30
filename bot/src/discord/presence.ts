// Bot presence as set on the dashboard (bot_profiles.presence): online
// status, one activity, a custom status and an optional rotation that
// switches the activity every intervalSeconds.

import { ActivityType, type ActivitiesOptions, type Client, type PresenceData, type PresenceStatusData } from 'discord.js';

export interface PresenceActivity {
  type: string;
  name: string;
  url?: string;
}

export interface PresenceSettings {
  status: string;
  activity: PresenceActivity;
  customStatus: string;
  /** Discord shows one activity of a bot: 'activity' (or rotation) or 'custom'. */
  show: 'activity' | 'custom';
  rotation: { enabled: boolean; intervalSeconds: number; entries: PresenceActivity[] };
}

const TYPES: Record<string, ActivityType> = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
};

const STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);

/** Fills defaults, so a missing or broken row still gives a valid presence. */
export function parsePresence(raw: unknown): PresenceSettings {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const act = (a: unknown): PresenceActivity => {
    const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    return { type: String(o.type ?? 'none'), name: String(o.name ?? ''), ...(o.url ? { url: String(o.url) } : {}) };
  };
  const r = (p.rotation && typeof p.rotation === 'object' ? p.rotation : {}) as Record<string, unknown>;
  return {
    status: STATUSES.has(String(p.status)) ? String(p.status) : 'online',
    activity: act(p.activity),
    customStatus: String(p.customStatus ?? ''),
    show: p.show === 'custom' ? 'custom' : 'activity',
    rotation: {
      enabled: r.enabled === true,
      intervalSeconds: Math.min(3600, Math.max(30, Number(r.intervalSeconds) || 300)),
      entries: Array.isArray(r.entries) ? r.entries.map(act) : [],
    },
  };
}

/** Replaces placeholders like {bot.servers}; the default keeps the text. */
export type RenderText = (text: string) => string;
const keep: RenderText = (text) => text;

/** Placeholders the status texts accept (see presenceVar in instance.ts). */
export const PLACEHOLDER = /\{[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}\}/;

function toActivity(a: PresenceActivity, render: RenderText = keep): ActivitiesOptions | null {
  const type = TYPES[a.type];
  const name = render(a.name).slice(0, 128);
  if (type === undefined || name.trim() === '') return null;
  return type === ActivityType.Streaming && a.url ? { type, name, url: a.url } : { type, name };
}

/** Entries of the rotation that Discord can show. */
export function rotationEntries(p: PresenceSettings, render: RenderText = keep): ActivitiesOptions[] {
  return p.rotation.enabled ? p.rotation.entries.map((e) => toActivity(e, render)).filter((a): a is ActivitiesOptions => a !== null) : [];
}

/** True when a status text uses a placeholder, so it has to be refreshed. */
export function hasPlaceholders(p: PresenceSettings): boolean {
  return [p.activity.name, p.customStatus, ...p.rotation.entries.map((e) => e.name)].some((t) => PLACEHOLDER.test(t));
}

/**
 * The presence to send. With an active rotation, entry number `round` (mod
 * length) replaces the fixed activity. The custom status comes last.
 */
export function buildPresence(p: PresenceSettings, round = 0, render: RenderText = keep): PresenceData {
  const rotation = rotationEntries(p, render);
  const main = rotation.length ? rotation[round % rotation.length]! : toActivity(p.activity, render);
  const text = render(p.customStatus).trim().slice(0, 128);
  const custom: ActivitiesOptions | null = text ? { type: ActivityType.Custom, name: 'Custom Status', state: text } : null;
  // Discord shows only one activity of a bot, so send just the chosen one
  // (the other one when the chosen one is empty).
  const shown = p.show === 'custom' ? (custom ?? main) : (main ?? custom);
  const activities: ActivitiesOptions[] = shown ? [shown] : [];
  return { status: p.status as PresenceStatusData, activities };
}

const REFRESH_SECONDS = 300;

/** Applies a presence to one client and runs its rotation timer. */
export class PresenceRunner {
  private timer: NodeJS.Timeout | undefined;
  private round = 0;

  /** Placeholder values (member count …) are read again at every change. */
  apply(client: Client, p: PresenceSettings, render: RenderText = keep): void {
    this.stop();
    this.round = 0;
    const set = () => client.user?.setPresence(buildPresence(p, this.round, render));
    set();
    const rotating = rotationEntries(p).length > 1;
    // Without rotation, texts with placeholders refresh every 5 minutes.
    const every = rotating ? p.rotation.intervalSeconds : hasPlaceholders(p) ? REFRESH_SECONDS : 0;
    if (every) {
      this.timer = setInterval(() => {
        if (rotating) this.round++;
        set();
      }, every * 1000);
      this.timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
