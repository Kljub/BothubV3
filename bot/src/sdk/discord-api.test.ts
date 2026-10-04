import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComponents, checkedLookup, discordApi, InteractionRegistry, outboundHttp, parsePluginCustomId, pluginCode, pluginCustomId, privateAddress, type DiscordApiDeps, type RawHttp } from './discord-api.js';
import { parseManifest } from './manifest.js';
import { useCatalog } from './catalog.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
useCatalog(join(root, 'shared', 'sdk-permissions.json'));

test('plugin custom_ids: short code, key and data, max. 100 characters', () => {
  const long = 'plugin_' + 'x'.repeat(57);
  const id = pluginCustomId(long, 'hit', 'game:12345');
  assert.ok(id.length <= 100);
  assert.deepEqual(parsePluginCustomId(id), { code: pluginCode(long), key: 'hit', data: 'game:12345' });
  assert.equal(parsePluginCustomId('bh:run:node'), null);
  assert.throws(() => pluginCustomId('plugin_a', 'Bad Key'), /sdk.component.bad_key/);
  assert.throws(() => pluginCustomId('plugin_a', 'k', 'x'.repeat(65)), /sdk.component.bad_data/);
});

test('components: buttons, link and select rows; invalid shapes refused', () => {
  const rows = buildComponents('plugin_a', [
    [{ key: 'hit', label: 'Hit', style: 'success' }, { type: 'link', url: 'https://example.com', label: 'Docs' }],
    [{ type: 'select', key: 'pick', options: [{ label: 'A', value: 'a' }] }],
  ]) as Array<{ components: Array<Record<string, unknown>> }>;
  assert.equal(rows[0]!.components[0]!.style, 3);
  assert.equal(rows[0]!.components[1]!.style, 5);
  assert.equal(rows[1]!.components[0]!.type, 3);
  assert.throws(() => buildComponents('plugin_a', [[{ type: 'link', url: 'http://x.example', label: 'x' }]]), /sdk.component.invalid/);
  assert.throws(() => buildComponents('plugin_a', [[{ type: 'select', key: 'p', options: [{ label: 'a', value: 'a' }] }, { key: 'b', label: 'b' }]]), /sdk.component.invalid/);
  assert.throws(() => buildComponents('plugin_a', [[], [], [], [], [], []]), /sdk.component.invalid/);
});

test('private addresses are recognised (v4, v6, mapped)', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.8',
    '::1', 'fd00::1', 'fe80::1', 'fec0::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', 'not-an-ip',
  ]) assert.ok(privateAddress(ip), ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip);
});

test('http.outbound: only manifest hosts, no private addresses, redirects checked', async () => {
  const hits: string[] = [];
  const raw: RawHttp = async (url, _init, address): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
    hits.push(`${url.hostname}@${address}`);
    if (url.pathname === '/away') return { status: 302, headers: { location: 'https://evil.example/' }, body: Buffer.from('') };
    if (url.pathname === '/inside') return { status: 302, headers: { location: 'https://inner.example/' }, body: Buffer.from('') };
    if (url.pathname === '/img') return { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([137, 80, 78, 71]) };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
  };
  const dns: Record<string, string[]> = { 'graphql.anilist.co': ['104.16.1.1'], 'inner.example': ['10.0.0.5'], 'evil.example': ['1.2.3.4'] };
  const resolve = async (h: string) => dns[h] ?? [];
  const hosts = ['graphql.anilist.co', 'inner.example'];
  const ok = await outboundHttp(hosts, 'POST', 'https://graphql.anilist.co/', { json: { query: '{}' } }, resolve, raw);
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.deepEqual(hits, ['graphql.anilist.co@104.16.1.1']);
  const img = await outboundHttp(hosts, 'GET', 'https://graphql.anilist.co/img', {}, resolve, raw);
  assert.deepEqual([img.text, img.base64], ['', Buffer.from([137, 80, 78, 71]).toString('base64')]);
  await assert.rejects(outboundHttp(hosts, 'GET', 'https://other.example/', {}, resolve, raw), /sdk.http.host_not_allowed/);
  await assert.rejects(outboundHttp(hosts, 'GET', 'http://graphql.anilist.co/', {}, resolve, raw), /sdk.http.bad_url/);
  await assert.rejects(outboundHttp(hosts, 'GET', 'https://inner.example/', {}, resolve, raw), /sdk.http.private_address/);
  await assert.rejects(outboundHttp(hosts, 'GET', 'https://graphql.anilist.co/away', {}, resolve, raw), /sdk.http.host_not_allowed/);
  await assert.rejects(outboundHttp(hosts, 'GET', 'https://graphql.anilist.co/inside', {}, resolve, raw), /sdk.http.private_address/);
  await assert.rejects(outboundHttp(hosts, 'GET', 'https://graphql.anilist.co/', { headers: { Cookie: 'x' } }, resolve, raw), /sdk.http.bad_header/);
});

