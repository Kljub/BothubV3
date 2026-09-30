// Timed events (table timed_events): when a schedule is due. Pure logic,
// no timers; the bot instance calls due() about once a second.
//
// interval: every intervalSeconds after the last run (or after the bot
//   started). A run missed while the bot was offline happens once at start.
// schedule: at each "HH:MM:SS" in times, in the bot's time zone.
// weekdays (0 = Sunday … 6 = Saturday) limit both kinds; empty = every day.

export interface TimedEvent {
  id: number;
  name: string;
  kind: 'interval' | 'schedule';
  intervalSeconds: number | null;
  times: string[];
  weekdays: number[];
  lastRunAt: number | null; // ms
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Weekday and "HH:MM:SS" of a moment in a time zone ('' = process TZ). */
export function localTime(ms: number, timeZone: string): { weekday: number; hms: string; date: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    weekday: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)),
    hms: `${p.hour}:${p.minute}:${p.second}`,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

function dayAllowed(ev: TimedEvent, weekday: number): boolean {
  return ev.weekdays.length === 0 || ev.weekdays.includes(weekday);
}

/**
 * True when ev is due in (prevMs, nowMs]. startedMs is when the bot started
 * (interval events without a stored last run count from there).
 */
export function isDue(ev: TimedEvent, prevMs: number, nowMs: number, startedMs: number, timeZone: string): boolean {
  if (ev.kind === 'interval') {
    if (!ev.intervalSeconds || ev.intervalSeconds < 10) return false;
    const from = ev.lastRunAt ?? startedMs;
    return nowMs - from >= ev.intervalSeconds * 1000 && dayAllowed(ev, localTime(nowMs, timeZone).weekday);
  }
  // Every whole second in (prev, now]; after a long pause look back 2 minutes at most.
  const times = new Set(ev.times);
  const first = Math.max(Math.floor(prevMs / 1000) + 1, Math.floor(nowMs / 1000) - 120);
  for (let s = first; s <= Math.floor(nowMs / 1000); s++) {
    const t = localTime(s * 1000, timeZone);
    if (times.has(t.hms) && dayAllowed(ev, t.weekday)) return true;
  }
  return false;
}

/** Next run after nowMs as "YYYY-MM-DD HH:MM:SS" in the time zone, '' if none within 8 days. */
export function nextRun(ev: TimedEvent, nowMs: number, timeZone: string): string {
  const fmt = (ms: number) => {
    const t = localTime(ms, timeZone);
    return `${t.date} ${t.hms}`;
  };
  if (ev.kind === 'interval') {
    if (!ev.intervalSeconds) return '';
    let next = nowMs + ev.intervalSeconds * 1000;
    for (let i = 0; i < 8 * 24 && !dayAllowed(ev, localTime(next, timeZone).weekday); i++) next += 3600_000;
    return fmt(next);
  }
  if (!ev.times.length) return '';
  // Walk minute by minute is too slow for 8 days; check each listed time per day.
  for (let day = 0; day <= 8; day++) {
    const base = nowMs + day * 86_400_000;
    const { date, weekday } = localTime(base, timeZone);
    if (!dayAllowed(ev, weekday)) continue;
    for (const hms of [...ev.times].sort()) {
      const candidate = `${date} ${hms}`;
      if (candidate > fmt(nowMs)) return candidate;
    }
  }
  return '';
}
