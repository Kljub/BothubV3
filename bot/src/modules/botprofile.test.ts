import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileFor } from './botprofile.js';

test('bot profile: per-server fields over the default, only https images', () => {
  const cfg = {
    nick: 'Helper', bio: 'Hi', avatar: 'https://cdn.example.com/a.png', banner: 'http://insecure/b.png',
    servers: [{ guildId: '123456789012345678', nick: 'Shop Bot', avatar: '' }],
  };
  assert.deepEqual(profileFor(cfg, '123456789012345678'), { nick: 'Shop Bot', bio: 'Hi', avatar: 'https://cdn.example.com/a.png', banner: null });
  assert.deepEqual(profileFor(cfg, '999999999999999999'), { nick: 'Helper', bio: 'Hi', avatar: 'https://cdn.example.com/a.png', banner: null });
  assert.deepEqual(profileFor({}, '1'), { nick: null, bio: null, avatar: null, banner: null });
});
