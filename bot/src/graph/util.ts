import { GraphError } from './interpreter.js';

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "10s", "5m", "1h", "2d", "1w" (also "1h30m") to milliseconds. */
export function parseDuration(text: string): number {
  const t = text.trim().toLowerCase();
  if (!/^(\d+[smhdw])+$/.test(t)) throw new GraphError('error.run.bad_duration', { value: text });
  let ms = 0;
  for (const [, n, unit] of t.matchAll(/(\d+)([smhdw])/g)) ms += Number(n) * UNIT_MS[unit!]!;
  return ms;
}

/** Discord IDs are 17-20 digit snowflakes; <@123> and <#123> are accepted. */
export function snowflake(text: string, field: string): string {
  const m = /^<[@#&!]*(\d{17,20})>$|^(\d{17,20})$/.exec(text.trim());
  const id = m?.[1] ?? m?.[2];
  if (!id) throw new GraphError('error.run.bad_id', { field, value: text });
  return id;
}

/** Comma or space separated list of IDs. */
export function snowflakes(text: string, field: string): string[] {
  // "<@&1><@&2>" (mentions without a separator) counts as two.
  return text
    .replace(/></g, '> <')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((x) => snowflake(x, field));
}
