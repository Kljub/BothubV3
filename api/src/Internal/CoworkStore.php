<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Co-Work of a bot: invites (link or to a user), saved roles and the
 * activity of the people who work on it. Members themselves are in
 * bot_members (BotStore). The gateway checks who may do this.
 */
final class CoworkStore
{
    private const ROLES = ['viewer', 'operator', 'builder', 'admin', 'custom'];
    private const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** Open invites of a bot (links that still work, user invites not answered). */
    public function invites(int $botId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT i.*, u.username FROM bot_invites i LEFT JOIN users u ON u.id = i.user_id
             WHERE i.bot_id = ? AND (i.expires_at IS NULL OR i.expires_at > " . self::NOW . ") AND (i.max_uses = 0 OR i.uses < i.max_uses)
             ORDER BY i.id DESC",
        );
        $stmt->execute([$botId]);
        return array_map($this->invite(...), $stmt->fetchAll());
    }

    /**
     * {kind: link|user, userId (user), role, permissions, roleName, expiresIn
     * (seconds, 0 = never), maxUses (0 = no limit)}. A link answers its token once.
     */
    public function createInvite(int $botId, int $by, array $in): array
    {
        $kind = $in['kind'] ?? '';
        $role = $in['role'] ?? '';
        $expires = $in['expiresIn'] ?? 0;
        $max = $in['maxUses'] ?? 0;
        if (!in_array($kind, ['link', 'user'], true) || !in_array($role, self::ROLES, true) || !is_int($expires) || $expires < 0 || $expires > 30 * 86400 || !is_int($max) || $max < 0 || $max > 1000) {
            throw new ApiError(422, 'error.validation', ['field' => 'invite']);
        }
        $userId = null;
        if ($kind === 'user') {
            $userId = $in['userId'] ?? 0;
            $u = $this->pdo->prepare('SELECT 1 FROM users WHERE id = ?');
            $u->execute([$userId]);
            if (!is_int($userId) || $u->fetchColumn() === false) {
                throw ApiError::notFound('error.user.not_found');
            }
            $max = 1;
        }
        $perms = $role === 'custom' ? array_values(array_map('strval', is_array($in['permissions'] ?? null) ? $in['permissions'] : [])) : [];
        $token = $kind === 'link' ? bin2hex(random_bytes(20)) : null;
        $expiresAt = $expires > 0 ? gmdate('Y-m-d\TH:i:s.000\Z', time() + $expires) : null;
        return Connection::write($this->pdo, function (PDO $pdo) use ($botId, $by, $kind, $role, $perms, $userId, $token, $expiresAt, $max, $in): array {
            if ($kind === 'user') {
                // One open invite per user and bot.
                $pdo->prepare("DELETE FROM bot_invites WHERE bot_id = ? AND kind = 'user' AND user_id = ?")->execute([$botId, $userId]);
            }
            $pdo->prepare('INSERT INTO bot_invites (bot_id, kind, token_hash, user_id, role, permissions, role_name, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$botId, $kind, $token === null ? null : hash('sha256', $token), $userId, $role, json_encode($perms), mb_substr((string) ($in['roleName'] ?? ''), 0, 40), $by, $expiresAt, $max]);
            $id = (int) $pdo->lastInsertId();
            $out = $this->invite($this->row($pdo, $id));
            if ($token !== null) {
                $out['token'] = $token;
            }
            return $out;
        });
    }

    public function revokeInvite(int $botId, int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM bot_invites WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        if ($stmt->rowCount() === 0) {
            throw ApiError::notFound('error.invite.unknown');
        }
    }

    /** Invites addressed to a user, with the bot's name. */
    public function userInvites(int $userId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT i.*, b.name AS bot_name, c.username AS by_name FROM bot_invites i JOIN bots b ON b.id = i.bot_id LEFT JOIN users c ON c.id = i.created_by
             WHERE i.kind = 'user' AND i.user_id = ? AND (i.expires_at IS NULL OR i.expires_at > " . self::NOW . ') ORDER BY i.id DESC',
        );
        $stmt->execute([$userId]);
        return array_map(fn (array $r) => $this->invite($r) + ['botName' => $r['bot_name'], 'byName' => $r['by_name']], $stmt->fetchAll());
    }

    /**
     * Accepts an invite: {token} (link) or {id} (to this user). The user
     * becomes a member with the invite's role. Answers {botId}.
     */
    public function accept(int $userId, array $in): array
    {
        return Connection::write($this->pdo, function (PDO $pdo) use ($userId, $in): array {
            if (is_string($in['token'] ?? null) && $in['token'] !== '') {
                $stmt = $pdo->prepare("SELECT * FROM bot_invites WHERE kind = 'link' AND token_hash = ?");
                $stmt->execute([hash('sha256', $in['token'])]);
            } else {
                $stmt = $pdo->prepare("SELECT * FROM bot_invites WHERE kind = 'user' AND id = ? AND user_id = ?");
                $stmt->execute([(int) ($in['id'] ?? 0), $userId]);
            }
            $inv = $stmt->fetch();
            $expired = $inv && $inv['expires_at'] !== null && $inv['expires_at'] <= gmdate('Y-m-d\TH:i:s.000\Z');
            if (!$inv || $expired || ((int) $inv['max_uses'] > 0 && (int) $inv['uses'] >= (int) $inv['max_uses'])) {
                throw new ApiError(410, 'error.invite.invalid');
            }
            $botId = (int) $inv['bot_id'];
            $owner = $pdo->prepare('SELECT owner_id FROM bots WHERE id = ?');
            $owner->execute([$botId]);
            if ((int) $owner->fetchColumn() !== $userId) {
                $pdo->prepare(
                    'INSERT INTO bot_members (bot_id, user_id, role, permissions, added_by) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (bot_id, user_id) DO UPDATE SET role = excluded.role, permissions = excluded.permissions',
                )->execute([$botId, $userId, $inv['role'], $inv['permissions'], $inv['created_by']]);
            }
            if ($inv['kind'] === 'user') {
                $pdo->prepare('DELETE FROM bot_invites WHERE id = ?')->execute([$inv['id']]);
            } else {
                $pdo->prepare('UPDATE bot_invites SET uses = uses + 1 WHERE id = ?')->execute([$inv['id']]);
            }
            $this->log($pdo, $botId, $userId, 'log.cowork.joined', ['role' => $inv['role']]);
            return ['botId' => $botId];
        });
    }

    public function decline(int $userId, int $id): void
    {
        $this->pdo->prepare("DELETE FROM bot_invites WHERE kind = 'user' AND id = ? AND user_id = ?")->execute([$id, $userId]);
    }

    public function savedRoles(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT id, name, permissions FROM bot_saved_roles WHERE bot_id = ? ORDER BY name');
        $stmt->execute([$botId]);
        return array_map(static fn (array $r) => ['id' => (int) $r['id'], 'name' => $r['name'], 'permissions' => json_decode($r['permissions'], true)], $stmt->fetchAll());
    }

    public function saveRole(int $botId, array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $perms = $in['permissions'] ?? [];
        if ($name === '' || mb_strlen($name) > 40 || !is_array($perms)) {
            throw new ApiError(422, 'error.validation', ['field' => 'role']);
        }
        $this->pdo->prepare('INSERT INTO bot_saved_roles (bot_id, name, permissions) VALUES (?, ?, ?) ON CONFLICT (bot_id, name) DO UPDATE SET permissions = excluded.permissions')
            ->execute([$botId, $name, json_encode(array_values(array_map('strval', $perms)))]);
        return $this->savedRoles($botId);
    }

    public function deleteRole(int $botId, int $id): void
    {
        $this->pdo->prepare('DELETE FROM bot_saved_roles WHERE id = ? AND bot_id = ?')->execute([$id, $botId]);
    }

    /** Changes and joins of the people who work on the bot, newest first. */
    public function activity(int $botId, int $limit = 50): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT l.at, l.key, l.params, u.username FROM logs l LEFT JOIN users u ON u.id = l.actor_user_id
             WHERE l.bot_id = ? AND l.key LIKE 'log.cowork.%' ORDER BY l.id DESC LIMIT " . max(1, min(200, $limit)),
        );
        $stmt->execute([$botId]);
        return array_map(static fn (array $r) => ['time' => $r['at'], 'key' => $r['key'], 'params' => json_decode((string) $r['params'], true) ?: (object) [], 'user' => $r['username']], $stmt->fetchAll());
    }

    /** {userId, area, method}: one change by a collaborator (written by the gateway). */
    public function addActivity(int $botId, array $in): void
    {
        $area = preg_replace('/[^a-z0-9_-]/', '', strtolower((string) ($in['area'] ?? ''))) ?: 'settings';
        $method = in_array($in['method'] ?? '', ['POST', 'PUT', 'PATCH', 'DELETE'], true) ? $in['method'] : 'PUT';
        $this->log($this->pdo, $botId, (int) ($in['userId'] ?? 0), 'log.cowork.change', ['area' => mb_substr($area, 0, 40), 'method' => $method]);
        // Keep the last 500 entries per bot.
        $this->pdo->prepare("DELETE FROM logs WHERE bot_id = ? AND key LIKE 'log.cowork.%' AND id NOT IN (SELECT id FROM logs WHERE bot_id = ? AND key LIKE 'log.cowork.%' ORDER BY id DESC LIMIT 500)")
            ->execute([$botId, $botId]);
    }

    private function log(PDO $pdo, int $botId, int $userId, string $key, array $params): void
    {
        $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source, actor_user_id) VALUES (?, 'change', ?, ?, 'dashboard', ?)")
            ->execute([$botId, $key, json_encode($params), $userId > 0 ? $userId : null]);
    }

    private function row(PDO $pdo, int $id): array
    {
        $stmt = $pdo->prepare('SELECT i.*, u.username FROM bot_invites i LEFT JOIN users u ON u.id = i.user_id WHERE i.id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch();
    }

    private function invite(array $r): array
    {
        return [
            'id' => (int) $r['id'], 'kind' => $r['kind'], 'role' => $r['role'], 'roleName' => $r['role_name'],
            'permissions' => json_decode($r['permissions'], true) ?: [], 'userId' => $r['user_id'] === null ? null : (int) $r['user_id'],
            'username' => $r['username'] ?? null, 'createdAt' => $r['created_at'], 'expiresAt' => $r['expires_at'],
            'maxUses' => (int) $r['max_uses'], 'uses' => (int) $r['uses'],
        ];
    }
}
