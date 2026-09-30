<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;

/**
 * Webhooks module (migration 0009): incoming HTTP calls that start custom
 * events of type "webhook". One API key per bot, stored as SHA-256 hash
 * plus the last 4 characters; the key is shown once when it is created.
 * A call writes outbox webhook.called; the bot runs the matching events.
 */
final class WebhookStore
{
    private const MAX = 50;
    private const EVENT_ID = '/^[a-z0-9]{16,40}$/';
    private const VAR_NAME = '/^[A-Za-z0-9_]{1,32}$/';
    public const MAX_BODY = 65536;

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** {items: [Webhook], apiKey: {set, hint, createdAt}} */
    public function list(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM webhooks WHERE bot_id = ? ORDER BY id');
        $stmt->execute([$botId]);
        $key = $this->pdo->prepare('SELECT hint, created_at FROM webhook_keys WHERE bot_id = ?');
        $key->execute([$botId]);
        $k = $key->fetch();
        return [
            'items' => array_map(self::json(...), $stmt->fetchAll()),
            'apiKey' => ['set' => $k !== false, 'hint' => $k ? '…' . $k['hint'] : null, 'createdAt' => $k ? $k['created_at'] : null],
        ];
    }

    public function create(int $botId, array $in): array
    {
        $eventId = $in['eventId'] ?? null;
        if (!is_string($eventId) || !preg_match(self::EVENT_ID, $eventId)) {
            throw new ApiError(422, 'error.webhook.event_id');
        }
        $name = self::name($in['name'] ?? null);
        $requireKey = ($in['requireKey'] ?? true) === true;
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $eventId, $name, $requireKey): int {
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM webhooks WHERE bot_id = ?');
            $stmt->execute([$botId]);
            if ((int) $stmt->fetchColumn() >= self::MAX) {
                throw new ApiError(422, 'error.webhook.limit', ['max' => self::MAX]);
            }
            $stmt = $pdo->prepare('SELECT 1 FROM webhooks WHERE bot_id = ? AND event_id = ?');
            $stmt->execute([$botId, $eventId]);
            if ($stmt->fetchColumn() !== false) {
                throw new ApiError(409, 'error.webhook.event_taken');
            }
            $pdo->prepare('INSERT INTO webhooks (bot_id, event_id, name, require_key) VALUES (?, ?, ?, ?)')->execute([$botId, $eventId, $name, $requireKey ? 1 : 0]);
            return (int) $pdo->lastInsertId();
        });
        return $this->get($botId, $id);
    }

    public function patch(int $botId, int $id, array $in): array
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $in): void {
            $this->get($botId, $id);
            if (array_key_exists('name', $in)) {
                $pdo->prepare('UPDATE webhooks SET name = ? WHERE id = ?')->execute([self::name($in['name']), $id]);
            }
            foreach (['requireKey' => 'require_key', 'enabled' => 'enabled'] as $field => $column) {
                if (array_key_exists($field, $in)) {
                    if (!is_bool($in[$field])) {
                        throw new ApiError(422, 'error.validation.failed', ['field' => $field]);
                    }
                    $pdo->prepare("UPDATE webhooks SET {$column} = ? WHERE id = ?")->execute([$in[$field] ? 1 : 0, $id]);
                }
            }
        });
        return $this->get($botId, $id);
    }

    public function delete(int $botId, int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id): void {
            $stmt = $pdo->prepare('DELETE FROM webhooks WHERE id = ? AND bot_id = ?');
            $stmt->execute([$id, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.webhook.unknown');
            }
        });
    }

    public function get(int $botId, int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM webhooks WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        return self::json($stmt->fetch() ?: throw ApiError::notFound('error.webhook.unknown'));
    }

    /** Creates a new key (the old one stops working) and returns it once. */
    public function newKey(int $botId): string
    {
        $key = 'bh_' . rtrim(strtr(base64_encode(random_bytes(30)), '+/', '-_'), '=');
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $key): void {
            $stmt = $pdo->prepare('INSERT INTO webhook_keys (bot_id, key_hash, hint, created_at) VALUES (?, ?, ?, strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'))
                ON CONFLICT (bot_id) DO UPDATE SET key_hash = excluded.key_hash, hint = excluded.hint, created_at = excluded.created_at');
            $stmt->bindValue(1, $botId, PDO::PARAM_INT);
            $stmt->bindValue(2, hash('sha256', $key, true), PDO::PARAM_LOB);
            $stmt->bindValue(3, substr($key, -4));
            $stmt->execute();
        });
        return $key;
    }

    /** Test call from the dashboard: like a real call, without the key. */
    public function test(int $botId, int $id, array $in): void
    {
        $hook = $this->get($botId, $id);
        $vars = self::variables(['variables' => $in['variables'] ?? []]);
        $this->fire($botId, $hook['eventId'], $hook['name'], json_encode(['variables' => (object) $vars], JSON_UNESCAPED_UNICODE), $vars);
    }

    /**
     * Public receiver POST /api/hooks/{botId}/{eventId}.
     *
     * @throws ApiError 401 key, 404 unknown/disabled, 415 json
     */
    public function receive(int $botId, string $eventId, ?string $authorization, string $body): void
    {
        if (!preg_match(self::EVENT_ID, $eventId)) {
            throw ApiError::notFound('error.webhook.unknown');
        }
        $stmt = $this->pdo->prepare('SELECT name, require_key, enabled FROM webhooks WHERE bot_id = ? AND event_id = ?');
        $stmt->execute([$botId, $eventId]);
        $hook = $stmt->fetch();
        if ($hook === false || $hook['enabled'] !== 1) {
            throw ApiError::notFound('error.webhook.unknown');
        }
        if ($hook['require_key'] === 1) {
            $key = $this->pdo->prepare('SELECT key_hash FROM webhook_keys WHERE bot_id = ?');
            $key->execute([$botId]);
            $hash = $key->fetchColumn();
            $given = trim(preg_replace('/^Bearer\s+/i', '', (string) $authorization));
            if (!is_string($hash) || $given === '' || !hash_equals($hash, hash('sha256', $given, true))) {
                throw new ApiError(401, 'error.webhook.key');
            }
        }
        $data = $body === '' ? [] : json_decode($body, true);
        if ($body !== '' && json_last_error() !== JSON_ERROR_NONE) {
            throw new ApiError(415, 'error.webhook.json');
        }
        $this->fire($botId, $eventId, $hook['name'], $body, self::variables(is_array($data) ? $data : []));
    }

    /**
     * Variables of a call: {"variables": {"a": "1"}} or the BotGhost form
     * {"variables": [{"name": "a", "value": "1"}]}. Invalid names are skipped.
     *
     * @return array<string, string>
     */
    public static function variables(array $data): array
    {
        $raw = $data['variables'] ?? [];
        $pairs = [];
        if (is_array($raw) && array_is_list($raw)) {
            foreach ($raw as $v) {
                if (is_array($v) && isset($v['name'])) {
                    $pairs[(string) $v['name']] = $v['value'] ?? '';
                }
            }
        } elseif (is_array($raw)) {
            $pairs = $raw;
        }
        $out = [];
        foreach ($pairs as $name => $value) {
            if (count($out) >= 50 || !preg_match(self::VAR_NAME, (string) $name)) {
                continue;
            }
            $out[(string) $name] = mb_substr(is_scalar($value) ? (string) $value : json_encode($value, JSON_UNESCAPED_UNICODE), 0, 1000);
        }
        return $out;
    }

    private function fire(int $botId, string $eventId, string $name, string $body, array $vars): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $eventId, $name, $body, $vars): void {
            $pdo->prepare("UPDATE webhooks SET calls = calls + 1, last_called_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bot_id = ? AND event_id = ?")
                ->execute([$botId, $eventId]);
            Outbox::add($pdo, 'webhook.called', [
                'botId' => $botId,
                'eventId' => $eventId,
                'name' => $name,
                'body' => mb_substr($body, 0, 4000),
                'variables' => (object) $vars,
            ]);
        });
    }

    private static function name(mixed $v): string
    {
        if (!is_string($v) || trim($v) === '' || mb_strlen(trim($v)) > 60) {
            throw new ApiError(422, 'error.webhook.name');
        }
        return trim($v);
    }

    private static function json(array $r): array
    {
        return [
            'id' => (int) $r['id'],
            'eventId' => $r['event_id'],
            'name' => $r['name'],
            'requireKey' => $r['require_key'] === 1,
            'enabled' => $r['enabled'] === 1,
            'url' => "/api/hooks/{$r['bot_id']}/{$r['event_id']}",
            'calls' => (int) $r['calls'],
            'lastCalledAt' => $r['last_called_at'],
            'createdAt' => $r['created_at'],
        ];
    }
}
