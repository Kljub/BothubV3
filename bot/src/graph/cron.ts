// Five-field cron for Timed Events: minute hour day-of-month month weekday.
// Supports *, lists (1,2), ranges (1-5), steps (*/15, 1-30/5) and names
// (jan, mon). Weekday 0 and 7 are Sunday. Like classic cron, day-of-month
// and weekday match with OR when both are restricted.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayAny: boolean;
  weekdayAny: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function field(text: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const value = (v: string): number => {
    const i = names.indexOf(v.toLowerCase());
    const n = i >= 0 ? i + nameBase : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`cron value out of range: ${v}`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-') as [string, string];
      lo = value(a);
      hi = value(b);
      if (lo > hi) throw new Error(`bad cron range: ${range}`);
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : max;
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** Throws on an invalid expression. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields');
  const [mi, h, d, mo, wd] = parts as [string, string, string, string, string];
  const weekday = field(wd, 0, 7, DAYS);
  if (weekday.delete(7)) weekday.add(0);
  return {
    minute: field(mi, 0, 59),
    hour: field(h, 0, 23),
    day: field(d, 1, 31),
    month: field(mo, 1, 12, MONTHS, 1),
    weekday,
    dayAny: d === '*',
    weekdayAny: wd === '*',
  };
}

/** Parts of a date in a time zone (the bot's TZ when empty). */
function partsIn(date: Date, timeZone: string | undefined): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}

export function cronMatches(cron: Cron, date: Date, timeZone?: string): boolean {
  const t = partsIn(date, timeZone || undefined);
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month)) return false;
  const dayHit = cron.day.has(t.day);
  const weekdayHit = cron.weekday.has(t.weekday);
  if (cron.dayAny || cron.weekdayAny) return dayHit && weekdayHit;
  return dayHit || weekdayHit;
}
