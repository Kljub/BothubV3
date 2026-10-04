import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Run, GraphError, definitions, type Engine, type Handler } from './interpreter.js';
import { coreHandlers, loopItems, type CoreDeps } from './handlers-core.js';
import { isPrivateAddress, parseHeaders, request } from './http.js';
import { cronMatches, parseCron } from './cron.js';
import type { Graph, GraphNode, NodeDefinition } from './types.js';

const defs = definitions([
  { type: 'trigger.slash', category: 'trigger' },
  { type: 'utility.error_handler', category: 'utility' },
  { type: 'action.run_loop', category: 'action', config: { properties: { loop: { default: 'count' }, count: { default: 3 } } } },
  { type: 'action.stop_loop', category: 'action' },
  { type: 'action.base64', category: 'action' },
  { type: 'action.api_request', category: 'action' },
  { type: 'action.reset_cooldown', category: 'action' },
  { type: 'condition.comparison', category: 'condition', conditionKind: 'compare' },
  { type: 'condition.state', category: 'condition', compact: true },
  { type: 'test.say', category: 'action' },
  { type: 'test.boom', category: 'action' },
] satisfies NodeDefinition[]);

const limits = { maxNodes: 500, maxEdges: 2000, maxSteps: 1000, maxLoopIterations: 100, maxRuntimeMs: 10_000, maxDiscordCallsPerRun: 50 };

function engine(said: string[], deps: Partial<CoreDeps> = {}): Engine {
  const handlers = coreHandlers({ vars: { get: () => undefined, set: () => undefined, delete: () => undefined }, logError: () => undefined, ...deps });
  handlers.set('test.say', ((node, run) => void said.push(run.str(node, 'text'))) as Handler);
  handlers.set('test.boom', () => {
    throw new GraphError('error.test.boom');
  });
  return { defs, handlers, limits, match: () => false };
}

let seq = 0;
const n = (type: string, config: Record<string, unknown> = {}): GraphNode => ({ id: `${type.split('.')[1]}_${++seq}`, type, typeVersion: 1, config });
const edge = (a: GraphNode, port: string, b: GraphNode) => ({ from: { node: a.id, port }, to: { node: b.id, port: 'in' } });
const graph = (nodes: GraphNode[], edges: Graph['edges']): Graph => ({ schemaVersion: 1, nodes, edges });

// ---------- loops ----------

test('count loop runs Each n times with round results, then Next', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const loop = n('action.run_loop', { count: 3, variable: 'L' });
  const body = n('test.say', { text: '{L}/{L.index}/{L.first}/{L.last}' });
  const after = n('test.say', { text: 'done' });
  const r = await new Run(graph([t, loop, body, after], [edge(t, 'next', loop), edge(loop, 'each', body), edge(loop, 'next', after)]), engine(said)).start();
  assert.equal(r.ok, true);
  assert.deepEqual(said, ['1/0/true/false', '2/1/false/false', '3/2/false/true', 'done']);
});

test('list loop walks JSON arrays, lines and commas', async () => {
  assert.deepEqual(loopItems('["a", 2, {"x":1}]'), ['a', '2', '{"x":1}']);
  assert.deepEqual(loopItems('a\nb\n\nc'), ['a', 'b', 'c']);
  assert.deepEqual(loopItems('a, b,c'), ['a', 'b', 'c']);
  assert.deepEqual(loopItems('  '), []);
  const said: string[] = [];
  const t = n('trigger.slash');
  const loop = n('action.run_loop', { loop: 'list', list: '{names}', variable: 'L' });
  const body = n('test.say', { text: '{L.count}:{L}' });
  await new Run(graph([t, loop, body], [edge(t, 'next', loop), edge(loop, 'each', body)]), engine(said), {}, { names: 'Ann,Bob' }).start();
  assert.deepEqual(said, ['1:Ann', '2:Bob']);
});

