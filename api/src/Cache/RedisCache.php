<?php

declare(strict_types=1);

namespace BotHub\Cache;

use BotHub\Redis\RedisConnect;

/**
 * Cache on the phpredis extension (installed in api/Dockerfile).
 *
 * Redis errors never reach the caller: reads become misses, writes and
 * deletes are dropped. After an error the cache stays off for
 * RETRY_AFTER seconds, so a dead Redis costs one timeout, not one per call.
 * Invalidations (delete, bumpBotVersion) ignore that window and retry once
 * on a fresh connection, because a dropped invalidation serves stale data
 * until TTL. If both tries fail, the entry expires by TTL.
 */
final class RedisCache implements Cache
{
    private const TIMEOUT = 0.5;
    private const RETRY_AFTER = 30;

    /** Shared per process (FrankenPHP worker), not per instance. */
    private static float $downUntil = 0.0;

    private ?\Redis $redis = null;

    public function __construct(private readonly string $url)
    {
    }

    public static function fromEnv(): self
    {
        return new self(RedisConnect::url());
    }

    public function get(string $key, mixed $default = null): mixed
    {
        $raw = $this->call(static fn (\Redis $r) => $r->get($key));
        if (!is_string($raw)) {
            return $default;
        }
        try {
            return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return $default;
        }
    }

    public function set(string $key, mixed $value, int $ttl = self::DEFAULT_TTL): void
    {
        SecretGuard::assertClean($value, $key);
        $raw = json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $this->call(static fn (\Redis $r) => $r->set($key, $raw, ['EX' => max(1, $ttl)]));
    }

    public function delete(string ...$keys): void
    {
        if ($keys !== []) {
            $this->invalidate(static fn (\Redis $r) => $r->unlink($keys));
        }
    }

    public function remember(string $key, callable $load, int $ttl = self::DEFAULT_TTL): mixed
    {
        $raw = $this->call(static fn (\Redis $r) => $r->get($key));
        if (is_string($raw)) {
            try {
                return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                // Corrupt entry: reload and overwrite below.
            }
        }
        $value = $load();
        $this->set($key, $value, $ttl);
        return $value;
    }

    public function botVersion(string $botId): int
    {
        $raw = $this->call(static fn (\Redis $r) => $r->get(Keys::botVersion($botId)));
        return is_string($raw) ? (int) $raw : 0;
    }

    public function bumpBotVersion(string $botId): int
    {
        $new = $this->invalidate(static fn (\Redis $r) => $r->incr(Keys::botVersion($botId)));
        return is_int($new) ? $new : 0;
    }

    /**
     * @param callable(\Redis): mixed $fn
     * @return mixed false when Redis is unavailable
     */
    private function call(callable $fn): mixed
    {
        if (microtime(true) < self::$downUntil) {
            return false;
        }
        try {
            return $fn($this->redis ??= $this->connect());
        } catch (\RedisException $e) {
            $this->redis = null;
            self::$downUntil = microtime(true) + self::RETRY_AFTER;
            error_log('cache: redis unavailable, bypassing for ' . self::RETRY_AFTER . 's: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * @param callable(\Redis): mixed $fn
     * @return mixed false when both tries failed
     */
    private function invalidate(callable $fn): mixed
    {
        for ($try = 1; $try <= 2; $try++) {
            try {
                $result = $fn($this->redis ??= $this->connect());
                self::$downUntil = 0.0;
                return $result;
            } catch (\RedisException $e) {
                $this->redis = null;
            }
        }
        self::$downUntil = microtime(true) + self::RETRY_AFTER;
        error_log('cache: invalidation lost, entries expire by TTL: ' . $e->getMessage());
        return false;
    }

    private function connect(): \Redis
    {
        // Persistent: FrankenPHP workers reuse the socket across requests.
        return RedisConnect::open($this->url, self::TIMEOUT, true);
    }
}
