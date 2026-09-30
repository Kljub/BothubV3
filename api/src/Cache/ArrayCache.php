<?php

declare(strict_types=1);

namespace BotHub\Cache;

/**
 * In-process cache for tests and for running without Redis. Same contract as
 * RedisCache, including the secret guard and JSON round trip.
 */
final class ArrayCache implements Cache
{
    /** @var array<string, array{string, float}> key => [json, expiresAt] */
    private array $items = [];

    public function get(string $key, mixed $default = null): mixed
    {
        $item = $this->items[$key] ?? null;
        if ($item === null || $item[1] < microtime(true)) {
            unset($this->items[$key]);
            return $default;
        }
        return json_decode($item[0], true, 512, JSON_THROW_ON_ERROR);
    }

    public function set(string $key, mixed $value, int $ttl = self::DEFAULT_TTL): void
    {
        SecretGuard::assertClean($value, $key);
        $this->items[$key] = [json_encode($value, JSON_THROW_ON_ERROR), microtime(true) + max(1, $ttl)];
    }

    public function delete(string ...$keys): void
    {
        foreach ($keys as $key) {
            unset($this->items[$key]);
        }
    }

    public function remember(string $key, callable $load, int $ttl = self::DEFAULT_TTL): mixed
    {
        if (isset($this->items[$key]) && $this->items[$key][1] >= microtime(true)) {
            return $this->get($key);
        }
        $value = $load();
        $this->set($key, $value, $ttl);
        return $value;
    }

    public function botVersion(string $botId): int
    {
        return (int) $this->get(Keys::botVersion($botId), 0);
    }

    public function bumpBotVersion(string $botId): int
    {
        $new = $this->botVersion($botId) + 1;
        $this->items[Keys::botVersion($botId)] = [(string) $new, PHP_FLOAT_MAX];
        return $new;
    }
}