test('stop loop leaves the loop and continues at Next', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const loop = n('action.run_loop', { count: 10, variable: 'L' });
  const cond = n('condition.comparison', { source: 'variable', subject: 'L' });
  const st = n('condition.state', { operator: 'eq', value: '3' });
  const stop = n('action.stop_loop');
  const body = n('test.say', { text: '{L}' });
  const after = n('test.say', { text: 'after' });
  const g = graph([t, loop, cond, st, stop, body, after], [
    edge(t, 'next', loop), edge(loop, 'each', body), edge(body, 'next', cond), edge(cond, 'branches', st), edge(st, 'next', stop), edge(loop, 'next', after),
  ]);
  const r = await new Run(g, engine(said)).start();
  assert.equal(r.ok, true);
  assert.deepEqual(said, ['1', '2', '3', 'after']);
});

test('nested loops: stop ends only the inner loop', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const outer = n('action.run_loop', { count: 2, variable: 'O' });
  const inner = n('action.run_loop', { count: 5, variable: 'I' });
  const say = n('test.say', { text: '{O}.{I}' });
  const stop = n('action.stop_loop');
  const g = graph([t, outer, inner, say, stop], [edge(t, 'next', outer), edge(outer, 'each', inner), edge(inner, 'each', say), edge(say, 'next', stop)]);
  await new Run(g, engine(said)).start();
  assert.deepEqual(said, ['1.1', '2.1']);
});

test('failure in a loop body runs the error handler once and ends the run', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const loop = n('action.run_loop', { count: 5 });
  const boom = n('test.boom');
  const after = n('test.say', { text: 'after' });
  const eh = n('utility.error_handler');
  const report = n('test.say', { text: 'handled {error.key}' });
  const g = graph([t, loop, boom, after, eh, report], [edge(t, 'next', loop), edge(loop, 'each', boom), edge(loop, 'next', after), edge(eh, 'next', report)]);
  const r = await new Run(g, engine(said)).start();
  assert.equal(r.ok, false);
  assert.equal(r.errorKey, 'error.test.boom');
  assert.deepEqual(said, ['handled error.test.boom']);
});

test('loop round limit and stop outside a loop', async () => {
  const t = n('trigger.slash');
  const loop = n('action.run_loop', { count: 101 });
  const r = await new Run(graph([t, loop], [edge(t, 'next', loop)]), engine([])).start();
  assert.equal(r.errorKey, 'error.run.too_many_loop_rounds');

  const said: string[] = [];
  const stop = n('action.stop_loop');
  const after = n('test.say', { text: 'still here' });
  const t2 = n('trigger.slash');
  const r2 = await new Run(graph([t2, stop, after], [edge(t2, 'next', stop), edge(stop, 'next', after)]), engine(said)).start();
  assert.equal(r2.ok, true);
  assert.deepEqual(said, ['still here']);
});

// ---------- base64, http, cooldown ----------

test('base64 encode and decode', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const enc = n('action.base64', { input: 'Grüße', variable: 'E' });
  const dec = n('action.base64', { direction: 'decode', input: '{E}', variable: 'D' });
  const say = n('test.say', { text: '{E}|{D}' });
  await new Run(graph([t, enc, dec, say], [edge(t, 'next', enc), edge(enc, 'next', dec), edge(dec, 'next', say)]), engine(said)).start();
  assert.deepEqual(said, [`${Buffer.from('Grüße').toString('base64')}|Grüße`]);
  const bad = n('action.base64', { direction: 'decode', input: 'not base64!' });
  const t2 = n('trigger.slash');
  const r = await new Run(graph([t2, bad], [edge(t2, 'next', bad)]), engine([])).start();
  assert.equal(r.errorKey, 'error.run.not_base64');
});

