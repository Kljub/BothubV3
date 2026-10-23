<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Accounts of the dashboard gateway: users (with password hash, 2FA secrets,
 * recovery code hashes, language, theme), roles and passkeys. The gateway
 * (Go) does the sign-in logic and keeps them in memory; this store keeps
 * them in the database so they survive restarts and can be several. Sign-in
 * sessions are kept by the SHA-256 of their cookie only. 2FA
 * secrets are encrypted at rest (SecretBox). Internal routes only.
 */
final class AccountStore
{
    public function __construct(private readonly PDO $pdo, private readonly SecretBox $box)
    {
    }

    /** Everything the gateway loads at start. */
    public function all(): array
    {
        $codes = [];
        foreach ($this->pdo->query('SELECT user_id, code_hash FROM user_recovery_codes WHERE used_at IS NULL')->fetchAll() as $c) {
            $codes[(int) $c['user_id']][] = $c['code_hash'];
        }
        $keys = [];
        foreach ($this->pdo->query('SELECT id, user_id, name, credential, created_at, last_used_at FROM passkeys ORDER BY created_at')->fetchAll() as $k) {
            $keys[] = ['id' => $k['id'], 'userId' => (int) $k['user_id'], 'name' => $k['name'], 'credential' => json_decode($k['credential'], false),
                'createdAt' => $k['created_at'], 'lastUsedAt' => $k['last_used_at']];
        }
        $users = array_map(fn (array $u) => [
            'id' => (int) $u['id'], 'username' => $u['username'], 'email' => $u['email'], 'roleId' => (int) $u['role_id'],
            'passwordHash' => $u['password_hash'], 'locale' => $u['locale'], 'theme' => $u['theme'],
            'totpSecret' => $u['totp_secret_enc'] === null ? '' : $this->box->decrypt($u['totp_secret_enc']),
            'totpPending' => $u['totp_pending_enc'] === null ? '' : $this->box->decrypt($u['totp_pending_enc']),
            'recoveryCodes' => $codes[(int) $u['id']] ?? [],
            'createdAt' => $u['created_at'], 'lastLoginAt' => $u['last_login_at'],
            'uiPrefs' => (object) json_decode($u['ui_prefs'] ?? '{}', true),
            'discordId' => $u['discord_id'] ?? '', 'discordName' => $u['discord_name'] ?? '',
            'trustedIps' => (object) json_decode($u['trusted_ips'] ?? '{}', true),
        ], $this->pdo->query('SELECT * FROM users ORDER BY id')->fetchAll());
        $roles = array_map(static fn (array $r) => [
            'id' => (int) $r['id'], 'key' => $r['key'], 'name' => $r['name'], 'builtin' => (int) $r['builtin'] === 1,
            'permissions' => json_decode($r['permissions'], true),
            'limits' => (object) json_decode($r['limits'] ?? '{}', true),
            'color' => $r['color'] ?? '', 'icon' => $r['icon'] ?? '',
        ], $this->pdo->query('SELECT * FROM roles ORDER BY id')->fetchAll());
        $this->pdo->prepare('DELETE FROM user_sessions WHERE expires_at < ?')->execute([gmdate('Y-m-d\TH:i:s\Z')]);
        $sessions = array_map(static fn (array $x) => [
            'keyHash' => $x['key_hash'], 'id' => $x['public_id'], 'userId' => (int) $x['user_id'], 'csrf' => $x['csrf'],
            'remember' => (int) $x['remember'] === 1, 'deviceKey' => $x['device_key'], 'userAgent' => $x['user_agent'], 'ip' => $x['ip'],
            'createdAt' => $x['created_at'], 'lastSeenAt' => $x['last_seen_at'], 'expiresAt' => $x['expires_at'],
        ], $this->pdo->query('SELECT * FROM user_sessions ORDER BY created_at')->fetchAll());
        $devices = array_map(fn (array $x) => [
            'keyHash' => $x['key_hash'], 'id' => $x['public_id'], 'userId' => (int) $x['user_id'], 'name' => $x['name'], 'platform' => $x['platform'],
            'appVersion' => $x['app_version'], 'publicKey' => $x['public_key'], 'pushToken' => $x['push_token'], 'pushPlatform' => $x['push_platform'],
            'notify' => json_decode($x['notify'], true) ?: [], 'ip' => $x['ip'], 'createdAt' => $x['created_at'], 'lastSeenAt' => $x['last_seen_at'],
            'guard' => (int) $x['guard'] === 1, 'guardSecret' => $x['guard_secret_enc'] === null ? '' : $this->box->decrypt($x['guard_secret_enc']),
        ], $this->pdo->query('SELECT * FROM mobile_devices ORDER BY created_at')->fetchAll());
        return ['users' => $users, 'roles' => $roles, 'passkeys' => $keys, 'sessions' => $sessions, 'devices' => $devices];
    }

