// Dates of the date blocks (Create Date, Format Date, Get Date Info, Get
// Time Ago) and of the event blocks. A date travels between blocks as Unix
// seconds; every block also reads the other forms parseDateTime knows.

import { GraphError } from './interpreter.js';
import { parseDuration } from './util.js';

/** A known IANA time zone, else UTC. */
export function zoneOf(timeZone: string): string {
  if (!timeZone.trim()) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
    return timeZone.trim();
  } catch {
    return 'UTC';
  }
}

/** UTC offset (ms) of a time zone at a moment. */
export function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(ms / 1000) * 1000;
}

/** Wall clock time in a zone to a moment (ms). */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const zone = zoneOf(timeZone);
  return guess - zoneOffset(guess - zoneOffset(guess, zone), zone);
}

/**
 * A date and time: "2026-12-24 18:00", "24.12.2026 18:00", ISO, Unix
 * seconds or milliseconds, <t:…>, "now", a duration from now ("2h",
 * "in 30m") or back ("2h ago"). Without a time zone in the text the given
 * one counts (UTC when empty or unknown).
 */
export function parseDateTime(text: string, timeZone = '', now = Date.now()): number {
  const t = text.trim();
  const fail = () => new GraphError('error.run.bad_date', { value: text });
  if (!t) throw fail();
  if (/^now$/i.test(t)) return now;
  const stamp = /^<t:(-?\d{1,12})(?::[a-zA-Z])?>$/.exec(t) ?? /^(\d{9,12})$/.exec(t);
  if (stamp) return Number(stamp[1]) * 1000;
  if (/^\d{13}$/.test(t)) return Number(t);
  const rel = /^(?:in\s+)?((?:\d+[smhdw])+)$/i.exec(t);
  if (rel) return now + parseDuration(rel[1]!);
  const ago = /^((?:\d+[smhdw])+)\s+ago$/i.exec(t);
  if (ago) return now - parseDuration(ago[1]!);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  let y: number, mo: number, d: number, h = 0, mi = 0, s = 0;
  if (m) [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t))) [d, mo, y, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  else {
    const iso = Date.parse(t);
    if (Number.isFinite(iso) && /\d{4}-\d{2}-\d{2}T/.test(t)) return iso;
    throw fail();
  }
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) throw fail();
  return zonedTime(y, mo, d, h, mi, s, timeZone);
}

/** "2h", "-3d", "+1w2h" to milliseconds (sign allowed). */
export function signedDuration(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const sign = t.startsWith('-') ? -1 : 1;
  return sign * parseDuration(t.replace(/^[+-]\s*/, ''));
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday … 7 = Sunday (ISO). */
  weekday: number;
}

export function dateParts(ms: number, timeZone: string): DateParts {
  const local = new Date(ms + zoneOffset(ms, zoneOf(timeZone)));
  const wd = local.getUTCDay();
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    weekday: wd === 0 ? 7 : wd,
  };
}

/** ISO week number (1-53). */
export function isoWeek(p: Pick<DateParts, 'year' | 'month' | 'day'>): number {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const wd = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - wd);
  const first = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - first) / 86_400_000 + 1) / 7);
}

export function dayOfYear(p: Pick<DateParts, 'year' | 'month' | 'day'>): number {
  return Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 1)) / 86_400_000) + 1;
}

const NAMES = {
  en: {
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  },
  de: {
    months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    days: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'],
  },
};

export type Lang = keyof typeof NAMES;

export function langOf(text: string): Lang {
  return text === 'de' ? 'de' : 'en';
}

export function monthName(month: number, lang: Lang): string {
  return NAMES[lang].months[month - 1] ?? '';
}

export function dayName(weekday: number, lang: Lang): string {
  return NAMES[lang].days[weekday - 1] ?? '';
}

/**
 * A pattern like "DD.MM.YYYY HH:mm": YYYY YY MMMM MMM MM M DDDD DDD DD D
 * HH H hh h mm m ss s A. Text in [brackets] stays as it is.
 */
export function formatPattern(ms: number, pattern: string, timeZone: string, lang: Lang): string {
  const p = dateParts(ms, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  const h12 = p.hour % 12 || 12;
  const tokens: Record<string, string> = {
    YYYY: String(p.year),
    YY: two(p.year % 100),
    MMMM: monthName(p.month, lang),
    MMM: monthName(p.month, lang).slice(0, 3),
    MM: two(p.month),
    M: String(p.month),
    DDDD: dayName(p.weekday, lang),
    DDD: dayName(p.weekday, lang).slice(0, lang === 'de' ? 2 : 3),
    DD: two(p.day),
    D: String(p.day),
    HH: two(p.hour),
    H: String(p.hour),
    hh: two(h12),
    h: String(h12),
    mm: two(p.minute),
    m: String(p.minute),
    ss: two(p.second),
    s: String(p.second),
    A: p.hour < 12 ? 'AM' : 'PM',
  };
  return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|D|HH|H|hh|h|mm|m|ss|s|A/g, (tok, lit: string | undefined) => (lit !== undefined ? lit : tokens[tok]!));
}

const STYLES: Record<string, string> = { short_time: 't', long_time: 'T', short_date: 'd', long_date: 'D', date_time: 'f', full: 'F', relative: 'R' };

/** A Discord timestamp (<t:…:f>), ISO text, Unix seconds or a pattern. */
export function formatDate(ms: number, format: string, pattern: string, timeZone: string, lang: Lang): string {
  const unix = Math.floor(ms / 1000);
  if (STYLES[format]) return `<t:${unix}:${STYLES[format]}>`;
  if (format === 'iso') return new Date(ms).toISOString();
  if (format === 'unix') return String(unix);
  return formatPattern(ms, pattern || 'YYYY-MM-DD HH:mm', timeZone, lang);
}

const UNITS: [number, Record<Lang, [string, string]>][] = [
  [31_536_000, { en: ['year', 'years'], de: ['Jahr', 'Jahren'] }],
  [2_592_000, { en: ['month', 'months'], de: ['Monat', 'Monaten'] }],
  [604_800, { en: ['week', 'weeks'], de: ['Woche', 'Wochen'] }],
  [86_400, { en: ['day', 'days'], de: ['Tag', 'Tagen'] }],
  [3_600, { en: ['hour', 'hours'], de: ['Stunde', 'Stunden'] }],
  [60, { en: ['minute', 'minutes'], de: ['Minute', 'Minuten'] }],
  [1, { en: ['second', 'seconds'], de: ['Sekunde', 'Sekunden'] }],
];

/** "3 hours ago", "in 2 days", "vor 3 Stunden", "in 2 Tagen". */
export function timeAgo(ms: number, now: number, lang: Lang): string {
  const diff = Math.round((ms - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 5) return lang === 'de' ? 'gerade eben' : 'just now';
  const [size, names] = UNITS.find(([s]) => abs >= s)!;
  const n = Math.floor(abs / size);
  const word = n === 1 ? names[lang][0] : names[lang][1];
  if (lang === 'de') return diff > 0 ? `in ${n} ${word}` : `vor ${n} ${word}`;
  return diff > 0 ? `in ${n} ${word}` : `${n} ${word} ago`;
}
