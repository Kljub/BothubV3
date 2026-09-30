<?php

declare(strict_types=1);

// API <-> BotCore interface tests without a framework:
//   php tests/botcore_test.php
// Redis part needs REDIS_URL. Stream names are the real ones, so point it
// at a spare database the bot does not read, e.g. redis://redis:6379/15.
// Exit code 0 = all passed.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\CommandPresets;
use BotHub\BotCore\Jobs;
use BotHub\BotCore\Outbox;
use BotHub\BotCore\OutboxRelay;
use BotHub\BotCore\SecretBox;
use BotHub\BotCore\StreamContract;
use BotHub\Cache\ArrayCache;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Redis\RedisConnect;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}
function throws(callable $fn): bool
{
    try {
        $fn();
        return false;
    } catch (\Throwable) {
        return true;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-botcore-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();

// --- secrets: same format as bot/src/core/secrets.ts ---
putenv('BOTHUB_SECRET_KEY');
$box = SecretBox::loadOrCreate($tmp);
check('secret key file created', is_file($tmp . '/secret.key'));
check('secret key file reused', SecretBox::loadOrCreate($tmp)->decrypt($box->encrypt('x')) === 'x');
$blob = $box->encrypt('token.abc');
check('blob = nonce 12 + body + tag 16', strlen($blob) === 12 + 9 + 16);
check('decrypt round trip', $box->decrypt($blob) === 'token.abc');
$blob[20] = $blob[20] ^ "\x01";
check('damaged blob refused', throws(fn () => $box->decrypt($blob)));
check('fingerprint stable', $box->fingerprint('t') === $box->fingerprint('t') && $box->fingerprint('t') !== $box->fingerprint('u'));
putenv('BOTHUB_SECRET_KEY=' . base64_encode(str_repeat('k', 32)));
check('key from ENV', (new SecretBox(str_repeat('k', 32)))->decrypt(SecretBox::loadOrCreate($tmp)->encrypt('y')) === 'y');
putenv('BOTHUB_SECRET_KEY');

// --- contract ---
check('unknown event refused', throws(fn () => Connection::write($pdo, fn (PDO $p) => Outbox::add($p, 'command.exploded', ['botId' => 1]))));
check('missing field refused', throws(fn () => Connection::write($pdo, fn (PDO $p) => Outbox::add($p, 'command.saved', ['botId' => 1]))));
check('outside transaction refused', throws(fn () => Outbox::add($pdo, 'bot.created', ['botId' => 1])));

// --- presets ---
$pdo->exec("INSERT INTO bots (name) VALUES ('Test')");
$botId = (int) $pdo->lastInsertId();
$count = Connection::write($pdo, fn (PDO $p) => CommandPresets::seed($p, $botId));
$row = $pdo->query("SELECT c.enabled, g.name AS grp, (SELECT COUNT(*) FROM command_versions v WHERE v.command_id = c.id) AS versions
    FROM commands c JOIN command_groups g ON g.id = c.group_id WHERE c.bot_id = {$botId} AND c.name = 'purge'")->fetch();
check('presets seeded', $count > 0 && (int) $pdo->query("SELECT COUNT(*) FROM commands WHERE bot_id = {$botId}")->fetchColumn() === $count);
check('preset disabled, in module group, one version', $row !== false && $row['enabled'] === 0 && $row['grp'] === 'Moderation' && $row['versions'] === 1);

if (!getenv('REDIS_URL')) {
    echo "skip redis: REDIS_URL not set\n";
    exit($failed === 0 ? 0 : 1);
}

// --- relay: outbox -> stream, cache bump, results -> job ---
$redis = RedisConnect::open(RedisConnect::url(), 2.0, false, 5.0);
$cache = new ArrayCache();
$jobs = new Jobs($redis);
$relay = new OutboxRelay($pdo, $redis, $cache, $jobs, 'test-' . bin2hex(random_bytes(3)));
$relay->setup();
$relay->tick(1); // drain pending results of earlier runs

$lastEvent = ($redis->xRevRange(StreamContract::EVENTS, '+', '-', 1) ?: ['0-0' => []]);
$from = array_key_first($lastEvent);
Connection::write($pdo, fn (PDO $p) => Outbox::add($p, 'command.saved', ['botId' => $botId, 'commandId' => 7]));
$v0 = $cache->botVersion((string) $botId);
check('relay sent 1 row', $relay->tick(1) === 1);
$entries = array_values(array_filter($redis->xRange(StreamContract::EVENTS, $from, '+'), fn ($id) => $id !== $from, ARRAY_FILTER_USE_KEY));
$event = json_decode(end($entries)['data'] ?? '{}', true);
check('event on bothub:events with type', $event === ['type' => 'command.saved', 'botId' => $botId, 'commandId' => 7]);
check('outbox row marked sent', (int) $pdo->query('SELECT COUNT(*) FROM outbox WHERE sent_at IS NULL')->fetchColumn() === 0);
check('cache version bumped', $cache->botVersion((string) $botId) === $v0 + 1);
check('nothing sent twice', $relay->tick(1) === 0);

$jobId = $jobs->dispatch('bot.start', ['botId' => $botId]);
check('job queued', $jobs->get($jobId)['status'] === 'queued');
$lastJob = $redis->xRevRange(StreamContract::JOBS, '+', '-', 1);
check('job on bothub:jobs', json_decode(reset($lastJob)['data'], true) === ['type' => 'bot.start', 'jobId' => $jobId, 'botId' => $botId]);
// Answer like the bot does (StreamConsumer.publishResult).
$redis->xAdd(StreamContract::RESULTS, '*', ['data' => json_encode(['jobId' => $jobId, 'ok' => false, 'errorKey' => 'error.bot.token_invalid'])]);
$relay->tick(1);
$job = $jobs->get($jobId);
check('job failed with errorKey', $job['status'] === 'failed' && $job['errorKey'] === 'error.bot.token_invalid' && $job['finishedAt'] !== null);
check('unknown job id ignored', $jobs->get('00000000-0000-4000-8000-000000000000') === null);
check('unknown job type refused', throws(fn () => $jobs->dispatch('bot.explode', ['botId' => 1])));

$redis->del('bothub:job:' . $jobId);
exit($failed === 0 ? 0 : 1);
