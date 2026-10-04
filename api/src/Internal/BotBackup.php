<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;

/**
 * Bot backups and templates (migration 0015, bot settings page).
 *
 * export(): the configuration of one bot as JSON: custom commands and events,
 * command groups, built-in command switches, modules, timed events, message
 * templates, Data Storage variables (definitions), webhooks (without key),
 * presence, time zone, plugin settings and plugin switches. Never the token,
 * secrets, logs or stored values.
 *
 * restore(): replaces that configuration of a bot in one transaction, after
 * an automatic backup. Imported data is untrusted (uploaded files): every part
 * goes through the same checks as the editors.
 *
 * Saved backups belong to one bot; templates are global. Ready-made templates
 * are files in shared/bot-templates/<key>.json ({name, description, data}).
 */
final class BotBackup
{
    public const FORMAT = 'bothub-bot-backup';
    public const VERSION = 1;
    private const MAX_BYTES = 5 * 1024 * 1024;
    private const MAX_BACKUPS = 50;
    private const MAX_AUTO = 10;
    private const MAX_TEMPLATES = 100;
    private const MAX_COMMANDS = 1000;
    private const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

    public function __construct(private readonly PDO $pdo, private readonly BotStore $bots, private readonly ?string $sharedDir = null)
    {
    }

    // ---------- export ----------

