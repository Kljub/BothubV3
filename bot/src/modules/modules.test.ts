import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from '../core/db.js';
import { Repo } from '../core/repo.js';
import { buildMessage, fill, idIn, idsIn, ModuleContext, passes, reactionOf, sameEmoji } from './context.js';
import { count, type CountState } from './games.js';
import { rolesToRestore } from './members.js';
import { keywordMatch, mediaViolation } from './messages.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function context(): ModuleContext {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'bothub-mod-')), 'bothub.sqlite'));
  const dir = join(root, 'api', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.exec("INSERT INTO bots (id, name) VALUES (1, 'Bot')");
  return new ModuleContext(1, new Repo(db));
}

test('refs are per server, filters all/except/only', () => {
  const refs = [{ id: '1', guild: 'A' }, { id: '2', guild: 'B' }, { id: 3, guild: 'A' }];
  assert.deepEqual(idsIn(refs, 'A'), ['1']);
  assert.equal(idIn({ id: '2', guild: 'B' }, 'A'), null);
  assert.equal(passes('all', [], 'x'), true);
  assert.equal(passes('only', ['a'], ['b', 'a']), true);
  assert.equal(passes('only', [], 'a'), false);
  assert.equal(passes('except', ['a'], 'a'), false);
});

test('messages: placeholders, text and embed', () => {
  assert.equal(fill('Hi {user.mention} {nope}', { 'user.mention': '<@1>' }), 'Hi <@1> {nope}');
  assert.deepEqual(buildMessage({ mode: 'text', content: 'Hi {user}' }, { user: 'Ann' }), { content: 'Hi Ann', allowedMentions: { parse: ['users'] } });
  assert.equal(buildMessage({ mode: 'text', content: '  ' }, {}), null);
  const e = buildMessage({ mode: 'embed', title: 'T {n}', color: '#ff0000', image: 'http://insecure' }, { n: '1' });
  assert.deepEqual(e?.embeds, [{ title: 'T 1', color: 0xff0000 }]);
  assert.equal(buildMessage({ mode: 'embed' }, {}), null);
});

test('emojis', () => {
  assert.equal(reactionOf('<:bh:123>'), 'bh:123');
  assert.equal(reactionOf(' 👍 '), '👍');
  assert.equal(sameEmoji('<a:x:5>', { id: '5', name: 'x' }), true);
  assert.equal(sameEmoji('⭐', { id: null, name: '⭐' }), true);
  assert.equal(sameEmoji('⭐', { id: null, name: '🌟' }), false);
});

test('autoresponder keyword matching', () => {
  assert.equal(keywordMatch('Hello there', ['hello'], 'contains'), true);
  assert.equal(keywordMatch('Hello there', ['hello'], 'equals'), false);
  assert.equal(keywordMatch('  HELLO ', ['hello'], 'equals'), true);
  assert.equal(keywordMatch('say hi', ['hi'], 'ends_with'), true);
  assert.equal(keywordMatch('this is chill', ['hi'], 'word'), false);
  assert.equal(keywordMatch('oh, hi!', ['hi'], 'word'), true);
  assert.equal(keywordMatch('größe ändern', ['ändern'], 'word'), true);
  assert.equal(keywordMatch('a.b', ['.'], 'word'), false);
  assert.equal(keywordMatch('', ['x']), false);
});

test('media channels', () => {
  const img = { name: 'cat.png', contentType: 'image/png', size: 10 };
  const vid = { name: 'clip.mp4', contentType: 'video/mp4', size: 10 };
  const m = (content: string, attachments: { name: string; contentType: string | null; size: number }[] = [img], embeds = 0) => ({ content, attachments, embeds });
  assert.equal(mediaViolation(m('hi', []), {}), 'no_media');
  assert.equal(mediaViolation(m('hi'), {}), null);
  assert.equal(mediaViolation(m('hi'), { allowText: false }), 'text');
  assert.equal(mediaViolation(m('https://x.y/cat.gif', [], 1), { allowText: false }), null);
  assert.equal(mediaViolation(m('', [], 1), { allowEmbeds: false }), 'no_media');
  assert.equal(mediaViolation(m('', [img, img, img]), { maxAttachments: 2 }), 'too_many');
  assert.equal(mediaViolation(m('', [vid]), { mediaType: 'images' }), 'type');
  assert.equal(mediaViolation(m('', [vid]), { mediaType: 'videos' }), null);
  assert.equal(mediaViolation(m('', [{ name: 'a.PDF', contentType: null, size: 1 }]), { mediaType: 'advanced', extensions: ['.pdf'] }), null);
  assert.equal(mediaViolation(m('', [img]), { mediaType: 'advanced', extensions: ['pdf'] }), 'type');
});

