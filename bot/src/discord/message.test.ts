import { test } from 'node:test';
import assert from 'node:assert/strict';

test('button and menu emojis: server emojis go by ID, Unicode by name', async () => {
  const { componentEmoji } = await import('./message.js');
  assert.equal(componentEmoji(''), undefined);
  assert.deepEqual(componentEmoji('👍'), { name: '👍' });
  assert.deepEqual(componentEmoji('<:pepe:123456789012345678>'), { id: '123456789012345678', name: 'pepe' });
  assert.deepEqual(componentEmoji(' <a:dance:123456789012345678> '), { id: '123456789012345678', name: 'dance', animated: true });
  assert.deepEqual(componentEmoji('pepe:123456789012345678'), { id: '123456789012345678', name: 'pepe' });
  assert.deepEqual(componentEmoji('1️⃣'), { name: '1️⃣' });
  assert.deepEqual(componentEmoji('🇩🇪'), { name: '🇩🇪' });
  // Text Discord cannot read would make it refuse the whole message.
  assert.equal(componentEmoji(':smile:'), undefined);
  assert.equal(componentEmoji('{emoji}'), undefined);
});

test('select menus: duplicate and padded option values, empty values, min/max kept in range', async () => {
  const { buildMessage } = await import('./message.js');
  const { Run } = await import('../graph/interpreter.js');
  const node = (id: string, type: string, config: Record<string, unknown> = {}, x = 0) => ({ id, type, typeVersion: 1, config, position: { x, y: 0 } });
  const msg = node('msg', 'action.send_message', { message: { content: 'pick' } });
  const menu = node('menu', 'component.select_menu', { min_values: 5, max_values: 9 });
  const q = node('q', 'condition.option');
  const a = node('a', 'condition.state', { value: ' Red ' }, 1);
  const b = node('b', 'condition.state', { value: 'Red' }, 2);
  const c = node('c', 'condition.state', { value: '' }, 3);
  const e = (f: string, fp: string, t: string, tp = 'in') => ({ from: { node: f, port: fp }, to: { node: t, port: tp } });
  const graph = { schemaVersion: 1, nodes: [msg, menu, q, a, b, c], edges: [e('msg', 'components', 'menu'), e('menu', 'next', 'q'), e('q', 'branches', 'a'), e('q', 'branches', 'b'), e('q', 'branches', 'c')] };
  const run = new Run(graph as never, { defs: new Map(), handlers: new Map(), limits: { maxNodes: 1, maxEdges: 1, maxSteps: 10, maxLoopIterations: 1, maxRuntimeMs: 1000, maxDiscordCallsPerRun: 1 }, match: () => false });
  const out = buildMessage(run, msg as never, (n) => `bh:x:${n.id}`) as { components: { components: { options: { value: string }[]; min_values: number; max_values: number }[] }[] };
  const sel = out.components[0]!.components[0]!;
  assert.deepEqual(sel.options.map((o) => o.value), ['Red', 'c']);
  assert.deepEqual([sel.min_values, sel.max_values], [2, 2]);
  assert.equal(run.optionValue(a as never), 'Red');
});

test('twitch lookup: profile, affiliate and subs, followers only with a user token, named variables', async () => {
  const { lookupTwitch, lookupResults, twitchVars } = await import('./twitch-lookup.js');
  const calls: string[] = [];
  const get = async (url: string, headers: Record<string, string>) => {
    calls.push(`${url} ${headers.Authorization}`);
    if (url.includes('/users?')) return url.includes('nobody') ? { status: 200, body: { data: [] } } : { status: 200, body: { data: [{ id: '7', login: 'kljub', display_name: 'Kljub', broadcaster_type: 'affiliate', profile_image_url: 'https://x/p.png', created_at: '2020-01-02T00:00:00Z' }] } };
    if (url.includes('/channels?')) return { status: 200, body: { data: [{ broadcaster_language: 'en', game_name: 'Chess', title: 't' }] } };
    if (url.includes('/streams?')) return { status: 200, body: { data: [] } };
    if (url.includes('/videos?')) return { status: 200, body: { data: [{ title: 'Last VOD', url: 'https://twitch.tv/videos/1', language: 'de', created_at: '2026-10-01T18:00:00Z' }] } };
    if (url.includes('/channels/followers')) return { status: 200, body: { total: 1234 } };
    return null;
  };
  assert.equal(await lookupTwitch('nobody', { clientId: 'c', appToken: 'a', userToken: null }, get), null);
  const p = (await lookupTwitch('kljub', { clientId: 'c', appToken: 'a', userToken: 'u' }, get))!;
  assert.equal(p.followers, 1234);
  assert.ok(calls.some((c) => c.includes('/channels/followers') && c.endsWith('Bearer u')), 'followers with the user token');
  const r = lookupResults(p);
  assert.deepEqual([r['.affiliate'], r['.subs'], r['.partner'], r['.language'], r['.followers']], ['✅', '✅', '❌', 'Deutsch', '1,234']);
  assert.match(String(r['.last_stream']), /^<t:\d+:R>$/);
  const noUser = (await lookupTwitch('kljub', { clientId: 'c', appToken: 'a', userToken: null }, get))!;
  assert.equal(lookupResults(noUser)['.followers'], '—');
  const v = twitchVars(p, { bits: '500' });
  assert.deepEqual([v.twitch_name, v.twitch_link, v.twitch_is_affiliate, v.twitch_bits, v.twitch_sub], ['Kljub', 'https://twitch.tv/kljub', '✅', '500', '✅']);
});

