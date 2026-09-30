<?php

declare(strict_types=1);

// Cache tests without a framework: php tests/cache_test.php
// Runs against ArrayCache always, and against RedisCache when REDIS_URL is set.
// Exit code 0 = all passed.

require __DIR__ . '/../src/autoload.php';

use BotHub\Cache\ArrayCache;
use BotHub\Cache\Cache;
use BotHub\Cache\Keys;
use BotHub\Cache\RedisCache;

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

function suite(string $label, Cache $cache): void
{
    $run = bin2hex(random_bytes(4));
    $key = Keys::entity('test', $run);

    check("{$label}: miss returns default", $cache->get($key, 'x') === 'x');

    $cache->set($key, ['id' => '1234567890123456789', 'n' => 1]);
    check("{$label}: snowflake stays string", $cache->get($key) === ['id' => '1234567890123456789', 'n' => 1]);

    $cache->delete($key);
    check("{$label}: delete removes entry", $cache->get($key, 'gone') === 'gone');

    $calls = 0;
    $load = function () use (&$calls) {
        $calls++;
        return null;
    };
    $cache->remember($key, $load);
    $cache->remember($key, $load);
    check("{$label}: remember caches null too", $calls === 1);
    $cache->delete($key);

    check("{$label}: secret field refused", throws(fn () => $cache->set($key, ['name' => 'a', 'token_enc' => 'x'])));
    check("{$label}: code_hash refused", throws(fn () => $cache->set($key, ["code_hash" => "x"])));
    check("{$label}: nested totp secret refused", throws(fn () => $cache->set($key, [['totp_secret_enc' => 'x']])));
    check("{$label}: secret not written", $cache->get($key, 'none') === 'none');

    $bot = 'bot' . $run;
    $v0 = $cache->botVersion($bot);
    $cache->set(Keys::bot($bot, $v0, 'commands'), ['ping']);
    $v1 = $cache->bumpBotVersion($bot);
    check("{$label}: bump increments version", $v1 === $v0 + 1 && $cache->botVersion($bot) === $v1);
    check("{$label}: bumped version misses", $cache->get(Keys::bot($bot, $v1, 'commands'), 'miss') === 'miss');
    $cache->delete(Keys::bot($bot, $v0, 'commands'), Keys::botVersion($bot));
}

suite('array', new ArrayCache());

if (getenv('REDIS_URL')) {
    suite('redis', RedisCache::fromEnv());

    $dead = new RedisCache('redis://127.0.0.1:1');
    $start = microtime(true);
    check('dead redis: get is a miss', $dead->get('k', 'd') === 'd');
    check('dead redis: remember still loads', $dead->remember('k', fn () => 42) === 42);
    check('dead redis: bypass after first failure', microtime(true) - $start < 1.5);
} else {
    echo "skip redis: REDIS_URL not set\n";
}

exit($failed === 0 ? 0 : 1);
