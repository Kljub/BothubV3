<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\CommandPresets;
use BotHub\BotCore\Outbox;
use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Bot rows for the internal endpoints (mockapi until the real REST API).
 * Tokens are stored encrypted; bot JSON never contains them.
 */
final class BotStore
{
    private const COLUMNS = "b.id, b.name, b.application_id, b.avatar_url, b.status, b.status_error_key,
        b.token_enc IS NOT NULL AS token_set, b.autostart, b.created_at, b.started_at, b.owner_id,
        (SELECT json_group_array(json_object('userId', m.user_id, 'role', m.role, 'permissions', json(m.permissions))) FROM bot_members m WHERE m.bot_id = b.id) AS members,
        (SELECT COUNT(*) FROM bot_guilds g WHERE g.bot_id = b.id AND g.left_at IS NULL) AS guild_count";

    /** $owner: the signed-in user; a new bot belongs to them and uses their secrets. */
    public function __construct(private readonly PDO $pdo, private readonly SecretBox $box, private readonly ?PluginStore $plugins = null, private readonly int $owner = 1)
    {
    }

    /** @return list<array<string, mixed>> */
    public function all(): array
    {
        return array_map(self::json(...), $this->pdo->query('SELECT ' . self::COLUMNS . ' FROM bots b ORDER BY b.id')->fetchAll());
    }

    /** @return array<string, mixed>|null */
    public function find(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT ' . self::COLUMNS . ' FROM bots b WHERE b.id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row === false ? null : self::json($row);
    }

    public function token(int $id): ?string
    {
        $stmt = $this->pdo->prepare('SELECT token_enc FROM bots WHERE id = ?');
        $stmt->execute([$id]);
        $enc = $stmt->fetchColumn();
        return is_string($enc) ? $this->box->decrypt($enc) : null;
    }

    /**
     * @param array{name: string, token: string, applicationId: ?string, avatarUrl: ?string, autostart: bool} $in
     * @throws ApiError
     */
    public function create(array $in): array
    {
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($in): int {
            $fingerprint = $this->box->fingerprint($in['token']);
            $this->assertUnique($fingerprint, $in['applicationId'], null);
            $stmt = $pdo->prepare('INSERT INTO bots (name, application_id, avatar_url, token_enc, token_fingerprint, autostart, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
            $stmt->bindValue(1, $in['name']);
            $stmt->bindValue(2, $in['applicationId']);
            $stmt->bindValue(3, $in['avatarUrl']);
            $stmt->bindValue(4, $this->box->encrypt($in['token']), PDO::PARAM_LOB);
            $stmt->bindValue(5, $fingerprint, PDO::PARAM_LOB);
            $stmt->bindValue(6, $in['autostart'] ? 1 : 0, PDO::PARAM_INT);
            $stmt->bindValue(7, $this->owner, PDO::PARAM_INT);
            $stmt->execute();
            $id = (int) $pdo->lastInsertId();
            $pdo->prepare('INSERT INTO bot_profiles (bot_id) VALUES (?)')->execute([$id]);
            CommandPresets::seed($pdo, $id);
            // New bots start with every module switched off; the owner turns on what they need.
            $off = $pdo->prepare('INSERT OR IGNORE INTO bot_modules (bot_id, module_key, enabled) VALUES (?, ?, 0)');
            foreach (CommandStore::moduleKeys() as $key) {
                $off->execute([$id, $key]);
            }
            $this->plugins?->seedBot($pdo, $id); // command copies of installed plugins
            Outbox::add($pdo, 'bot.created', ['botId' => $id]);
            return $id;
        });
        return $this->find($id);
    }

