import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPick, type RoleGroup } from './rolegroups.js';

const group = (over: Partial<RoleGroup> = {}): RoleGroup => ({
  name: 'Colours', channel: null, style: 'buttons', message: { mode: 'text', content: '' } as RoleGroup['message'], roles: [], labels: [], emojis: [],
  buttonStyle: 'secondary', placeholder: '', maxRoles: 0, requiredRoles: [], blacklist: [], permanent: false, ...over,
});
const roles = ['r1', 'r2', 'r3'];

test('a button toggles its role', () => {
  assert.deepEqual(planPick(group(), roles, ['x'], ['r1'], 'r1'), { add: ['r1'], remove: [] });
  assert.deepEqual(planPick(group(), roles, ['r1'], [], 'r1'), { add: [], remove: ['r1'] });
});

test('one role per menu: a click swaps, a select of two is refused', () => {
  assert.deepEqual(planPick(group({ maxRoles: 1 }), roles, ['r1'], ['r1', 'r2'], 'r2'), { add: ['r2'], remove: ['r1'] });
  assert.equal(planPick(group({ maxRoles: 1 }), roles, [], ['r1', 'r2']).error, 'one');
  assert.equal(planPick(group({ maxRoles: 2 }), roles, ['r1', 'r2'], ['r1', 'r2', 'r3'], 'r3').error, 'max');
});

test('a select sets exactly the picked roles; roles outside the menu stay out of it', () => {
  assert.deepEqual(planPick(group(), roles, ['r1', 'other'], ['r2', 'other']), { add: ['r2'], remove: ['r1'] });
});

test('permanent roles are never removed', () => {
  assert.deepEqual(planPick(group({ permanent: true }), roles, ['r1'], ['r2']), { add: ['r2'], remove: [] });
  assert.deepEqual(planPick(group({ permanent: true }), roles, ['r1'], [], 'r1'), { add: [], remove: [] });
});
