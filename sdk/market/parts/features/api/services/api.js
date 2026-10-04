// Service "api" ("secrets.use"). The plugin has no network access of its
// own. It sends requests with admin secrets it never sees:
//   ctx.http.secret({ url: URL_SECRET, path?, method?, query?, json?, headers?,
//                     auth?: { secret, header?, format?: 'bearer'|'plain'|'query', param? } })
//     -> { status, headers, json (null if not JSON), text }
// The admin stores the address (e.g. https://api.example.com/v1) and the API
// key as secrets under Admin -> API / Secrets and shares both with this
// plugin in the App Store. Rules: both names must be in bothub.json
// "services.secrets"; path starts with "/", no ".." or "//"; no
// Authorization, Cookie or Host headers; request JSON <= 64 KB, answer
// <= 1 MB, 10 s timeout. Errors: sdk.http.bad_path, sdk.http.timeout,
// sdk.http.too_big; NotSetUp (below) when a secret has no value yet.
//
// The install creates every secret of "services.secrets" that does not exist
// yet, empty ([NULL]) and shared with this plugin; the App Store shows the
// plugin as "Not set up" until the admin pastes the values. Until then a
// request fails with sdk.secret.not_shared, which get() turns into NotSetUp.

export const URL_SECRET = '__URL_SECRET__';
export const KEY_SECRET = '__KEY_SECRET__';

/** A secret of the plugin has no value yet (empty [NULL], missing or not shared). */
export class NotSetUp extends Error {
  constructor() {
    super(`Not set up yet: an admin pastes the values of ${URL_SECRET} and ${KEY_SECRET} under Admin → API / Secrets.`);
    this.missing = [URL_SECRET, KEY_SECRET];
  }
}

/** GET <address><path>?<query> with the key as "Authorization: Bearer <key>"; returns the SDK answer. */
export async function get(ctx, path, query = {}) {
  try {
    return await ctx.http.secret({ url: URL_SECRET, method: 'GET', path, query, auth: { secret: KEY_SECRET } });
  } catch (err) {
    if (String(err?.message ?? err).includes('sdk.secret.not_shared')) throw new NotSetUp();
    throw err;
  }
}

/** Reads "a.b.0.c" out of a JSON value; undefined when missing. */
export function pick(value, path) {
  if (!path) return value;
  let cur = value;
  for (const part of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Turns "a=1&b=two" into { a: '1', b: 'two' }. */
export function parseQuery(text) {
  return Object.fromEntries(new URLSearchParams(String(text ?? '')));
}