    /**
     * @param array<string, mixed> $in name, token, autostart, avatarUrl, applicationId (each optional)
     * @throws ApiError
     */
    public function update(int $id, array $in): array
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($id, $in): void {
            if ($this->find($id) === null) {
                throw ApiError::notFound();
            }
            $sets = [];
            $params = [];
            foreach (['name' => 'name', 'avatarUrl' => 'avatar_url', 'applicationId' => 'application_id'] as $field => $column) {
                if (array_key_exists($field, $in)) {
                    $sets[] = "{$column} = ?";
                    $params[] = [$in[$field], PDO::PARAM_STR];
                }
            }
            if (array_key_exists('autostart', $in)) {
                $sets[] = 'autostart = ?';
                $params[] = [$in['autostart'] ? 1 : 0, PDO::PARAM_INT];
            }
            if (array_key_exists('token', $in)) {
                $fingerprint = $this->box->fingerprint($in['token']);
                $this->assertUnique($fingerprint, null, $id);
                $sets[] = 'token_enc = ?';
                $params[] = [$this->box->encrypt($in['token']), PDO::PARAM_LOB];
                $sets[] = 'token_fingerprint = ?';
                $params[] = [$fingerprint, PDO::PARAM_LOB];
            }
            if (array_key_exists('applicationId', $in) && $in['applicationId'] !== null) {
                $this->assertUnique(null, $in['applicationId'], $id);
            }
            if ($sets === []) {
                return;
            }
            $sets[] = "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
            $stmt = $pdo->prepare('UPDATE bots SET ' . implode(', ', $sets) . ' WHERE id = ?');
            foreach ($params as $i => [$value, $type]) {
                $stmt->bindValue($i + 1, $value, $value === null ? PDO::PARAM_NULL : $type);
            }
            $stmt->bindValue(count($params) + 1, $id, PDO::PARAM_INT);
            $stmt->execute();
            Outbox::add($pdo, 'bot.updated', ['botId' => $id]);
        });
        return $this->find($id);
    }

    /** @throws ApiError */
    public function delete(int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($id): void {
            $stmt = $pdo->prepare('DELETE FROM bots WHERE id = ?');
            $stmt->execute([$id]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound();
            }
            Outbox::add($pdo, 'bot.deleted', ['botId' => $id]);
        });
    }

    private const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
    private const ACTIVITIES = ['none', 'playing', 'streaming', 'listening', 'watching', 'competing'];

    /** Presence as the dashboard edits it; defaults fill missing fields. */
    public function presence(int $id): array
    {
        $this->find($id) ?? throw ApiError::notFound();
        $stmt = $this->pdo->prepare('SELECT presence FROM bot_profiles WHERE bot_id = ?');
        $stmt->execute([$id]);
        $raw = $stmt->fetchColumn();
        return self::normalizePresence(is_string($raw) ? (json_decode($raw, true) ?: []) : []);
    }

    /**
     * Merges the fields present in $in, stores the result and tells the bot
     * (outbox bot.presence).
     *
     * @throws ApiError
     */
    public function patchPresence(int $id, array $in): array
    {
        $p = $this->presence($id);
        if (array_key_exists('status', $in)) {
            if (!in_array($in['status'], self::STATUSES, true)) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'status']);
            }
            $p['status'] = $in['status'];
        }
        if (array_key_exists('activity', $in)) {
            $p['activity'] = self::activity($in['activity'], 'activity');
        }
        if (array_key_exists('customStatus', $in)) {
            if (!is_string($in['customStatus']) || mb_strlen($in['customStatus']) > 128) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'customStatus']);
            }
            $p['customStatus'] = $in['customStatus'];
        }
        if (array_key_exists('show', $in)) {
            if (!in_array($in['show'], ['activity', 'custom'], true)) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'show']);
            }
            $p['show'] = $in['show'];
        }
        if (array_key_exists('rotation', $in)) {
            $r = $in['rotation'];
            $interval = $r['intervalSeconds'] ?? null;
            if (!is_array($r) || !is_int($interval) || $interval < 30 || $interval > 3600 || !is_array($r['entries'] ?? []) || count($r['entries'] ?? []) > 20) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'rotation']);
            }
            $p['rotation'] = [
                'enabled' => ($r['enabled'] ?? false) === true,
                'intervalSeconds' => $interval,
                'entries' => array_map(fn ($e) => self::activity($e, 'rotation'), array_values($r['entries'] ?? [])),
            ];
        }
        $json = json_encode($p, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        Connection::write($this->pdo, function (PDO $pdo) use ($id, $json): void {
            $pdo->prepare("INSERT INTO bot_profiles (bot_id, presence) VALUES (?, ?)
                ON CONFLICT (bot_id) DO UPDATE SET presence = excluded.presence, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                ->execute([$id, $json]);
            Outbox::add($pdo, 'bot.presence', ['botId' => $id]);
        });
        return $p;
    }

    private static function activity(mixed $a, string $field): array
    {
        if (!is_array($a) || !in_array($a['type'] ?? null, self::ACTIVITIES, true) || !is_string($a['name'] ?? '') || mb_strlen($a['name'] ?? '') > 128) {
            throw new ApiError(422, 'error.validation.failed', ['field' => $field]);
        }
        $out = ['type' => $a['type'], 'name' => (string) ($a['name'] ?? '')];
        if (isset($a['url']) && $a['url'] !== '') {
            if (!is_string($a['url']) || !preg_match('#^https://(www\.)?(twitch\.tv|youtube\.com)/#', $a['url'])) {
                throw new ApiError(422, 'error.validation.failed', ['field' => $field . '.url']);
            }
            $out['url'] = $a['url'];
        }
        return $out;
    }

    private static function normalizePresence(array $p): array
    {
        $activity = is_array($p['activity'] ?? null) ? $p['activity'] : [];
        $rotation = is_array($p['rotation'] ?? null) ? $p['rotation'] : [];
        return [
            'status' => in_array($p['status'] ?? null, self::STATUSES, true) ? $p['status'] : 'online',
            'activity' => ['type' => in_array($activity['type'] ?? null, self::ACTIVITIES, true) ? $activity['type'] : 'none', 'name' => (string) ($activity['name'] ?? '')]
                + (isset($activity['url']) ? ['url' => (string) $activity['url']] : []),
            'customStatus' => (string) ($p['customStatus'] ?? ''),
            // Discord shows one activity of a bot: the activity (or rotation) or the custom status.
            'show' => ($p['show'] ?? null) === 'custom' ? 'custom' : 'activity',
            'rotation' => [
                'enabled' => ($rotation['enabled'] ?? false) === true,
                'intervalSeconds' => (int) ($rotation['intervalSeconds'] ?? 300),
                'entries' => array_values(is_array($rotation['entries'] ?? null) ? $rotation['entries'] : []),
            ],
        ];
    }

    private function assertUnique(?string $fingerprint, ?string $applicationId, ?int $exceptId): void
    {
        $checks = [];
        if ($fingerprint !== null) {
            $checks[] = ['token_fingerprint = ?', $fingerprint, PDO::PARAM_LOB];
        }
        if ($applicationId !== null && $applicationId !== '') {
            $checks[] = ['application_id = ?', $applicationId, PDO::PARAM_STR];
        }
        foreach ($checks as [$where, $value, $type]) {
            $stmt = $this->pdo->prepare("SELECT 1 FROM bots WHERE {$where} AND id != ?");
            $stmt->bindValue(1, $value, $type);
            $stmt->bindValue(2, $exceptId ?? 0, PDO::PARAM_INT);
            $stmt->execute();
            if ($stmt->fetchColumn() !== false) {
                throw new ApiError(409, 'error.bot.duplicate');
            }
        }
    }

    /** @param array<string, mixed> $r */
    /** Co-Work: adds or changes a member (role preset or custom with its permissions). */
    public function setMember(int $botId, int $userId, string $role, array $permissions, int $by): void
    {
        if ($this->find($botId) === null) {
            throw ApiError::notFound('error.bot.not_found');
        }
        if (!in_array($role, ['viewer', 'operator', 'builder', 'admin', 'custom'], true)) {
            throw new ApiError(422, 'error.validation', ['field' => 'role']);
        }
        $user = $this->pdo->prepare('SELECT 1 FROM users WHERE id = ?');
        $user->execute([$userId]);
        if ($user->fetchColumn() === false) {
            throw ApiError::notFound('error.user.not_found');
        }
        $perms = array_values(array_unique(array_filter(array_map('strval', $permissions), static fn ($p) => preg_match('/^[a-z]+\.[a-z_]+$/', $p) === 1)));
        $this->pdo->prepare(
            'INSERT INTO bot_members (bot_id, user_id, role, permissions, added_by) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (bot_id, user_id) DO UPDATE SET role = excluded.role, permissions = excluded.permissions',
        )->execute([$botId, $userId, $role, json_encode($role === 'custom' ? $perms : []), $by]);
    }

    public function removeMember(int $botId, int $userId): void
    {
        $this->pdo->prepare('DELETE FROM bot_members WHERE bot_id = ? AND user_id = ?')->execute([$botId, $userId]);
    }

    private static function json(array $r): array
    {
        return [
            'id' => (int) $r['id'],
            'name' => $r['name'],
            'applicationId' => $r['application_id'],
            'avatarUrl' => $r['avatar_url'],
            'status' => $r['status'],
            'statusErrorKey' => $r['status_error_key'],
            'tokenSet' => (bool) $r['token_set'],
            'autostart' => (bool) $r['autostart'],
            'guildCount' => (int) $r['guild_count'],
            'createdAt' => $r['created_at'],
            'startedAt' => $r['status'] === 'running' ? $r['started_at'] : null,
            // Co-Work: the owner and the other users who work on the bot.
            'ownerId' => (int) $r['owner_id'],
            'members' => json_decode((string) ($r['members'] ?? '[]'), true) ?: [],
        ];
    }
}
