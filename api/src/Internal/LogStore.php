<?php

declare(strict_types=1);

namespace BotHub\Internal;

use PDO;

/**
 * Reads the log table for the dashboard: the log of one bot (written by the
 * bot: updates, warnings, errors of commands and plugins) and the instance
 * log (bot_id NULL: API, audit events). Oldest first, the newest $limit rows.
 */
final class LogStore
{
    public const LEVELS = ['update', 'change', 'warning', 'error'];
    private const LIMIT_MAX = 500;

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return list<array<string, mixed>> */
    public function forBot(int $botId, mixed $level, mixed $limit): array
    {
        return $this->query('l.bot_id = ?', [$botId], $level, $limit);
    }

    /** @return list<array<string, mixed>> */
    public function server(mixed $level, mixed $limit): array
    {
        return $this->query('l.bot_id IS NULL', [], $level, $limit);
    }

    public function clear(int $botId): void
    {
        $this->pdo->prepare('DELETE FROM logs WHERE bot_id = ?')->execute([$botId]);
    }

    private function query(string $where, array $args, mixed $level, mixed $limit): array
    {
        if (is_string($level) && in_array($level, self::LEVELS, true)) {
            $where .= ' AND l.level = ?';
            $args[] = $level;
        }
        $n = is_numeric($limit) ? max(1, min(self::LIMIT_MAX, (int) $limit)) : 200;
        $stmt = $this->pdo->prepare(
            "SELECT l.id, l.at, l.level, l.code, l.key, l.params, l.change, l.source, u.username AS actor
             FROM logs l LEFT JOIN users u ON u.id = l.actor_user_id
             WHERE {$where} ORDER BY l.id DESC LIMIT {$n}",
        );
        $stmt->execute($args);
        $rows = array_reverse($stmt->fetchAll());
        return array_map(static function (array $r): array {
            $out = [
                'id' => (int) $r['id'],
                'time' => $r['at'],
                'level' => $r['level'],
                'code' => $r['code'],
                'key' => $r['key'],
                'params' => $r['params'] !== null ? (object) (json_decode($r['params'], true) ?: []) : null,
                'change' => $r['change'] !== null ? json_decode($r['change'], true) : null,
            ];
            if ($r['source'] !== null) {
                $out['source'] = $r['source'];
            }
            if ($r['actor'] !== null) {
                $out['actor'] = $r['actor'];
            }
            return $out;
        }, $rows);
    }
}
