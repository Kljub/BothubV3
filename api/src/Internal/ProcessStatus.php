<?php

declare(strict_types=1);

namespace BotHub\Internal;

/**
 * BotCore and database rows of the resource overview.
 * Database: response time of a real read, file size (with WAL) and the free
 * space of the data disk.
 *
 * BotCore: The Node process writes a heartbeat
 * to Redis every 10 s (bot/src/core/heartbeat.ts, TTL 30 s) and appends each
 * start to a list; no heartbeat means the process is down.
 */
final class ProcessStatus
{
    public const HEARTBEAT_KEY = 'bothub:process:botcore';
    public const STARTS_KEY = 'bothub:process:botcore:starts';

    public static function read(\Redis $redis, ?\DateTimeImmutable $now = null): array
    {
        $raw = $redis->get(self::HEARTBEAT_KEY);
        $starts = $redis->lRange(self::STARTS_KEY, 0, -1);
        return self::botcore(is_string($raw) ? json_decode($raw, true) : null, is_array($starts) ? $starts : [], $now ?? new \DateTimeImmutable());
    }

    /** Times a small read (median of 5) and reports size and free disk space. */
    public static function database(\PDO $pdo, string $path): array
    {
        $times = [];
        for ($i = 0; $i < 5; $i++) {
            $t = hrtime(true);
            $pdo->query('SELECT COUNT(*) FROM bots')->fetchColumn();
            $times[] = (hrtime(true) - $t) / 1e6;
        }
        sort($times);
        $size = 0;
        foreach (['', '-wal', '-shm'] as $suffix) {
            $size += is_file($path . $suffix) ? (int) filesize($path . $suffix) : 0;
        }
        $free = @disk_free_space(dirname($path));
        return [
            'key' => 'database',
            'kind' => 'database',
            'status' => 'running',
            'latencyMs' => round($times[2], 2),
            'storageBytes' => $size,
            'diskFreeBytes' => $free === false ? 0 : (int) $free,
        ];
    }

    /**
     * @param array<string, mixed>|null $heartbeat
     * @param list<string> $starts process starts "<ISO time>|clean" or "<ISO time>|crash"
     */
    public static function botcore(?array $heartbeat, array $starts, \DateTimeImmutable $now): array
    {
        $dayAgo = $now->getTimestamp() - 86400;
        // Only starts after a crash count; a restart button, deploy or docker stop is planned.
        $restarts = count(array_filter($starts, static function (string $s) use ($dayAgo): bool {
            [$at, $kind] = explode('|', $s, 2) + [1 => 'clean'];
            return $kind === 'crash' && ($t = strtotime($at)) !== false && $t >= $dayAgo;
        }));
        if (!is_array($heartbeat)) {
            return ['key' => 'botcore', 'kind' => 'service', 'status' => 'stopped', 'restarts24h' => $restarts];
        }
        $started = strtotime((string) ($heartbeat['startedAt'] ?? ''));
        return [
            'key' => 'botcore',
            'kind' => 'service',
            'status' => 'running',
            'pid' => (int) ($heartbeat['pid'] ?? 0),
            'cpuPercent' => (float) ($heartbeat['cpuPercent'] ?? 0),
            'memoryBytes' => (int) ($heartbeat['memoryBytes'] ?? 0),
            'uptimeSeconds' => $started === false ? 0 : max(0, $now->getTimestamp() - $started),
            'restarts24h' => $restarts,
            'bots' => (int) ($heartbeat['bots'] ?? 0),
        ];
    }
}
