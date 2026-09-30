<?php

declare(strict_types=1);

namespace BotHub\Cache;

/**
 * Key names. Everything lives under bothub:cache:, next to the reserved
 * streams bothub:events, bothub:jobs and bothub:results.
 *
 *   bothub:cache:<entity>:<id>                      global entries
 *   bothub:cache:botver:<botId>                     version counter (no TTL)
 *   bothub:cache:bot:<botId>:v<n>:<entity>[:<id>]   bot-scoped entries
 *
 * Bot-scoped entries of an old version are never read again and expire by TTL.
 */
final class Keys
{
    public const PREFIX = 'bothub:cache:';

    public static function entity(string $entity, string|int $id): string
    {
        return self::PREFIX . $entity . ':' . $id;
    }

    public static function botVersion(string $botId): string
    {
        return self::PREFIX . 'botver:' . $botId;
    }

    /** Bot-scoped key; get $version from Cache::botVersion(). */
    public static function bot(string $botId, int $version, string $entity, string|int|null $id = null): string
    {
        $key = self::PREFIX . 'bot:' . $botId . ':v' . $version . ':' . $entity;
        return $id === null ? $key : $key . ':' . $id;
    }
}
