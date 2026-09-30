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
  const { parseFeed, newVideos } = await import('./timers.js');
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
