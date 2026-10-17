import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, getPath, listOf, parseObject, removePath, roundTo, setPath, typedValue, valueType } from './values.js';
import { compare } from './compare.js';
import { dateParts, formatDate, isoWeek, parseDateTime, signedDuration, timeAgo } from './dates.js';
import { Run, definitions, type Engine } from './interpreter.js';
import { valueHandlers } from './handlers-values.js';
import { voiceMatch } from '../discord/handlers-server.js';
import type { GraphNode } from './types.js';

test('value types and the value checks of If / Else', () => {
  assert.equal(valueType(''), 'empty');
  assert.equal(valueType(' 12.5 '), 'number');
  assert.equal(valueType('true'), 'boolean');
  assert.equal(valueType('[1,"a"]'), 'list');
  assert.equal(valueType('{"a":1}'), 'object');
  assert.equal(valueType('{a'), 'text');
  assert.equal(compare('', 'empty', ''), true);
  assert.equal(compare('x', 'exists', ''), true);
  assert.equal(compare('5', 'is_number', ''), true);
  assert.equal(compare('[]', 'is_list', ''), true);
  assert.equal(compare('hi', 'is_object', ''), false);
});

test('objects: lines or JSON, paths, add and remove', () => {
  const o = parseObject('name: Kljub\ncoins = 10\nstats.level: 3\nvip: true');
  assert.deepEqual(o, { name: 'Kljub', coins: 10, stats: { level: 3 }, vip: true });
  assert.deepEqual(parseObject('{"a":[1,{"b":2}]}'), { a: [1, { b: 2 }] });
  assert.equal(getPath(parseObject('{"a":[1,{"b":2}]}'), 'a.1.b'), 2);
  setPath(o, 'stats.xp', typedValue('50', 'auto'));
  assert.equal(getPath(o, 'stats.xp'), 50);
  assert.equal(removePath(o, 'stats.level'), true);
  assert.equal(removePath(o, 'nope'), false);
  assert.deepEqual(o.stats, { xp: 50 });
  assert.throws(() => parseObject('[1,2]', false), /bad_json/);
  assert.throws(() => setPath({}, '__proto__.x', 1), /bad_json/);
  assert.deepEqual(listOf('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(listOf('["x",2]'), ['x', '2']);
});

test('maths expressions', () => {
  assert.equal(calculate('(2 + 3) * 4'), 20);
  assert.equal(calculate('2 ^ 3 ^ 2'), 512);
  assert.equal(calculate('-2 ^ 2'), -4);
  assert.equal(calculate('max(1, 7, 3) + round(2.5)'), 10);
  assert.equal(calculate('10 % 4'), 2);
  assert.equal(roundTo(calculate('10 / 3'), 2), '3.33');
  assert.equal(roundTo(0.1 + 0.2, null), '0.3');
  assert.throws(() => calculate('1 / 0'), /division_by_zero/);
  assert.throws(() => calculate('2 +'), /bad_expression/);
  assert.throws(() => calculate('process.exit()'), /bad_expression/);
});

test('dates: parse, parts, patterns, time ago', () => {
  const ms = parseDateTime('2026-12-24 18:00', 'Europe/Berlin');
  assert.equal(ms, Date.UTC(2026, 11, 24, 17, 0));
  assert.equal(parseDateTime('1800000000000'), 1_800_000_000_000);
  assert.equal(parseDateTime('2h ago', '', 10_000_000), 10_000_000 - 7_200_000);
  assert.equal(signedDuration('-1d'), -86_400_000);
  const p = dateParts(ms, 'Europe/Berlin');
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.weekday], [2026, 12, 24, 18, 4]);
  assert.equal(isoWeek(p), 52);
  assert.equal(formatDate(ms, 'custom', 'DDDD, DD.MM.YYYY [um] HH:mm', 'Europe/Berlin', 'de'), 'Donnerstag, 24.12.2026 um 18:00');
  assert.equal(formatDate(ms, 'relative', '', '', 'en'), `<t:${ms / 1000}:R>`);
  assert.equal(timeAgo(0, 3 * 3_600_000, 'en'), '3 hours ago');
  assert.equal(timeAgo(2 * 86_400_000, 0, 'de'), 'in 2 Tagen');
  assert.equal(timeAgo(0, 60_000, 'de'), 'vor 1 Minute');
});

