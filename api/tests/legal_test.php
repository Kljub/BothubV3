<?php

declare(strict_types=1);

// Operator details of the Terms and Privacy pages: php tests/legal_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\InternalRouter;
use BotHub\Internal\LegalStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-legal-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$router = new InternalRouter(new BotStore($pdo, new SecretBox(random_bytes(32))), static fn () => throw new \RuntimeException('no jobs'), actor: 'admin', legal: new LegalStore($pdo));

$r = $router->handle('GET', '/internal/legal', []);
check('empty at first', $r[0] === 200 && $r[1]['operator'] === '' && $r[1]['email'] === '' && $r[1]['updatedAt'] === null);
$r = $router->handle('PUT', '/internal/admin/legal', ['operator' => ' Max Muster ', 'address' => "Musterweg 1\r\n12345 Berlin", 'email' => 'bot@example.org']);
check('saved and trimmed', $r[0] === 200 && $r[1]['operator'] === 'Max Muster' && $r[1]['address'] === "Musterweg 1\n12345 Berlin");
check('public read', $router->handle('GET', '/internal/legal', [])[1]['email'] === 'bot@example.org');
check('source link https only', $router->handle('PUT', '/internal/admin/legal', ['sourceUrl' => 'http://x.example'])[0] === 422
    && $router->handle('PUT', '/internal/admin/legal', ['sourceUrl' => 'https://github.com/Kljub/BothubV3'])[1]['sourceUrl'] === 'https://github.com/Kljub/BothubV3');
check('bad e-mail refused', $router->handle('PUT', '/internal/admin/legal', ['email' => 'nope'])[0] === 422);
check('too long refused', $router->handle('PUT', '/internal/admin/legal', ['operator' => str_repeat('x', 121)])[0] === 422);
check('public path cannot write', $router->handle('PUT', '/internal/legal', ['operator' => 'x'])[0] === 405);
check('change logged without values', str_contains((string) $pdo->query("SELECT params FROM logs WHERE key = 'log.server.legal_saved'")->fetchColumn(), 'admin'));

echo $failed === 0 ? "all passed\n" : "{$failed} failed\n";
exit($failed === 0 ? 0 : 1);
