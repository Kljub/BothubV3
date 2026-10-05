import { test } from 'node:test';
import assert from 'node:assert/strict';

test('button and menu emojis: server emojis go by ID, Unicode by name', async () => {
  const { componentEmoji } = await import('./message.js');
  assert.equal(componentEmoji(''), undefined);
  assert.deepEqual(componentEmoji('👍'), { name: '👍' });
  assert.deepEqual(componentEmoji('<:pepe:123456789012345678>'), { id: '123456789012345678', name: 'pepe' });
  assert.deepEqual(componentEmoji(' <a:dance:123456789012345678> '), { id: '123456789012345678', name: 'dance', animated: true });
});
