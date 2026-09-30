<?php

declare(strict_types=1);

namespace BotHub\BotCore;

use BotHub\Cache\Cache;
use BotHub\Database\Connection;
use PDO;

/**
 * Long-running process (bin/relay.php) between SQLite and the bot:
 *
 * 1. Moves open outbox rows to their Redis stream, in id order, and sets
 *    sent_at. Delivery is at least once: a crash between XADD and UPDATE
 *    sends the row again, so bot handlers must be idempotent (they reload).
 * 2. Bumps the cache version of the bot named in each event, so API cache
 *    entries die as reliably as the event is delivered.
 * 3. Reads bothub:results (consumer group 'api') and stores job results.
 *
 * If Redis is down, rows stay in the outbox and go out when it is back.
 */
final class OutboxRelay
{
    private const BATCH = 100;
    private const RESULTS_GROUP = 'api';
    private const KEEP_SENT = '-7 days';

    private string $resultsFrom = '0';
    private float $nextPrune = 0.0;

    public function __construct(
        private readonly PDO $pdo,
        private readonly \Redis $redis,
        private readonly Cache $cache,
        private readonly Jobs $jobs,
        private readonly string $consumer = 'relay',
    ) {
    }

    /** Creates the results consumer group (idempotent). */
    public function setup(): void
    {
        try {
            $this->redis->xGroup('CREATE', StreamContract::RESULTS, self::RESULTS_GROUP, '$', true);
        } catch (\RedisException $e) {
            if (!str_contains($e->getMessage(), 'BUSYGROUP')) {
                throw $e;
            }
        }
        // phpredis reports BUSYGROUP via getLastError() instead of throwing.
        $this->redis->clearLastError();
    }

    /**
     * One round: send open outbox rows, then wait up to $blockMs for job
     * results. Returns the number of outbox rows sent.
     */
    public function tick(int $blockMs = 500): int
    {
        $sent = $this->relayOutbox();
        $this->readResults($sent === self::BATCH ? 1 : $blockMs);
        if (microtime(true) >= $this->nextPrune) {
            $this->prune();
            $this->nextPrune = microtime(true) + 3600;
        }
        return $sent;
    }

    private function relayOutbox(): int
    {
        $rows = $this->pdo->query(
            'SELECT id, stream, type, payload FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ' . self::BATCH,
        )->fetchAll();

        $sent = [];
        $failed = null;
        foreach ($rows as $row) {
            $payload = json_decode($row['payload'], true, 512, JSON_THROW_ON_ERROR);
            $data = json_encode(['type' => $row['type']] + $payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            try {
                $this->redis->xAdd($row['stream'], '*', ['data' => $data], StreamContract::MAXLEN, true);
            } catch (\RedisException $e) {
                // Keep the order: stop at the first failure, retry next tick.
                $failed = (int) $row['id'];
                error_log("relay: outbox {$row['id']} not sent: " . $e->getMessage());
                break;
            }
            $sent[] = (int) $row['id'];
            if (isset($payload['botId'])) {
                $this->cache->bumpBotVersion((string) $payload['botId']);
            }
        }

        if ($sent !== [] || $failed !== null) {
            Connection::write($this->pdo, function (PDO $pdo) use ($sent, $failed): void {
                if ($sent !== []) {
                    $in = implode(',', array_fill(0, count($sent), '?'));
                    $pdo->prepare("UPDATE outbox SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = attempts + 1 WHERE id IN ({$in})")
                        ->execute($sent);
                }
                if ($failed !== null) {
                    $pdo->prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?')->execute([$failed]);
                }
            });
        }
        if ($failed !== null) {
            throw new \RedisException('redis unavailable');
        }
        return count($sent);
    }

    private function readResults(int $blockMs): void
    {
        // '0' first: results this consumer read but did not acknowledge (crash).
        $reply = $this->redis->xReadGroup(self::RESULTS_GROUP, $this->consumer, [StreamContract::RESULTS => $this->resultsFrom], 50, $this->resultsFrom === '0' ? null : $blockMs);
        $entries = is_array($reply) ? ($reply[StreamContract::RESULTS] ?? []) : [];
        if ($this->resultsFrom === '0' && $entries === []) {
            $this->resultsFrom = '>';
        }
        foreach ($entries as $id => $fields) {
            try {
                $this->jobs->finish(json_decode($fields['data'] ?? '{}', true, 512, JSON_THROW_ON_ERROR));
            } catch (\JsonException $e) {
                error_log("relay: bad result {$id}: " . $e->getMessage());
            }
            $this->redis->xAck(StreamContract::RESULTS, self::RESULTS_GROUP, [$id]);
        }
    }

    private function prune(): void
    {
        $cutoff = (new \DateTimeImmutable(self::KEEP_SENT, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
        Connection::write($this->pdo, static function (PDO $pdo) use ($cutoff): void {
            $pdo->prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?')->execute([$cutoff]);
        });
    }
}
