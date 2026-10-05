// Leak guard: no token or secret leaves the bot, however a command, module
// or plugin is built. Known values (bot tokens, admin secrets, interaction
// tokens) and anything shaped like a Discord token are replaced with
// "[redacted]" at every exit: Discord API requests (messages, embeds, files,
// webhooks, interaction answers), the log, values handed to plugins and the
// API Request block. Values are registered where they come into memory.

const MARK = '[redacted]';
const MIN_LENGTH = 8; // shorter values would hit ordinary text
const MAX_VALUES = 5000;
const MAX_FILE = 8_000_000;

// value -> expiry (ms timestamp; Infinity: until the process ends)
const known = new Map<string, number>();

// Shapes of Discord secrets, also of other bots: bot tokens (base64 user ID .
// timestamp . HMAC), interaction tokens ("interaction:" in base64) and the
// token part of webhook addresses.
const PATTERNS: [RegExp, string][] = [
  [/\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g, MARK],
  [/\baW50ZXJhY3Rpb246[A-Za-z\d_-]{20,}/g, MARK],
  [/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{15,22}\/)[A-Za-z\d_-]{40,}/gi, `$1${MARK}`],
];

/** Remembers a sensitive value; ttlMs for short-lived ones (interaction tokens). */
export function guardValue(value: string | null | undefined, ttlMs = Infinity): void {
  if (!value || value.length < MIN_LENGTH) return;
  if (known.size >= MAX_VALUES) prune(Date.now(), true);
  known.set(value, Date.now() + ttlMs);
}

function prune(now: number, hard = false): void {
  for (const [v, until] of known) if (until <= now) known.delete(v);
  if (hard && known.size >= MAX_VALUES) {
    // drop the short-lived ones first (oldest insertion order)
    for (const [v, until] of known) {
      if (until !== Infinity) known.delete(v);
      if (known.size < MAX_VALUES * 0.9) break;
    }
  }
}

let lastPrune = 0;

/** The text with every known secret and token shape replaced. */
export function redact(text: string): string {
  if (!text || text.length < MIN_LENGTH) return text;
  const now = Date.now();
  if (now - lastPrune > 60_000) {
    lastPrune = now;
    prune(now);
  }
  let out = text;
  for (const [v, until] of known) if (until > now && out.includes(v)) out = out.split(v).join(MARK);
  for (const [re, to] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) out = out.replace(re, to);
  }
  return out;
}

/** Strings inside objects and arrays redacted (a copy where something changed). */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redact(value) as T;
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = redactDeep(v, depth + 1);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? out : value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // class instances (streams, …) stay
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = redactDeep(v, depth + 1);
    if (r !== v) changed = true;
    out[k] = r;
  }
  return (changed ? out : value) as T;
}

/** File data with secrets in it (as text) gets them replaced. */
function redactData(data: unknown): unknown {
  if (typeof data === 'string') return redact(data);
  if (!(data instanceof Uint8Array) || data.length > MAX_FILE) return data;
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  const clean = redact(text);
  return clean === text ? data : Buffer.from(clean, 'utf8');
}

interface RestRequest { body?: unknown; files?: { data?: unknown }[] }

/** Puts the guard in front of every Discord API request of a REST client (body and files; the route stays). */
export function guardRest(rest: { request: (options: RestRequest) => Promise<unknown> }): void {
  const send = rest.request.bind(rest);
  rest.request = (options: RestRequest) => {
    const files = options.files?.map((f) => (f && 'data' in f ? { ...f, data: redactData(f.data) } : f));
    return send({ ...options, body: redactDeep(options.body), ...(files ? { files } : {}) });
  };
}

/** True for the Discord API (discord.com/api, discordapp.com/api, …). */
export function isDiscordApi(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!/(^|\.)(discord|discordapp)\.(com|gg)$/.test(host) && !/(^|\.)discord\.(media|new)$/.test(host)) return false;
  return /^\/api(\/|$)/i.test(url.pathname);
}

const TOKEN_KEY = /token|secret|password/i;

/**
 * An answer of the Discord API without token fields: PATCH /users/@me,
 * GET webhooks and others answer with "token" values, which must never
 * become a variable. Known secrets and token shapes are masked as well.
 */
export function redactDiscordAnswer(text: string): string {
  const masked = redact(text);
  let json: unknown;
  try {
    json = JSON.parse(masked);
  } catch {
    return masked;
  }
  const strip = (v: unknown, depth: number): unknown => {
    if (depth > 20 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = TOKEN_KEY.test(k) && typeof x === 'string' ? MARK : strip(x, depth + 1);
    return out;
  };
  return JSON.stringify(strip(json, 0));
}

/** For tests: forget all values. */
export function resetGuard(): void {
  known.clear();
}
