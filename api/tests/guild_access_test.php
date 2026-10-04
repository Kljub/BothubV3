<?php

declare(strict_types=1);

// Closed invites (server allowlist): php tests/guild_access_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\GuildAccessStore;
use BotHub\Internal\InternalRouter;
use BotHub\Internal\InviteStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-guildaccess-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$router = new InternalRouter(new BotStore($pdo, new SecretBox(random_bytes(32))), static fn () => throw new \RuntimeException('no jobs'), actor: 'admin', invite: new InviteStore($pdo), guildAccess: new GuildAccessStore($pdo));
$pdo->exec("INSERT INTO bots (name, application_id) VALUES ('Njetflix', '123456789012345678')");
$pdo->exec("INSERT INTO bot_guilds (bot_id, guild_id, name) VALUES (1, '100000000000000001', 'Home'), (1, '100000000000000002', 'Other')");

$r = $router->handle('GET', '/internal/bots/1/guild-access', []);
check('open by default, current servers listed', $r[0] === 200 && $r[1]['closed'] === false && count($r[1]['guilds']) === 2 && $r[1]['guilds'][0]['allowed'] === false);
$r = $router->handle('PUT', '/internal/bots/1/guild-access', ['closed' => true, 'allowed' => []]);
check('closed without servers refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'error.guild_access.empty'));
check('bad id refused', $router->handle('PUT', '/internal/bots/1/guild-access', ['closed' => true, 'allowed' => ['x']])[0] === 422);
$r = $router->handle('PUT', '/internal/bots/1/guild-access', ['closed' => true, 'allowed' => ['100000000000000001', '200000000000000009']]);
$byId = array_column($r[1]['guilds'], null, 'id');
check('saved: home allowed, other not, planned server listed', $r[0] === 200 && $r[1]['closed'] === true
    && $byId['100000000000000001']['allowed'] && !$byId['100000000000000002']['allowed'] && $byId['200000000000000009']['current'] === false);
check('outbox tells the bot', (int) $pdo->query("SELECT COUNT(*) FROM outbox WHERE type = 'bot.guild_access'")->fetchColumn() === 1);
check('unknown bot 404', $router->handle('GET', '/internal/bots/9/guild-access', [])[0] === 404);
$router->handle('PUT', '/internal/admin/invite-settings', ['enabled' => true, 'mode' => 'public']);
check('invite page says closed', $router->handle('GET', '/internal/invite/123456789012345678', [])[1]['bot']['invitesClosed'] === true);

echo $failed === 0 ? "all passed\n" : "{$failed} failed\n";
exit($failed === 0 ? 0 : 1);
