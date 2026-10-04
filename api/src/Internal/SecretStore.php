<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Global secrets: name, value, description (migration 0013, admin tab "API /
 * Secrets"). Secrets are write-only: no answer contains a value, not even
 * partly. Every change writes a server log entry and outbox secrets.changed,
 * so the bot drops its cache.
 */
final class SecretStore
{
    private const KEY = '/^[A-Z][A-Z0-9_]{1,39}$/';
    private const MAX = 100;
    private const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

    public function __construct(private readonly PDO $pdo, private readonly SecretBox $box)
    {
    }

    // ---------- secrets ----------

    public function secrets(): array
    {
        $rows = $this->pdo->query('SELECT key, description, length(value_enc) AS len, created_at, updated_at FROM secrets ORDER BY key')->fetchAll();
        // set: false for a placeholder a plugin install created ([NULL]: no value yet).
        return array_map(static fn (array $r) => [
            'key' => $r['key'], 'description' => $r['description'], 'set' => (int) $r['len'] > 0, 'createdAt' => $r['created_at'], 'updatedAt' => $r['updated_at'],
        ], $rows);
    }

    /** Decrypted value for internal use only (never in an answer or a log); null when unset. */
    public function value(string $key): ?string
    {
        $stmt = $this->pdo->prepare('SELECT value_enc FROM secrets WHERE key = ?');
        $stmt->execute([$key]);
        $enc = $stmt->fetchColumn();
        // An empty blob is a placeholder ([NULL]): no value yet.
        return is_string($enc) && $enc !== '' ? $this->box->decrypt($enc) : null;
    }

    /** Creates or updates; an empty value on update keeps the stored one. */
    public function saveSecret(string $key, array $in, string $actor): array
    {
        self::key($key, 'error.secret.key');
        $value = $in['value'] ?? '';
        $description = $in['description'] ?? '';
        if (!is_string($value) || strlen($value) > 4096) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'value']);
        }
        if (!is_string($description) || mb_strlen($description) > 200) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'description']);
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($key, $value, $description, $actor): void {
            $exists = $pdo->prepare('SELECT 1 FROM secrets WHERE key = ?');
            $exists->execute([$key]);
            if ($exists->fetchColumn() === false) {
                if ($value === '') {
                    throw new ApiError(422, 'error.secret.value_required');
                }
                if ((int) $pdo->query('SELECT COUNT(*) FROM secrets')->fetchColumn() >= self::MAX) {
                    throw new ApiError(422, 'error.secret.limit', ['max' => self::MAX]);
                }
                $stmt = $pdo->prepare('INSERT INTO secrets (key, value_enc, description) VALUES (?, ?, ?)');
                $stmt->bindValue(1, $key);
                $stmt->bindValue(2, $this->box->encrypt($value), PDO::PARAM_LOB);
                $stmt->bindValue(3, $description);
                $stmt->execute();
            } elseif ($value !== '') {
                $stmt = $pdo->prepare('UPDATE secrets SET value_enc = ?, description = ?, updated_at = ' . self::NOW . ' WHERE key = ?');
                $stmt->bindValue(1, $this->box->encrypt($value), PDO::PARAM_LOB);
                $stmt->bindValue(2, $description);
                $stmt->bindValue(3, $key);
                $stmt->execute();
            } else {
                $pdo->prepare('UPDATE secrets SET description = ?, updated_at = ' . self::NOW . ' WHERE key = ?')->execute([$description, $key]);
            }
            $this->log($pdo, 'log.server.secret_saved', $key, $actor);
        });
        foreach ($this->secrets() as $s) {
            if ($s['key'] === $key) {
                return $s;
            }
        }
        throw ApiError::notFound('error.secret.unknown');
    }

    public function deleteSecret(string $key, string $actor): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($key, $actor): void {
            $stmt = $pdo->prepare('DELETE FROM secrets WHERE key = ?');
            $stmt->execute([$key]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.secret.unknown');
            }
            $this->log($pdo, 'log.server.secret_deleted', $key, $actor);
        });
    }

    // ---------- helpers ----------

    private static function key(string $key, string $error): void
    {
        if (!preg_match(self::KEY, $key)) {
            throw new ApiError(422, $error);
        }
    }

    /** Server log (bot_id NULL) + outbox secrets.changed. Never contains a value. */
    private function log(PDO $pdo, string $logKey, string $key, string $actor): void
    {
        $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'change', ?, ?, 'api')")
            ->execute([$logKey, json_encode(['key' => $key, 'actor' => mb_substr($actor, 0, 64)], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)]);
        Outbox::add($pdo, 'secrets.changed', []);
    }
}
