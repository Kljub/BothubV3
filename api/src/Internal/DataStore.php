<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Data Storage module (migration 0007): variables defined on the dashboard
 * and their stored values. Blocks reference them as {var.<key>}; "used in"
 * counts commands and events whose graph contains var.<key>. Same rules as
 * the bot (bot/src/core/datastore.ts) and the mock.
 */
final class DataStore
{
    public const MAX_VARIABLES = 200;
    public const MAX_VALUES = 100000;
    private const PAGE_SIZE = 25;
    public const EXPORT_ROWS = 5000;
    private const TYPES = ['text', 'number', 'list', 'object', 'object_list'];
    private const OWNERS = ['shared', 'member', 'channel'];
    private const KEY = '/^[a-z][a-z0-9_]{0,31}$/';
    private const SNOWFLAKE = '/^\d{17,20}$/';
    private const NUMBER = '/^\s*-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return list<array<string, mixed>> sorted by group, then name */
    public function list(int $botId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT v.*, (SELECT COUNT(*) FROM data_values d WHERE d.variable_id = v.id) AS value_count
             FROM data_variables v WHERE v.bot_id = ? ORDER BY lower(v.group_name), lower(v.name)',
        );
        $stmt->execute([$botId]);
        $graphs = $this->pdo->prepare('SELECT graph FROM commands WHERE bot_id = ?');
        $graphs->execute([$botId]);
        $all = $graphs->fetchAll(PDO::FETCH_COLUMN);
        return array_map(fn (array $row) => self::json($row, $all), $stmt->fetchAll());
    }

    public function get(int $botId, int $id): array
    {
        foreach ($this->list($botId) as $v) {
            if ($v['id'] === $id) {
                return $v;
            }
        }
        throw ApiError::notFound('error.data.unknown');
    }

    public function create(int $botId, array $in): array
    {
        $v = self::input($in);
        $key = is_string($in['key'] ?? null) && $in['key'] !== '' ? $in['key'] : self::keyFromName($v['name']);
        if (!preg_match(self::KEY, $key)) {
            throw new ApiError(422, 'error.data.key');
        }
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $key, $v): int {
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM data_variables WHERE bot_id = ?');
            $stmt->execute([$botId]);
            if ((int) $stmt->fetchColumn() >= self::MAX_VARIABLES) {
                throw new ApiError(422, 'error.data.limit');
            }
            $stmt = $pdo->prepare('SELECT 1 FROM data_variables WHERE bot_id = ? AND key = ?');
            $stmt->execute([$botId, $key]);
            if ($stmt->fetchColumn() !== false) {
                throw new ApiError(409, 'error.data.key_taken');
            }
            $pdo->prepare('INSERT INTO data_variables (bot_id, key, name, description, type, owner, per_server, default_value, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$botId, $key, $v['name'], $v['description'], $v['type'], $v['owner'], $v['perServer'] ? 1 : 0, $v['defaultValue'], $v['group']]);
            return (int) $pdo->lastInsertId();
        });
        return $this->get($botId, $id);
    }

    /** The key stays; a new type, owner or server setting drops the stored values. */
    public function update(int $botId, int $id, array $in): array
    {
        $v = self::input($in);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $v): void {
            $old = $this->row($botId, $id);
            if ($old['type'] !== $v['type'] || $old['owner'] !== $v['owner'] || (int) $old['per_server'] !== ($v['perServer'] ? 1 : 0)) {
                $pdo->prepare('DELETE FROM data_values WHERE variable_id = ?')->execute([$id]);
            }
            $pdo->prepare("UPDATE data_variables SET name = ?, description = ?, type = ?, owner = ?, per_server = ?, default_value = ?, group_name = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
                ->execute([$v['name'], $v['description'], $v['type'], $v['owner'], $v['perServer'] ? 1 : 0, $v['defaultValue'], $v['group'], $id]);
        });
        return $this->get($botId, $id);
    }

    public function delete(int $botId, int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id): void {
            $this->row($botId, $id);
            $pdo->prepare('DELETE FROM data_variables WHERE id = ?')->execute([$id]);
        });
    }

    /**
     * Values, 25 per page; q filters by server or owner ID prefix.
     *
     * @param array<string, string> $query q, page, sort (updated|value), export (up to 5,000 rows)
     */
    public function values(int $botId, int $id, array $query): array
    {
        $v = $this->row($botId, $id);
        $q = trim((string) ($query['q'] ?? ''));
        $where = 'variable_id = ?';
        $args = [$id];
        if ($q !== '') {
            $where .= " AND (server_id LIKE ? ESCAPE '\\' OR owner_id LIKE ? ESCAPE '\\')";
            $like = addcslashes($q, '%_\\') . '%';
            array_push($args, $like, $like);
        }
        $order = ($query['sort'] ?? '') === 'value'
            ? ($v['type'] === 'number' ? 'CAST(value AS REAL) DESC' : 'value')
            : 'updated_at DESC';
        $count = $this->pdo->prepare("SELECT COUNT(*) FROM data_values WHERE {$where}");
        $count->execute($args);
        $total = (int) $count->fetchColumn();
        $export = ($query['export'] ?? '') === '1';
        $size = $export ? self::EXPORT_ROWS : self::PAGE_SIZE;
        $page = $export ? 1 : max(1, (int) ($query['page'] ?? 1));
        $stmt = $this->pdo->prepare("SELECT server_id, owner_id, value, updated_at FROM data_values WHERE {$where} ORDER BY {$order} LIMIT {$size} OFFSET " . (($page - 1) * $size));
        $stmt->execute($args);
        $items = array_map(static fn (array $r) => ['serverId' => $r['server_id'], 'ownerId' => $r['owner_id'], 'value' => $r['value'], 'updatedAt' => $r['updated_at']], $stmt->fetchAll());
        return ['items' => $items, 'total' => $total, 'page' => $page, 'pageSize' => $size];
    }

    public function setValue(int $botId, int $id, array $in): array
    {
        $server = is_string($in['serverId'] ?? null) ? trim($in['serverId']) : '';
        $owner = is_string($in['ownerId'] ?? null) ? trim($in['ownerId']) : '';
        $value = $in['value'] ?? null;
        if (!is_string($value)) {
            throw new ApiError(422, 'error.data.value');
        }
        return Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $server, $owner, $value): array {
            $v = $this->row($botId, $id);
            $needServer = (int) $v['per_server'] === 1;
            $needOwner = $v['owner'] !== 'shared';
            if ($needServer !== ($server !== '') || $needOwner !== ($owner !== '')
                || ($needServer && !preg_match(self::SNOWFLAKE, $server)) || ($needOwner && !preg_match(self::SNOWFLAKE, $owner))) {
                throw new ApiError(422, 'error.data.ids');
            }
            if (!self::validValue($v['type'], $value)) {
                throw new ApiError(422, 'error.data.value');
            }
            $exists = $pdo->prepare('SELECT 1 FROM data_values WHERE variable_id = ? AND server_id = ? AND owner_id = ?');
            $exists->execute([$id, $server, $owner]);
            if ($exists->fetchColumn() === false) {
                $count = $pdo->prepare('SELECT COUNT(*) FROM data_values WHERE variable_id = ?');
                $count->execute([$id]);
                if ((int) $count->fetchColumn() >= self::MAX_VALUES) {
                    throw new ApiError(422, 'error.data.limit_values');
                }
            }
            $now = gmdate('Y-m-d\TH:i:s.v\Z');
            $pdo->prepare('INSERT INTO data_values (variable_id, server_id, owner_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
                ->execute([$id, $server, $owner, $value, $now]);
            return ['serverId' => $server, 'ownerId' => $owner, 'value' => $value, 'updatedAt' => $now];
        });
    }

    /** One value (serverId + ownerId), or every value with $all. */
    public function deleteValues(int $botId, int $id, array $query): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $query): void {
            $this->row($botId, $id);
            if (($query['all'] ?? '') === 'true') {
                $pdo->prepare('DELETE FROM data_values WHERE variable_id = ?')->execute([$id]);
                return;
            }
            $stmt = $pdo->prepare('DELETE FROM data_values WHERE variable_id = ? AND server_id = ? AND owner_id = ?');
            $stmt->execute([$id, (string) ($query['serverId'] ?? ''), (string) ($query['ownerId'] ?? '')]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.data.value_unknown');
            }
        });
    }

    /** Every value of one member or channel across the bot's variables. */
    public function lookup(int $botId, string $id): array
    {
        if (!preg_match(self::SNOWFLAKE, $id)) {
            throw new ApiError(422, 'error.data.ids');
        }
        $stmt = $this->pdo->prepare('SELECT v.id, v.key, d.server_id, d.owner_id, d.value, d.updated_at FROM data_values d
            JOIN data_variables v ON v.id = d.variable_id WHERE v.bot_id = ? AND d.owner_id = ? ORDER BY v.name LIMIT 500');
        $stmt->execute([$botId, $id]);
        return ['items' => array_map(static fn (array $r) => [
            'variableId' => (int) $r['id'], 'key' => $r['key'], 'serverId' => $r['server_id'], 'ownerId' => $r['owner_id'],
            'value' => $r['value'], 'updatedAt' => $r['updated_at'],
        ], $stmt->fetchAll())];
    }

    public static function validValue(string $type, string $value): bool
    {
        if (strlen($value) > 4000) {
            return false;
        }
        if ($value === '' || $type === 'text') {
            return true;
        }
        if ($type === 'number') {
            return preg_match(self::NUMBER, $value) === 1 && is_finite((float) $value);
        }
        try {
            $v = json_decode($value, false, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return false;
        }
        return match ($type) {
            'list' => is_array($v) && array_reduce($v, static fn ($ok, $x) => $ok && (is_string($x) || is_int($x) || is_float($x) || is_bool($x)), true),
            'object' => $v instanceof \stdClass,
            'object_list' => is_array($v) && array_reduce($v, static fn ($ok, $x) => $ok && $x instanceof \stdClass, true),
            default => false,
        };
    }

    public static function keyFromName(string $name): string
    {
        $k = trim((string) preg_replace('/[^a-z0-9_]+/', '_', strtolower($name)), '_');
        $k = ltrim($k, '0123456789_');
        return rtrim(substr($k, 0, 32), '_');
    }

    private function row(int $botId, int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM data_variables WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        return $stmt->fetch() ?: throw ApiError::notFound('error.data.unknown');
    }

    /** @return array{name: string, description: string, type: string, owner: string, perServer: bool, defaultValue: string, group: string} */
    public static function input(array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $type = $in['type'] ?? null;
        $owner = $in['owner'] ?? null;
        $group = trim((string) ($in['group'] ?? ''));
        $description = trim((string) ($in['description'] ?? ''));
        $default = (string) ($in['defaultValue'] ?? '');
        if ($name === '' || mb_strlen($name) > 32) {
            throw new ApiError(422, 'error.data.name');
        }
        if (!in_array($type, self::TYPES, true)) {
            throw new ApiError(422, 'error.data.type');
        }
        if (!in_array($owner, self::OWNERS, true)) {
            throw new ApiError(422, 'error.data.owner');
        }
        if (mb_strlen($group) > 40 || mb_strlen($description) > 200) {
            throw new ApiError(422, 'error.data.too_long');
        }
        if (!self::validValue($type, $default)) {
            throw new ApiError(422, 'error.data.value');
        }
        // Channel IDs belong to one server anyway.
        $perServer = $owner === 'channel' || ($in['perServer'] ?? true) === true;
        return ['name' => $name, 'description' => $description, 'type' => $type, 'owner' => $owner, 'perServer' => $perServer, 'defaultValue' => $default, 'group' => $group];
    }

    /** @param list<string> $graphs graphs of the bot's commands and events */
    private static function json(array $row, array $graphs): array
    {
        $pattern = '/var\.' . preg_quote($row['key'], '/') . '\b/';
        return [
            'id' => (int) $row['id'],
            'key' => $row['key'],
            'name' => $row['name'],
            'description' => $row['description'],
            'type' => $row['type'],
            'owner' => $row['owner'],
            'perServer' => (int) $row['per_server'] === 1,
            'defaultValue' => $row['default_value'],
            'group' => $row['group_name'],
            'values' => (int) $row['value_count'],
            'usedIn' => count(array_filter($graphs, static fn ($g) => preg_match($pattern, (string) $g) === 1)),
            'updatedAt' => $row['updated_at'],
        ];
    }
}