test('api request stores status, body and JSON paths', async () => {
  const said: string[] = [];
  let seen: unknown[] = [];
  const http = async (...args: unknown[]) => {
    seen = args;
    return { status: 200, body: '{"user":{"name":"Ann"},"tags":["a","b"]}' };
  };
  const t = n('trigger.slash');
  const req = n('action.api_request', { method: 'POST', url: 'https://example.com/{id}', headers: 'X-Key: {key}', body: '{"id":"{id}"}', variable: 'R' });
  const say = n('test.say', { text: '{R.status} {R.json.user.name} {R.json.tags.1}' });
  await new Run(graph([t, req, say], [edge(t, 'next', req), edge(req, 'next', say)]), engine(said, { http: http as never }), {}, { id: '7', key: 'k' }).start();
  assert.deepEqual(said, ['200 Ann b']);
  assert.deepEqual(seen, ['POST', 'https://example.com/7', { 'X-Key': 'k', 'Content-Type': 'application/json' }, '{"id":"7"}']);
});

test('private addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(request('GET', 'http://127.0.0.1:6379/', {}, undefined), (e: GraphError) => e.key === 'error.run.url_not_allowed');
  await assert.rejects(request('GET', 'http://localhost/', {}, undefined), (e: GraphError) => e.key === 'error.run.url_not_allowed');
  await assert.rejects(request('GET', 'file:///etc/passwd', {}, undefined), (e: GraphError) => e.key === 'error.run.bad_url');
  assert.deepEqual(parseHeaders('A: 1\nB: x: y'), { A: '1', B: 'x: y' });
  assert.deepEqual(parseHeaders('{"A": 1}'), { A: '1' });
});

test('reset cooldown builds the scope key of the slash trigger', async () => {
  const calls: string[][] = [];
  const resetCooldown = (c: string, s: string) => void calls.push([c, s]);
  for (const [scope, key] of [['user', 'g:1:u:9'], ['server', 'g:1'], ['global', '']]) {
    const t = n('trigger.slash');
    const rc = n('action.reset_cooldown', { command: '/daily', cooldown_scope: scope, user: '{user.id}' });
    await new Run(graph([t, rc], [edge(t, 'next', rc)]), engine([], { resetCooldown }), {}, { 'server.id': '1', 'user.id': '9' }).start();
    assert.deepEqual(calls.pop(), ['daily', key]);
  }
});

// ---------- cron ----------

test('cron fields, names, steps and day OR weekday', () => {
  const at = (iso: string) => new Date(iso);
  const mon9 = parseCron('0 9 * * mon');
  assert.equal(cronMatches(mon9, at('2026-09-28T09:00:00Z'), 'UTC'), true); // Monday
  assert.equal(cronMatches(mon9, at('2026-09-29T09:00:00Z'), 'UTC'), false);
  assert.equal(cronMatches(parseCron('*/15 * * * *'), at('2026-09-29T10:45:00Z'), 'UTC'), true);
  assert.equal(cronMatches(parseCron('*/15 * * * *'), at('2026-09-29T10:46:00Z'), 'UTC'), false);
  assert.equal(cronMatches(parseCron('0 0 1 * 0'), at('2026-10-01T00:00:00Z'), 'UTC'), true); // 1st, a Thursday
  assert.equal(cronMatches(parseCron('0 0 1 * 7'), at('2026-10-04T00:00:00Z'), 'UTC'), true); // Sunday as 7
  assert.equal(cronMatches(parseCron('30 8 * * *'), at('2026-09-29T06:30:00Z'), 'Europe/Berlin'), true);
  for (const bad of ['', '* * * *', '60 * * * *', '* * * * 8', '5-1 * * * *', '*/0 * * * *']) assert.throws(() => parseCron(bad), bad);
});

