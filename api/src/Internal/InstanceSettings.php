<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Instance settings the gateway owns (settings key "server": domain, ports,
 * session hours, upload limit, automatic updates, restart policy). The
 * gateway validates them; this store only keeps them across restarts.
 * Internal routes only: GET /internal/settings/server ({value}), PUT (the object).
 */
final class InstanceSettings
{
    private const KEYS = ['server'];

    public function __construct(private readonly PDO $pdo)
    {
    }

    public static function known(string $key): bool
    {
        return in_array($key, self::KEYS, true);
    }

    /** The stored object, or an empty one. */
    public function get(string $key): object
    {
        $stmt = $this->pdo->prepare('SELECT value FROM settings WHERE key = ?');
        $stmt->execute([$key]);
        $v = json_decode((string) ($stmt->fetchColumn() ?: '{}'), false);
        return is_object($v) ? $v : new \stdClass();
    }

    public function put(string $key, array $in): void
    {
        $json = json_encode((object) $in, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > 16384) {
            throw new ApiError(422, 'error.validation.failed', ['field' => $key]);
        }
        Connection::write($this->pdo, static function (PDO $pdo) use ($key, $json): void {
            $pdo->prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            )->execute([$key, $json]);
        });
    }
}
