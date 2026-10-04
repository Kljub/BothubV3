<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Operator details for the public Terms of Service and Privacy Policy pages
 * (settings key "legal"): who runs this BotHub instance and how to reach
 * them. Public on purpose: the pages need it without a login. The contact
 * e-mail may stay empty; the dashboard then shows the admin's e-mail.
 */
final class LegalStore
{
    private const KEY = 'legal';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return array{operator: string, address: string, email: string, sourceUrl: string, updatedAt: ?string} */
    public function get(): array
    {
        $stmt = $this->pdo->prepare('SELECT value, updated_at FROM settings WHERE key = ?');
        $stmt->execute([self::KEY]);
        $row = $stmt->fetch();
        $v = $row ? json_decode((string) $row['value'], true) : null;
        $v = is_array($v) ? $v : [];
        return [
            'operator' => (string) ($v['operator'] ?? ''),
            'address' => (string) ($v['address'] ?? ''),
            'email' => (string) ($v['email'] ?? ''),
            'sourceUrl' => (string) ($v['sourceUrl'] ?? ''),
            'updatedAt' => $row ? (string) $row['updated_at'] : null,
        ];
    }

    public function save(array $in, string $actor): array
    {
        $operator = trim((string) ($in['operator'] ?? ''));
        $address = trim(str_replace("\r\n", "\n", (string) ($in['address'] ?? '')));
        $email = trim((string) ($in['email'] ?? ''));
        $source = trim((string) ($in['sourceUrl'] ?? ''));
        if ($source !== '' && (mb_strlen($source) > 300 || !preg_match('#^https://[^\s<>"]+$#', $source))) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'sourceUrl']);
        }
        if (mb_strlen($operator) > 120) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'operator']);
        }
        if (mb_strlen($address) > 300) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'address']);
        }
        if ($email !== '' && (mb_strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false)) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'email']);
        }
        $json = json_encode(['operator' => $operator, 'address' => $address, 'email' => $email, 'sourceUrl' => $source], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        Connection::write($this->pdo, function (PDO $pdo) use ($json, $actor): void {
            $pdo->prepare("INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                ->execute([self::KEY, $json]);
            $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'change', 'log.server.legal_saved', ?, 'api')")
                ->execute([json_encode(['actor' => mb_substr($actor, 0, 64)], JSON_THROW_ON_ERROR)]);
        });
        return $this->get();
    }
}
