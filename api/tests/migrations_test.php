<?php

declare(strict_types=1);

// Schema tests without a framework: php tests/migrations_test.php
// Exit code 0 = all passed.

require __DIR__ . '/../src/Database/Connection.php';
require __DIR__ . '/../src/Database/Migrator.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}
function throws(callable $fn): bool
{
    try {
        $fn();
        return false;
    } catch (\Throwable) {
        return true;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-test-' . bin2hex(random_bytes(4));
mkdir($tmp);
$dbPath = $tmp . '/bothub.sqlite';
$migrations = __DIR__ . '/../migrations';
$shared = getenv('SHARED_DIR') ?: __DIR__ . '/../../shared';

// --- migrate a fresh database, then again (no-op) ---
$pdo = Connection::open($dbPath);
$m = new Migrator($pdo, $migrations);
$ran = $m->migrate();
$expected = json_decode(file_get_contents($shared . '/db-schema.json'), true)['version'];
check('fresh database migrates to shared/db-schema.json version', $m->currentVersion() === $expected);
check('every migration ran once', count($ran) === $expected);
check('second run does nothing', $m->migrate() === []);
check('WAL mode', $pdo->query('PRAGMA journal_mode')->fetchColumn() === 'wal');
check('foreign keys on', (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn() === 1);

$tables = $pdo->query("SELECT name FROM sqlite_schema WHERE type = 'table'")->fetchAll(PDO::FETCH_COLUMN);
foreach (['settings', 'users', 'roles', 'passkeys', 'logs', 'outbox', 'bots', 'bot_guilds', 'bot_modules', 'sdk_policies', 'plugin_installs', 'bot_plugin_disabled',
    'commands', 'command_groups', 'command_versions', 'message_templates', 'scheduled_jobs', 'variables',
    'economy_balances', 'warnings', 'mod_cases', 'mod_notes', 'leveling_members', 'giveaways', 'polls', 'suggestions', 'tickets', 'modmail_threads'] as $t) {
    check("table {$t}", in_array($t, $tables, true));
}

// --- constraints ---
$pdo->exec("INSERT INTO users (username, password_hash, role_id) VALUES ('admin', 'x', 1)");
$pdo->exec("INSERT INTO bots (name) VALUES ('Test bot')");
$botId = (int) $pdo->lastInsertId();
$graph = '{"schemaVersion":1,"nodes":[],"edges":[]}';
// A fresh statement per call: SQLite needs a reset after a failed execute.
$insert = new class ($pdo) {
    public function __construct(private PDO $pdo)
    {
    }
    public function execute(array $values): bool
    {
        return $this->pdo->prepare('INSERT INTO commands (bot_id, name, graph, builtin, module_key, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')->execute($values);
    }
};

check('invalid JSON graph is rejected', throws(fn () => $insert->execute([$botId, 'broken', '{nope', 0, null, null])));
$insert->execute([$botId, 'ping', $graph, 0, null, null]);
check('duplicate custom command name is rejected', throws(fn () => $insert->execute([$botId, 'ping', $graph, 0, null, null])));
check('built-in command may share the name of a custom copy', !throws(fn () => $insert->execute([$botId, 'ping', $graph, 1, 'servermanagement', null])));
check('built-in command needs its module', throws(fn () => $insert->execute([$botId, 'kick', $graph, 1, null, null])));
check('a deleted command frees its name', !throws(function () use ($pdo, $insert, $botId, $graph): void {
    $pdo->exec("UPDATE commands SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE name = 'ping' AND builtin = 0");
    $insert->execute([$botId, 'ping', $graph, 0, null, null]);
}));
check('event type only on events', throws(fn () => $pdo->exec("INSERT INTO commands (bot_id, name, graph, event_type) VALUES ({$botId}, 'x', '{}', 'member_join')")));
check('invalid role permissions are rejected', throws(fn () => $pdo->exec("INSERT INTO roles (key, name, permissions) VALUES ('mod', 'Mod', '{}')")));
check('poll needs 2 to 10 answers', throws(fn () => $pdo->exec("INSERT INTO polls (bot_id, guild_id, channel_id, question, answers) VALUES ({$botId}, '1', '2', 'Q?', '[\"only one\"]')")));
check('STRICT rejects text in an integer column', throws(fn () => $pdo->exec("INSERT INTO warnings (bot_id, guild_id, user_id) VALUES ('abc', '1', '2')")));

// --- command presets fit the schema ---
$presets = json_decode(file_get_contents($shared . '/command-presets.json'), true)['commands'];
$groupIds = [];
$ok = true;
Connection::write($pdo, function (PDO $pdo) use ($presets, $botId, &$groupIds, &$ok): void {
    $group = $pdo->prepare('INSERT INTO command_groups (bot_id, name, position) VALUES (?, ?, ?)');
    $cmd = $pdo->prepare('INSERT INTO commands (bot_id, name, description, enabled, group_id, graph) VALUES (?, ?, ?, 0, ?, ?)');
    foreach ($presets as $p) {
        if (!isset($groupIds[$p['group']])) {
            $group->execute([$botId, $p['group'], count($groupIds)]);
            $groupIds[$p['group']] = (int) $pdo->lastInsertId();
        }
        $name = $p['name'] === 'ping' ? 'ping-copy' : $p['name']; // 'ping' exists above
        $ok = $ok && $cmd->execute([$botId, $name, $p['description'], $groupIds[$p['group']], json_encode($p['graph'])]);
    }
});
$count = (int) $pdo->query("SELECT count(*) FROM commands WHERE bot_id = {$botId} AND enabled = 0")->fetchColumn();
check('all ' . count($presets) . ' command presets insert as disabled custom commands', $ok && $count === count($presets));

// --- cascades ---
$pdo->exec("INSERT INTO command_versions (command_id, nodes, graph) SELECT id, 0, graph FROM commands WHERE bot_id = {$botId}");
$pdo->exec("DELETE FROM bots WHERE id = {$botId}");
check('deleting a bot deletes its commands, groups and versions', (int) $pdo->query(
    'SELECT (SELECT count(*) FROM commands) + (SELECT count(*) FROM command_groups) + (SELECT count(*) FROM command_versions)'
)->fetchColumn() === 0);

// --- applied migrations are immutable ---
$copy = $tmp . '/migrations';
mkdir($copy);
foreach (glob($migrations . '/*.sql') as $f) {
    copy($f, $copy . '/' . basename($f));
}
file_put_contents($copy . '/0001_core.sql', "\n-- edited", FILE_APPEND);
check('changed applied migration fails', throws(fn () => (new Migrator($pdo, $copy))->migrate()));

// --- a failing migration rolls back completely ---
$fresh = Connection::open($tmp . '/fresh.sqlite');
copy($migrations . '/0001_core.sql', $copy . '/0001_core.sql');
file_put_contents($copy . sprintf('/%04d_broken.sql', $expected + 1), "CREATE TABLE half (id INTEGER PRIMARY KEY) STRICT;\nTHIS IS NOT SQL;");
$broken = new Migrator($fresh, $copy);
check('broken migration throws', throws(fn () => $broken->migrate()));
check('broken migration leaves no half table', $fresh->query("SELECT count(*) FROM sqlite_schema WHERE name = 'half'")->fetchColumn() === 0);
check('version stays at the last good migration', $broken->currentVersion() === $expected);

echo $failed === 0 ? "\nall passed\n" : "\n{$failed} failed\n";
exit($failed === 0 ? 0 : 1);
