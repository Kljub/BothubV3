import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { openDb } from '../core/db.js';
import { Repo } from '../core/repo.js';
import { denied, type Permissions, type PseudoRoles } from './commands.js';
import { ADMIN_ROLE, MODERATOR_ROLE, Moderation, parseConfig, renderTemplate } from './moderation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function repo(): Repo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'bothub-mod-')), 'bothub.sqlite'));
  const dir = join(root, 'api', 'migrations');
  for (const [i, f] of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().entries()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
  db.prepare("INSERT INTO bots (name) VALUES ('Test')").run();
  return new Repo(db);
}

const member = (roles: string[], perms: bigint[] = [], guild = '1') =>
  ({ guild: { id: guild }, roles: { cache: new Map(roles.map((r) => [r, {}])) }, permissions: { has: (b: bigint) => perms.includes(b) } }) as never;

test('config: defaults, stored values, bad values fall back', () => {
  const c = parseConfig({});
  assert.deepEqual(c.moderators.required_permissions, ['manage_messages']);
  assert.deepEqual(c.admins.required_permissions, ['administrator']);
  assert.equal(c.dmMode, 'embed');
  const s = parseConfig({
    dmMode: 'text',
    logColor: 'red',
    banDeleteMessages: '99y',
    autoPunishments: [
      { trigger: 'warnings', count: 3, action: 'ban', duration: '1d' },
      { trigger: 'x', count: 1, action: 'kick', duration: '' },
      { trigger: 'warnings', count: 4, action: 'ban', duration: 'forever' },
      { trigger: 'warnings', count: 5, action: 'timeout', duration: '' },
      { trigger: 'warnings', count: 6, action: 'kick' },
    ],
  });
  assert.equal(s.dmMode, 'text');
  assert.equal(s.logColor, '#5865f2');
  assert.equal(s.banDeleteMessages, 'none', 'unknown deletion falls back');
  assert.deepEqual(s.autoPunishments.map((r) => r.count), [3], 'bad durations and missing fields are skipped');
});

test('dm template variables', () => {
  assert.equal(renderTemplate('{action} #{case} by {moderator}: {reason} {unknown}', { action: 'Ban', case: '4', moderator: '<@1>', reason: 'spam' }), 'Ban #4 by <@1>: spam {unknown}');
});

test('pseudo roles: older configs are read into the blocks', () => {
  const r = repo();
  r.db.prepare("INSERT INTO bot_modules (bot_id, module_key, config) VALUES (1, 'moderation', ?)").run(
    JSON.stringify({ defaultPermissions: false, moderatorRoles: [{ id: '10', guild: '1' }], adminRoles: [{ id: '20', guild: '1' }] }),
  );
  const mod = new Moderation(1, r, () => null);
  mod.reload(new Set());
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['10'])), true);
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['10'], [], '2')), false, 'roles of another server do not count');
  assert.equal(mod.hasPseudoRole(ADMIN_ROLE, member(['10'])), false);
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['20'])), true, 'admins may use moderator commands');
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member([], [PermissionFlagsBits.ManageMessages])), false, 'default permissions are off');
  assert.equal(mod.hasPseudoRole(ADMIN_ROLE, member([], [PermissionFlagsBits.Administrator])), true);
  assert.equal(mod.hasPseudoRole('123', member([])), undefined);

  const p: Permissions = { allowed_roles: [{ id: MODERATOR_ROLE }], banned_roles: [], required_permissions: [], banned_channels: [], hide_without_permission: false };
  const pseudo: PseudoRoles = (id, m) => mod.hasPseudoRole(id, m);
  assert.equal(denied(p, member(['10']), '5', pseudo), null);
  assert.equal(denied(p, member([]), '5', pseudo), 'role');

  r.db.prepare("UPDATE bot_modules SET config = '{}'").run();
  mod.reload(new Set());
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member([], [PermissionFlagsBits.ManageMessages])), true, 'default: Manage Messages is a moderator');
});

