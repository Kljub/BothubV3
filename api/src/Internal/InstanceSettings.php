<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Instance settings the gateway owns (settings key "server": domain, ports,
 * session hours, upload limit, automatic updates, restart policy; key
 * "registration": self-registration on/off and its role; key "smtp": the
 * mail server). The gateway validates them; this store only keeps them
 * across restarts. The SMTP password is encrypted (secret_enc, SecretBox),
 * never in the JSON value.
 * Internal routes only: GET /internal/settings/{key} ({value}), PUT (the object).
 */
final class InstanceSettings
{
    private const KEYS = ['server', 'registration', 'smtp', 'security'];
    /** Keys whose "password" field goes into secret_enc. */
    private const SECRET = ['smtp'];

    public function __construct(private readonly PDO $pdo, private readonly ?SecretBox $box = null)
    {
    }

    public static function known(string $key): bool
    {
        return in_array($key, self::KEYS, true);
    }

    /** The stored object, or an empty one (with "password" for keys that keep one). */
    public function get(string $key): object
    {
        $stmt = $this->pdo->prepare('SELECT value, secret_enc FROM settings WHERE key = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch();
        $v = json_decode((string) ($row['value'] ?? '{}'), false);
        $v = is_object($v) ? $v : new \stdClass();
        if (in_array($key, self::SECRET, true) && $this->box !== null) {
            $v->password = ($row['secret_enc'] ?? null) !== null ? $this->box->decrypt((string) $row['secret_enc']) : '';
        }
        return $v;
    }

    /** Stores the object; for secret keys a "password" field replaces the secret ("" removes it), no field keeps it. */
    public function put(string $key, array $in): void
    {
        $secret = in_array($key, self::SECRET, true);
        $password = $secret && array_key_exists('password', $in) ? (string) $in['password'] : null;
        unset($in['password']);
        $json = json_encode((object) $in, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > 16384 || ($password !== null && strlen($password) > 1024)) {
            throw new ApiError(422, 'error.validation.failed', ['field' => $key]);
        }
        if ($password !== null && $this->box === null) {
            throw new \LogicException('InstanceSettings needs a SecretBox for secrets');
        }
        $enc = $password === null || $password === '' ? null : $this->box->encrypt($password);
        Connection::write($this->pdo, static function (PDO $pdo) use ($key, $json, $password, $enc): void {
            $pdo->prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            )->execute([$key, $json]);
            if ($password !== null) {
                $stmt = $pdo->prepare('UPDATE settings SET secret_enc = ? WHERE key = ?');
                $stmt->bindValue(1, $enc, $enc === null ? PDO::PARAM_NULL : PDO::PARAM_LOB);
                $stmt->bindValue(2, $key);
                $stmt->execute();
            }
        });
    }
}
