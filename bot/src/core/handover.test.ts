import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimEvents, claimKey, handover } from './handover.js';

test('handover: the same event gives the same key on every core; caches and the connection are local', () => {
  assert.equal(claimKey('interactionCreate', [{ id: '123' }]), 'interactionCreate:123');
  assert.equal(claimKey('messageCreate', [{ id: '9' }]), 'messageCreate:9');
  assert.equal(claimKey('clientReady', [{}]), null);
  assert.equal(claimKey('inviteCreate', [{ code: 'x' }]), null);
  const member = (roles: string[]) => ({ toJSON: () => ({ id: '1', roles }) });
  // Update events: only the new state counts (the old one may be cached on one core only).
  assert.equal(claimKey('guildMemberUpdate', [null, member(['a'])]), claimKey('guildMemberUpdate', [member(['x']), member(['a'])]));
  assert.notEqual(claimKey('guildMemberUpdate', [null, member(['a'])]), claimKey('guildMemberUpdate', [null, member(['a', 'b'])]));
  assert.notEqual(claimKey('messageReactionAdd', [{ toJSON: () => ({ m: 1, e: '👍' }) }, { id: 'u1' }]), claimKey('messageReactionAdd', [{ toJSON: () => ({ m: 1, e: '👍' }) }, { id: 'u2' }]));
});

test('handover: alone (no update running) every event goes straight to the listeners', () => {
  const seen: string[] = [];
  const client = { emit: (event: string, ..._args: unknown[]) => { seen.push(event); return true; } };
  claimEvents(client, 1);
  assert.equal(handover.overlap, false);
  client.emit('messageCreate', { id: '1' });
  client.emit('clientReady');
  assert.deepEqual(seen, ['messageCreate', 'clientReady']);
  assert.equal(handover.isLeader(), true);
});