test('pseudo roles: blocks with banned roles and channels', () => {
  const r = repo();
  const cfg = {
    moderators: { allowed_roles: [{ id: '10', guild: '1' }], banned_roles: [{ id: '30', guild: '1' }], required_permissions: ['kick_members'], banned_channels: [{ id: '99', guild: '1' }] },
    admins: { allowed_roles: [{ id: '20', guild: '1' }], banned_roles: [], required_permissions: [], banned_channels: [] },
  };
  r.db.prepare("INSERT INTO bot_modules (bot_id, module_key, config) VALUES (1, 'moderation', ?)").run(JSON.stringify(cfg));
  const mod = new Moderation(1, r, () => null);
  mod.reload(new Set());
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['10']), '5'), true);
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member([], [PermissionFlagsBits.KickMembers]), '5'), true, 'all required permissions');
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member([], [PermissionFlagsBits.ManageMessages]), '5'), false, 'not a required permission');
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['10', '30']), '5'), false, 'banned role');
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['10']), '99'), false, 'banned channel');
  assert.equal(mod.hasPseudoRole(MODERATOR_ROLE, member(['20']), '99'), true, 'admins are moderators in every channel');
  assert.equal(mod.hasPseudoRole(ADMIN_ROLE, member([]), '5'), false, 'empty permissions: roles only');
  assert.equal(mod.hasPseudoRole(ADMIN_ROLE, member([], [PermissionFlagsBits.Administrator]), '5'), true, 'Discord Administrator always counts');

  const p: Permissions = { allowed_roles: [{ id: MODERATOR_ROLE }], banned_roles: [], required_permissions: [], banned_channels: [], hide_without_permission: false };
  const pseudo: PseudoRoles = (id, m, ch) => mod.hasPseudoRole(id, m, ch);
  assert.equal(denied(p, member(['10']), '5', pseudo), null);
  assert.equal(denied(p, member(['10']), '99', pseudo), 'role', 'the channel goes through to the block');
});

test('cases: numbers per server, remove, clear, count', () => {
  const r = repo();
  const add = (guildId: string, action: 'warn' | 'timeout') => r.addCase(1, { guildId, userId: '5', moderatorId: '6', action, reason: 'r', duration: '', auto: false });
  assert.equal(add('1', 'warn'), 1);
  assert.equal(add('1', 'timeout'), 2);
  assert.equal(add('2', 'warn'), 1, 'numbers count per server');
  assert.equal(r.modCase(1, '1', 2)?.action, 'timeout');
  assert.equal(r.countCases(1, '1', '5', 'timeout'), 1);
  assert.equal(r.removeCase(1, '1', 2), true);
  assert.equal(r.modCase(1, '1', 2), undefined);
  assert.equal(add('1', 'warn'), 3, 'removed numbers are not reused');
  r.addWarning(1, '1', '5', '6', 'x');
  r.clearWarnings(1, '1', '5');
  assert.equal(r.countCases(1, '1', '5', 'warn'), 0, 'clearing warnings resets the warning count of automatic punishments');
  assert.equal(r.clearCases(1, '1', '5'), 0);
  assert.equal(r.cases(1, '1', '5').length, 0);
  const note = r.addNote(1, '1', '5', '6', 'watch');
  assert.equal(r.notes(1, '1', '5')[0]?.content, 'watch');
  assert.equal(r.removeNote(1, '2', note), false, 'notes of another server');
  assert.equal(r.removeNote(1, '1', note), true);
});

test('bot status keeps started_at while running, clears it otherwise', () => {
  const r = repo();
  const at = () => (r.db.prepare('SELECT started_at FROM bots WHERE id = 1').get() as { started_at: string | null }).started_at;
  r.setBotStatus(1, 'starting');
  assert.equal(at(), null);
  r.setBotStatus(1, 'running');
  const first = at();
  assert.ok(first);
  r.setBotStatus(1, 'running');
  assert.equal(at(), first, 'a second running status keeps the start time');
  r.setBotStatus(1, 'stopped');
  assert.equal(at(), null);
});

