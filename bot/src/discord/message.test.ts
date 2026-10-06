import { test } from 'node:test';
import assert from 'node:assert/strict';

test('button and menu emojis: server emojis go by ID, Unicode by name', async () => {
  const { componentEmoji } = await import('./message.js');
  assert.equal(componentEmoji(''), undefined);
  assert.deepEqual(componentEmoji('👍'), { name: '👍' });
  assert.deepEqual(componentEmoji('<:pepe:123456789012345678>'), { id: '123456789012345678', name: 'pepe' });
  assert.deepEqual(componentEmoji(' <a:dance:123456789012345678> '), { id: '123456789012345678', name: 'dance', animated: true });
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