    public function export(int $botId): array
    {
        $bot = $this->bots->find($botId) ?? throw ApiError::notFound();
        $q = function (string $sql) use ($botId): array {
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([$botId]);
            return $stmt->fetchAll();
        };
        $obj = static fn (?string $json) => json_decode($json ?? '{}', false, 512, JSON_THROW_ON_ERROR);
        $tz = $q('SELECT timezone FROM bots WHERE id = ?')[0]['timezone'] ?? '';

        $groups = $q('SELECT id, name, description, position FROM command_groups WHERE bot_id = ? ORDER BY position, id');
        $commands = $q('SELECT kind, name, description, enabled, hidden, group_id, event_type, graph, plugin_id, plugin_version, preset_name
            FROM commands WHERE bot_id = ? AND builtin = 0 AND deleted_at IS NULL ORDER BY id');
        return [
            'format' => self::FORMAT,
            'version' => self::VERSION,
            'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'bot' => ['name' => $bot['name']],
            'settings' => ['timezone' => $tz],
            'presence' => $obj($q('SELECT presence FROM bot_profiles WHERE bot_id = ?')[0]['presence'] ?? null),
            'modules' => array_map(static fn ($r) => ['key' => $r['module_key'], 'enabled' => $r['enabled'] === 1, 'config' => $obj($r['config'])],
                $q('SELECT module_key, enabled, config FROM bot_modules WHERE bot_id = ? ORDER BY module_key')),
            'groups' => array_map(static fn ($r) => ['ref' => $r['id'], 'name' => $r['name'], 'description' => $r['description'], 'position' => $r['position']], $groups),
            'commands' => array_map(static fn ($r) => [
                'kind' => $r['kind'], 'name' => $r['name'], 'description' => $r['description'], 'enabled' => $r['enabled'] === 1, 'hidden' => $r['hidden'] === 1,
                'group' => $r['group_id'], 'eventType' => $r['event_type'], 'graph' => $obj($r['graph']),
                'pluginId' => $r['plugin_id'], 'pluginVersion' => $r['plugin_version'], 'presetName' => $r['preset_name'],
            ], $commands),
            'builtinCommands' => array_map(static fn ($r) => ['module' => $r['module_key'], 'name' => $r['name'], 'enabled' => $r['enabled'] === 1],
                $q('SELECT module_key, name, enabled FROM commands WHERE bot_id = ? AND builtin = 1 AND deleted_at IS NULL ORDER BY id')),
            'timedEvents' => array_map(static fn ($r) => [
                'ref' => $r['id'], 'name' => $r['name'], 'kind' => $r['kind'], 'intervalSeconds' => $r['interval_seconds'],
                'times' => json_decode($r['times'], true), 'weekdays' => json_decode($r['weekdays'], true), 'enabled' => $r['enabled'] === 1,
            ], $q('SELECT * FROM timed_events WHERE bot_id = ? ORDER BY id')),
            'messageTemplates' => array_map(static fn ($r) => ['name' => $r['name'], 'message' => $obj($r['message'])],
                $q('SELECT name, message FROM message_templates WHERE bot_id = ? ORDER BY id')),
            'dataVariables' => array_map(static fn ($r) => [
                'key' => $r['key'], 'name' => $r['name'], 'description' => $r['description'], 'type' => $r['type'], 'owner' => $r['owner'],
                'perServer' => $r['per_server'] === 1, 'defaultValue' => $r['default_value'], 'group' => $r['group_name'],
            ], $q('SELECT * FROM data_variables WHERE bot_id = ? ORDER BY id')),
            'webhooks' => array_map(static fn ($r) => ['eventId' => $r['event_id'], 'name' => $r['name'], 'requireKey' => $r['require_key'] === 1, 'enabled' => $r['enabled'] === 1],
                $q('SELECT event_id, name, require_key, enabled FROM webhooks WHERE bot_id = ? ORDER BY id')),
            'plugins' => [
                'settings' => array_map(static fn ($r) => ['pluginId' => $r['plugin_id'], 'config' => $obj($r['config'])],
                    $q('SELECT plugin_id, config FROM plugin_settings WHERE bot_id = ? ORDER BY plugin_id')),
                'disabled' => array_column($q('SELECT plugin_id FROM bot_plugin_disabled WHERE bot_id = ? ORDER BY plugin_id'), 'plugin_id'),
            ],
        ];
    }

    // ---------- saved backups and templates ----------

    /** Backups of the bot, global templates and ready-made templates; without data. */
    public function list(int $botId): array
    {
        $this->bots->find($botId) ?? throw ApiError::notFound();
        $stmt = $this->pdo->prepare("SELECT id, kind, name, description, auto, created_at, length(data) AS size FROM bot_templates
            WHERE (kind = 'backup' AND bot_id = ?) OR kind = 'template' ORDER BY created_at DESC, id DESC");
        $stmt->execute([$botId]);
        $items = array_map(static fn ($r) => [
            'id' => (string) $r['id'], 'kind' => $r['kind'], 'name' => $r['name'], 'description' => $r['description'],
            'auto' => $r['auto'] === 1, 'createdAt' => $r['created_at'], 'size' => (int) $r['size'],
        ], $stmt->fetchAll());
        foreach ($this->builtins() as $key => $t) {
            $items[] = ['id' => 'builtin:' . $key, 'kind' => 'builtin', 'name' => $t['name'], 'description' => $t['description'], 'auto' => false, 'createdAt' => null, 'size' => 0];
        }
        return $items;
    }

    /** Saves the current state as a backup of the bot or as a global template. */
    public function save(int $botId, array $in): array
    {
        $kind = $in['kind'] ?? 'backup';
        if ($kind !== 'backup' && $kind !== 'template') {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'kind']);
        }
        $name = trim((string) ($in['name'] ?? ''));
        $description = trim((string) ($in['description'] ?? ''));
        if ($name === '' || mb_strlen($name) > 60 || mb_strlen($description) > 300) {
            throw new ApiError(422, 'error.backup.name');
        }
        $data = $this->export($botId);
        $id = Connection::write($this->pdo, fn (PDO $pdo) => $this->insert($pdo, $botId, $kind, $name, $description, false, $data));
        return ['id' => (string) $id, 'kind' => $kind, 'name' => $name];
    }

