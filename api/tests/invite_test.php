<?php

declare(strict_types=1);

// Custom invite link: php tests/invite_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
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

$tmp = sys_get_temp_dir() . '/bothub-invite-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$router = new InternalRouter(new BotStore($pdo, new SecretBox(random_bytes(32))), static fn () => throw new \RuntimeException('no jobs'), actor: 'admin', invite: new InviteStore($pdo));
$pdo->exec("INSERT INTO bots (name, application_id, avatar_url) VALUES ('Njetflix', '123456789012345678', 'https://cdn.discordapp.com/avatars/1/a.png')");

check('off by default', $router->handle('GET', '/internal/admin/invite-settings', [])[1] === ['enabled' => false, 'mode' => 'private']);
check('page 404 while off', $router->handle('GET', '/internal/invite/123456789012345678', [])[0] === 404);
$r = $router->handle('PUT', '/internal/admin/invite-settings', ['enabled' => true, 'mode' => 'private']);
check('switched on', $r[0] === 200 && $r[1]['enabled'] === true);
$r = $router->handle('GET', '/internal/invite/123456789012345678', []);
check('page data: name, avatar, mode', $r[0] === 200 && $r[1]['bot']['name'] === 'Njetflix' && $r[1]['mode'] === 'private' && !isset($r[1]['bot']['token']));
check('unknown bot 404', $router->handle('GET', '/internal/invite/999999999999999999', [])[0] === 404);
check('bad mode refused', $router->handle('PUT', '/internal/admin/invite-settings', ['enabled' => true, 'mode' => 'all'])[0] === 422);
check('enabled must be bool', $router->handle('PUT', '/internal/admin/invite-settings', ['enabled' => 'yes', 'mode' => 'public'])[0] === 422);
check('logged', (int) $pdo->query("SELECT COUNT(*) FROM logs WHERE key = 'log.server.invite_saved'")->fetchColumn() === 1);

echo $failed === 0 ? "all passed\n" : "{$failed} failed\n";
exit($failed === 0 ? 0 : 1);
