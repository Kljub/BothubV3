// HTTP for the API Request block. Graphs are written in the dashboard, so a
// request must not reach the instance's own services (Redis, API) or the
// local network: every resolved address is checked before connecting.

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isDiscordApi, redactDiscordAnswer } from '../core/leakguard.js';
import { GraphError } from './interpreter.js';

const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 8000;

export interface HttpResponse {
  status: number;
  body: string;
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/**
 * Checks the address and returns the IP to connect to. The request then uses
 * exactly this IP (no second DNS lookup), so a name cannot first point to a
 * public address and then to the instance's own services (DNS rebinding).
 */
async function publicAddress(url: URL): Promise<{ address: string; family: number }> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new GraphError('error.run.bad_url', { value: url.href });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new GraphError('error.run.http_failed', { message: `cannot resolve ${host}` });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new GraphError('error.run.url_not_allowed', { value: host });
  return addrs[0]!;
}

/** One HTTP exchange to a fixed IP (TLS still checks the host name). */
function send(url: URL, pinned: { address: string; family: number }, method: string, headers: Record<string, string>, body: string | undefined): Promise<{ status: number; location: string | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const pin = ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
      if (opts?.all) cb(null, [pinned]);
      else cb(null, pinned.address, pinned.family);
    }) as never;
    const req = lib.request(url, { method, headers, lookup: pin, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          reject(new GraphError('error.run.http_failed', { message: `response larger than ${MAX_BODY} bytes` }));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => reject(new GraphError('error.run.http_failed', { message: err.message })));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new GraphError('error.run.http_failed', { message: err.message })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** "Name: value" per line (the builder hint), or a JSON object. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(trimmed) as Record<string, unknown>)) out[k] = String(v);
      return out;
    } catch {
      // not JSON: fall through to lines
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Sends one request. Redirects are followed by hand (max 3), so each target
 * passes the address check too.
 */
export async function request(method: string, rawUrl: string, headers: Record<string, string>, body: string | undefined): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GraphError('error.run.bad_url', { value: rawUrl });
  }
  for (let hop = 0; hop <= 3; hop++) {
    const res = await send(url, await publicAddress(url), method, headers, body);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      if (res.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    // Answers of the Discord API (e.g. PATCH /users/@me) lose their token fields.
    return { status: res.status, body: isDiscordApi(url) ? redactDiscordAnswer(res.text) : res.text };
  }
  throw new GraphError('error.run.http_failed', { message: 'too many redirects' });
}
