<?php

declare(strict_types=1);

namespace BotHub\Internal;

/**
 * Read-only view of shared/sdk-permissions.json for the API: the permission
 * keys, the old coarse keys and their finer replacements ("replaced"), and
 * which discord.events.* permission each Discord event needs. A manifest
 * that still names an old key (e.g. discord.members.manage) is read as if it
 * named the new keys, so plugins built before the split keep working.
 */
final class SdkCatalog
{
    private static ?array $doc = null;

    /** @param array<string, mixed>|null $doc tests pass their own catalog; null = shared file */
    public static function use(?array $doc): void
    {
        self::$doc = $doc;
    }

    private static function doc(): array
    {
        if (self::$doc === null) {
            $file = (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/sdk-permissions.json';
            $doc = json_decode((string) @file_get_contents($file), true);
            self::$doc = is_array($doc) ? $doc : [];
        }
        return self::$doc;
    }

    /** @return list<array<string, mixed>> */
    public static function permissions(): array
    {
        return array_values(array_filter(self::doc()['permissions'] ?? [], static fn ($p) => is_array($p) && is_string($p['key'] ?? null)));
    }

    /** Old keys replaced by the new ones; other values stay (validation still sees them); order kept, no duplicates. */
    public static function expand(mixed $perms): mixed
    {
        if (!is_array($perms)) {
            return $perms;
        }
        $replaced = self::doc()['replaced'] ?? [];
        $out = [];
        foreach ($perms as $p) {
            foreach (is_string($p) && is_array($replaced[$p] ?? null) ? $replaced[$p] : [$p] as $k) {
                if (!in_array($k, $out, true)) {
                    $out[] = $k;
                }
            }
        }
        return $out;
    }

    /** @return array<string, string> Discord event => the permission it needs */
    public static function eventPermissions(): array
    {
        $out = [];
        foreach (self::permissions() as $p) {
            foreach (is_array($p['events'] ?? null) ? $p['events'] : [] as $event) {
                if (is_string($event)) {
                    $out[$event] = $p['key'];
                }
            }
        }
        return $out;
    }
}
