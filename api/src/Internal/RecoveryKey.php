<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Recovery key of the instance (table recovery_key, one row).
 *
 * An admin creates it in the dashboard (Admin → Security); it is shown once,
 * only its Argon2id hash is stored. With it the owner of the server gets the
 * admin account back on the command line (bin/recover-admin.php through
 * "start-app recover-admin"): a new password, 2FA, passkeys and sessions of
 * that account gone. The key works once and can do nothing else: no access
 * to bots, tokens or other data.
 */
final class RecoveryKey
{
    private const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return array{set: bool, createdAt: ?string, createdBy: string} */
    public function status(): array
    {
        $row = $this->pdo->query('SELECT created_at, created_by FROM recovery_key WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
        return ['set' => $row !== false, 'createdAt' => $row['created_at'] ?? null, 'createdBy' => (string) ($row['created_by'] ?? '')];
    }

    /** A new key (an old one stops working); the plain key is returned only here. */
    public function create(string $by): string
    {
        $chars = '';
        for ($i = 0; $i < 30; $i++) {
            $chars .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
        }
        // BHRK- and 6 groups of 5: 150 bits.
        $key = 'BHRK-' . implode('-', str_split($chars, 5));
        $hash = password_hash(self::normalize($key), PASSWORD_ARGON2ID);
        Connection::write($this->pdo, function (PDO $pdo) use ($hash, $by): void {
            $pdo->prepare('INSERT INTO recovery_key (id, key_hash, created_by) VALUES (1, ?, ?)
                ON CONFLICT (id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, created_by = excluded.created_by')
                ->execute([$hash, mb_substr($by, 0, 64)]);
            $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'change', 'log.server.recovery_key_created', ?, 'api')")
                ->execute([json_encode(['by' => $by])]);
        });
        return $key;
    }

    public static function normalize(string $key): string
    {
        return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $key) ?? '');
    }

    /**
     * Uses the key: the admin (by name, else the first account with the
     * admin role) gets a new password; its 2FA, recovery codes, passkeys and
     * sessions go; the key is used up.
     *
     * @return array{username: string, password: string}
     * @throws \RuntimeException wrong key, no key, no admin
     */
    public function recover(string $key, string $username = ''): array
    {
        $row = $this->pdo->query('SELECT key_hash FROM recovery_key WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            throw new \RuntimeException('no recovery key is set up (create one in the dashboard: Admin → Security)');
        }
        if (!password_verify(self::normalize($key), (string) $row['key_hash'])) {
            throw new \RuntimeException('wrong recovery key');
        }
        if ($username !== '') {
            $stmt = $this->pdo->prepare('SELECT u.id, u.username FROM users u WHERE u.username = ?');
            $stmt->execute([$username]);
        } else {
            $stmt = $this->pdo->query("SELECT u.id, u.username FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'admin' ORDER BY u.id LIMIT 1");
        }
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($user === false) {
            throw new \RuntimeException($username !== '' ? "no user named {$username}" : 'there is no admin account');
        }
        $password = '';
        for ($i = 0; $i < 20; $i++) {
            $password .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
        }
        $id = (int) $user['id'];
        Connection::write($this->pdo, function (PDO $pdo) use ($id, $password, $user): void {
            $pdo->prepare('UPDATE users SET password_hash = ?, totp_secret_enc = NULL, totp_pending_enc = NULL, password_changed_at = ? WHERE id = ?')
                ->execute([password_hash($password, PASSWORD_ARGON2ID), gmdate('Y-m-d\TH:i:s\Z'), $id]);
            // The admin role, in case the account was moved to another one.
            $pdo->prepare("UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'admin') WHERE id = ? AND EXISTS (SELECT 1 FROM roles WHERE key = 'admin')")->execute([$id]);
            foreach (['user_recovery_codes', 'passkeys', 'user_sessions'] as $table) {
                $pdo->prepare("DELETE FROM {$table} WHERE user_id = ?")->execute([$id]);
            }
            $pdo->exec('DELETE FROM recovery_key');
            $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'warning', 'log.server.admin_recovered', ?, 'api')")
                ->execute([json_encode(['user' => $user['username']])]);
        });
        return ['username' => (string) $user['username'], 'password' => $password];
    }
}