test('extra blocks: dates with time zones, pages, component edits', async () => {
  const { parseDateTime, splitPages, nextPage, editComponents, hexColor } = await import('./handlers-extra.js');
  assert.equal(parseDateTime('2026-12-24 18:00', 'Europe/Berlin'), Date.UTC(2026, 11, 24, 17, 0));
  assert.equal(parseDateTime('24.07.2026 18:00', 'Europe/Berlin'), Date.UTC(2026, 6, 24, 16, 0));
  assert.equal(parseDateTime('2026-12-24 18:00'), Date.UTC(2026, 11, 24, 18, 0));
  assert.equal(parseDateTime('<t:1800000000:R>'), 1_800_000_000_000);
  assert.equal(parseDateTime('in 2h', '', 1000), 1000 + 7_200_000);
  assert.throws(() => parseDateTime('31.02.2026'), /bad_date/);
  assert.deepEqual(splitPages('one\n---\ntwo\n-----\nthree'), ['one', 'two', 'three']);
  assert.deepEqual([nextPage('next', 2, 3, 1), nextPage('previous', 0, 3, 1), nextPage('last', 0, 3, 1), nextPage('page', 0, 3, 9)], [2, 0, 2, 2]);
  const rows = [{ type: 1, components: [{ type: 2, custom_id: 'bh:abc:btn_1', label: 'Go' }, { type: 2, custom_id: 'bh:abc:btn_2', label: 'Stop' }] }];
  assert.equal(editComponents(rows, 'btn_2', { label: 'Done', disabled: true }), 1);
  assert.deepEqual(rows[0]!.components[1], { type: 2, custom_id: 'bh:abc:btn_2', label: 'Done', disabled: true });
  assert.equal(editComponents(rows, '', { disabled: true }), 2);
  assert.equal(editComponents(rows, 'nope', { disabled: true }), 0);
  assert.equal(hexColor('#5865F2'), 0x5865f2);
  assert.equal(hexColor(''), undefined);
  assert.throws(() => hexColor('red'), /bad_color/);
});

test('send form: labelled modal fields, select options cleaned, answers as text', async () => {
  const { modalOf, formValue } = await import('./handlers-extra.js');
  const m = modalOf({ render: (s: string) => s.replace('{x}', 'X') }, 'bhf:1', 'Apply {x}', [
    { type: 'text', variable: 'name', label: 'Name', required: true, style: 'paragraph' },
    { type: 'select', variable: 'team', label: 'Team', max_values: 5, options: [{ label: 'Red', value: ' red ' }, { label: 'Red 2', value: 'red' }, { label: 'Blue', value: 'blue' }] },
    { type: 'user', variable: 'friend', label: 'Friend' },
  ]) as { title: string; components: { type: number; label: string; component: Record<string, any> }[] };
  assert.equal(m.title, 'Apply X');
  assert.deepEqual(m.components.map((c) => [c.type, c.component.type, c.component.custom_id]), [[18, 4, 'f0'], [18, 3, 'f1'], [18, 5, 'f2']]);
  assert.equal(m.components[0]!.component.style, 2);
  assert.deepEqual(m.components[1]!.component.options.map((o: { value: string }) => o.value), ['red', 'blue']);
  assert.equal(m.components[1]!.component.max_values, 2);
  assert.equal(formValue({ value: 'hi' }), 'hi');
  assert.equal(formValue({ values: ['1', '2'] }), '1, 2');
  assert.equal(formValue(undefined), '');
});