test('undo jobs: due, cancel by key, finish', () => {
  const r = repo();
  r.addJob(1, 'undo', new Date(Date.now() - 1000), { op: 'unban' }, 'tempban:1:5');
  r.addJob(1, 'undo', new Date(Date.now() + 60_000), { op: 'unban' }, 'tempban:1:6');
  const due = r.dueJobs(1, ['undo'], new Date());
  assert.deepEqual(due.map((j) => j.payload.op), ['unban']);
  r.finishJob(due[0]!.id);
  assert.equal(r.dueJobs(1, ['undo'], new Date()).length, 0);
  assert.equal(r.cancelJobs(1, 'tempban:1:6'), 1);
  assert.equal(r.dueJobs(1, ['undo'], new Date(Date.now() + 120_000)).length, 0);
});

test('automatic punishment rule: exact count, highest wins', () => {
  const mod = new Moderation(1, {} as Repo, () => null);
  mod.config = parseConfig({
    autoPunishments: [
      { trigger: 'warnings', count: 3, action: 'timeout', duration: '1h' },
      { trigger: 'warnings', count: 3, action: 'kick', duration: '' },
      { trigger: 'timeouts', count: 2, action: 'ban', duration: '' },
    ],
  });
  assert.equal(mod.ruleFor('warnings', 3)?.action, 'kick');
  assert.equal(mod.ruleFor('warnings', 4), undefined);
  assert.equal(mod.ruleFor('timeouts', 2)?.action, 'ban');
});

test('music: yt-dlp lines, queue order, ffmpeg arguments, lyrics titles', async () => {
  const { trackOf, nextIndex, ffmpegArgs, clock, errorText, parseClock, trackLength } = await import('./music.js');
  const { cleanTitle } = await import('./lyrics.js');
  const t = trackOf(JSON.stringify({ id: 'abc', title: 'Song', duration: 185.4, uploader: 'Band', ie_key: 'Youtube', url: 'abc' }), '1');
  assert.deepEqual(t, { title: 'Song', url: 'https://www.youtube.com/watch?v=abc', duration: 185, author: 'Band', requester: '1' });
  assert.equal(trackOf('not json', null), null);
  assert.equal(nextIndex(0, 3, 'off'), 1);
  assert.equal(nextIndex(2, 3, 'off'), -1, 'end of the queue');
  assert.equal(nextIndex(2, 3, 'queue'), 0, 'loop queue');
  assert.equal(nextIndex(1, 3, 'track'), 1, 'loop track');
  assert.equal(nextIndex(1, 3, 'track', true), 2, 'skip leaves a looped track');
  const args = ffmpegArgs('https://x/a', 30, ['bassboost', 'nope']).join(' ');
  assert.match(args, /-ss 30 -i https:\/\/x\/a -af bass=g=10 -vn -f s16le -ar 48000 -ac 2/);
  assert.doesNotMatch(ffmpegArgs('u', 0, []).join(' '), /-ss|-af/);
  assert.equal(clock(185), '3:05');
  assert.equal(clock(3723), '1:02:03');
  assert.equal(clock(0), '0:00');
  assert.equal(parseClock('3:05'), 185);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('soon'), 0);
  assert.equal(trackLength({ duration: 0, live: true }), 'live');
  assert.equal(trackLength({ duration: 0 }), '?:??');
  assert.equal(trackOf(JSON.stringify({ id: 'abc', ie_key: 'Youtube', title: 'X', duration_string: '4:10' }), null)!.duration, 250);
  assert.match(errorText('ERROR: [youtube] abc: Sign in to confirm you’re not a bot'), /bot check/);
  assert.equal(errorText('ERROR: [generic] Unsupported URL: https://x'), 'Unsupported URL: https://x');
  assert.equal(cleanTitle('Rick Astley - Never Gonna Give You Up (Official Music Video) [4K Remaster]'), 'Rick Astley - Never Gonna Give You Up');
});
