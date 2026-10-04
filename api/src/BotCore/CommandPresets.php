<?php

declare(strict_types=1);

namespace BotHub\BotCore;

use PDO;

/**
 * Seeds the copies of every module command (shared/command-presets.json)
 * as disabled, hidden custom commands (shown under Custom Commands once the
 * user saves one), one command group per module, so they can be
 * rebuilt in the command builder. The dashboard finds a copy by name and
 * group (module page, gear button).
 *
 * Call inside the Connection::write() that creates the bot.
 */
final class CommandPresets
{
    /** @return int number of commands created */
    public static function seed(PDO $pdo, int $botId, ?string $file = null): int
    {
        if (!$pdo->inTransaction()) {
            throw new \LogicException('CommandPresets::seed must run inside Connection::write()');
        }
        $file ??= (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/command-presets.json';
        // Objects, not arrays: empty {} configs must stay {} in the stored graph.
        $doc = json_decode((string) file_get_contents($file), false, 512, JSON_THROW_ON_ERROR);

        $position = (int) $pdo->query("SELECT COALESCE(MAX(position) + 1, 0) FROM command_groups WHERE bot_id = {$botId}")->fetchColumn();
        $addGroup = $pdo->prepare('INSERT INTO command_groups (bot_id, name, position, system) VALUES (?, ?, ?, 1)');
        $addCommand = $pdo->prepare(
            "INSERT INTO commands (bot_id, kind, name, description, builtin, enabled, hidden, group_id, graph, preset_name)
             VALUES (?, 'command', ?, ?, 0, 0, 1, ?, ?, ?)",
        );
        $addVersion = $pdo->prepare('INSERT INTO command_versions (command_id, nodes, graph) VALUES (?, ?, ?)');

        $groups = [];
        foreach ($doc->commands as $preset) {
            $group = mb_substr($preset->group, 0, 40);
            if (!isset($groups[$group])) {
                $addGroup->execute([$botId, $group, min($position++, 999)]);
                $groups[$group] = (int) $pdo->lastInsertId();
            }
            $graph = json_encode($preset->graph, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $addCommand->execute([$botId, $preset->name, mb_substr($preset->description ?? '', 0, 100), $groups[$group], $graph, $preset->name]);
            $addVersion->execute([(int) $pdo->lastInsertId(), count($preset->graph->nodes ?? []), $graph]);
        }
        return count($doc->commands);
    }

    /**
     * Gives every bot the module commands that came with newer presets (e.g.
     * /daily after the economy got it). Setting 'presets.known' holds the
     * presets already rolled out, so a copy the user deleted is not added
     * again. Copies start off and hidden, like at bot creation. Call inside
     * Connection::write().
     *
     * @return int number of copies added
     */
    public static function addMissing(PDO $pdo, ?string $file = null): int
    {
        if (!$pdo->inTransaction()) {
            throw new \LogicException('CommandPresets::addMissing must run inside Connection::write()');
        }
        $file ??= (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/command-presets.json';
        $doc = json_decode((string) file_get_contents($file), false, 512, JSON_THROW_ON_ERROR);
        $known = $pdo->query("SELECT value FROM settings WHERE key = 'presets.known'")->fetchColumn();
        $known = $known === false ? [] : (array) json_decode((string) $known, true);
        $has = $pdo->prepare('SELECT 1 FROM commands WHERE bot_id = ? AND preset_name = ? AND plugin_id IS NULL');
        $group = $pdo->prepare('SELECT id FROM command_groups WHERE bot_id = ? AND name = ? AND system = 1');
        $addGroup = $pdo->prepare('INSERT INTO command_groups (bot_id, name, position, system) VALUES (?, ?, ?, 1)');
        $addCommand = $pdo->prepare(
            "INSERT INTO commands (bot_id, kind, name, description, builtin, enabled, hidden, group_id, graph, preset_name)
             VALUES (?, 'command', ?, ?, 0, 0, 1, ?, ?, ?)",
        );
        $addVersion = $pdo->prepare('INSERT INTO command_versions (command_id, nodes, graph) VALUES (?, ?, ?)');
        $added = 0;
        foreach ($pdo->query('SELECT id FROM bots')->fetchAll(PDO::FETCH_COLUMN) as $botId) {
            $before = $added;
            foreach ($doc->commands as $preset) {
                if (in_array($preset->name, $known, true)) {
                    continue;
                }
                $has->execute([$botId, $preset->name]);
                if ($has->fetchColumn() !== false) {
                    continue;
                }
                $name = mb_substr($preset->group, 0, 40);
                $group->execute([$botId, $name]);
                $groupId = $group->fetchColumn();
                if ($groupId === false) {
                    $position = (int) $pdo->query('SELECT COALESCE(MAX(position) + 1, 0) FROM command_groups WHERE bot_id = ' . (int) $botId)->fetchColumn();
                    $addGroup->execute([$botId, $name, min($position, 999)]);
                    $groupId = (int) $pdo->lastInsertId();
                }
                $graph = json_encode($preset->graph, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $addCommand->execute([$botId, $preset->name, mb_substr($preset->description ?? '', 0, 100), (int) $groupId, $graph, $preset->name]);
                $addVersion->execute([(int) $pdo->lastInsertId(), count($preset->graph->nodes ?? []), $graph]);
                $added++;
            }
            if ($added > $before) {
                Outbox::add($pdo, 'commands.changed', ['botId' => (int) $botId]);
            }
        }
        $names = array_map(fn ($c) => $c->name, $doc->commands);
        $pdo->prepare(
            "INSERT INTO settings (key, value) VALUES ('presets.known', ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        )->execute([json_encode(array_values(array_unique([...$known, ...$names])), JSON_UNESCAPED_UNICODE)]);
        return $added;
    }

    /**
     * Brings module copies the user never saved (hidden = 1) up to the current
     * preset graph, e.g. after a preset got its blocks. Saved copies (hidden = 0),
     * plugin copies and the enabled switch are left alone. Each changed copy gets
     * a version row and a command.saved event. Call inside Connection::write().
     *
     * @return int number of copies changed
     */
    public static function refresh(PDO $pdo, ?string $file = null): int
    {
        if (!$pdo->inTransaction()) {
            throw new \LogicException('CommandPresets::refresh must run inside Connection::write()');
        }
        $file ??= (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/command-presets.json';
        $doc = json_decode((string) file_get_contents($file), false, 512, JSON_THROW_ON_ERROR);

        $copies = $pdo->prepare(
            "SELECT id, bot_id, graph FROM commands
             WHERE preset_name = ? AND hidden = 1 AND plugin_id IS NULL AND kind = 'command' AND deleted_at IS NULL",
        );
        $update = $pdo->prepare("UPDATE commands SET graph = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?");
        $addVersion = $pdo->prepare('INSERT INTO command_versions (command_id, nodes, graph) VALUES (?, ?, ?)');

        $changed = 0;
        foreach ($doc->commands as $preset) {
            $graph = json_encode($preset->graph, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $copies->execute([$preset->name]);
            foreach ($copies->fetchAll() as $row) {
                // Compare decoded: key order or escaping alone is no change.
                if (json_decode((string) $row['graph'], true) == json_decode($graph, true)) {
                    continue;
                }
                $update->execute([$graph, (int) $row['id']]);
                $addVersion->execute([(int) $row['id'], count($preset->graph->nodes ?? []), $graph]);
                Outbox::add($pdo, 'command.saved', ['botId' => (int) $row['bot_id'], 'commandId' => (int) $row['id']]);
                $changed++;
            }
        }
        return $changed;
    }

    /**
     * Puts module copies back into their module's system group when they
     * lost it (a module group could be deleted before groups became system
     * groups, migration 0019). The group is created again when missing.
     * Call inside Connection::write().
     *
     * @return int number of copies moved back
     */
    public static function regroup(PDO $pdo, ?string $file = null): int
    {
        if (!$pdo->inTransaction()) {
            throw new \LogicException('CommandPresets::regroup must run inside Connection::write()');
        }
        $file ??= (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/command-presets.json';
        $doc = json_decode((string) file_get_contents($file), false, 512, JSON_THROW_ON_ERROR);

        $orphans = $pdo->prepare(
            "SELECT id, bot_id FROM commands
             WHERE preset_name = ? AND plugin_id IS NULL AND group_id IS NULL AND kind = 'command' AND deleted_at IS NULL",
        );
        $findGroup = $pdo->prepare('SELECT id FROM command_groups WHERE bot_id = ? AND name = ? AND system = 1');
        $addGroup = $pdo->prepare(
            'INSERT INTO command_groups (bot_id, name, position, system)
             VALUES (?, ?, (SELECT MIN(999, COALESCE(MAX(position) + 1, 0)) FROM command_groups WHERE bot_id = ?), 1)',
        );
        $move = $pdo->prepare('UPDATE commands SET group_id = ? WHERE id = ?');

        $moved = 0;
        foreach ($doc->commands as $preset) {
            $orphans->execute([$preset->name]);
            foreach ($orphans->fetchAll() as $row) {
                $botId = (int) $row['bot_id'];
                $name = mb_substr($preset->group, 0, 40);
                $findGroup->execute([$botId, $name]);
                $group = $findGroup->fetchColumn();
                if ($group === false) {
                    $addGroup->execute([$botId, $name, $botId]);
                    $group = $pdo->lastInsertId();
                }
                $move->execute([(int) $group, (int) $row['id']]);
                Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => (int) $row['id']]);
                $moved++;
            }
        }
        return $moved;
    }

    /** One preset by its name (unique in command-presets.json), graph decoded as objects. */
    public static function find(string $name, ?string $file = null): ?object
    {
        $file ??= (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/command-presets.json';
        $doc = json_decode((string) file_get_contents($file), false, 512, JSON_THROW_ON_ERROR);
        foreach ($doc->commands as $preset) {
            if ($preset->name === $name) {
                return $preset;
            }
        }
        return null;
    }
}
