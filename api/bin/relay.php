<?php

declare(strict_types=1);

// Outbox relay (plan.md, section 1): outbox -> bothub:events/bothub:jobs,
// bothub:results -> job state. Runs as its own process next to the API
// (docker-compose service "relay"; supervisord in the AMP image).

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\Jobs;
use BotHub\BotCore\OutboxRelay;
use BotHub\Cache\RedisCache;
use BotHub\Database\Connection;
use BotHub\Redis\RedisConnect;

$stop = false;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$stop) { $stop = true; });
pcntl_signal(SIGINT, function () use (&$stop) { $stop = true; });

$pdo = Connection::open(Connection::defaultPath());
$cache = RedisCache::fromEnv();
$relay = null;
$backoff = 1;

fwrite(STDOUT, "relay: started\n");
while (!$stop) {
    try {
        if ($relay === null) {
            // Read timeout above the XREADGROUP block time.
            $redis = RedisConnect::open(RedisConnect::url(), 2.0, false, 5.0);
            $relay = new OutboxRelay($pdo, $redis, $cache, new Jobs($redis), 'relay-' . gethostname());
            $relay->setup();
            $backoff = 1;
        }
        $relay->tick();
    } catch (\RedisException $e) {
        error_log('relay: redis unavailable, retry in ' . $backoff . 's: ' . $e->getMessage());
        $relay = null;
        sleep($backoff);
        $backoff = min($backoff * 2, 30);
    }
}
fwrite(STDOUT, "relay: stopped\n");
