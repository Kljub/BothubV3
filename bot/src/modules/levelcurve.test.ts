import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formulaProblem, levelFor, parseFormula, evaluate, xpForLevel } from './levelcurve.js';
import { rewardPlan } from './community.js';

test('formula: precedence, power to the right, functions', () => {
  const v = (src: string, l: number) => evaluate(parseFormula(src), l);
  assert.equal(v('5 * level ^ 2 + 50 * level', 2), 120);
  assert.equal(v('2 ^ 3 ^ 2', 0), 512);
  assert.equal(v('floor(sqrt(L) * 10) + max(1, 2, 3)', 4), 23);
  assert.equal(v('-(level - 10)', 3), 7);
  assert.throws(() => parseFormula('level +'), /unexpected end/);
  assert.throws(() => parseFormula('process.exit()'), /unknown name/);
  assert.throws(() => parseFormula('pow(2)'), /wrong number/);
});

test('custom curve; broken or flat formulas fall back or stop', () => {
  const custom = { curve: 'custom', curveFormula: '100 * level ^ 2' };
  assert.equal(xpForLevel(3, custom), 900);
  assert.equal(levelFor(899, custom), 2);
  assert.equal(levelFor(900, custom), 3);
  assert.equal(xpForLevel(2, { curve: 'custom', curveFormula: 'level +' }), 250); // linear default
  assert.equal(levelFor(1_000_000, { curve: 'custom', curveFormula: '500' }), 1); // does not rise: no endless levels
  assert.equal(formulaProblem('500'), 'the XP must rise with every level (level 2 gives 500)');
  assert.equal(formulaProblem('50 * level ^ 1.5'), null);
});

test('rewards: stacking, highest only, once', () => {
  const r = [{ level: 1, role: 'a' }, { level: 5, role: 'b' }, { level: 10, role: 'c', once: true }];
  assert.deepEqual(rewardPlan(r, 6, true, [], []), { add: ['a', 'b'], remove: [] });
  assert.deepEqual(rewardPlan(r, 6, false, ['a'], []), { add: ['b'], remove: ['a'] });
  assert.deepEqual(rewardPlan(r, 12, false, ['b'], []), { add: ['c'], remove: ['b'] });
  // Given once and removed by hand: not given again.
  assert.deepEqual(rewardPlan(r, 12, true, ['a', 'b'], ['c']), { add: [], remove: [] });
});
