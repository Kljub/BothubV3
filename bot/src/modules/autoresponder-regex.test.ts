import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regexMatch } from './messages.js';

test('regex responders: groups become placeholders', () => {
  assert.deepEqual(regexMatch('!wiki Discord', ['/^!wiki (\\w+)/i']), { match: '!wiki Discord', 'match.1': 'Discord' });
  assert.deepEqual(regexMatch('order 42', ['nothing', '/order (?<id>\\d+)/']), { match: 'order 42', 'match.1': '42', 'match.id': '42' });
  assert.equal(regexMatch('hello', ['/^bye/']), null);
});