test('http.outbound: one deadline for the whole call', async () => {
  const slow: RawHttp = () => new Promise(() => undefined);
  const start = Date.now();
  await assert.rejects(outboundHttp(['slow.example'], 'GET', 'https://slow.example/', {}, async () => ['1.2.3.4'], slow, 50), /sdk.http.timeout/);
  assert.ok(Date.now() - start < 2000);
});

test('manifest: services.hosts needs http.outbound and real host names', () => {
  const base = { id: 'plugin_a', name: 'A', version: '1.0.0', sdk: 1, main: 'index.js' };
  assert.deepEqual(parseManifest({ ...base, permissions: ['http.outbound'], hosts: ['graphql.anilist.co'] }).hosts, ['graphql.anilist.co']);
  assert.throws(() => parseManifest({ ...base, permissions: [], hosts: ['graphql.anilist.co'] }), /sdk.manifest.invalid/);
  for (const bad of ['localhost', '*.example.com', '10.0.0.1', 'https://x.example']) {
    assert.throws(() => parseManifest({ ...base, permissions: ['http.outbound'], hosts: [bad] }), /sdk.manifest.invalid/, bad);
  }
});

test('interaction handles are bound to bot and plugin', () => {
  const reg = new InteractionRegistry();
  const fake = { replied: false, deferred: false } as never;
  const h = reg.hold(1, 'plugin_a', fake, false);
  assert.equal(reg.get(1, 'plugin_a', h), fake);
  assert.throws(() => reg.get(1, 'plugin_b', h), /sdk.interaction.unknown/);
  assert.throws(() => reg.get(2, 'plugin_a', h), /sdk.interaction.unknown/);
  reg.dropBot(1);
  assert.throws(() => reg.get(1, 'plugin_a', h), /sdk.interaction.unknown/);
});

test('economy: plugins never take more than a member has', async () => {
  const balances = new Map<string, number>([['200000000000000001:100000000000000001', 50]]);
  const banks = new Map<string, number>([['200000000000000001:100000000000000002', 40]]);
  const guild = { id: '200000000000000001' };
  const deps: DiscordApiDeps = {
    client: () => ({ isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } }) as never,
    render: (m) => m as Record<string, unknown>,
    economy: {
      balance: (g, u) => balances.get(`${g}:${u}`) ?? 0,
      change: (g, u, n, mode) => {
        const v = mode === 'set' ? n : (balances.get(`${g}:${u}`) ?? 0) + n;
        balances.set(`${g}:${u}`, v);
        return v;
      },
      pay: () => false,
      leaderboard: () => [],
      bank: (g, u) => banks.get(`${g}:${u}`) ?? 0,
      bankTake: (g, f, t, n) => {
        if ((banks.get(`${g}:${f}`) ?? 0) < n) return false;
        banks.set(`${g}:${f}`, (banks.get(`${g}:${f}`) ?? 0) - n);
        balances.set(`${g}:${t}`, (balances.get(`${g}:${t}`) ?? 0) + n);
        return true;
      },
    },
  };
  const api = discordApi(1, 'plugin_a', [], deps, new InteractionRegistry());
  const call = (name: string, ...args: unknown[]) => api[name]!({ args });
  assert.equal(await call('economy.remove', guild.id, '100000000000000001', 20), 30);
  assert.throws(() => call('economy.remove', guild.id, '100000000000000001', 31), /sdk.economy.not_enough/);
  assert.throws(() => call('economy.add', guild.id, '100000000000000001', -5), /sdk.economy.bad_amount/);
  assert.throws(() => call('economy.get', '999999999999999999', '100000000000000001'), /sdk.discord.unknown_guild/);
  assert.throws(() => call('economy.transfer', guild.id, '100000000000000001', '100000000000000002', 10), /sdk.economy.not_enough/);
  assert.equal(await call('economy.bank', guild.id, '100000000000000002'), 40);
  await call('economy.bankTransfer', guild.id, '100000000000000002', '100000000000000001', 25);
  assert.deepEqual([banks.get('200000000000000001:100000000000000002'), balances.get('200000000000000001:100000000000000001')], [15, 55]);
  assert.throws(() => call('economy.bankTransfer', guild.id, '100000000000000002', '100000000000000001', 16), /sdk.economy.not_enough/);
});

