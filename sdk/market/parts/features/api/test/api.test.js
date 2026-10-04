import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, runBlock } from '#sdk-testing';
import plugin from '../index.js';
import { KEY_SECRET, URL_SECRET, pick } from '../services/api.js';

// The fake checks the names against the manifest "secrets", like the bot.
const manifest = { id: '__ID__', secrets: [URL_SECRET, KEY_SECRET] };
const secrets = { [URL_SECRET]: 'https://api.example.test/v1', [KEY_SECRET]: 'test-key-123' };

// A fake API server: the test decides what the address answers.
function ctxWith(server, shared = secrets) {
  return createTestContext({ id: '__ID__', manifest, permissions: ['secrets.use'], secrets: shared, web: server ? { 'api.example.test': server } : {} });
}

test('api_get: path, query, key and a field of the JSON answer', async () => {
  const ctx = ctxWith((req) => ({ status: 200, json: { data: { items: [{ name: `got ${new URL(req.url).pathname}?${req.query.q}` }] } } }));
  const out = await runBlock(plugin, 'api_get', ctx, { config: { path: '/search', query: 'q=cats', field: 'data.items.0.name' } });
  assert.equal(out.results[''], 'got /v1/search?cats');
  assert.equal(out.results['.status'], '200');
  assert.equal(ctx.requests[0].headers.Authorization, 'Bearer test-key-123', 'the bot adds the key');
});

test('api_get: HTTP errors go to port "failed"', async () => {
  const ctx = ctxWith(() => ({ status: 404, json: { error: 'not found' } }));
  const out = await runBlock(plugin, 'api_get', ctx, { config: { path: '/missing' } });
  assert.equal(out.port, 'failed');
  assert.equal(out.results['.status'], '404');
});

test('api_get: secrets not shared, bad paths', async () => {
  const empty = await runBlock(plugin, 'api_get', ctxWith(() => ({ json: {} }), {}), { config: { path: '/' } });
  assert.equal(empty.port, 'not_set_up', 'empty ([NULL]) or not shared: not set up');
  assert.equal(empty.results['.missing'], `${URL_SECRET}, ${KEY_SECRET}`);
  const ctx = ctxWith(() => ({ json: {} }));
  await assert.rejects(runBlock(plugin, 'api_get', ctx, { config: { path: '/../admin' } }), { message: 'sdk.http.bad_path' });
});

test('pick reads nested fields', () => {
  assert.equal(pick({ a: [{ b: 1 }] }, 'a.0.b'), 1);
  assert.equal(pick({ a: 1 }, 'a.b.c'), undefined);
});
