<?php

declare(strict_types=1);

namespace BotHub\Cache;

/**
 * Read-through cache for repositories (api/src/Repository/*).
 *
 * Rules:
 * - The cache is a speed-up only. SQLite stays the source of truth, and every
 *   method must work (as a miss) when Redis is down.
 * - Invalidate after commit: call delete()/bumpBotVersion() after
 *   Connection::write() has returned, never inside the transaction.
 * - Never store secret columns (see SecretGuard).
 * - Values are JSON, so Discord snowflakes stay strings and the bot can read
 *   the same entries.
 */
interface Cache
{
    /** Default TTL in seconds. Safety net only; writes invalidate explicitly. */
    public const DEFAULT_TTL = 600;

    /**
     * Returns the cached value, or $default on a miss or when Redis is down.
     * A stored null is returned as null, not as $default.
     */
    public function get(string $key, mixed $default = null): mixed;

    public function set(string $key, mixed $value, int $ttl = self::DEFAULT_TTL): void;

    public function delete(string ...$keys): void;

    /**
     * Returns the cached value for $key, or runs $load, caches its result
     * (null included) and returns it.
     *
     * @template T
     * @param callable(): T $load
     * @return T
     */
    public function remember(string $key, callable $load, int $ttl = self::DEFAULT_TTL): mixed;

    /**
     * Current cache version of a bot. Bot-scoped keys (Keys::bot()) embed it,
     * so bumping it drops every cached entry of that bot at once.
     */
    public function botVersion(string $botId): int;

    /** Invalidates every bot-scoped entry of $botId. Returns the new version. */
    public function bumpBotVersion(string $botId): int;
}
