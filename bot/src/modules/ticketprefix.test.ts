import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefixedName } from './support.js';

test('ticket prefix: cleaned and put in front of the base name; empty removes it', () => {
  assert.equal(prefixedName('ticket-12', 'assigned'), 'assigned-ticket-12');
  assert.equal(prefixedName('ticket-12', ' Waiting On User! '), 'waiting-on-user-ticket-12');
  assert.equal(prefixedName('ticket-12', ''), 'ticket-12');
  assert.equal(prefixedName('ticket-12', '---'), 'ticket-12');
});
