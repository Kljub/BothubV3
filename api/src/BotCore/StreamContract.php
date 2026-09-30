<?php

declare(strict_types=1);

namespace BotHub\BotCore;

/**
 * Reads shared/streams.json, the contract between API and bot, so the API
 * cannot send an event or job type the bot does not know.
 */
final class StreamContract
{
    public const EVENTS = 'bothub:events';
    public const JOBS = 'bothub:jobs';
    public const RESULTS = 'bothub:results';

    /** Streams are trimmed to about this many entries. */
    public const MAXLEN = 10000;

    /** @var array<string, array<string, array<string, mixed>>> stream => type => fields */
    private static array $types = [];

    public static function assertKnown(string $stream, string $type, array $payload): void
    {
        $fields = self::types()[$stream][$type] ?? null;
        if ($fields === null) {
            throw new \InvalidArgumentException("Unknown {$stream} type '{$type}' (shared/streams.json)");
        }
        foreach ($fields as $field => $_) {
            if ($field[0] !== '$' && $field !== 'jobId' && !array_key_exists($field, $payload)) {
                throw new \InvalidArgumentException("{$type}: missing field '{$field}'");
            }
        }
    }

    /** @return array<string, array<string, array<string, mixed>>> */
    private static function types(): array
    {
        if (self::$types === []) {
            $shared = getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared';
            $doc = json_decode((string) file_get_contents($shared . '/streams.json'), true, 512, JSON_THROW_ON_ERROR);
            foreach ($doc['streams'] as $stream => $def) {
                self::$types[$stream] = $def['types'] ?? [];
            }
        }
        return self::$types;
    }
}
