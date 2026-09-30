<?php

declare(strict_types=1);

namespace BotHub\Cache;

/**
 * Refuses values that contain secret columns, so a repository that caches a
 * full row by mistake fails loudly in development instead of copying tokens
 * into Redis.
 */
final class SecretGuard
{
    /** Schema convention (0001_core.sql): secrets end in _enc, hashes in _hash. */
    private const SUFFIXES = ['_enc', '_hash'];
    private const EXACT = ['token_fingerprint'];

    public static function assertClean(mixed $value, string $key): void
    {
        if (!is_array($value)) {
            return;
        }
        foreach ($value as $field => $inner) {
            if (is_string($field) && self::isSecret($field)) {
                throw new \LogicException("Refusing to cache secret field '{$field}' under {$key}");
            }
            self::assertClean($inner, $key);
        }
    }

    private static function isSecret(string $field): bool
    {
        if (in_array($field, self::EXACT, true)) {
            return true;
        }
        foreach (self::SUFFIXES as $suffix) {
            if (str_ends_with($field, $suffix)) {
                return true;
            }
        }
        return false;
    }
}
