import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captchaCode, renderCaptcha } from './anticaptcha.js';

test('captcha: 5 characters without look-alikes, drawn as a PNG', async () => {
  for (let i = 0; i < 50; i++) assert.match(captchaCode(), /^[A-HJ-NP-Z2-9]{5}$/);
  let n = 0;
  assert.equal(captchaCode(() => (n++ % 10) / 10), 'ADGKN');
  const png = await renderCaptcha('AB3CD');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.length > 2000, 'letters, lines and dots');
});
