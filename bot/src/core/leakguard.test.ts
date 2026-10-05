import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardRest, guardValue, isDiscordApi, redact, redactDeep, redactDiscordAnswer, resetGuard } from './leakguard.js';

// Built at run time so secret scanners do not take the fake token for a real one.
const BOT = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GAbCdE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');

test('leak guard: known values and Discord token shapes are masked', () => {
  resetGuard();
  guardValue('sk-very-secret-key');
  guardValue('short'); // too short: ordinary text stays
  assert.equal(redact('key sk-very-secret-key!'), 'key [redacted]!');
  assert.equal(redact('short text'), 'short text');
  assert.equal(redact(`token ${BOT} end`), 'token [redacted] end', 'a bot token of any bot');
  assert.equal(redact('aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDEyMzQ1Njc4OmFiY2Rl'), '[redacted]', 'an interaction token');
  assert.equal(redact('https://discord.com/api/webhooks/123456789012345678/' + 'x'.repeat(68)), 'https://discord.com/api/webhooks/123456789012345678/[redacted]');
  const obj = { a: 'ok', b: [{ c: 'sk-very-secret-key' }] };
  assert.deepEqual(redactDeep(obj), { a: 'ok', b: [{ c: '[redacted]' }] });
  assert.equal(redactDeep({ a: 'plain' }).a, 'plain');
  guardValue('interaction-token-123', -1); // already expired
  assert.equal(redact('interaction-token-123'), 'interaction-token-123');
});

test('leak guard: Discord answers lose token fields, REST bodies and files are masked', async () => {
  resetGuard();
  assert.ok(isDiscordApi(new URL('https://discord.com/api/v10/users/@me')));
  assert.ok(!isDiscordApi(new URL('https://discord.com/channels/1/2')));
  assert.ok(!isDiscordApi(new URL('https://example.com/api/x')));
  assert.deepEqual(JSON.parse(redactDiscordAnswer('{"id":"1","username":"bot","token":"abc.def","nested":{"access_token":"x"}}')), { id: '1', username: 'bot', token: '[redacted]', nested: { access_token: '[redacted]' } });
  guardValue('sk-very-secret-key');
  const sent: unknown[] = [];
  const rest = { request: async (o: unknown) => void sent.push(o) };
  guardRest(rest);
  await rest.request({ body: { content: `see ${BOT}`, embeds: [{ description: 'sk-very-secret-key' }] }, files: [{ name: 'a.txt', data: Buffer.from('key=sk-very-secret-key') }] });
  const o = sent[0] as { body: { content: string; embeds: { description: string }[] }; files: { data: Buffer }[] };
  assert.equal(o.body.content, 'see [redacted]');
  assert.equal(o.body.embeds[0]!.description, '[redacted]');
  assert.equal(o.files[0]!.data.toString(), 'key=[redacted]');
});
