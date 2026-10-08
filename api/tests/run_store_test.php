<?php

declare(strict_types=1);

// Playbacks and errors: runs of a command, the Errors list, fixed, dismiss and mute.

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\ApiError;
use BotHub\Internal\RunStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-runs-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$pdo->exec("INSERT INTO bots (id, name, token_enc, token_fingerprint) VALUES (1, 'Bot', x'00', x'01'), (2, 'Other', x'02', x'03')");
$pdo->exec("INSERT INTO commands (id, bot_id, name, graph) VALUES (1, 1, 'ping', '{}'), (2, 2, 'other', '{}')");
$add = $pdo->prepare('INSERT INTO run_traces (bot_id, command_id, run_key, ok, error_node, error_key, error_hint, steps, start_vars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
$add->execute([1, 1, 'a', 0, 'send_1', 'error.run.discord', '{"key":"discord.50013.message","text":"Discord refused","fix":"Check overrides","params":{}}', '[{"node":"t","status":"ok"},{"node":"send_1","status":"error"}]', '{"user":"kljub"}']);
$add->execute([1, 1, 'b', 0, 'role_1', 'error.run.missing_permissions', null, '[{"node":"role_1","status":"error"}]', '{}']);
$add->execute([2, 2, 'c', 0, 'x', 'error.run.discord', null, '[]', '{}']);

$s = new RunStore($pdo);
$errors = $s->list(1, null, true, false, null);
check('errors list: own bot only, newest first', count($errors) === 2 && $errors[0]['error_node'] === 'role_1' && $errors[1]['command_name'] === 'ping');
check('reason comes along', $errors[1]['error_hint']['fix'] === 'Check overrides' && $errors[1]['fixed'] === false);

$add->execute([1, 1, 'd', 1, null, null, null, '[{"node":"t","status":"ok"},{"node":"send_1","status":"ok"}]', '{}']);
$errors = $s->list(1, null, true, false, null);
check('a later ok run through the block: fixed', $errors[1]['fixed'] === true && $errors[0]['fixed'] === false);
check('command runs include ok ones', count($s->list(1, 1, false, false, null)) === 3);

$one = $s->get(1, $errors[1]['id']);
check('one run with steps and start variables', count($one['steps']) === 2 && $one['start_vars']->user === 'kljub');
try {
    $s->get(1, 3);
    check('other bot run hidden', false);
} catch (ApiError $e) {
    check('other bot run hidden', $e->status === 404);
}

$s->mute(1, $errors[0]['id'], true);
check('muted error leaves the list', count($s->list(1, null, true, false, null)) === 1);
check('muted shown on request', count($s->list(1, null, true, true, null)) === 2);
$s->mute(1, $errors[0]['id'], false);
$s->dismiss(1, $errors[1]['id']);
check('dismissed', count($s->list(1, null, true, false, null)) === 1);
check('dismiss all', $s->dismissAll(1, null) === 1 && $s->list(1, null, true, false, null) === []);
check('other bot untouched', count($s->list(2, null, true, false, null)) === 1);

exit($failed > 0 ? 1 : 0);
