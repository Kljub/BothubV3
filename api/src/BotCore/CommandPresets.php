<?php

declare(strict_types=1);

namespace BotHub\BotCore;

use PDO;

/**
 * Seeds the copies of every module command (shared/command-presets.json)
 * as disabled custom commands, one command group per module, so they can be
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
        $addGroup = $pdo->prepare('INSERT INTO command_groups (bot_id, name, position) VALUES (?, ?, ?)');
        $addCommand = $pdo->prepare(
            "INSERT INTO commands (bot_id, kind, name, description, builtin, enabled, group_id, graph)
             VALUES (?, 'command', ?, ?, 0, 0, ?, ?)",
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
            $addCommand->execute([$botId, $preset->name, mb_substr($preset->description ?? '', 0, 100), $groups[$group], $graph]);
            $addVersion->execute([(int) $pdo->lastInsertId(), count($preset->graph->nodes ?? []), $graph]);
        }
        return count($doc->commands);
    }
}
