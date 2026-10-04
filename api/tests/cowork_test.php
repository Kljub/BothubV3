<?php

declare(strict_types=1);

// Co-Work invites, roles, activity: php tests/cowork_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\CoworkStore;
use BotHub\Internal\InternalRouter;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-cw-' . bin2hex(random_bytes(4));
mkdir($tmp);
putenv('DATA_DIR=' . $tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
foreach ([[1, 'owner'], [2, 'helper'], [3, 'friend']] as [$id, $n]) {
    $pdo->exec("INSERT INTO users (id, username, password_hash, role_id) VALUES ({$id}, '{$n}', 'x', 2)");
}
$pdo->exec("INSERT INTO bots (id, name, token_enc, token_fingerprint, owner_id) VALUES (5, 'Bot', x'00', x'05', 1)");
$box = SecretBox::loadOrCreate($tmp);
$as = fn (int $user) => new InternalRouter(new BotStore($pdo, $box), static fn () => throw new \RuntimeException('no jobs'), userId: $user, cowork: new CoworkStore($pdo));
$call = fn (int $user, string $m, string $p, array $b = []) => $as($user)->handle($m, $p, $b, null, []);

$r = $call(1, 'POST', '/internal/bots/5/cowork/invites', ['kind' => 'link', 'role' => 'builder', 'expiresIn' => 3600, 'maxUses' => 1]);
check('link invite', $r[0] === 201 && strlen($r[1]['token'] ?? '') === 40 && $r[1]['maxUses'] === 1);
$token = $r[1]['token'];
check('join by link', $call(2, 'POST', '/internal/invites/accept', ['token' => $token])[1] === ['botId' => 5]);
check('member with the role', $pdo->query('SELECT role FROM bot_members WHERE bot_id = 5 AND user_id = 2')->fetchColumn() === 'builder');
check('used up', $call(3, 'POST', '/internal/invites/accept', ['token' => $token])[0] === 410);
$r = $call(1, 'POST', '/internal/bots/5/cowork/invites', ['kind' => 'user', 'userId' => 3, 'role' => 'custom', 'permissions' => ['bot.control'], 'roleName' => 'Starter']);
check('user invite', $r[0] === 201 && $r[1]['username'] === 'friend' && !isset($r[1]['token']));
$mine = $call(3, 'GET', '/internal/invites')[1]['items'];
check('invitee sees it', count($mine) === 1 && $mine[0]['botName'] === 'Bot' && $mine[0]['byName'] === 'owner');
check('others cannot accept it', $call(2, 'POST', '/internal/invites/accept', ['id' => $mine[0]['id']])[0] === 410);
$call(3, 'POST', '/internal/invites/accept', ['id' => $mine[0]['id']]);
check('custom rights', $pdo->query('SELECT permissions FROM bot_members WHERE bot_id = 5 AND user_id = 3')->fetchColumn() === '["bot.control"]');
check('roles', $call(1, 'POST', '/internal/bots/5/cowork/roles', ['name' => 'Mod', 'permissions' => ['logs.view']])[1]['items'][0]['name'] === 'Mod');
$call(1, 'POST', '/internal/bots/5/cowork/activity', ['userId' => 2, 'area' => 'commands', 'method' => 'PUT']);
$page = $call(1, 'GET', '/internal/bots/5/cowork')[1];
check('page', $page['invites'] === [] && count($page['roles']) === 1 && $page['activity'][0]['user'] === 'helper' && $page['activity'][0]['params']['area'] === 'commands'
    && count(array_filter($page['activity'], fn ($a) => $a['key'] === 'log.cowork.joined')) === 2);
$id = $call(1, 'POST', '/internal/bots/5/cowork/invites', ['kind' => 'link', 'role' => 'viewer'])[1]['id'];
check('revoke', $call(1, 'DELETE', "/internal/bots/5/cowork/invites/{$id}")[0] === 204 && $call(1, 'GET', '/internal/bots/5/cowork')[1]['invites'] === []);
check('bad invite', $call(1, 'POST', '/internal/bots/5/cowork/invites', ['kind' => 'link', 'role' => 'king'])[0] === 422);

exit($failed === 0 ? 0 : 1);