    /** Data of a saved entry or a ready-made template, for download or restore. */
    public function data(int $botId, string $id): array
    {
        if (str_starts_with($id, 'builtin:')) {
            return ($this->builtins()[substr($id, 8)] ?? throw ApiError::notFound('error.backup.unknown'))['data'];
        }
        $stmt = $this->pdo->prepare("SELECT data FROM bot_templates WHERE id = ? AND ((kind = 'backup' AND bot_id = ?) OR kind = 'template')");
        $stmt->execute([(int) $id, $botId]);
        $raw = $stmt->fetchColumn();
        return $raw === false ? throw ApiError::notFound('error.backup.unknown') : json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    }

    public function delete(int $botId, string $id): void
    {
        if (str_starts_with($id, 'builtin:')) {
            throw new ApiError(403, 'error.backup.builtin');
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id): void {
            $stmt = $pdo->prepare("DELETE FROM bot_templates WHERE id = ? AND ((kind = 'backup' AND bot_id = ?) OR kind = 'template')");
            $stmt->execute([(int) $id, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.backup.unknown');
            }
        });
    }

    // ---------- restore ----------

    /**
     * Replaces the bot's configuration with $data (a saved entry, a ready-made
     * template or an uploaded file). Makes an automatic backup first.
     */
    public function restore(int $botId, array $data, string $sourceName): array
    {
        $this->bots->find($botId) ?? throw ApiError::notFound();
        $d = self::check($data);
        $before = $this->export($botId);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $d, $before, $sourceName): void {
            $this->insert($pdo, $botId, 'backup', mb_substr('Auto: ' . $sourceName, 0, 60), '', true, $before);
            $this->apply($pdo, $botId, $d);
            foreach (['commands.changed' => ['botId' => $botId], 'timed.changed' => ['botId' => $botId], 'plugins.changed' => []] as $type => $payload) {
                Outbox::add($pdo, $type, $payload);
            }
            foreach ($d['modules'] as $m) {
                Outbox::add($pdo, 'module.changed', ['botId' => $botId, 'module' => $m['key']]);
            }
        });
        // Presence goes through BotStore's own checks and event.
        if (is_array($d['presence'])) {
            $this->bots->patchPresence($botId, $d['presence']);
        }
        return ['ok' => true, 'commands' => count($d['commands']), 'modules' => count($d['modules'])];
    }

    /** Checks the shape and every part; throws error.backup.* on the first problem. */
    public static function check(array $data): array
    {
        if (($data['format'] ?? null) !== self::FORMAT || ($data['version'] ?? null) !== self::VERSION) {
            throw new ApiError(422, 'error.backup.format');
        }
        if (strlen(json_encode($data, JSON_THROW_ON_ERROR)) > self::MAX_BYTES) {
            throw new ApiError(422, 'error.backup.too_big');
        }
        $list = static function (string $key, int $max) use ($data): array {
            $v = $data[$key] ?? [];
            if (!is_array($v) || !array_is_list($v) || count($v) > $max) {
                throw new ApiError(422, 'error.backup.part', ['part' => $key]);
            }
            return $v;
        };
        $part = static function (string $key, callable $fn) {
            try {
                return $fn();
            } catch (ApiError $e) {
                throw new ApiError(422, 'error.backup.part', ['part' => $key, 'reason' => $e->key]);
            } catch (\Throwable) {
                throw new ApiError(422, 'error.backup.part', ['part' => $key]);
            }
        };
        $out = ['settings' => [], 'presence' => null, 'groups' => [], 'commands' => [], 'builtinCommands' => [], 'modules' => [], 'timedEvents' => [],
            'messageTemplates' => [], 'dataVariables' => [], 'webhooks' => [], 'pluginSettings' => [], 'pluginDisabled' => []];

        $tz = $data['settings']['timezone'] ?? '';
        if (!is_string($tz) || ($tz !== '' && !in_array($tz, \DateTimeZone::listIdentifiers(), true))) {
            throw new ApiError(422, 'error.backup.part', ['part' => 'settings']);
        }
        $out['settings'] = ['timezone' => $tz];
        if (isset($data['presence']) && is_array($data['presence'])) {
            $out['presence'] = $data['presence'];
        }

        $refs = [];
        foreach ($list('groups', 100) as $g) { // 50 own groups plus the module and plugin groups
            $out['groups'][] = $part('groups', static function () use ($g, &$refs) {
                [$name, $description, $position] = CommandStore::validGroup(['name' => $g['name'] ?? '', 'description' => $g['description'] ?? '', 'position' => $g['position'] ?? 0]);
                $refs[] = $g['ref'] ?? null;
                return ['ref' => $g['ref'] ?? null, 'name' => $name, 'description' => $description, 'position' => $position];
            });
        }
        $names = [];
        foreach ($list('commands', self::MAX_COMMANDS) as $c) {
            $out['commands'][] = $part('commands', static function () use ($c, $refs, &$names) {
                $kind = $c['kind'] ?? 'command';
                if (!in_array($kind, ['command', 'event'], true)) {
                    throw new ApiError(422, 'error.validation.failed');
                }
                $name = trim((string) ($c['name'] ?? ''));
                $description = (string) ($c['description'] ?? '');
                $eventType = $kind === 'event' ? (string) ($c['eventType'] ?? '') : null;
                $kind === 'event' ? CommandStore::validEvent($name, (string) $eventType) : CommandStore::validCommand($name, $description);
                if ($kind === 'command') {
                    if (isset($names[$name])) {
                        throw new ApiError(422, 'error.command.name_taken');
                    }
                    $names[$name] = true;
                }
                $graph = json_decode(json_encode($c['graph'] ?? null, JSON_THROW_ON_ERROR), true);
                CommandStore::validGraph($graph);
                $group = $c['group'] ?? null;
                return [
                    'kind' => $kind, 'name' => $name, 'description' => $description, 'enabled' => ($c['enabled'] ?? false) === true, 'hidden' => ($c['hidden'] ?? false) === true,
                    'eventType' => $eventType === '' ? null : $eventType, 'graph' => $c['graph'],
                    'group' => $group !== null && in_array($group, $refs, true) ? $group : null,
                    'pluginId' => is_string($c['pluginId'] ?? null) ? mb_substr($c['pluginId'], 0, 64) : null,
                    'pluginVersion' => is_string($c['pluginVersion'] ?? null) ? mb_substr($c['pluginVersion'], 0, 20) : null,
                    'presetName' => is_string($c['presetName'] ?? null) ? mb_substr($c['presetName'], 0, 32) : null,
                ];
            });
        }
        foreach ($list('builtinCommands', 500) as $b) {
            if (is_string($b['module'] ?? null) && is_string($b['name'] ?? null) && is_bool($b['enabled'] ?? null)) {
                $out['builtinCommands'][] = ['module' => $b['module'], 'name' => $b['name'], 'enabled' => $b['enabled']];
            }
        }
        foreach ($list('modules', 100) as $m) {
            $out['modules'][] = $part('modules', static function () use ($m) {
                $key = (string) ($m['key'] ?? '');
                if (!CommandStore::moduleKnown($key)) {
                    throw new ApiError(422, 'error.module.unknown');
                }
                $in = json_decode(json_encode($m['config'] ?? new \stdClass(), JSON_THROW_ON_ERROR), true) ?: [];
                $schema = ModuleSettings::schema($key);
                $config = $schema !== null ? ModuleSettings::normalize($schema, $in) : ($key === ModerationConfig::MODULE ? ModerationConfig::normalize($in) : []);
                return ['key' => $key, 'enabled' => ($m['enabled'] ?? true) === true, 'config' => $config];
            });
        }
        foreach ($list('timedEvents', 50) as $t) {
            $out['timedEvents'][] = $part('timedEvents', static function () use ($t) {
                $v = TimedStore::valid($t);
                return ['ref' => $t['ref'] ?? null, 'values' => $v];
            });
        }
        foreach ($list('messageTemplates', 100) as $m) {
            $out['messageTemplates'][] = $part('messageTemplates', static function () use ($m) {
                $name = trim((string) ($m['name'] ?? ''));
                $msg = json_decode(json_encode($m['message'] ?? null, JSON_THROW_ON_ERROR), false);
                if ($name === '' || mb_strlen($name) > 60 || !is_object($msg) || !TemplateStore::validMessage($msg)) {
                    throw new ApiError(422, 'error.template.message');
                }
                return ['name' => $name, 'message' => $msg];
            });
        }
        $keys = [];
        foreach ($list('dataVariables', DataStore::MAX_VARIABLES) as $v) {
            $out['dataVariables'][] = $part('dataVariables', static function () use ($v, &$keys) {
                $in = DataStore::input($v);
                $key = (string) ($v['key'] ?? '');
                if (!preg_match('/^[a-z][a-z0-9_]{0,31}$/', $key) || isset($keys[$key])) {
                    throw new ApiError(422, 'error.data.key');
                }
                $keys[$key] = true;
                return ['key' => $key] + $in;
            });
        }
        foreach ($list('webhooks', 50) as $w) {
            $out['webhooks'][] = $part('webhooks', static function () use ($w) {
                $eventId = (string) ($w['eventId'] ?? '');
                $name = trim((string) ($w['name'] ?? ''));
                if (!preg_match('/^[a-z0-9]{16,40}$/', $eventId) || $name === '' || mb_strlen($name) > 60) {
                    throw new ApiError(422, 'error.validation.failed');
                }
                return ['eventId' => $eventId, 'name' => $name, 'requireKey' => ($w['requireKey'] ?? true) === true, 'enabled' => ($w['enabled'] ?? true) === true];
            });
        }
        $plugins = $data['plugins'] ?? [];
        foreach (is_array($plugins['settings'] ?? null) ? array_slice($plugins['settings'], 0, 100) : [] as $p) {
            if (is_string($p['pluginId'] ?? null) && preg_match('/^plugin_[a-z0-9_]{1,57}$/', $p['pluginId']) && is_array($p['config'] ?? null)) {
                $json = json_encode((object) $p['config'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                if (strlen($json) <= 65536) {
                    $out['pluginSettings'][] = ['pluginId' => $p['pluginId'], 'config' => $json];
                }
            }
        }
        foreach (is_array($plugins['disabled'] ?? null) ? array_slice($plugins['disabled'], 0, 100) : [] as $id) {
            if (is_string($id) && preg_match('/^plugin_[a-z0-9_]{1,57}$/', $id)) {
                $out['pluginDisabled'][] = $id;
            }
        }
        return $out;
    }

    private function apply(PDO $pdo, int $botId, array $d): void
    {
        // Remove what the backup replaces. Data Storage variables and webhooks
        // are matched by key, so their stored values and URLs survive.
        foreach (['DELETE FROM commands WHERE bot_id = ? AND builtin = 0', 'DELETE FROM command_groups WHERE bot_id = ?', 'DELETE FROM timed_events WHERE bot_id = ?',
            'DELETE FROM message_templates WHERE bot_id = ?', 'DELETE FROM bot_modules WHERE bot_id = ?', 'DELETE FROM plugin_settings WHERE bot_id = ?',
            'DELETE FROM bot_plugin_disabled WHERE bot_id = ?'] as $sql) {
            $pdo->prepare($sql)->execute([$botId]);
        }
        $pdo->prepare('UPDATE bots SET timezone = ? WHERE id = ?')->execute([$d['settings']['timezone'], $botId]);

        $groupIds = [];
        foreach ($d['groups'] as $g) {
            $pdo->prepare('INSERT INTO command_groups (bot_id, name, description, position) VALUES (?, ?, ?, ?)')->execute([$botId, $g['name'], $g['description'], $g['position']]);
            if ($g['ref'] !== null) {
                $groupIds[$g['ref']] = (int) $pdo->lastInsertId();
            }
        }
        $timedIds = [];
        foreach ($d['timedEvents'] as $t) {
            $pdo->prepare('INSERT INTO timed_events (bot_id, name, kind, interval_seconds, times, weekdays, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$botId, ...array_values($t['values'])]);
            if ($t['ref'] !== null) {
                $timedIds[(string) $t['ref']] = (int) $pdo->lastInsertId();
            }
        }
        $insert = $pdo->prepare('INSERT INTO commands (bot_id, kind, name, description, enabled, hidden, group_id, event_type, graph, plugin_id, plugin_version, preset_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        foreach ($d['commands'] as $c) {
            // A timed event picked in a trigger has a new ID now.
            $graph = json_decode(json_encode($c['graph'], JSON_THROW_ON_ERROR), false);
            foreach ($graph->nodes ?? [] as $node) {
                if (isset($node->config->timed_event)) {
                    $old = (string) $node->config->timed_event;
                    $node->config->timed_event = $timedIds[$old] ?? null;
                }
            }
            $insert->execute([$botId, $c['kind'], $c['name'], $c['description'], $c['enabled'] ? 1 : 0, $c['hidden'] ? 1 : 0, $c['group'] !== null ? ($groupIds[$c['group']] ?? null) : null,
                $c['eventType'], json_encode($graph, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $c['pluginId'], $c['pluginVersion'], $c['presetName']]);
        }
        // Groups holding module or plugin copies are system groups again (migration 0019).
        $pdo->prepare('UPDATE command_groups SET system = 1 WHERE bot_id = ? AND EXISTS (
            SELECT 1 FROM commands c WHERE c.group_id = command_groups.id AND (c.preset_name IS NOT NULL OR c.plugin_id IS NOT NULL))')->execute([$botId]);
        foreach ($d['builtinCommands'] as $b) {
            $pdo->prepare('UPDATE commands SET enabled = ?, updated_at = ' . self::NOW . ' WHERE bot_id = ? AND builtin = 1 AND module_key = ? AND name = ?')
                ->execute([$b['enabled'] ? 1 : 0, $botId, $b['module'], $b['name']]);
        }
        foreach ($d['modules'] as $m) {
            $pdo->prepare('INSERT INTO bot_modules (bot_id, module_key, enabled, config) VALUES (?, ?, ?, ?)')
                ->execute([$botId, $m['key'], $m['enabled'] ? 1 : 0, json_encode((object) $m['config'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
        }
        foreach ($d['messageTemplates'] as $m) {
            $pdo->prepare('INSERT INTO message_templates (bot_id, name, message) VALUES (?, ?, ?)')
                ->execute([$botId, $m['name'], json_encode($m['message'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
        }
        // Data Storage: update by key, add new ones, drop the others (with their values).
        $keep = array_column($d['dataVariables'], 'key');
        $stmt = $pdo->prepare('SELECT key FROM data_variables WHERE bot_id = ?');
        $stmt->execute([$botId]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $key) {
            if (!in_array($key, $keep, true)) {
                $pdo->prepare('DELETE FROM data_variables WHERE bot_id = ? AND key = ?')->execute([$botId, $key]);
            }
        }
        foreach ($d['dataVariables'] as $v) {
            $pdo->prepare("INSERT INTO data_variables (bot_id, key, name, description, type, owner, per_server, default_value, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (bot_id, key) DO UPDATE SET name = excluded.name, description = excluded.description, type = excluded.type, owner = excluded.owner,
                per_server = excluded.per_server, default_value = excluded.default_value, group_name = excluded.group_name, updated_at = " . self::NOW)
                ->execute([$botId, $v['key'], $v['name'], $v['description'], $v['type'], $v['owner'], $v['perServer'] ? 1 : 0, $v['defaultValue'], $v['group']]);
        }
        // Webhooks: same event ID keeps the URL; the API key stays the bot's own.
        $keep = array_column($d['webhooks'], 'eventId');
        $stmt = $pdo->prepare('SELECT event_id FROM webhooks WHERE bot_id = ?');
        $stmt->execute([$botId]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $eventId) {
            if (!in_array($eventId, $keep, true)) {
                $pdo->prepare('DELETE FROM webhooks WHERE bot_id = ? AND event_id = ?')->execute([$botId, $eventId]);
            }
        }
        foreach ($d['webhooks'] as $w) {
            $pdo->prepare('INSERT INTO webhooks (bot_id, event_id, name, require_key, enabled) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (bot_id, event_id) DO UPDATE SET name = excluded.name, require_key = excluded.require_key, enabled = excluded.enabled')
                ->execute([$botId, $w['eventId'], $w['name'], $w['requireKey'] ? 1 : 0, $w['enabled'] ? 1 : 0]);
        }
        foreach ($d['pluginSettings'] as $p) {
            $pdo->prepare('INSERT INTO plugin_settings (bot_id, plugin_id, config) VALUES (?, ?, ?)')->execute([$botId, $p['pluginId'], $p['config']]);
        }
        // Only plugins that are installed here can be switched off.
        foreach ($d['pluginDisabled'] as $id) {
            $pdo->prepare('INSERT OR IGNORE INTO bot_plugin_disabled (bot_id, plugin_id) SELECT ?, plugin_id FROM plugin_installs WHERE plugin_id = ?')->execute([$botId, $id]);
        }
    }

    private function insert(PDO $pdo, int $botId, string $kind, string $name, string $description, bool $auto, array $data): int
    {
        $json = json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > self::MAX_BYTES) {
            throw new ApiError(422, 'error.backup.too_big');
        }
        if ($kind === 'template') {
            if ((int) $pdo->query("SELECT COUNT(*) FROM bot_templates WHERE kind = 'template'")->fetchColumn() >= self::MAX_TEMPLATES) {
                throw new ApiError(422, 'error.backup.limit', ['max' => self::MAX_TEMPLATES]);
            }
        } elseif (!$auto) {
            $stmt = $pdo->prepare("SELECT COUNT(*) FROM bot_templates WHERE kind = 'backup' AND bot_id = ? AND auto = 0");
            $stmt->execute([$botId]);
            if ((int) $stmt->fetchColumn() >= self::MAX_BACKUPS) {
                throw new ApiError(422, 'error.backup.limit', ['max' => self::MAX_BACKUPS]);
            }
        }
        $pdo->prepare('INSERT INTO bot_templates (kind, bot_id, name, description, auto, data) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$kind, $kind === 'backup' ? $botId : null, $name, $description, $auto ? 1 : 0, $json]);
        $id = (int) $pdo->lastInsertId();
        if ($auto) {
            // Keep the newest automatic backups only.
            $pdo->prepare("DELETE FROM bot_templates WHERE kind = 'backup' AND bot_id = ? AND auto = 1 AND id NOT IN
                (SELECT id FROM bot_templates WHERE kind = 'backup' AND bot_id = ? AND auto = 1 ORDER BY id DESC LIMIT " . self::MAX_AUTO . ')')
                ->execute([$botId, $botId]);
        }
        return $id;
    }

    /** @return array<string, array{name: string, description: string, data: array}> */
    private function builtins(): array
    {
        $dir = ($this->sharedDir ?? (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared')) . '/bot-templates';
        $out = [];
        foreach (glob($dir . '/*.json') ?: [] as $file) {
            $key = basename($file, '.json');
            $t = json_decode((string) file_get_contents($file), true);
            if (preg_match('/^[a-z0-9-]{1,40}$/', $key) && is_array($t) && is_string($t['name'] ?? null) && is_array($t['data'] ?? null)) {
                $out[$key] = ['name' => $t['name'], 'description' => (string) ($t['description'] ?? ''), 'data' => $t['data']];
            }
        }
        ksort($out);
        return $out;
    }
}
