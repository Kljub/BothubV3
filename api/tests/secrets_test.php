<?php

declare(strict_types=1);

// Global secrets: php tests/secrets_test.php
// Exit code 0 = all passed.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\InternalRouter;
use BotHub\Internal\SecretStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-secrets-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$box = new SecretBox(random_bytes(32));
$router = new InternalRouter(new BotStore($pdo, $box), static fn () => throw new \RuntimeException('no jobs'), secrets: new SecretStore($pdo, $box), actor: 'admin', userId: 7);
$value = 'sk-VERY-SECRET-' . bin2hex(random_bytes(8));
$answers = '';

function call(string $method, string $path, ?array $body = null): array
{
    global $router, $answers;
    [$status, $out] = $router->handle($method, $path, $body ?? []);
    $json = $out === null ? '' : json_encode($out);
    $answers .= $json;
    return [$status, $out === null ? null : json_decode($json, true)];
}

check('new secret needs a value', call('PUT', '/internal/admin/secrets/OPENAI_KEY', ['description' => 'x'])[1]['error']['key'] === 'error.secret.value_required');
check('bad key', call('PUT', '/internal/admin/secrets/openai', ['value' => 'x'])[1]['error']['key'] === 'error.secret.key');
[$s, $sec] = call('PUT', '/internal/admin/secrets/OPENAI_KEY', ['value' => $value, 'description' => 'OpenAI']);
check('secret created without value in answer', $s === 200 && $sec['key'] === 'OPENAI_KEY' && !array_key_exists('value', $sec));
call('PUT', '/internal/admin/secrets/OPENAI_KEY', ['description' => 'OpenAI (renamed)']);
$enc = $pdo->query("SELECT value_enc FROM secrets WHERE key = 'OPENAI_KEY'")->fetchColumn();
check('empty value keeps the stored one', $box->decrypt($enc) === $value);
check('stored encrypted', !str_contains($enc, $value));
$store = new SecretStore($pdo, $box);
check('internal value read', $store->value(0, 'OPENAI_KEY') === $value && $store->value(0, 'NOPE') === null);
[$s, $list] = call('GET', '/internal/admin/secrets');
check('list has description and set flag only', $s === 200 && $list['items'][0]['description'] === 'OpenAI (renamed)' && $list['items'][0]['set'] === true && count($list['items'][0]) === 5);

// Own secrets of the signed-in user (User settings → API / Secrets).
[$s] = call('PUT', '/internal/me/secrets/OPENAI_KEY', ['value' => 'user-key']);
check('user secret saved apart from the instance one', $s === 200 && $store->value(7, 'OPENAI_KEY') === 'user-key' && $store->value(0, 'OPENAI_KEY') === $value);
check('user list has own secrets only', array_column(call('GET', '/internal/me/secrets')[1]['items'], 'key') === ['OPENAI_KEY'] && $store->value(8, 'OPENAI_KEY') === null);
check('user secret delete', call('DELETE', '/internal/me/secrets/OPENAI_KEY')[0] === 204 && $store->value(0, 'OPENAI_KEY') === $value);

check('endpoints are gone', call('GET', '/internal/admin/endpoints')[0] === 404);
check('secret delete', call('DELETE', '/internal/admin/secrets/OPENAI_KEY')[0] === 204 && call('DELETE', '/internal/admin/secrets/OPENAI_KEY')[0] === 404);

$logs = $pdo->query("SELECT key, params, source FROM logs WHERE bot_id IS NULL ORDER BY id")->fetchAll();
check('server log entries', array_column($logs, 'key') === ['log.server.secret_saved', 'log.server.secret_saved', 'log.server.secret_saved', 'log.server.secret_deleted', 'log.server.secret_deleted']
    && json_decode($logs[0]['params'], true) === ['key' => 'OPENAI_KEY', 'actor' => 'admin'] && $logs[0]['source'] === 'api');
check('outbox secrets.changed', (int) $pdo->query("SELECT COUNT(*) FROM outbox WHERE type = 'secrets.changed'")->fetchColumn() === 5);
check('no answer or log contains the value', !str_contains($answers, $value) && !str_contains(json_encode($logs), $value) && !str_contains($answers, substr($value, 0, 12)));

exit($failed === 0 ? 0 : 1);