test('voice member check values', () => {
  const members = [{ id: '111111111111111111', bot: false }, { id: '222222222222222222', bot: true }];
  assert.equal(voiceMatch(members, ''), true);
  assert.equal(voiceMatch([], 'any'), false);
  assert.equal(voiceMatch(members, 'bots'), true);
  assert.equal(voiceMatch([members[1]!], 'humans'), false);
  assert.equal(voiceMatch(members, '>=1'), true);
  assert.equal(voiceMatch(members, '2'), false);
  assert.equal(voiceMatch(members, '<@111111111111111111>'), true);
});

test('variable blocks: control a list, read it for another member', async () => {
  const store = new Map<string, string>();
  const deps = {
    vars: {
      get: (s: string, id: string, n: string) => store.get(`${s}|${id}|${n}`),
      set: (s: string, id: string, n: string, v: string) => void store.set(`${s}|${id}|${n}`, v),
      delete: (s: string, id: string, n: string) => void store.delete(`${s}|${id}|${n}`),
    },
    logError: () => undefined,
  };
  const handlers = new Map(valueHandlers(deps));
  const engine: Engine = { defs: definitions([]), handlers, limits: { maxNodes: 50, maxEdges: 50, maxSteps: 50, maxLoopIterations: 5, maxRuntimeMs: 1000, maxDiscordCallsPerRun: 5 }, match: async () => false };
  const run = new Run({ schemaVersion: 1, nodes: [], edges: [] }, engine, {}, { 'server.id': 'g', 'user.id': '1' });
  const node = (type: string, config: Record<string, unknown>): GraphNode => ({ id: type, type, typeVersion: 1, config });
  const go = (n: GraphNode) => handlers.get(n.type)!(n, run);
  await go(node('action.control_variable', { var_name: 'tags', scope: 'user', list_operation: 'list_add', value: 'a' }));
  await go(node('action.control_variable', { var_name: 'tags', scope: 'user', list_operation: 'list_add_unique', value: 'a' }));
  await go(node('action.control_variable', { var_name: 'tags', scope: 'user', list_operation: 'list_add', value: 'b', variable: 'T' }));
  assert.equal(store.get('user|g:1|tags'), '["a","b"]');
  assert.equal(run.vars.get('T.count'), '2');
  store.set('user|g:222222222222222222|tags', '["z"]');
  await go(node('action.get_variable', { var_name: 'tags', scope: 'user', target_user: '<@222222222222222222>', variable: 'G' }));
  assert.equal(run.vars.get('G'), '["z"]');
  assert.equal(run.vars.get('G.0'), 'z');
  await go(node('action.create_object', { properties: 'a: 1\nb.c: x', variable: 'O' }));
  assert.equal(run.vars.get('O'), '{"a":1,"b":{"c":"x"}}');
  assert.equal(run.vars.get('O.b.c'), 'x');
});

test('user variables: banner, account age and member since; banners loaded only when a graph uses them', async () => {
  const { userVars, bannerPrefixes, fillBanners } = await import('../discord/vars.js');
  const { cardSlug } = await import('../discord/handlers.js');
  const day = 86_400_000;
  const user = { id: '1', username: 'kljub', createdTimestamp: 10 * day, displayAvatarURL: () => 'a.png', bannerURL: () => null } as never;
  const member = { displayName: 'K', joinedTimestamp: 15 * day, displayAvatarURL: () => 'm.png', bannerURL: () => null, voice: {} } as never;
  const v = userVars(user, member, 'user', 20 * day);
  assert.deepEqual([v['user.created'], v['user.account_age'], v['user.account_days'], v['user.member_since'], v['user.member_days'], v['user.banner']], ['<t:864000:D>', '<t:864000:R>', '10', '<t:1296000:R>', '5', '']);
  const graph = { nodes: [{ config: { message: { embeds: [{ image_url: '{user.banner}', thumbnail_url: '{target.banner}' }] } } }] };
  assert.deepEqual(bannerPrefixes(graph), ['user', 'target']);
  const vars: Record<string, string> = { 'user.id': '1', 'user.banner': '' };
  const client = { users: { fetch: async (id: string) => ({ bannerURL: () => (id === '1' ? 'https://cdn/banner.png' : null) }) } } as never;
  await fillBanners(client, graph, vars);
  assert.equal(vars['user.banner'], 'https://cdn/banner.png');
  assert.equal(vars['target.banner'], '', 'no user: empty, never the placeholder');
  assert.equal(cardSlug(' Welcome Card #2 '), 'Welcome_Card_2');
});
