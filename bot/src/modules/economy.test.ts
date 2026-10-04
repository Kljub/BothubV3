import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawWinner, interest } from './economy.js';

test('interest compounds per day and caps the rate at 5 %', () => {
  assert.equal(interest(1000, 1, 1), 10);
  assert.equal(interest(1000, 1, 2), 20);
  assert.equal(interest(1000, 50, 1), 50);
  assert.equal(interest(0, 1, 3), 0);
  assert.equal(interest(1000, 0, 3), 0);
});

test('drawWinner weights by tickets and skips empty pots', () => {
  assert.equal(drawWinner({}), null);
  assert.equal(drawWinner({ a: 0 }), null);
  assert.equal(drawWinner({ a: 1, b: 3 }, () => 0), 'a');
  assert.equal(drawWinner({ a: 1, b: 3 }, () => 0.3), 'b');
  assert.equal(drawWinner({ a: 1, b: 3 }, () => 0.999), 'b');
});