test('emoji.list / emoji.get: the custom emojis of a server', async () => {
  const emoji = (id: string, name: string, animated: boolean) => ({ id, name, animated, available: true, imageURL: () => `https://cdn.discordapp.com/emojis/${id}.png` });
  const guild = { id: '200000000000000001', emojis: { cache: new Map([['300000000000000002', emoji('300000000000000002', 'wave', true)], ['300000000000000001', emoji('300000000000000001', 'bothub', false)]]) } };
  const deps: DiscordApiDeps = {
    client: () => ({ isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } }) as never,
    render: (m) => m as Record<string, unknown>,
    economy: { balance: () => 0, change: () => 0, pay: () => false, leaderboard: () => [], bank: () => 0, bankTake: () => false },
  };
  const api = discordApi(1, 'plugin_a', [], deps, new InteractionRegistry());
  const call = (name: string, ...args: unknown[]) => api[name]!({ args });
  const list = (await call('emoji.list', guild.id)) as { name: string; mention: string }[];
  assert.deepEqual(list.map((e) => e.name), ['bothub', 'wave']);
  assert.equal(list[1]!.mention, '<a:wave:300000000000000002>');
  assert.equal(((await call('emoji.get', guild.id, '300000000000000001')) as { mention: string }).mention, '<:bothub:300000000000000001>');
  assert.throws(() => call('emoji.get', guild.id, '300000000000000009'), /sdk.discord.unknown_emoji/);
});

