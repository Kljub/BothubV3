<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;

/**
 * Custom commands and custom events of one bot (command builder), their
 * saved versions, "Recently deleted", command groups and module switches.
 * Same JSON and rules as the mock API (dashboard/cmd/mockapi/commands.go),
 * so the mock can forward to these endpoints unchanged.
 *
 * Every change writes an outbox event in the same transaction; the NodeCore
 * reloads the bot's graphs when it arrives.
 */
final class CommandStore
{
    private const KEEP_VERSIONS = 3;
    private const KEEP_DELETED = '-30 days';
    private const MAX_GROUPS = 50;
    private const COMMAND_NAME = '/^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$/';
    private const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

    /** @var array<string, true>|null */
    private static ?array $eventTypes = null;

    public function __construct(private readonly PDO $pdo)
    {
    }

    // ---------- commands and events ----------

    /** @param 'command'|'event' $kind */
    public function list(int $botId, string $kind): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT id, kind, name, description, enabled, builtin, group_id, event_type, updated_at FROM commands
             WHERE bot_id = ? AND kind = ? AND builtin = 0 AND deleted_at IS NULL ORDER BY id",
        );
        $stmt->execute([$botId, $kind]);
        return array_map(static fn (array $r) => self::json($r, false), $stmt->fetchAll());
    }

    public function get(int $botId, string $kind, int $id): array
    {
        return self::json($this->row($botId, $kind, $id), true);
    }

    public function create(int $botId, string $kind, array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $description = (string) ($in['description'] ?? '');
        $enabled = ($in['enabled'] ?? false) === true;
        $eventType = null;
        if ($kind === 'event') {
            $eventType = (string) ($in['eventType'] ?? '');
            self::validEvent($name, $eventType);
            $graph = self::starterEventGraph($name, $eventType);
            $eventType = $eventType === '' ? null : $eventType;
        } else {
            self::validCommand($name, $description);
            $graph = self::starterGraph($name, $description);
        }
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $kind, $name, $description, $enabled, $eventType, $graph): int {
            if ($kind === 'command') {
                $this->assertNameFree($botId, $name, 0);
            }
            $pdo->prepare('INSERT INTO commands (bot_id, kind, name, description, enabled, event_type, graph) VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$botId, $kind, $name, $description, $enabled ? 1 : 0, $eventType, $graph]);
            $id = (int) $pdo->lastInsertId();
            Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => $id]);
            return $id;
        });
        return $this->get($botId, $kind, $id);
    }

    /** {enabled?, groupId?} */
    public function patch(int $botId, string $kind, int $id, array $in): array
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $kind, $id, $in): void {
            $this->row($botId, $kind, $id);
            if (array_key_exists('enabled', $in)) {
                if (!is_bool($in['enabled'])) {
                    throw new ApiError(422, 'error.validation', ['field' => 'enabled']);
                }
                $pdo->prepare('UPDATE commands SET enabled = ?, updated_at = ' . self::NOW . ' WHERE id = ?')->execute([$in['enabled'] ? 1 : 0, $id]);
            }
            if (array_key_exists('groupId', $in)) {
                $group = $in['groupId'];
                if ($group !== null && (!is_int($group) || !$this->groupExists($botId, $group))) {
                    throw new ApiError(422, 'error.group.unknown');
                }
                $pdo->prepare('UPDATE commands SET group_id = ? WHERE id = ?')->execute([$group, $id]);
            }
            Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => $id]);
        });
        return $this->get($botId, $kind, $id);
    }

    /**
     * Saves the graph from the builder: {name, description, enabled, graph}.
     * $graphObject is the same graph decoded to objects, so empty {} configs
     * stay objects when it is stored (arrays would turn them into []).
     */
    public function save(int $botId, string $kind, int $id, array $in, mixed $graphObject): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $description = (string) ($in['description'] ?? '');
        $enabled = ($in['enabled'] ?? false) === true;
        $graph = $in['graph'] ?? null;
        $nodes = self::validGraph($graph);
        $eventType = null;
        if ($kind === 'event') {
            foreach ($graph['nodes'] as $node) {
                if (($node['type'] ?? '') === 'trigger.event') {
                    $eventType = is_string($node['config']['event'] ?? null) ? $node['config']['event'] : '';
                }
            }
            self::validEvent($name, (string) $eventType);
            $eventType = $eventType === '' ? null : $eventType;
        } else {
            self::validCommand($name, $description);
        }
        $json = json_encode($graphObject, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $kind, $id, $name, $description, $enabled, $eventType, $json, $nodes): void {
            $this->row($botId, $kind, $id);
            if ($kind === 'command') {
                $this->assertNameFree($botId, $name, $id);
            }
            $pdo->prepare('UPDATE commands SET name = ?, description = ?, enabled = ?, event_type = ?, graph = ?, updated_at = ' . self::NOW . ' WHERE id = ?')
                ->execute([$name, $description, $enabled ? 1 : 0, $eventType, $json, $id]);
            $this->addVersion($id, $nodes, $json);
            Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => $id]);
        });
        return $this->get($botId, $kind, $id);
    }

    /** Soft delete: kept 30 days under "Recently deleted". */
    public function delete(int $botId, string $kind, int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $kind, $id): void {
            $this->row($botId, $kind, $id);
            $pdo->prepare('UPDATE commands SET deleted_at = ' . self::NOW . ' WHERE id = ?')->execute([$id]);
            Outbox::add($pdo, 'command.deleted', ['botId' => $botId, 'commandId' => $id]);
        });
    }

    public function listDeleted(int $botId, string $kind): array
    {
        $this->purgeDeleted($botId);
        $stmt = $this->pdo->prepare(
            'SELECT id, name, description, deleted_at FROM commands WHERE bot_id = ? AND kind = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',
        );
        $stmt->execute([$botId, $kind]);
        return array_map(static fn (array $r) => [
            'id' => (int) $r['id'], 'name' => $r['name'], 'description' => $r['description'], 'deletedAt' => $r['deleted_at'],
        ], $stmt->fetchAll());
    }

    public function restoreDeleted(int $botId, string $kind, int $id): array
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $kind, $id): void {
            $stmt = $pdo->prepare('SELECT name FROM commands WHERE id = ? AND bot_id = ? AND kind = ? AND deleted_at IS NOT NULL');
            $stmt->execute([$id, $botId, $kind]);
            $name = $stmt->fetchColumn();
            if ($name === false) {
                throw ApiError::notFound('error.command.unknown');
            }
            if ($kind === 'command') {
                $this->assertNameFree($botId, (string) $name, $id);
            }
            $pdo->prepare('UPDATE commands SET deleted_at = NULL, updated_at = ' . self::NOW . ' WHERE id = ?')->execute([$id]);
            Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => $id]);
        });
        return $this->get($botId, $kind, $id);
    }

    // ---------- versions ----------

    public function versions(int $botId, string $kind, int $id): array
    {
        $this->row($botId, $kind, $id);
        $stmt = $this->pdo->prepare('SELECT id, saved_at, nodes FROM command_versions WHERE command_id = ? ORDER BY id DESC');
        $stmt->execute([$id]);
        return array_map(static fn (array $r) => ['id' => (int) $r['id'], 'savedAt' => $r['saved_at'], 'nodes' => (int) $r['nodes']], $stmt->fetchAll());
    }

    public function version(int $botId, string $kind, int $id, int $versionId): array
    {
        $this->row($botId, $kind, $id);
        $v = $this->versionRow($id, $versionId);
        return ['id' => (int) $v['id'], 'savedAt' => $v['saved_at'], 'nodes' => (int) $v['nodes'], 'graph' => json_decode($v['graph'], false, 512, JSON_THROW_ON_ERROR)];
    }

    /** Restoring saves the old graph again as the newest version. */
    public function restoreVersion(int $botId, string $kind, int $id, int $versionId): array
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $kind, $id, $versionId): void {
            $this->row($botId, $kind, $id);
            $v = $this->versionRow($id, $versionId);
            $pdo->prepare('UPDATE commands SET graph = ?, updated_at = ' . self::NOW . ' WHERE id = ?')->execute([$v['graph'], $id]);
            $this->addVersion($id, (int) $v['nodes'], $v['graph']);
            Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => $id]);
        });
        return $this->get($botId, $kind, $id);
    }

    // ---------- groups ----------

    public function groups(int $botId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT g.id, g.name, g.description, g.position,
                (SELECT COUNT(*) FROM commands c WHERE c.group_id = g.id AND c.builtin = 0 AND c.deleted_at IS NULL) AS commands
             FROM command_groups g WHERE g.bot_id = ? ORDER BY g.position, g.id',
        );
        $stmt->execute([$botId]);
        return array_map(self::groupJson(...), $stmt->fetchAll());
    }

    public function createGroup(int $botId, array $in): array
    {
        [$name, $description, $position] = self::validGroup($in);
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $name, $description, $position): int {
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM command_groups WHERE bot_id = ?');
            $stmt->execute([$botId]);
            if ((int) $stmt->fetchColumn() >= self::MAX_GROUPS) {
                throw new ApiError(422, 'error.group.limit');
            }
            $pdo->prepare('INSERT INTO command_groups (bot_id, name, description, position) VALUES (?, ?, ?, ?)')->execute([$botId, $name, $description, $position]);
            return (int) $pdo->lastInsertId();
        });
        return $this->group($botId, $id);
    }

    public function updateGroup(int $botId, int $groupId, array $in): array
    {
        [$name, $description, $position] = self::validGroup($in);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $groupId, $name, $description, $position): void {
            $stmt = $pdo->prepare('UPDATE command_groups SET name = ?, description = ?, position = ? WHERE id = ? AND bot_id = ?');
            $stmt->execute([$name, $description, $position, $groupId, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.group.unknown');
            }
        });
        return $this->group($botId, $groupId);
    }

    /** Commands of the group stay, without a group (ON DELETE SET NULL). */
    public function deleteGroup(int $botId, int $groupId): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $groupId): void {
            $stmt = $pdo->prepare('DELETE FROM command_groups WHERE id = ? AND bot_id = ?');
            $stmt->execute([$groupId, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.group.unknown');
            }
        });
    }

    // ---------- modules ----------

    /** Stored module switches; a module without a row is on. */
    public function modules(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT module_key, enabled FROM bot_modules WHERE bot_id = ? ORDER BY module_key');
        $stmt->execute([$botId]);
        return array_map(static fn (array $r) => ['key' => $r['module_key'], 'enabled' => $r['enabled'] === 1], $stmt->fetchAll());
    }

    public function setModule(int $botId, string $key, array $in): array
    {
        if (!is_bool($in['enabled'] ?? null)) {
            throw new ApiError(422, 'error.validation', ['field' => 'enabled']);
        }
        if (!self::moduleKnown($key)) {
            throw ApiError::notFound('error.module.unknown');
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $key, $in): void {
            $pdo->prepare('INSERT INTO bot_modules (bot_id, module_key, enabled) VALUES (?, ?, ?)
                ON CONFLICT (bot_id, module_key) DO UPDATE SET enabled = excluded.enabled')
                ->execute([$botId, $key, $in['enabled'] ? 1 : 0]);
            Outbox::add($pdo, 'module.changed', ['botId' => $botId, 'module' => $key]);
        });
        return ['key' => $key, 'enabled' => $in['enabled']];
    }

    /** Settings of a module (bot_modules.config); only modules with a settings page. */
    public function moduleConfig(int $botId, string $key): array
    {
        self::configurable($key);
        $stmt = $this->pdo->prepare('SELECT config FROM bot_modules WHERE bot_id = ? AND module_key = ?');
        $stmt->execute([$botId, $key]);
        $raw = $stmt->fetchColumn();
        $stored = is_string($raw) ? json_decode($raw, true) : [];
        $stored = is_array($stored) ? $stored : [];
        $schema = ModuleSettings::schema($key);
        return $schema !== null ? ModuleSettings::read($schema, $stored) : ModerationConfig::read($stored);
    }

    /** Replaces the settings; a module without a row stays on. */
    public function setModuleConfig(int $botId, string $key, array $in): array
    {
        self::configurable($key);
        $schema = ModuleSettings::schema($key);
        $config = $schema !== null ? ModuleSettings::normalize($schema, $in) : ModerationConfig::normalize($in);
        $json = json_encode($config, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $key, $json): void {
            $pdo->prepare('INSERT INTO bot_modules (bot_id, module_key, config) VALUES (?, ?, ?)
                ON CONFLICT (bot_id, module_key) DO UPDATE SET config = excluded.config, updated_at = ' . self::NOW)
                ->execute([$botId, $key, $json]);
            Outbox::add($pdo, 'module.changed', ['botId' => $botId, 'module' => $key]);
        });
        return $config;
    }

    private static function configurable(string $key): void
    {
        if ($key !== ModerationConfig::MODULE && ModuleSettings::schema($key) === null) {
            throw ApiError::notFound(self::moduleKnown($key) ? 'error.module.no_settings' : 'error.module.unknown');
        }
    }

    // ---------- helpers ----------

    private function row(int $botId, string $kind, int $id): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, kind, name, description, enabled, builtin, group_id, event_type, updated_at, graph FROM commands
             WHERE id = ? AND bot_id = ? AND kind = ? AND builtin = 0 AND deleted_at IS NULL',
        );
        $stmt->execute([$id, $botId, $kind]);
        return $stmt->fetch() ?: throw ApiError::notFound('error.command.unknown');
    }

    private function versionRow(int $commandId, int $versionId): array
    {
        $stmt = $this->pdo->prepare('SELECT id, saved_at, nodes, graph FROM command_versions WHERE id = ? AND command_id = ?');
        $stmt->execute([$versionId, $commandId]);
        return $stmt->fetch() ?: throw ApiError::notFound('error.version.unknown');
    }

    private function addVersion(int $commandId, int $nodes, string $graph): void
    {
        $this->pdo->prepare('INSERT INTO command_versions (command_id, nodes, graph) VALUES (?, ?, ?)')->execute([$commandId, $nodes, $graph]);
        $this->pdo->prepare('DELETE FROM command_versions WHERE command_id = ? AND id NOT IN
            (SELECT id FROM command_versions WHERE command_id = ? ORDER BY id DESC LIMIT ' . self::KEEP_VERSIONS . ')')
            ->execute([$commandId, $commandId]);
    }

    private function assertNameFree(int $botId, string $name, int $exceptId): void
    {
        $stmt = $this->pdo->prepare("SELECT 1 FROM commands WHERE bot_id = ? AND kind = 'command' AND builtin = 0 AND deleted_at IS NULL AND name = ? AND id != ?");
        $stmt->execute([$botId, $name, $exceptId]);
        if ($stmt->fetchColumn() !== false) {
            throw new ApiError(409, 'error.command.name_taken');
        }
    }

    private function groupExists(int $botId, int $groupId): bool
    {
        $stmt = $this->pdo->prepare('SELECT 1 FROM command_groups WHERE id = ? AND bot_id = ?');
        $stmt->execute([$groupId, $botId]);
        return $stmt->fetchColumn() !== false;
    }

    private function group(int $botId, int $groupId): array
    {
        foreach ($this->groups($botId) as $g) {
            if ($g['id'] === $groupId) {
                return $g;
            }
        }
        throw ApiError::notFound('error.group.unknown');
    }

    private function purgeDeleted(int $botId): void
    {
        $cutoff = (new \DateTimeImmutable(self::KEEP_DELETED, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
        Connection::write($this->pdo, static function (PDO $pdo) use ($botId, $cutoff): void {
            $pdo->prepare('DELETE FROM commands WHERE bot_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?')->execute([$botId, $cutoff]);
        });
    }

    private static function validCommand(string $name, string $description): void
    {
        if (!preg_match(self::COMMAND_NAME, $name) || strlen($description) > 100) {
            throw new ApiError(422, 'error.command.name');
        }
    }

    private static function validEvent(string $name, string $eventType): void
    {
        $len = mb_strlen($name);
        if ($len === 0 || $len > 100) {
            throw new ApiError(422, 'error.event.name');
        }
        if ($eventType !== '' && !isset(self::eventTypes()[$eventType])) {
            throw new ApiError(422, 'error.event.type');
        }
    }

    /** Structure check; returns the node count. */
    private static function validGraph(mixed $g): int
    {
        if (!is_array($g) || ($g['schemaVersion'] ?? null) !== 1 || !is_array($g['nodes'] ?? null) || !is_array($g['edges'] ?? null)
            || count($g['nodes']) === 0 || count($g['nodes']) > 500 || count($g['edges']) > 2000) {
            throw new ApiError(422, 'error.graph.invalid');
        }
        // Node IDs unique, node types known, edges between existing nodes.
        $known = self::nodeTypes();
        $ids = [];
        foreach ($g['nodes'] as $node) {
            if (!is_array($node) || !is_string($node['id'] ?? null) || $node['id'] === '' || !is_string($node['type'] ?? null)) {
                throw new ApiError(422, 'error.graph.invalid');
            }
            if (isset($ids[$node['id']])) {
                throw new ApiError(422, 'error.graph.duplicate_node', ['node' => $node['id']]);
            }
            if ($known !== [] && !isset($known[$node['type']]) && !str_starts_with($node['type'], 'plugin.')) {
                throw new ApiError(422, 'error.graph.unknown_type', ['type' => $node['type']]);
            }
            $ids[$node['id']] = true;
        }
        foreach ($g['edges'] as $e) {
            $from = $e['from'] ?? null;
            $to = $e['to'] ?? null;
            if (!is_array($from) || !is_array($to) || !is_string($from['port'] ?? null) || !is_string($to['port'] ?? null)
                || !isset($ids[$from['node'] ?? '']) || !isset($ids[$to['node'] ?? ''])) {
                throw new ApiError(422, 'error.graph.bad_edge');
            }
        }
        return count($g['nodes']);
    }

    /** @var array<string, true>|null node types from shared/nodes */
    private static ?array $nodeTypes = null;

    /** @return array<string, true> */
    private static function nodeTypes(): array
    {
        if (self::$nodeTypes === null) {
            self::$nodeTypes = [];
            foreach (glob(self::shared('nodes') . '/*.json') ?: [] as $file) {
                self::$nodeTypes[basename($file, '.json')] = true;
            }
        }
        return self::$nodeTypes;
    }

    /** @return array{string, string, int} */
    private static function validGroup(array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $description = trim((string) ($in['description'] ?? ''));
        $position = $in['position'] ?? 0;
        if ($name === '' || mb_strlen($name) > 40 || mb_strlen($description) > 200 || !is_int($position) || $position < 0 || $position > 999) {
            throw new ApiError(422, 'error.group.invalid');
        }
        return [$name, $description, $position];
    }

    /** @return array<string, true> */
    private static function eventTypes(): array
    {
        if (self::$eventTypes === null) {
            $doc = json_decode((string) file_get_contents(self::shared('events.json')), true, 512, JSON_THROW_ON_ERROR);
            self::$eventTypes = [];
            foreach ($doc['categories'] as $cat) {
                foreach ($cat['events'] as $ev) {
                    self::$eventTypes[$ev['key']] = true;
                }
            }
        }
        return self::$eventTypes;
    }

    private static function moduleKnown(string $key): bool
    {
        $doc = json_decode((string) file_get_contents(self::shared('modules.json')), true, 512, JSON_THROW_ON_ERROR);
        foreach ($doc['modules'] as $module) {
            if (($module['key'] ?? null) === $key) {
                return true;
            }
        }
        return false;
    }

    private static function shared(string $file): string
    {
        return (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/' . $file;
    }

    private static function starterGraph(string $name, string $description): string
    {
        return json_encode(['schemaVersion' => 1, 'nodes' => [
            ['id' => 'trigger', 'type' => 'trigger.slash', 'typeVersion' => 1, 'config' => ['command_name' => $name, 'description' => $description], 'position' => ['x' => 120, 'y' => 120]],
            ['id' => 'error', 'type' => 'utility.error_handler', 'typeVersion' => 1, 'config' => ['variable' => 'error'], 'position' => ['x' => 440, 'y' => 120]],
        ], 'edges' => []], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }

    private static function starterEventGraph(string $name, string $eventType): string
    {
        $config = ['event_name' => $name] + ($eventType !== '' ? ['event' => $eventType] : []);
        return json_encode(['schemaVersion' => 1, 'nodes' => [
            ['id' => 'trigger', 'type' => 'trigger.event', 'typeVersion' => 1, 'config' => $config, 'position' => ['x' => 120, 'y' => 120]],
            ['id' => 'error', 'type' => 'utility.error_handler', 'typeVersion' => 1, 'config' => ['variable' => 'error'], 'position' => ['x' => 440, 'y' => 120]],
        ], 'edges' => []], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }

    private static function json(array $r, bool $withGraph): array
    {
        $out = [
            'id' => (int) $r['id'],
            'name' => $r['name'],
            'description' => $r['description'],
            'enabled' => $r['enabled'] === 1,
            'builtin' => $r['builtin'] === 1,
            'groupId' => $r['group_id'] === null ? null : (int) $r['group_id'],
            'updatedAt' => $r['updated_at'],
        ];
        if ($r['kind'] === 'event') {
            $out['kind'] = 'event';
            $out['eventType'] = $r['event_type'] ?? '';
        }
        if ($withGraph) {
            $out['graph'] = json_decode($r['graph'], false, 512, JSON_THROW_ON_ERROR); // objects: {} stays {}
        }
        return $out;
    }

    private static function groupJson(array $r): array
    {
        return ['id' => (int) $r['id'], 'name' => $r['name'], 'description' => $r['description'], 'position' => (int) $r['position'], 'commands' => (int) $r['commands']];
    }
}
