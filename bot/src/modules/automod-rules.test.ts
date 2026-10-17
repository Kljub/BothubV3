import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firedTriggers, memberConditions, ruleRegex, type RuleInput } from './automod-rules.js';

const msg = (content: string, over: Partial<RuleInput> = {}): RuleInput => ({ content, attachments: 0, mentions: 0, sameBefore: [], ...over });

test('words: whole words, * for parts', () => {
  assert.deepEqual(firedTriggers({ triggers: ['words'], words: ['spam'] }, msg('no spam here')), ['words']);
  assert.deepEqual(firedTriggers({ triggers: ['words'], words: ['spam'] }, msg('spammer')), []);
  assert.deepEqual(firedTriggers({ triggers: ['words'], words: ['spam*'] }, msg('Spammer')), ['words']);
});

test('regex with and without slashes; invalid patterns never match', () => {
  assert.deepEqual(firedTriggers({ triggers: ['regex'], pattern: '/fre+ nitro/i' }, msg('FREEE NITRO')), ['regex']);
  assert.deepEqual(firedTriggers({ triggers: ['regex'], pattern: 'free nitro' }, msg('Free Nitro')), ['regex']);
  assert.equal(ruleRegex('(('), null);
});

test('links except allowed domains and their subdomains', () => {
  const rule = { triggers: ['links'], allowedDomains: ['youtube.com'] };
  assert.deepEqual(firedTriggers(rule, msg('https://www.youtube.com/watch?v=1 and https://m.youtube.com/x')), []);
  assert.deepEqual(firedTriggers(rule, msg('see https://evil.example/x')), ['links']);
  assert.deepEqual(firedTriggers(rule, msg('https://notyoutube.com')), ['links']);
});

test('counts: caps percent, emojis, mentions, attachments, lines, repeats', () => {
  assert.deepEqual(firedTriggers({ triggers: ['caps'], threshold: 70 }, msg('THIS IS VERY LOUD TEXT')), ['caps']);
  assert.deepEqual(firedTriggers({ triggers: ['caps'], threshold: 70 }, msg('OK')), []);
  assert.deepEqual(firedTriggers({ triggers: ['emojis'], threshold: 3 }, msg('😀😀 <:x:123456789012345678>')), ['emojis']);
  assert.deepEqual(firedTriggers({ triggers: ['mentions', 'attachments'], threshold: 2 }, msg('', { mentions: 2, attachments: 1 })), ['mentions']);
  assert.deepEqual(firedTriggers({ triggers: ['newlines'], threshold: 3 }, msg('a\nb\nc\nd')), ['newlines']);
  assert.deepEqual(firedTriggers({ triggers: ['repeat'], threshold: 3, repeatSeconds: 30 }, msg('hi', { sameBefore: [5, 20] })), ['repeat']);
  assert.deepEqual(firedTriggers({ triggers: ['repeat'], threshold: 3, repeatSeconds: 30 }, msg('hi', { sameBefore: [5, 40] })), []);
});

test('member conditions: account and membership age', () => {
  assert.equal(memberConditions({ maxAccountDays: 7 }, 3, 100), true);
  assert.equal(memberConditions({ maxAccountDays: 7 }, 30, 100), false);
  assert.equal(memberConditions({ maxMemberDays: 1 }, 300, 0.5), true);
  assert.equal(memberConditions({}, 1, 1), true);
});

test('nested quantifiers are refused (they can hang the bot)', () => {
  assert.equal(ruleRegex('(a+)+$'), null);
  assert.equal(ruleRegex('/(\\w*)*x/'), null);
  assert.notEqual(ruleRegex('/^!wiki (\\w+)/i'), null);
});
