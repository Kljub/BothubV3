import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explain, hintKey, type RunErrorTexts } from './explain.js';

const texts = JSON.parse(readFileSync(new URL('../../../shared/run-errors.json', import.meta.url), 'utf8')) as RunErrorTexts;

test('missing permissions: the reason fits the block', () => {
  assert.equal(hintKey('action.add_roles', 'error.run.missing_permissions', {}, texts), 'discord.50013.roles');
  assert.equal(hintKey('action.ban', 'error.run.missing_permissions', {}, texts), 'discord.50013.moderation');
  assert.equal(hintKey('action.send_message', 'error.run.discord', { code: 50013 }, texts), 'discord.50013.message');
  assert.equal(hintKey('action.set_variable', 'error.run.missing_permissions', {}, texts), 'discord.50013');
});

test('Discord form errors: emoji, length, address', () => {
  assert.equal(hintKey('action.send_message', 'error.run.discord', { code: 50035, message: 'Invalid Form Body components[0][0].emoji.name: Invalid emoji' }, texts), 'discord.50035.emoji');
  assert.equal(hintKey('action.send_message', 'error.run.discord', { code: 50035, message: 'content: Must be 2000 or fewer in length.' }, texts), 'discord.50035.length');
  assert.equal(hintKey('x', 'error.run.discord', { code: 99999, message: 'odd' }, texts), 'discord.0');
  assert.equal(hintKey('x', 'error.run.block_failed', { code: 10062 }, texts), 'discord.10062');
});

test('run errors are filled with their params; unknown keys give null', () => {
  const h = explain('action.run_equation', 'error.run.not_a_number', { field: 'amount', value: 'abc' }, texts)!;
  assert.match(h.text, /"amount" got "abc"/);
  assert.ok(h.fix.length > 10);
  assert.equal(explain('x', 'error.run.economy', { message: 'no' }, texts), null);
});

test('every entry has English and German text and fix', () => {
  for (const [k, v] of Object.entries(texts)) {
    if (k.startsWith('$')) continue;
    assert.ok(typeof v === 'object' && v.en?.text && v.en.fix && v.de?.text && v.de.fix, k);
  }
});
