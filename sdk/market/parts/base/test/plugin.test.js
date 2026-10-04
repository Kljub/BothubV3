// Checks that bothub.json, the layer files, the code and the texts fit
// together (the same checks as "npm run validate"). Keep this test.
// The checker lives in the BotHub repo (sdk/market); its "npm test" passes
// the path in BOTHUB_MARKET_CHECK. A plain "npm test" here skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checker = process.env.BOTHUB_MARKET_CHECK;

test('bothub.json, layers, handlers and texts are consistent', { skip: !checker && 'run "npm test" in Bothub/sdk/market' }, async () => {
  const { check } = await import(pathToFileURL(checker).href);
  const errors = await check(fileURLToPath(new URL('..', import.meta.url)));
  assert.deepEqual(errors, []);
});