    /** Adds or changes a user (the gateway's ID). */
    public function saveUser(int $id, array $in): void
    {
        $username = trim((string) ($in['username'] ?? ''));
        $hash = (string) ($in['passwordHash'] ?? '');
        $roleId = $in['roleId'] ?? 0;
        if ($id < 1 || mb_strlen($username) < 3 || mb_strlen($username) > 32 || $hash === '' || !is_int($roleId)) {
            throw new ApiError(422, 'error.validation', ['field' => 'user']);
        }
        $theme = in_array($in['theme'] ?? '', ['dark', 'light', 'system'], true) ? $in['theme'] : 'system';
        $seal = fn (mixed $v): ?string => is_string($v) && $v !== '' ? $this->box->encrypt($v) : null;
        // Dashboard preferences: a JSON object of at most 16 KB, else empty.
        $prefs = json_encode(is_array($in['uiPrefs'] ?? null) ? (object) $in['uiPrefs'] : new \stdClass(), JSON_UNESCAPED_UNICODE);
        if ($prefs === false || strlen($prefs) > 16384) {
            $prefs = '{}';
        }
        // Sign in with Discord: the linked account and hashes of addresses that finished a sign-in with 2FA.
        $discordId = is_string($in['discordId'] ?? null) && preg_match('/^\d{17,20}$/', $in['discordId']) ? $in['discordId'] : null;
        $discordName = $discordId === null ? null : mb_substr((string) ($in['discordName'] ?? ''), 0, 40);
        $trusted = [];
        foreach (is_array($in['trustedIps'] ?? null) ? $in['trustedIps'] : [] as $h => $at) {
            if (is_string($h) && preg_match('/^[0-9a-f]{32}$/', $h) && is_string($at) && strlen($at) <= 40 && count($trusted) < 20) {
                $trusted[$h] = $at;
            }
        }
        $trustedJson = json_encode((object) $trusted);
        Connection::write($this->pdo, function (PDO $pdo) use ($id, $username, $hash, $roleId, $theme, $in, $seal, $prefs, $discordId, $discordName, $trustedJson): void {
            $stmt = $pdo->prepare(
                'INSERT INTO users (id, username, email, password_hash, role_id, locale, theme, totp_secret_enc, totp_pending_enc, last_login_at, ui_prefs,
                   discord_id, discord_name, trusted_ips)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET username = excluded.username, email = excluded.email, password_hash = excluded.password_hash,
                   role_id = excluded.role_id, locale = excluded.locale, theme = excluded.theme, totp_secret_enc = excluded.totp_secret_enc,
                   totp_pending_enc = excluded.totp_pending_enc, last_login_at = excluded.last_login_at, ui_prefs = excluded.ui_prefs,
                   discord_id = excluded.discord_id, discord_name = excluded.discord_name, trusted_ips = excluded.trusted_ips',
            );
            $values = [$id, $username, ($in['email'] ?? null) ?: null, $hash, $roleId, mb_substr((string) ($in['locale'] ?? 'en'), 0, 8), $theme,
                $seal($in['totpSecret'] ?? ''), $seal($in['totpPending'] ?? ''), $in['lastLoginAt'] ?? null, $prefs, $discordId, $discordName, $trustedJson];
            foreach ($values as $i => $v) {
                // The 2FA secrets are BLOB columns (STRICT tables).
                $stmt->bindValue($i + 1, $v, $v === null ? PDO::PARAM_NULL : ($i === 7 || $i === 8 ? PDO::PARAM_LOB : PDO::PARAM_STR));
            }
            $stmt->execute();
            if (array_key_exists('recoveryCodes', $in) && is_array($in['recoveryCodes'])) {
                $pdo->prepare('DELETE FROM user_recovery_codes WHERE user_id = ?')->execute([$id]);
                $add = $pdo->prepare('INSERT OR IGNORE INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)');
                foreach (array_slice($in['recoveryCodes'], 0, 20) as $c) {
                    $add->execute([$id, (string) $c]);
                }
            }
        });
    }

    public function deleteUser(int $id): void
    {
        $this->pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
    }

    public function saveRole(int $id, array $in): void
    {
        $key = (string) ($in['key'] ?? '');
        $name = trim((string) ($in['name'] ?? ''));
        $perms = $in['permissions'] ?? [];
        if ($id < 1 || !preg_match('/^[a-z][a-z0-9_-]{0,31}$/', $key) || $name === '' || mb_strlen($name) > 40 || !is_array($perms)) {
            throw new ApiError(422, 'error.validation', ['field' => 'role']);
        }
        // Color and icon: names from the gateway's lists (a-z, max. 16).
        $style = static fn (string $k): string => is_string($in[$k] ?? null) && preg_match('/^[a-z]{1,16}$/', $in[$k]) ? $in[$k] : '';
        // Limits: whole numbers 0..10000 per known key; other keys are dropped.
        $limits = [];
        foreach (['maxBots', 'maxRunning', 'idleStopHours'] as $k) {
            $v = $in['limits'][$k] ?? null;
            if (is_int($v) && $v >= 0 && $v <= 10000) {
                $limits[$k] = $v;
            }
        }
        $this->pdo->prepare(
            'INSERT INTO roles (id, key, name, builtin, permissions, limits, color, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET key = excluded.key, name = excluded.name, builtin = excluded.builtin, permissions = excluded.permissions,
               limits = excluded.limits, color = excluded.color, icon = excluded.icon',
        )->execute([$id, $key, $name, ($in['builtin'] ?? false) === true ? 1 : 0, json_encode(array_values(array_map('strval', $perms))), json_encode((object) $limits), $style('color'), $style('icon')]);
    }

    public function deleteRole(int $id): void
    {
        $used = $this->pdo->prepare('SELECT COUNT(*) FROM users WHERE role_id = ?');
        $used->execute([$id]);
        if ((int) $used->fetchColumn() > 0) {
            throw new ApiError(409, 'error.role.in_use');
        }
        $this->pdo->prepare('DELETE FROM roles WHERE id = ? AND builtin = 0')->execute([$id]);
    }

    public function savePasskey(string $id, array $in): void
    {
        $userId = $in['userId'] ?? 0;
        $name = trim((string) ($in['name'] ?? ''));
        if ($id === '' || strlen($id) > 400 || !is_int($userId) || $name === '' || mb_strlen($name) > 60 || !isset($in['credential'])) {
            throw new ApiError(422, 'error.validation', ['field' => 'passkey']);
        }
        $this->pdo->prepare(
            'INSERT INTO passkeys (id, user_id, name, credential, created_at, last_used_at) VALUES (?, ?, ?, ?, COALESCE(?, strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')), ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, credential = excluded.credential, last_used_at = excluded.last_used_at',
        )->execute([$id, $userId, $name, json_encode($in['credential'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), $in['createdAt'] ?? null, $in['lastUsedAt'] ?? null]);
    }

    public function deletePasskey(string $id): void
    {
        $this->pdo->prepare('DELETE FROM passkeys WHERE id = ?')->execute([$id]);
    }

    /** Adds or changes a sign-in session (key: SHA-256 hex of the cookie). */
    public function saveSession(string $keyHash, array $in): void
    {
        $userId = $in['userId'] ?? 0;
        $time = static fn (mixed $v): bool => is_string($v) && strtotime($v) !== false;
        $deviceKey = $in['deviceKey'] ?? null;
        if (!preg_match('/^[0-9a-f]{64}$/', $keyHash) || !is_int($userId) || $userId < 1 || !preg_match('/^[0-9a-f]{8,64}$/', (string) ($in['id'] ?? ''))
            || !is_string($in['csrf'] ?? null) || $in['csrf'] === '' || !$time($in['createdAt'] ?? null) || !$time($in['lastSeenAt'] ?? null)
            || !$time($in['expiresAt'] ?? null) || ($deviceKey !== null && (!is_string($deviceKey) || strlen($deviceKey) > 400))) {
            throw new ApiError(422, 'error.validation', ['field' => 'session']);
        }
        $this->pdo->prepare(
            'INSERT INTO user_sessions (key_hash, public_id, user_id, csrf, remember, device_key, user_agent, ip, created_at, last_seen_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (key_hash) DO UPDATE SET user_agent = excluded.user_agent, ip = excluded.ip, last_seen_at = excluded.last_seen_at,
               expires_at = excluded.expires_at',
        )->execute([$keyHash, $in['id'], $userId, $in['csrf'], ($in['remember'] ?? false) === true ? 1 : 0, $deviceKey ?: null,
            mb_substr((string) ($in['userAgent'] ?? ''), 0, 300), mb_substr((string) ($in['ip'] ?? ''), 0, 64),
            $in['createdAt'], $in['lastSeenAt'], $in['expiresAt']]);
    }

    public function deleteSession(string $keyHash): void
    {
        $this->pdo->prepare('DELETE FROM user_sessions WHERE key_hash = ?')->execute([$keyHash]);
    }

    /** Adds or changes a paired phone of the mobile app (key: SHA-256 hex of its token). */
    public function saveDevice(string $keyHash, array $in): void
    {
        $userId = $in['userId'] ?? 0;
        $time = static fn (mixed $v): bool => is_string($v) && strtotime($v) !== false;
        $notify = $in['notify'] ?? [];
        if (!preg_match('/^[0-9a-f]{64}$/', $keyHash) || !is_int($userId) || $userId < 1 || !preg_match('/^[0-9a-f]{8,64}$/', (string) ($in['id'] ?? ''))
            || !is_string($in['name'] ?? null) || $in['name'] === '' || mb_strlen($in['name']) > 40 || !in_array($in['platform'] ?? null, ['android', 'ios'], true)
            || !is_string($in['publicKey'] ?? null) || strlen($in['publicKey']) > 400 || !is_array($notify)
            || !$time($in['createdAt'] ?? null) || !$time($in['lastSeenAt'] ?? null)) {
            throw new ApiError(422, 'error.validation', ['field' => 'device']);
        }
        $stmt = $this->pdo->prepare(
            'INSERT INTO mobile_devices (key_hash, public_id, user_id, name, platform, app_version, public_key, push_token, push_platform, notify, ip, created_at, last_seen_at, guard, guard_secret_enc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (key_hash) DO UPDATE SET name = excluded.name, app_version = excluded.app_version, push_token = excluded.push_token,
               push_platform = excluded.push_platform, notify = excluded.notify, ip = excluded.ip, last_seen_at = excluded.last_seen_at, guard = excluded.guard',
        );
        $values = [$keyHash, $in['id'], $userId, $in['name'], $in['platform'], mb_substr((string) ($in['appVersion'] ?? ''), 0, 20), $in['publicKey'],
            mb_substr((string) ($in['pushToken'] ?? ''), 0, 4096), mb_substr((string) ($in['pushPlatform'] ?? ''), 0, 10),
            json_encode(array_values(array_filter($notify, 'is_string'))), mb_substr((string) ($in['ip'] ?? ''), 0, 64), $in['createdAt'], $in['lastSeenAt'],
            ($in['guard'] ?? false) === true ? 1 : 0, is_string($in['guardSecret'] ?? null) && $in['guardSecret'] !== '' ? $this->box->encrypt($in['guardSecret']) : null];
        // The secret is a BLOB (STRICT table): bound as LOB, the rest as text and numbers.
        foreach ($values as $n => $v) {
            $stmt->bindValue($n + 1, $v, $n === 14 && $v !== null ? PDO::PARAM_LOB : (is_int($v) ? PDO::PARAM_INT : ($v === null ? PDO::PARAM_NULL : PDO::PARAM_STR)));
        }
        $stmt->execute();
    }

    public function deleteDevice(string $keyHash): void
    {
        $this->pdo->prepare('DELETE FROM mobile_devices WHERE key_hash = ?')->execute([$keyHash]);
    }
}
