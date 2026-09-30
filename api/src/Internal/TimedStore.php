<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;

/**
 * Timed events of one bot (migration 0006) and the bot's time settings.
 * Every change writes outbox timed.changed; the NodeCore reloads its
 * schedules. Custom events of type "timed" pick a schedule by id.
 */
final class TimedStore
{
    private const MAX_EVENTS = 50;
    private const MAX_TIMES = 24;
    private const MIN_INTERVAL = 10;
    private const MAX_INTERVAL = 31536000; // 365 days
    private const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

    public function __construct(private readonly PDO $pdo)
    {
    }

    public function list(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM timed_events WHERE bot_id = ? ORDER BY id');
        $stmt->execute([$botId]);
        return array_map(self::json(...), $stmt->fetchAll());
    }

    public function create(int $botId, array $in): array
    {
        $e = self::valid($in);
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $e): int {
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM timed_events WHERE bot_id = ?');
            $stmt->execute([$botId]);
            if ((int) $stmt->fetchColumn() >= self::MAX_EVENTS) {
                throw new ApiError(422, 'error.timed.limit', ['max' => self::MAX_EVENTS]);
            }
            $pdo->prepare('INSERT INTO timed_events (bot_id, name, kind, interval_seconds, times, weekdays, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$botId, ...array_values($e)]);
            $id = (int) $pdo->lastInsertId();
            Outbox::add($pdo, 'timed.changed', ['botId' => $botId]);
            return $id;
        });
        return $this->get($botId, $id);
    }

    public function update(int $botId, int $id, array $in): array
    {
        $e = self::valid($in);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $e): void {
            $stmt = $pdo->prepare('UPDATE timed_events SET name = ?, kind = ?, interval_seconds = ?, times = ?, weekdays = ?, enabled = ?, updated_at = ' . self::NOW . ' WHERE id = ? AND bot_id = ?');
            $stmt->execute([...array_values($e), $id, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.timed.unknown');
            }
            Outbox::add($pdo, 'timed.changed', ['botId' => $botId]);
        });
        return $this->get($botId, $id);
    }

    public function delete(int $botId, int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id): void {
            $stmt = $pdo->prepare('DELETE FROM timed_events WHERE id = ? AND bot_id = ?');
            $stmt->execute([$id, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.timed.unknown');
            }
            Outbox::add($pdo, 'timed.changed', ['botId' => $botId]);
        });
    }

    public function get(int $botId, int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM timed_events WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        return self::json($stmt->fetch() ?: throw ApiError::notFound('error.timed.unknown'));
    }

    /** {timezone, defaultServerId} */
    public function settings(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT timezone, default_guild_id FROM bots WHERE id = ?');
        $stmt->execute([$botId]);
        $r = $stmt->fetch() ?: throw ApiError::notFound();
        return ['timezone' => $r['timezone'], 'defaultServerId' => $r['default_guild_id']];
    }

    /** Merges the fields present in $in. */
    public function setSettings(int $botId, array $in): array
    {
        $current = $this->settings($botId);
        if (array_key_exists('timezone', $in)) {
            $current['timezone'] = self::timezone($in['timezone']);
        }
        if (array_key_exists('defaultServerId', $in)) {
            $g = $in['defaultServerId'];
            if ($g !== null && $g !== '' && (!is_string($g) || !preg_match('/^\d{15,21}$/', $g))) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'defaultServerId']);
            }
            // Must be a server the bot is in (when the bot has reported its servers).
            if (is_string($g) && $g !== '') {
                $known = $this->pdo->prepare('SELECT COUNT(*) FROM bot_guilds WHERE bot_id = ? AND left_at IS NULL');
                $known->execute([$botId]);
                $in = $this->pdo->prepare('SELECT 1 FROM bot_guilds WHERE bot_id = ? AND guild_id = ? AND left_at IS NULL');
                $in->execute([$botId, $g]);
                if ((int) $known->fetchColumn() > 0 && $in->fetchColumn() === false) {
                    throw new ApiError(422, 'error.timed.server', ['field' => 'defaultServerId']);
                }
            }
            $current['defaultServerId'] = $g === '' ? null : $g;
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $current): void {
            $pdo->prepare('UPDATE bots SET timezone = ?, default_guild_id = ?, updated_at = ' . self::NOW . ' WHERE id = ?')
                ->execute([$current['timezone'], $current['defaultServerId'], $botId]);
            Outbox::add($pdo, 'timed.changed', ['botId' => $botId]);
        });
        return $current;
    }

    /** @return array{name: string, kind: string, interval: ?int, times: string, weekdays: string, enabled: int} column order of the INSERT */
    private static function valid(array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 60) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'name']);
        }
        $kind = $in['kind'] ?? null;
        if ($kind !== 'interval' && $kind !== 'schedule') {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'kind']);
        }
        $interval = null;
        $times = [];
        if ($kind === 'interval') {
            $interval = $in['intervalSeconds'] ?? null;
            if (!is_int($interval) || $interval < self::MIN_INTERVAL || $interval > self::MAX_INTERVAL) {
                throw new ApiError(422, 'error.timed.interval', ['min' => self::MIN_INTERVAL]);
            }
        } else {
            $list = $in['times'] ?? null;
            if (!is_array($list) || $list === [] || count($list) > self::MAX_TIMES) {
                throw new ApiError(422, 'error.timed.times', ['max' => self::MAX_TIMES]);
            }
            foreach ($list as $t) {
                if (!is_string($t) || !preg_match('/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/', $t)) {
                    throw new ApiError(422, 'error.timed.times', ['max' => self::MAX_TIMES]);
                }
                $times[] = strlen($t) === 5 ? $t . ':00' : $t;
            }
            $times = array_values(array_unique($times));
            sort($times);
        }
        $weekdays = $in['weekdays'] ?? [];
        if (!is_array($weekdays)) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'weekdays']);
        }
        foreach ($weekdays as $d) {
            if (!is_int($d) || $d < 0 || $d > 6) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'weekdays']);
            }
        }
        $weekdays = array_values(array_unique($weekdays));
        sort($weekdays);
        $enabled = $in['enabled'] ?? true;
        if (!is_bool($enabled)) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'enabled']);
        }
        return [
            'name' => $name,
            'kind' => $kind,
            'interval' => $interval,
            'times' => json_encode($times),
            'weekdays' => json_encode($weekdays),
            'enabled' => $enabled ? 1 : 0,
        ];
    }

    private static function timezone(mixed $tz): string
    {
        if ($tz === '' || $tz === null) {
            return '';
        }
        if (is_string($tz) && strlen($tz) <= 64 && preg_match('#^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$#', $tz)) {
            try {
                new \DateTimeZone($tz);
                return $tz;
            } catch (\Exception) {
                // unknown name: 422 below
            }
        }
        throw new ApiError(422, 'error.validation.failed', ['field' => 'timezone']);
    }

    private static function json(array $r): array
    {
        return [
            'id' => (int) $r['id'],
            'name' => $r['name'],
            'kind' => $r['kind'],
            'intervalSeconds' => $r['interval_seconds'] === null ? null : (int) $r['interval_seconds'],
            'times' => json_decode($r['times'], true),
            'weekdays' => json_decode($r['weekdays'], true),
            'enabled' => $r['enabled'] === 1,
            'lastRunAt' => $r['last_run_at'],
            'updatedAt' => $r['updated_at'],
        ];
    }
}