test('counting rules', () => {
  const s: CountState = { count: 4, lastUser: 'a', lastAt: 0 };
  assert.deepEqual(count(s, 'hello', 'b', 10_000, {}), { kind: 'ignore' });
  assert.deepEqual(count(s, ' 5 ', 'b', 10_000, {}), { kind: 'ok', state: { count: 5, lastUser: 'b', lastAt: 10_000 }, expected: 6 });
  assert.equal(count(s, '5', 'a', 10_000, {}).kind, 'twice');
  assert.equal(count(s, '5', 'a', 10_000, { allowTwice: true }).kind, 'ok');
  assert.deepEqual(count(s, '7', 'b', 10_000, {}), { kind: 'wrong', state: s, expected: 5 });
  assert.deepEqual(count(s, '7', 'b', 10_000, { resetOnFail: true }), { kind: 'wrong', state: { count: 0, lastUser: null, lastAt: 10_000 }, expected: 1 });
  assert.equal(count({ ...s, lastAt: 8000 }, '5', 'b', 10_000, { cooldown: true }).kind, 'cooldown');
});

test('sticky roles filter', () => {
  assert.deepEqual(rolesToRestore(['1', '2', '3'], 'ignored', ['2']), ['1', '3']);
  assert.deepEqual(rolesToRestore(['1', '2', '3'], 'allowed', ['2', '9']), ['2']);
});

test('module state and settings cache', () => {
  const ctx = context();
  assert.equal(ctx.getState('counting', 'g', 'ch:1'), undefined);
  ctx.setState('counting', 'g', 'ch:1', { count: 3 });
  ctx.setState('counting', 'g', 'ch:1', { count: 4 });
  assert.deepEqual(ctx.getState('counting', 'g', 'ch:1'), { count: 4 });
  ctx.deleteState('counting', 'g', 'ch:1');
  assert.equal(ctx.getState('counting', 'g', 'ch:1'), undefined);

  assert.equal(ctx.enabled('counting'), false, 'never configured');
  ctx.db.prepare("INSERT INTO bot_modules (bot_id, module_key, enabled, config) VALUES (1, 'counting', 1, '{\"mode\":\"webhook\"}')").run();
  assert.equal(ctx.enabled('counting'), false, 'cached');
  ctx.invalidate();
  assert.equal(ctx.enabled('counting'), true);
  assert.deepEqual(ctx.config('counting'), { mode: 'webhook' });
  ctx.db.prepare("UPDATE bot_modules SET enabled = 0 WHERE module_key = 'counting'").run();
  ctx.invalidate();
  assert.equal(ctx.enabled('counting'), false, 'switched off');
});

test('leveling curve', async () => {
  const { xpForLevel, levelFor } = await import('./community.js');
  assert.equal(xpForLevel(0, 100, 50), 0);
  assert.equal(xpForLevel(1, 100, 50), 100);
  assert.equal(xpForLevel(3, 100, 50), 100 + 150 + 200);
  assert.equal(levelFor(99, 100, 50), 0);
  assert.equal(levelFor(100, 100, 50), 1);
  assert.equal(levelFor(449, 100, 50), 2);
  assert.equal(levelFor(450, 100, 50), 3);
  assert.equal(levelFor(1_000_000, 100, 50, 10), 10);
});

test('invite detection and suggestion verdicts', async () => {
  const { usedInvite, autoVerdict } = await import('./community.js');
  assert.equal(usedInvite(new Map([['a', 1], ['b', 2]]), new Map([['a', 1], ['b', 3]])), 'b');
  assert.equal(usedInvite(new Map([['a', 1], ['once', 0]]), new Map([['a', 1]])), 'once');
  assert.equal(usedInvite(new Map([['a', 1], ['b', 1]]), new Map([['a', 2], ['b', 2]])), null);
  assert.equal(autoVerdict(10, 0, 10, 0), 'approved');
  assert.equal(autoVerdict(0, 5, 0, 5), 'rejected');
  assert.equal(autoVerdict(9, 4, 10, 5), null);
  assert.equal(autoVerdict(100, 100, 0, 0), null);
});

