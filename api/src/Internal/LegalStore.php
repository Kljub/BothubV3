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
 *
 * Disclosures (settings key "legal.disclosures"): the privacy sections of
 * modules that store sensitive data (modules.json privacySection), e.g.
 * {"webVerify": {"since": "…", "module": "web-verify"}}. The first
 * activation of such a module adds its section; nothing ever removes it,
 * because stored data must stay explained after the module is switched off.
 */
final class LegalStore
{
    private const KEY = 'legal';
    private const DISCLOSURES = 'legal.disclosures';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return array{operator: string, address: string, email: string, sourceUrl: string, updatedAt: ?string, disclosures: array<string, array{since: string, module: string}>} */
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
            'disclosures' => (object) self::disclosures($this->pdo),
        ];
    }

    /** @return array<string, array{since: string, module: string}> */
    public static function disclosures(PDO $pdo): array
    {
        $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = ?');
        $stmt->execute([self::DISCLOSURES]);
        $v = json_decode((string) $stmt->fetchColumn(), true);
        $out = [];
        foreach (is_array($v) ? $v : [] as $section => $d) {
            if (is_string($section) && is_array($d)) {
                $out[$section] = ['since' => (string) ($d['since'] ?? ''), 'module' => (string) ($d['module'] ?? '')];
            }
        }
        return $out;
    }

    public static function disclosed(PDO $pdo, string $section): bool
    {
        return isset(self::disclosures($pdo)[$section]);
    }

    /**
     * Adds a privacy section once (inside the caller's write transaction).
     * A section that is there already keeps its date.
     */
    public static function disclose(PDO $pdo, string $section, string $module): void
    {
        $all = self::disclosures($pdo);
        if (isset($all[$section])) {
            return;
        }
        $all[$section] = ['since' => gmdate('Y-m-d\TH:i:s\Z'), 'module' => $module];
        $pdo->prepare("INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
            ->execute([self::DISCLOSURES, json_encode($all, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)]);
        $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'change', 'log.server.privacy_section_added', ?, 'api')")
            ->execute([json_encode(['section' => $section, 'module' => $module], JSON_THROW_ON_ERROR)]);
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
