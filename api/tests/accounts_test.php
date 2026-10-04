<?php

declare(strict_types=1);

// Accounts of the gateway: php tests/accounts_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\AccountStore;
use BotHub\Internal\BotStore;
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

$tmp = sys_get_temp_dir() . '/bothub-acc-' . bin2hex(random_bytes(4));
mkdir($tmp);
putenv('DATA_DIR=' . $tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$box = SecretBox::loadOrCreate($tmp);
$router = new InternalRouter(new BotStore($pdo, $box), static fn () => throw new \RuntimeException('no jobs'), accounts: new AccountStore($pdo, $box));
$call = fn (string $m, string $p, array $b = []) => $router->handle($m, $p, $b, null, []);

check('role', $call('PUT', '/internal/accounts/roles/3', ['key' => 'banned', 'name' => 'Banned', 'builtin' => true, 'permissions' => []])[0] === 204);
$r = $call('PUT', '/internal/accounts/users/1', ['username' => 'admin', 'passwordHash' => '$argon2id$x', 'roleId' => 1, 'theme' => 'dark', 'locale' => 'de',
    'totpSecret' => 'JBSWY3DPEHPK3PXP', 'recoveryCodes' => ['h1', 'h2']]);
check('user', $r[0] === 204);
check('2FA secret encrypted at rest', (string) $pdo->query('SELECT totp_secret_enc FROM users WHERE id = 1')->fetchColumn() !== 'JBSWY3DPEHPK3PXP');
check('passkey', $call('PUT', '/internal/accounts/passkeys/abc_-1', ['userId' => 1, 'name' => 'Laptop', 'credential' => ['id' => 'x']])[0] === 204);
$all = $call('GET', '/internal/accounts')[1];
$u = $all['users'][0];
check('load', $u['username'] === 'admin' && $u['totpSecret'] === 'JBSWY3DPEHPK3PXP' && $u['recoveryCodes'] === ['h1', 'h2'] && $u['locale'] === 'de'
    && $all['passkeys'][0]['name'] === 'Laptop' && count($all['roles']) >= 3);
$call('PUT', '/internal/accounts/users/1', ['username' => 'admin', 'passwordHash' => '$argon2id$y', 'roleId' => 1]);
check('update keeps passkeys', count($call('GET', '/internal/accounts')[1]['passkeys']) === 1);
check('role in use stays', $call('DELETE', '/internal/accounts/roles/1')[0] === 409);
check('delete user', $call('DELETE', '/internal/accounts/users/1')[0] === 204 && $call('GET', '/internal/accounts')[1]['users'] === []);
check('bad user refused', $call('PUT', '/internal/accounts/users/2', ['username' => 'x'])[0] === 422);

exit($failed === 0 ? 0 : 1);