test('timers: intervals, questions, age, words, stats', async () => {
  const { intervalMs, nextQuestion, age, statValue } = await import('./timers.js');
  const { keywordFree } = await import('./context.js');
  assert.equal(intervalMs({ days: 1, hours: 2, minutes: 3 }), (1440 + 120 + 3) * 60_000);
  assert.equal(nextQuestion([], [], true), null);
  assert.equal(nextQuestion(['a', 'b'], ['a'], true), 'b');
  assert.equal(nextQuestion(['a', 'b'], ['a', 'b'], true, () => 0), 'a');
  assert.equal(nextQuestion(['a', 'b'], ['a'], false, () => 0), 'a');
  assert.equal(age(2000, { year: 2026 }), '26');
  assert.equal(age(null, { year: 2026 }), '');
  assert.equal(keywordFree('Hello World', ['world']), false);
  assert.equal(keywordFree('Hello', ['world', ' ']), true);
  const members = [{ user: { bot: false }, presence: { status: 'online' } }, { user: { bot: true }, presence: null }, { user: { bot: false }, presence: { status: 'offline' } }];
  const guild = {
    memberCount: 3, premiumSubscriptionCount: 7, premiumTier: 2,
    channels: { cache: { size: 12 } }, roles: { cache: { size: 5 } },
    members: { cache: { filter: (fn: (m: (typeof members)[number]) => boolean) => ({ size: members.filter(fn).length }) } },
  };
  assert.deepEqual(['members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'boost_level'].map((s) => statValue(guild as never, s)), [3, 2, 1, 1, 12, 4, 7, 2]);
});

test('verification codes and transcripts', async () => {
  const { verificationCode, codeMatches, transcript } = await import('./support.js');
  let n = 0;
  const seq = () => (n++ % 10) / 10;
  assert.match(verificationCode('number', seq), /^\d{6}$/);
  assert.match(verificationCode('captcha'), /^[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(codeMatches('AB12C', ' ab 12c '), true);
  assert.equal(codeMatches('AB12C', 'AB12'), false);
  assert.equal(
    transcript([{ at: new Date('2026-09-30T10:00:00Z'), author: 'ann', content: 'hi', attachments: ['https://x/y.png'] }]),
    '[2026-09-30 10:00:00] ann: hi https://x/y.png',
  );
});

test('youtube feed parsing', async () => {
  const { parseFeed, newVideos } = await import('./feeds.js');
  const xml = `<feed><entry><yt:videoId>v2</yt:videoId><title>Second &amp; best</title><author>\n<name>Chan</name></author></entry>
    <entry><yt:videoId>v1</yt:videoId><title><![CDATA[First]]></title><author><name>Chan</name></author></entry></feed>`;
  const videos = parseFeed(xml);
  assert.deepEqual(videos.map((v) => [v.id, v.title, v.author]), [['v2', 'Second & best', 'Chan'], ['v1', 'First', 'Chan']]);
  assert.equal(videos[0]!.url, 'https://www.youtube.com/watch?v=v2');
  assert.deepEqual(newVideos(videos, undefined), []);
  assert.deepEqual(newVideos(videos, 'v2'), []);
  assert.deepEqual(newVideos(videos, 'v1').map((v) => v.id), ['v2']);
  assert.deepEqual(newVideos(videos, 'gone').map((v) => v.id), ['v2']);
});

test('automod rules from settings', async () => {
  const { wantedRules } = await import('./automod.js');
  assert.deepEqual(wantedRules({}, null), []);
  const rules = wantedRules({ words: ['bad*', ' '], invites: true, profanity: true, mentionLimit: 5, spam: true, timeoutSeconds: 60, blockMessage: 'No' }, '1');
  assert.deepEqual(rules.map((r) => r.name), ['BotHub · Words', 'BotHub · Filters', 'BotHub · Mentions', 'BotHub · Spam']);
  assert.deepEqual(rules[0]!.triggerMetadata.keywordFilter, ['bad*']);
  assert.equal((rules[0]!.triggerMetadata.regexPatterns as string[]).length, 1);
  assert.equal(rules[0]!.actions.length, 3, 'block, alert, timeout');
  assert.equal(rules[1]!.actions.length, 2, 'presets: no timeout');
  assert.equal(rules[3]!.actions.length, 2, 'spam: no timeout');
});

test('send budget per channel and bot', async () => {
  const { Bucket, SendLimiter } = await import('./guard.js');
  const b = new Bucket(2, 1000, 0);
  assert.deepEqual([b.take(0), b.take(0), b.take(0), b.take(500), b.take(500)], [true, true, false, true, false]);
  const l = new SendLimiter();
  const t = Date.now();
  const first = Array.from({ length: 6 }, () => l.allow('c1', t));
  assert.deepEqual(first, [true, true, true, true, true, false], '5 per channel');
  const other = Array.from({ length: 30 }, (_, i) => l.allow(`c${i + 2}`, t)).filter(Boolean).length;
  assert.equal(other, 25, '30 per bot in total');
});

test('round 2 helpers: chunks and strict cooldown', async () => {
  const { chunks } = await import('./support.js');
  const { cooldownOf } = await import('../discord/commands.js');
  assert.deepEqual(chunks('abc', 5), ['abc']);
  assert.deepEqual(chunks('abcdefg', 3), ['abc', 'def', 'g']);
  assert.equal(chunks('x'.repeat(9000), 4000).join(''), 'x'.repeat(9000));
  assert.deepEqual([cooldownOf(30), cooldownOf('30'), cooldownOf(Number.NaN), cooldownOf(Infinity), cooldownOf(0), cooldownOf(90_000), cooldownOf(2.5), cooldownOf(undefined)], [30, 10, 10, 10, 10, 10, 10, 10]);
});

test('global secrets are read from the database and decrypted', async () => {
  const { secretValue, mask } = await import('../core/secrets-global.js');
  const { encrypt } = await import('../core/secrets.js');
  const ctx = context();
  const key = Buffer.alloc(32, 7);
  ctx.db.prepare("INSERT INTO secrets (owner_id, key, value_enc) VALUES (1, 'TOKEN', ?)").run(encrypt(key, 'abcd-1234'));
  assert.equal(secretValue(ctx.repo, () => key, 1, 'TOKEN'), 'abcd-1234');
  assert.equal(secretValue(ctx.repo, () => key, 1, 'NONE'), null);
  // A bot uses its owner's secrets only, never another user's.
  ctx.db.prepare("INSERT INTO bots (id, name, owner_id) VALUES (2, 'Other', 5)").run();
  assert.equal(secretValue(ctx.repo, () => key, 2, 'TOKEN'), null);
  assert.equal(mask('x abcd-1234 y', ['abcd-1234']), 'x •••• y');
});

test('automod media filter: GIFs, images and videos', async () => {
  const { mediaKinds, blockedKinds, kindList } = await import('./automod.js');
  const kinds = (content: string, attachments: { name: string; contentType: string | null }[] = [], embeds: { type: string | null; url: string | null; provider: string | null }[] = []) =>
    [...mediaKinds({ content, attachments, embeds })].sort().join(',');
  assert.equal(kinds('', [{ name: 'a.gif', contentType: 'image/gif' }]), 'gif');
  assert.equal(kinds('', [{ name: 'a.png', contentType: 'image/png' }, { name: 'b.mp4', contentType: 'video/mp4' }]), 'image,video');
  assert.equal(kinds('look https://tenor.com/view/cat-dance-123'), 'gif', 'GIF picker link');
  assert.equal(kinds('https://media.giphy.com/media/x/giphy.gif'), 'gif');
  assert.equal(kinds('https://example.com/pic.jpg?width=200'), 'image');
  assert.equal(kinds('https://example.com/clip.webm'), 'video');
  assert.equal(kinds('', [], [{ type: 'gifv', url: 'https://tenor.com/view/x', provider: 'Tenor' }]), 'gif', 'preview of a GIF link');
  assert.equal(kinds('https://youtu.be/abc', [], [{ type: 'video', url: 'https://youtu.be/abc', provider: 'YouTube' }]), '', 'a YouTube link is not a video file');
  assert.equal(kinds('hello https://example.com/page'), '');
  const all = mediaKinds({ content: '', attachments: [{ name: 'a.gif', contentType: 'image/gif' }, { name: 'b.png', contentType: 'image/png' }], embeds: [] });
  assert.deepEqual(blockedKinds({ channels: [] }, all), ['gif'], 'default: GIFs only');
  assert.deepEqual(blockedKinds({ channels: [], gifs: false, images: true }, all), ['image']);
  assert.equal(kindList(['gif', 'image', 'video']), 'GIFs, images and videos');
  assert.equal(kindList(['image']), 'images');
});

test('honeypot: trap channels, exempt members, timeout length', async () => {
  const { trapOf, isExempt, timeoutMs } = await import('./honeypot.js');
  const { PermissionFlagsBits } = await import('discord.js');
  const cfg = {
    traps: [{ _id: 'a', channel: { id: '20', guild: '1' }, action: 'kick' as const }],
    exempt: { allowed_roles: [{ id: '30', guild: '1' }], required_permissions: ['manage_messages'] },
  };
  assert.equal(trapOf(cfg, '1', '20')?._id, 'a');
  assert.equal(trapOf(cfg, '2', '20'), null, 'channel of another server');
  const member = (id: string, roles: string[], perms: bigint[] = []) =>
    ({ id, guild: { id: '1', ownerId: '99' }, roles: { cache: new Map(roles.map((r) => [r, {}])) }, permissions: { has: (b: bigint) => perms.includes(b) } }) as never;
  assert.equal(isExempt(cfg, member('5', []), '20'), false);
  assert.equal(isExempt(cfg, member('5', ['30']), '20'), true, 'exempt role');
  assert.equal(isExempt(cfg, member('5', [], [PermissionFlagsBits.ManageMessages]), '20'), true, 'exempt permission');
  assert.equal(isExempt(cfg, member('99', []), '20'), true, 'server owner');
  assert.equal(isExempt(cfg, member('5', [], [PermissionFlagsBits.Administrator]), '20'), true, 'Administrator');
  assert.equal(isExempt({ traps: [] }, member('5', [], [PermissionFlagsBits.ManageMessages]), '20'), true, 'default: Manage Messages');
  assert.equal(timeoutMs('30m'), 1_800_000);
  assert.equal(timeoutMs('60d'), 28 * 86_400_000, 'Discord allows 28 days at most');
  assert.equal(timeoutMs('junk'), 86_400_000);

  const { warningPayload } = await import('./honeypot.js');
  const json = (p: { components?: readonly unknown[] }) => JSON.stringify((p.components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));
  const p = warningPayload({ channel: null, action: 'kick', description: 'Every message: **{action}** on {server}.' }, { server: 'Home' }, 182);
  assert.match(json(p), /## ⚠️ Do not send messages in this channel!\\nEvery message: \*\*Kick\*\* on Home\./);
  assert.match(json(p), /"label":"Honeypot: 182"/);
  assert.match(json(p), /"disabled":true/);
  assert.doesNotMatch(json(warningPayload({ channel: null, counter: false }, {}, 3)), /Honeypot: 3/, 'counter off');
});

test('giveaways: draw and message', async () => {
  const { drawWinners, giveawayPayload } = await import('./giveaway.js');
  let i = 0;
  const seq = (max: number) => (i++ * 7) % max;
  const w = drawWinners(['a', 'b', 'c', 'a', 'd'], 2, seq);
  assert.equal(w.length, 2);
  assert.equal(new Set(w).size, 2, 'different winners');
  assert.deepEqual(drawWinners(['a'], 3).sort(), ['a'], 'fewer entrants than winners');
  assert.deepEqual(drawWinners([], 1), []);
  const json = (p: { components?: readonly unknown[] }) => JSON.stringify((p.components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));
  const g = { channel: '1', prize: 'Nitro', winners: 2, endsAt: new Date(Date.now() + 3_600_000).toISOString(), ended: false, winnerIds: [], entrants: ['5'], role: '9', host: '7', url: '' };
  const open = json(giveawayPayload(g));
  assert.match(open, /## 🎉 Nitro/);
  assert.match(open, /\*\*Entries:\*\* 1/);
  assert.match(open, /"label":"Enter"/);
  assert.match(open, /<@&9>/);
  const ended = json(giveawayPayload({ ...g, ended: true, winnerIds: ['5'] }));
  assert.match(ended, /Winner:\*\* <@5>/);
  assert.match(ended, /"disabled":true/);
});

test('free games: Epic and Steam answers', async () => {
  const { epicGames, steamGames, freeGamesText } = await import('./freegames.js');
  const now = Date.parse('2026-10-03T12:00:00Z');
  const offer = (pct: number, start: string, end: string) => ({ promotionalOffers: [{ startDate: start, endDate: end, discountSetting: { discountPercentage: pct } }] });
  const raw = { data: { Catalog: { searchStore: { elements: [
    { title: 'Free Now', productSlug: 'free-now', promotions: { promotionalOffers: [offer(0, '2026-10-01T15:00:00Z', '2026-10-08T15:00:00Z')] } },
    { title: 'Half Price', productSlug: 'half', promotions: { promotionalOffers: [offer(50, '2026-10-01T15:00:00Z', '2026-10-08T15:00:00Z')] } },
    { title: 'Next Week', productSlug: 'later', promotions: { promotionalOffers: [], upcomingPromotionalOffers: [offer(0, '2026-10-08T15:00:00Z', '2026-10-15T15:00:00Z')] } },
  ] } } } };
  const epic = epicGames(raw, now);
  assert.deepEqual(epic.map((g) => g.title), ['Free Now']);
  assert.equal(epic[0]!.url, 'https://store.epicgames.com/p/free-now');
  const steam = steamGames([{ title: 'Cool Game (Steam) Key Giveaway', status: 'Active', open_giveaway_url: 'https://x', end_date: '2026-10-10 23:59:00' }, { title: 'Old', status: 'Expired' }]);
  assert.deepEqual(steam.map((g) => g.title), ['Cool Game']);
  assert.match(freeGamesText([...epic, ...steam]), /\*\*\[Free Now\]\(https:\/\/store\.epicgames\.com\/p\/free-now\)\*\* \(Epic Games\) · free until <t:\d+:R>/);
  assert.equal(steamGames({}).length, 0);
});

test('free games: new games and schedule', async () => {
  const { newGames, gameKey, scheduleDue, platformsOf } = await import('./freegames.js');
  const a = { title: 'A', store: 'Epic Games' as const, url: '', until: '2026-10-08T15:00:00.000Z', image: null, description: '' };
  const b = { ...a, title: 'B' };
  assert.deepEqual(newGames([a, b], [gameKey(a)]).map((g) => g.title), ['B']);
  const local = { weekday: 6, hms: '18:05:00', date: '2026-10-03' }; // Saturday
  assert.equal(scheduleDue({ time: '18:00' }, local, undefined), true);
  assert.equal(scheduleDue({ time: '18:00' }, local, '2026-10-03'), false, 'once a day');
  assert.equal(scheduleDue({ time: '19:00' }, local, undefined), false, 'not yet');
  assert.equal(scheduleDue({ time: '18:00', sat: false }, local, undefined), false, 'day not chosen');
  assert.deepEqual(platformsOf({}), { epic: true, steam: true });
  const { listPayload, listSignature } = await import('./freegames.js');
  const many = Array.from({ length: 12 }, (_, i) => ({ ...a, title: `G${i}` }));
  const p = listPayload(many, '7');
  assert.equal(p.embeds.length, 10, 'max. 10 embeds');
  assert.match(p.content, /^<@&7> 🎮 \*\*12 free games right now\*\*/);
  assert.match(p.content, /G10/, 'the rest as lines');
  assert.equal(listSignature([a, b]), listSignature([b, a]), 'order does not matter');
  assert.notEqual(listSignature([a, b]), listSignature([a]));
  assert.deepEqual(platformsOf({ steam: false }), { epic: true, steam: false });
});

test('tickets: panel by name', async () => {
  const { ticketPanelIndex } = await import('./support.js');
  const cfg = { panels: [{ name: 'Support' }, { name: 'Bewerbung' }] as never[] };
  assert.equal(ticketPanelIndex(cfg, ''), 0, 'empty: first panel');
  assert.equal(ticketPanelIndex(cfg, 'bewerbung'), 1);
  assert.equal(ticketPanelIndex(cfg, 'nope'), -1);
  assert.equal(ticketPanelIndex({}, ''), -1, 'no panels');
});

test('social feeds: messages, Reddit, GitHub, YouTube handles', async () => {
  const { messageOf, notification, parseReddit, newPosts, githubEntry, newerId, channelIdOfPage } = await import('./feeds.js');
  assert.deepEqual(messageOf('hi {title}', { mode: 'text', content: 'x' }), { mode: 'text', content: 'hi {title}' });
  assert.deepEqual(messageOf(undefined, { mode: 'text', content: 'x' }), { mode: 'text', content: 'x' });
  const n = notification({ mode: 'embed', title: '{title}', image: '{thumbnail}' }, { title: 'Live', thumbnail: '' }, ['5']);
  assert.equal(n?.content, '<@&5>');
  assert.equal(n?.embeds?.[0] && 'title' in n.embeds[0] ? n.embeds[0].title : '', 'Live');
  assert.deepEqual(n?.allowedMentions, { roles: ['5'] });

  const posts = parseReddit({ data: { children: [
    { data: { name: 't3_b', created_utc: 20, title: 'B', author: 'u', permalink: '/r/x/b', url: 'https://i.redd.it/b.png', link_flair_text: 'News' } },
    { data: { name: 't3_a', created_utc: 10, title: 'A', author: 'u', permalink: '/r/x/a', url: 'https://example.com', over_18: true } },
  ] } });
  assert.deepEqual(posts.map((p) => [p.name, p.url, p.image, p.nsfw]), [['t3_b', 'https://www.reddit.com/r/x/b', 'https://i.redd.it/b.png', false], ['t3_a', 'https://www.reddit.com/r/x/a', '', true]]);
  assert.deepEqual(newPosts(posts, undefined), []);
  assert.deepEqual(newPosts(posts, 10).map((p) => p.name), ['t3_b']);
  assert.deepEqual(newPosts(posts, 0).map((p) => p.name), ['t3_a', 't3_b']);

  const push = githubEntry({ type: 'PushEvent', actor: { login: 'ann' }, repo: { name: 'ann/x' }, payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40), commits: [{ sha: 'c'.repeat(40), message: 'fix: y\nbody' }] } });
  assert.equal(push?.key, 'push');
  assert.equal(push?.vars.branch, 'main');
  assert.equal(push?.vars.commits, '`ccccccc` fix: y');
  assert.equal(githubEntry({ type: 'PullRequestEvent', repo: { name: 'a/b' }, payload: { action: 'closed', pull_request: { number: 3, title: 'T', merged: true } } })?.vars.event, 'pull request merged');
  assert.equal(githubEntry({ type: 'IssuesEvent', repo: { name: 'a/b' }, payload: { action: 'labeled' } }), null);
  assert.equal(newerId('100', '99'), true);
  assert.equal(newerId('99', '100'), false);
  assert.equal(channelIdOfPage('<meta itemprop="identifier" content="UCabcdefghijklmnopqrstuv">'), 'UCabcdefghijklmnopqrstuv');
});

test('twitter link fix', async () => {
  const { fixLinks } = await import('./linkfix.js');
  const r = fixLinks('look https://x.com/ann/status/123?s=20 and <https://twitter.com/b/status/9> https://x.com/home', 'vxtwitter');
  assert.deepEqual(r.links, ['https://vxtwitter.com/ann/status/123']);
  assert.equal(r.text, 'look https://vxtwitter.com/ann/status/123 and <https://twitter.com/b/status/9> https://x.com/home');
});

test('welcome and leave: account age and membership placeholders', async () => {
  const { timeVars } = await import('./context.js');
  const now = Date.parse('2026-10-05T12:00:00Z');
  const v = timeVars({ createdTimestamp: Date.parse('2020-01-01T00:00:00Z') }, Date.parse('2026-07-07T12:00:00Z'), now);
  assert.equal(v['user.created'], `<t:${Date.parse('2020-01-01T00:00:00Z') / 1000}:D>`);
  assert.match(v['user.created.ago']!, /^<t:\d+:R>$/);
  assert.match(v['member.joined']!, /^<t:\d+:D>$/);
  assert.equal(v['member.days'], '90');
  const left = timeVars({ createdTimestamp: now }, null, now);
  assert.equal(left['member.joined'], '?', 'unknown join time of an uncached member');
  assert.equal(left['member.days'], '?');
});

test('game sales: Steam specials, biggest discount first, as a list', async () => {
  const { steamSales, gameSalesText, price } = await import('./freegames.js');
  const item = (id: number, name: string, pct: number, orig: number, fin: number) => ({ id, name, discounted: pct > 0, discount_percent: pct, original_price: orig, final_price: fin, currency: 'EUR', discount_expiration: 1791478800 });
  const sales = steamSales({ specials: { items: [item(1, 'Cyberpunk 2077', 70, 5999, 1799), item(2, 'Full Price', 0, 999, 999)] }, new_releases: { items: [item(3, 'Indie', 90, 1000, 100), item(1, 'Cyberpunk 2077', 70, 5999, 1799)] }, status: 1 });
  assert.deepEqual(sales.map((s) => s.title), ['Indie', 'Cyberpunk 2077'], 'discounted only, no doubles, biggest first');
  assert.equal(price(1799, 'EUR').replace(/\s/g, ' '), '17,99 €');
  const text = gameSalesText(sales);
  assert.match(text, /`-70 %` \*\*\[Cyberpunk 2077\]\(https:\/\/store\.steampowered\.com\/app\/1\/\)\*\* ~~59,99.€~~ \*\*17,99.€\*\* · until <t:1791478800:R>/);
  assert.equal(text.split('\n').length, 2);
});

/** A member stand-in for AFK and Thanks: nickname, roles and the manageable flag. */
function fakeMember(id: string, name: string, opts: { bot?: boolean; manageable?: boolean } = {}) {
  const m = {
    id, nickname: null as string | null, displayName: name, manageable: opts.manageable ?? true,
    user: { id, bot: opts.bot ?? false, username: name },
    guild: { id: 'G' },
    roles: { cache: new Map<string, unknown>(), add: async (ids: string[]) => { for (const r of ids) m.roles.cache.set(r, true); } },
    setNickname: async (nick: string | null) => { m.nickname = nick; m.displayName = nick ?? name; },
  };
  return m;
}

test('afk: set with a prefix, clear restores the name', async () => {
  const { setAfk, clearAfk, afkOf } = await import('./afk.js');
  const ctx = context();
  const member = fakeMember('5', 'Daniel');
  const state = await setAfk(ctx, member as never, '  lunch  ', 1_000_000);
  assert.equal(state.reason, 'lunch');
  assert.equal(member.displayName, '[AFK] Daniel');
  assert.equal(afkOf(ctx, 'G', '5')?.since, 1_000_000);
  await setAfk(ctx, member as never, 'still away');
  assert.equal(member.displayName, '[AFK] Daniel', 'no double prefix');
  assert.ok(await clearAfk(ctx, member as never));
  assert.equal(member.nickname, null, 'old nickname back');
  assert.equal(afkOf(ctx, 'G', '5'), undefined);
  assert.equal(await clearAfk(ctx, member as never), null);
  const owner = fakeMember('6', 'Owner', { manageable: false });
  await setAfk(ctx, owner as never, '');
  assert.equal(owner.displayName, 'Owner', 'members above the bot keep their name');
  assert.equal(afkOf(ctx, 'G', '6')?.reason, 'AFK');
});

test('thanks: cooldown, no self or bot thanks, ranking and reward roles', async () => {
  const { giveThanks, thanksOf, thanksTop, thanksRank, ThanksError } = await import('./thanks.js');
  const ctx = context();
  ctx.db.prepare("INSERT INTO bot_modules (bot_id, module_key, config) VALUES (1, 'thanks', ?)").run(JSON.stringify({ cooldown: 60, rewards: [{ count: 2, role: { id: 'R2', guild: 'G' } }] }));
  const guild = { id: 'G', roles: { cache: new Map([['R2', { id: 'R2', managed: false, position: 1 }]]), everyone: { id: 'G' } }, members: { me: { permissions: { has: () => true }, roles: { highest: { position: 9 } } } } };
  const anna = fakeMember('A', 'Anna');
  const ben = fakeMember('B', 'Ben');
  const t0 = 10_000_000;
  assert.equal(await giveThanks(ctx, guild as never, 'X', anna as never, t0), 1);
  await assert.rejects(giveThanks(ctx, guild as never, 'X', anna as never, t0 + 60_000), (e: unknown) => e instanceof ThanksError && /again/.test((e as Error).message), 'cooldown');
  assert.equal(await giveThanks(ctx, guild as never, 'X', anna as never, t0 + 3_600_001), 2);
  assert.ok(anna.roles.cache.has('R2'), 'reward role at 2 thanks');
  await assert.rejects(giveThanks(ctx, guild as never, 'A', anna as never, t0), /yourself/);
  await assert.rejects(giveThanks(ctx, guild as never, 'X', fakeMember('C', 'Bot', { bot: true }) as never, t0), /Bots/);
  await giveThanks(ctx, guild as never, 'Y', ben as never, t0);
  assert.equal(thanksOf(ctx, 'G', 'A'), 2);
  assert.deepEqual(thanksTop(ctx, 'G', 10).map((r) => [r.userId, r.n]), [['A', 2], ['B', 1]]);
  assert.deepEqual([thanksRank(ctx, 'G', 'A'), thanksRank(ctx, 'G', 'B'), thanksRank(ctx, 'G', 'Z')], [1, 2, 0]);
});

test('radio: stations from Radio Browser, a station is a live track', async () => {
  const { stationsOf, stationTrack, stationLines } = await import('../discord/radio.js');
  const list = stationsOf([
    { stationuuid: 'u1', name: ' 1LIVE ', url: 'http://x/pls', url_resolved: 'https://wdr.example/1live.mp3', country: 'Germany', countrycode: 'de', tags: 'pop,rock,charts,news,talk', codec: 'MP3', bitrate: 128, lastcheckok: 1 },
    { stationuuid: 'u2', name: 'Broken', url: 'https://dead.example', lastcheckok: 0 },
    { stationuuid: 'u3', name: 'No stream', url: 'ftp://x' },
  ]);
  assert.deepEqual(list.map((s) => s.name), ['1LIVE'], 'working stations with a stream only');
  const t = stationTrack(list[0]!, '5');
  assert.equal(t.live, true);
  assert.equal(t.url, 'https://wdr.example/1live.mp3', 'resolved stream URL');
  assert.equal(t.title, '🇩🇪 1LIVE');
  assert.equal(t.author, 'Germany · pop, rock, charts, news', 'four tags at most');
  assert.match(stationLines(list), /1\. 🇩🇪 \*\*1LIVE\*\* · Germany · pop, rock, charts, news \(128 kbps MP3\)/);
});

test('song recognition: ICY titles, ACRCloud signature and answer', async () => {
  const { splitStreamTitle, parseIcyMeta, acrSignature, acrSong } = await import('../discord/recognize.js');
  assert.equal(parseIcyMeta("StreamTitle='Daft Punk - One More Time';StreamUrl='';\0\0"), 'Daft Punk - One More Time');
  assert.deepEqual(splitStreamTitle('  Daft Punk - One More Time '), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(splitStreamTitle('Morning Show'), { artist: '', title: 'Morning Show' });
  assert.equal(splitStreamTitle(''), null);
  assert.equal(splitStreamTitle('Werbung'), null, 'ads are no song');
  // Signature as in ACRCloud's docs: HMAC-SHA1 over the five lines, base64.
  const { createHmac } = await import('node:crypto');
  assert.equal(acrSignature('sec', 'key', '1700000000'), createHmac('sha1', 'sec').update('POST\n/v1/identify\nkey\naudio\n1\n1700000000').digest('base64'));
  const song = acrSong({ status: { code: 0, msg: 'Success' }, metadata: { music: [{ title: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], album: { name: 'After Hours' }, external_metadata: { spotify: { track: { id: '0VjIjW4GlUZAMYd2vXMi3b' } } } }] } });
  assert.deepEqual(song, { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', link: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b', source: 'acrcloud' });
  assert.equal(acrSong({ status: { code: 1001, msg: 'No result' } }), null);
  assert.throws(() => acrSong({ status: { code: 3001, msg: 'Missing/Invalid Access Key' } }), /Invalid Access Key/);
});