test('helper placeholders: time and random', async () => {
  const { helperValue } = await import('./handlers-core.js');
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  const s = now / 1000;
  assert.equal(helperValue('time.now', now), `<t:${s}:f>`);
  assert.equal(helperValue('time.unix', now), String(s));
  assert.equal(helperValue('time.in:2h', now), `<t:${s + 7200}:f>`);
  assert.equal(helperValue('time.in_unix:30m', now), String(s + 1800));
  assert.equal(helperValue('time.in:soon', now), undefined);
  for (let i = 0; i < 20; i++) {
    const n = Number(helperValue('random:3-5'));
    assert.ok(n >= 3 && n <= 5);
  }
  assert.equal(helperValue('random:5-3'), undefined);
  assert.equal(helperValue('nope'), undefined);
});

test('api request with an endpoint: header from the secret, value masked', async () => {
  const said: string[] = [];
  let seen: unknown[] = [];
  const secret = 'sk-top-secret-123';
  const http = async (...args: unknown[]) => {
    seen = args;
    return { status: 200, body: `{"echo":"Bearer ${secret}","ok":true}` };
  };
  const secrets: Record<string, string> = { OPENAI_URL: 'https://api.example.com/v1/', OPENAI_KEY: secret };
  const secretFn = (key: string) => secrets[key] ?? null;
  const t = n('trigger.slash');
  const req = n('action.api_request', { url_secret: 'OPENAI_URL', auth_secret: 'OPENAI_KEY', url: '/models', variable: 'R' });
  const say = n('test.say', { text: '{R.body}|{R.json.echo}' });
  const r = await new Run(graph([t, req, say], [edge(t, 'next', req), edge(req, 'next', say)]), engine(said, { http: http as never, secret: secretFn })).start();
  assert.equal(r.ok, true);
  assert.equal(seen[1], 'https://api.example.com/v1/models');
  assert.deepEqual(seen[2], { Authorization: `Bearer ${secret}` });
  assert.ok(!said[0]!.includes(secret), 'secret masked in results');
  assert.match(said[0]!, /Bearer ••••/);

  const run1 = (config: Record<string, unknown>) => {
    const tt = n('trigger.slash');
    const x = n('action.api_request', config);
    return new Run(graph([tt, x], [edge(tt, 'next', x)]), engine([], { http: http as never, secret: secretFn })).start();
  };
  assert.equal((await run1({ url_secret: 'OPENAI_URL', url: 'https://evil.example/x' })).errorKey, 'error.run.bad_url', 'a path only');
  assert.equal((await run1({ url_secret: 'NOPE' })).errorKey, 'error.run.unknown_secret');
  assert.equal((await run1({ url: 'https://evil.example/x', auth_secret: 'OPENAI_KEY' })).errorKey, 'error.run.secret_needs_url', 'a key never goes to a free address');
  await run1({ url_secret: 'OPENAI_URL', url: 'q', auth_secret: 'OPENAI_KEY', auth_format: 'query', auth_param: 'appid' });
  assert.equal(seen[1], `https://api.example.com/v1/q?appid=${secret}`);
});

test('polls: answers, length, summary', async () => {
  const { pollAnswers, pollHours, pollSummary } = await import('../discord/handlers.js');
  assert.deepEqual(pollAnswers('Yes | No |  | Maybe'), ['Yes', 'No', 'Maybe']);
  assert.deepEqual(pollAnswers('Red\nGreen\r\nBlue'), ['Red', 'Green', 'Blue']);
  assert.equal(pollHours(''), 24);
  assert.equal(pollHours('10m'), 1, 'Discord polls last at least one hour');
  assert.equal(pollHours('3d'), 72);
  assert.equal(pollHours('60d'), 768, 'at most 32 days');
  const s = pollSummary([{ text: 'Yes', votes: 3 }, { text: 'No', votes: 1 }]);
  assert.equal(s.total, 4);
  assert.equal(s.winner, 'Yes');
  assert.match(s.text, /\*\*Yes\*\* — 3 votes \(75 %\)/);
  assert.equal(pollSummary([{ text: 'A', votes: 2 }, { text: 'B', votes: 2 }]).winner, '', 'tie');
  assert.equal(pollSummary([{ text: 'A', votes: 0 }]).winner, '', 'no votes');
});