test('moderation cases, voice moderation and the audit log', async () => {
  const recorded: unknown[] = [];
  const voice: string[] = [];
  const me = { id: '900000000000000009', roles: { highest: { position: 10 } } };
  const member = (id: string, channelId: string | null) => ({
    id, roles: { highest: { position: 1 } },
    voice: { channelId, setMute: async (on: boolean) => void voice.push(`mute ${id} ${on}`), setDeaf: async (on: boolean) => void voice.push(`deaf ${id} ${on}`),
      disconnect: async () => void voice.push(`disconnect ${id}`), setChannel: async (c: string) => void voice.push(`move ${id} ${c}`) },
  });
  const members = new Map([['100000000000000001', member('100000000000000001', '400000000000000001')], ['100000000000000002', member('100000000000000002', null)]]);
  const guild = {
    id: '200000000000000001', ownerId: '1', members: { me, cache: new Map([[me.id, me]]), fetch: async (id: string) => members.get(id) ?? Promise.reject(new Error('unknown')) },
    channels: { cache: new Map([['400000000000000002', { id: '400000000000000002', type: 2 }], ['400000000000000003', { id: '400000000000000003', type: 0 }]]) },
    fetchAuditLogs: async (opt: { limit: number; type?: number }) => ({ entries: new Map([['1', { id: '1', action: 22, executorId: '9', targetId: '100000000000000001', targetType: 'User', reason: 'spam', changes: [{ key: 'nick', old: 'a', new: { x: 1 } }], createdAt: new Date(0) }]]), opt }),
  };
  const deps: DiscordApiDeps = {
    client: () => ({ isReady: () => true, user: { id: me.id }, guilds: { cache: new Map([[guild.id, guild]]) } }) as never,
    render: (m) => m as Record<string, unknown>,
    economy: { balance: () => 0, change: () => 0, pay: () => false, leaderboard: () => [], bank: () => 0, bankTake: () => false },
    moderation: {
      record: async (_g, c) => { recorded.push(c); return recorded.length; },
      cases: () => [], modCase: (_g, n) => (n === 1 ? { number: 1, guildId: guild.id, userId: '1', moderatorId: null, action: 'warn', reason: '', duration: '', auto: false, createdAt: '' } : undefined),
      addNote: () => 7, notes: () => [],
    },
  };
  const api = discordApi(1, 'plugin_a', [], deps, new InteractionRegistry());
  const call = (name: string, ...args: unknown[]) => api[name]!({ args });

  assert.equal(await call('moderation.warn', guild.id, '100000000000000001', 'Spam', '100000000000000002'), 1);
  assert.equal(await call('moderation.record', guild.id, '100000000000000001', 'timeout', 'Calm down', '1h'), 2);
  assert.deepEqual(recorded[1], { userId: '100000000000000001', moderatorId: null, action: 'timeout', reason: 'Calm down', duration: '1h' });
  await assert.rejects(call('moderation.record', guild.id, '100000000000000001', 'explode') as Promise<unknown>, /sdk.moderation.bad_action/);
  assert.equal((await call('moderation.getCase', guild.id, 1) as { number: number }).number, 1);
  assert.equal(await call('moderation.getCase', guild.id, 5), null);
  assert.equal(await call('moderation.note', guild.id, '100000000000000001', 'Watch out'), 7);
  assert.throws(() => call('moderation.note', guild.id, '100000000000000001', '  '), /sdk.moderation.bad_note/);

  await call('member.voiceMute', guild.id, '100000000000000001', true);
  await call('member.voiceMove', guild.id, '100000000000000001', '400000000000000002');
  await assert.rejects(call('member.voiceMove', guild.id, '100000000000000001', '400000000000000003') as Promise<unknown>, /sdk.discord.bad_channel/);
  await assert.rejects(call('member.voiceDisconnect', guild.id, '100000000000000002') as Promise<unknown>, /sdk.voice.not_in_voice/);
  assert.deepEqual(voice, ['mute 100000000000000001 true', 'move 100000000000000001 400000000000000002']);

  const log = (await call('audit.list', guild.id, { type: 'MemberBanAdd', limit: 500 })) as { action: string; changes: { new: string }[] }[];
  assert.equal(log[0]!.action, 'MemberBanAdd');
  assert.equal(log[0]!.changes[0]!.new, '{"x":1}');
  await assert.rejects(call('audit.list', guild.id, { type: 'Nope' }) as Promise<unknown>, /sdk.audit.bad_type/);
});

test('https lookup answers in both forms Node uses (single and { all: true })', async () => {
  const look = checkedLookup('104.26.0.1');
  const single = await new Promise((ok) => look('x', {}, (_e, a, f) => ok([a, f])));
  assert.deepEqual(single, ['104.26.0.1', 4]);
  const all = await new Promise((ok) => look('x', { all: true }, (_e, a) => ok(a)));
  assert.deepEqual(all, [{ address: '104.26.0.1', family: 4 }]);
  // The real request path: node:https with this lookup reaches the socket (no "Invalid IP address").
  const { request } = await import('node:https');
  const err = await new Promise<Error>((ok) => {
    const req = request({ host: 'example.invalid', path: '/', lookup: checkedLookup('127.0.0.1') as never, timeout: 2000 }, () => ok(new Error('answered')));
    req.on('error', ok);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
  assert.doesNotMatch(err.message, /Invalid IP address/);
});

test('interaction.reply: a command set to "only me" answers ephemeral', async () => {
  const reg = new InteractionRegistry();
  const sent: unknown[] = [];
  const fake = { replied: false, deferred: false, reply: async (p: unknown) => void sent.push(p) } as never;
  const api = discordApi(1, 'plugin_a', [], { client: () => undefined, render: (m) => m as Record<string, unknown>, economy: { balance: () => 0, change: () => 0, pay: () => false, leaderboard: () => [], bank: () => 0, bankTake: () => false } }, reg);
  await api['interaction.reply']!({ args: [reg.hold(1, 'plugin_a', fake, false, true), 'hi'] });
  await api['interaction.reply']!({ args: [reg.hold(1, 'plugin_a', fake, false), 'hi'] });
  assert.deepEqual(sent.map((p) => (p as { flags: number }).flags), [64, 0]);
});
