import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, parseNumber } from './numbers.js';
import { GraphError } from './interpreter.js';

test('format number: separators and short numbers', () => {
  assert.equal(formatNumber(1249, 'grouped', 'en', null), '1,249');
  assert.equal(formatNumber(1249.5, 'grouped', 'de', null), '1.249,5');
  assert.equal(formatNumber(1249, 'grouped', 'en', 2), '1,249.00');
  assert.equal(formatNumber(999, 'compact', 'en', null), '999');
  assert.equal(formatNumber(1249, 'compact', 'en', null), '1.2K');
  assert.equal(formatNumber(1249, 'compact', 'de', null), '1,2K');
  assert.equal(formatNumber(1000, 'compact', 'en', null), '1K');
  assert.equal(formatNumber(999_960, 'compact', 'en', null), '1M', 'rounding moves to the next unit');
  assert.equal(formatNumber(-2_500_000, 'compact', 'en', null), '-2.5M');
  assert.equal(formatNumber(3_200_000_000, 'compact', 'en', 2), '3.2B');
});

test('format number: ordinal, roman, binary, hex', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map((n) => formatNumber(n, 'ordinal', 'en', null)), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  assert.equal(formatNumber(7, 'ordinal', 'de', null), '7.');
  assert.equal(formatNumber(1249, 'roman', 'en', null), 'MCCXLIX');
  assert.equal(formatNumber(3999, 'roman', 'en', null), 'MMMCMXCIX');
  assert.throws(() => formatNumber(4000, 'roman', 'en', null), (e: unknown) => e instanceof GraphError && e.key === 'error.run.number_out_of_range');
  assert.throws(() => formatNumber(0, 'roman', 'en', null), GraphError);
  assert.equal(formatNumber(1249, 'binary', 'en', null), '10011100001');
  assert.equal(formatNumber(1249, 'hex', 'en', null), '4E1');
  assert.equal(formatNumber(-255, 'hex', 'en', null), '-FF');
});

test('format number: words in English and German', () => {
  assert.equal(formatNumber(0, 'words', 'en', null), 'zero');
  assert.equal(formatNumber(1249, 'words', 'en', null), 'one thousand two hundred forty-nine');
  assert.equal(formatNumber(2_000_015, 'words', 'en', null), 'two million fifteen');
  assert.equal(formatNumber(-3.5, 'words', 'en', null), 'minus three point five');
  assert.equal(formatNumber(1, 'words', 'de', null), 'eins');
  assert.equal(formatNumber(21, 'words', 'de', null), 'einundzwanzig');
  assert.equal(formatNumber(101, 'words', 'de', null), 'einhunderteins');
  assert.equal(formatNumber(1249, 'words', 'de', null), 'eintausendzweihundertneunundvierzig');
  assert.equal(formatNumber(1001, 'words', 'de', null), 'eintausendeins');
  assert.equal(formatNumber(1_000_000, 'words', 'de', null), 'eine Million');
  assert.equal(formatNumber(2_300_000, 'words', 'de', null), 'zwei Millionen dreihunderttausend');
  assert.equal(formatNumber(30, 'words', 'de', null), 'dreißig');
});

test('parse number: plain, grouped and wrong input', () => {
  assert.equal(parseNumber(' 1249 ', 'en'), 1249);
  assert.equal(parseNumber('1,249', 'en'), 1249);
  assert.equal(parseNumber('1.249,5', 'de'), 1249.5);
  assert.equal(parseNumber('12,5', 'de'), 12.5);
  assert.equal(parseNumber('1.5', 'en'), 1.5);
  assert.throws(() => parseNumber('abc', 'en'), (e: unknown) => e instanceof GraphError && e.key === 'error.run.not_a_number');
  assert.throws(() => parseNumber('', 'en'), GraphError);
});
