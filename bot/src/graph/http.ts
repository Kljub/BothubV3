// HTTP for the API Request block. Graphs are written in the dashboard, so a
// request must not reach the instance's own services (Redis, API) or the
// local network: every resolved address is checked before connecting.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new GraphError('error.run.bad_url', { value: url.href });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new GraphError('error.run.http_failed', { message: `cannot resolve ${host}` });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new GraphError('error.run.url_not_allowed', { value: host });
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
    await assertPublic(url);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new GraphError('error.run.http_failed', { message: (err as Error).message });
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      if (res.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return { status: res.status, body: await readLimited(res) };
  }
  throw new GraphError('error.run.http_failed', { message: 'too many redirects' });
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new GraphError('error.run.http_failed', { message: `response larger than ${MAX_BODY} bytes` });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
