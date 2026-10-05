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
$router = new InternalRouter(new BotStore($pdo, $box), static fn () => throw new \RuntimeException('no jobs'), accounts: new AccountStore($pdo, $box),
    settings: new \BotHub\Internal\InstanceSettings($pdo, $box));
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
$hash = hash('sha256', 'cookie');
$sess = ['id' => 'abcd1234', 'userId' => 1, 'csrf' => 'c', 'remember' => true, 'deviceKey' => 'MFkw', 'userAgent' => 'Firefox', 'ip' => '1.2.3.4',
    'createdAt' => '2026-01-01T00:00:00Z', 'lastSeenAt' => '2026-01-01T00:00:00Z', 'expiresAt' => '2099-01-01T00:00:00Z'];
check('session', $call('PUT', '/internal/accounts/sessions/' . $hash, $sess)[0] === 204);
$call('PUT', '/internal/accounts/sessions/' . $hash, ['lastSeenAt' => '2026-02-01T00:00:00Z', 'userAgent' => 'Chrome'] + $sess);
$s = $call('GET', '/internal/accounts')[1]['sessions'];
check('session load', count($s) === 1 && $s[0]['keyHash'] === $hash && $s[0]['remember'] === true && $s[0]['deviceKey'] === 'MFkw'
    && $s[0]['userAgent'] === 'Chrome' && $s[0]['lastSeenAt'] === '2026-02-01T00:00:00Z');
check('bad session refused', $call('PUT', '/internal/accounts/sessions/xyz', $sess)[0] === 422);
$call('PUT', '/internal/accounts/sessions/' . hash('sha256', 'old'), ['id' => 'beef0000', 'expiresAt' => '2020-01-01T00:00:00Z'] + $sess);
check('expired session dropped', count($call('GET', '/internal/accounts')[1]['sessions']) === 1);
check('delete session', $call('DELETE', '/internal/accounts/sessions/' . $hash)[0] === 204 && $call('GET', '/internal/accounts')[1]['sessions'] === []);
check('role in use stays', $call('DELETE', '/internal/accounts/roles/1')[0] === 409);
check('delete user', $call('DELETE', '/internal/accounts/users/1')[0] === 204 && $call('GET', '/internal/accounts')[1]['users'] === []);
check('bad user refused', $call('PUT', '/internal/accounts/users/2', ['username' => 'x'])[0] === 422);

// Co-Work: members of a bot show in the bot list.
$call('PUT', '/internal/accounts/users/1', ['username' => 'owner', 'passwordHash' => '$argon2id$x', 'roleId' => 1]);
$call('PUT', '/internal/accounts/users/2', ['username' => 'helper', 'passwordHash' => '$argon2id$x', 'roleId' => 3]);
$pdo->exec("INSERT INTO bots (id, name, token_enc, token_fingerprint, owner_id) VALUES (5, 'Bot', x'00', x'05', 1)");
check('member', $call('PUT', '/internal/bots/5/members/2', ['role' => 'custom', 'permissions' => ['bot.control', 'bad perm']])[0] === 204);
$b = array_values(array_filter($call('GET', '/internal/bots')[1]['items'] ?? $call('GET', '/internal/bots')[1], fn ($x) => $x['id'] === 5))[0] ?? [];
check('bot list has owner and members', ($b['ownerId'] ?? 0) === 1 && ($b['members'][0]['userId'] ?? 0) === 2 && ($b['members'][0]['permissions'] ?? null) === ['bot.control']);
check('bad role refused', $call('PUT', '/internal/bots/5/members/2', ['role' => 'king'])[0] === 422);
check('unknown user refused', $call('PUT', '/internal/bots/5/members/9', ['role' => 'viewer'])[0] === 404);
check('remove member', $call('DELETE', '/internal/bots/5/members/2')[0] === 204);

// Instance settings of the gateway.
check('settings empty', $call('GET', '/internal/settings/server')[1]['value'] == new stdClass());
check('settings save', $call('PUT', '/internal/settings/server', ['sessionHours' => 24, 'autoUpdate' => 'check'])[0] === 204);
check('settings load', $call('GET', '/internal/settings/server')[1]['value']->autoUpdate === 'check');
check('unknown settings key', $call('GET', '/internal/settings/mail')[0] === 404);
// SMTP: the password is encrypted and kept when a save leaves it out.
$call('PUT', '/internal/settings/smtp', ['enabled' => true, 'host' => 'mail.example.org', 'password' => 's3cret']);
check('smtp password encrypted', !str_contains((string) $pdo->query("SELECT value || hex(secret_enc) FROM settings WHERE key = 'smtp'")->fetchColumn(), 's3cret'));
$call('PUT', '/internal/settings/smtp', ['enabled' => true, 'host' => 'smtp.example.org']);
$smtp = $call('GET', '/internal/settings/smtp')[1]['value'];
check('smtp password kept', $smtp->password === 's3cret' && $smtp->host === 'smtp.example.org');
$call('PUT', '/internal/settings/smtp', ['enabled' => false, 'password' => '']);
check('smtp password removed', $call('GET', '/internal/settings/smtp')[1]['value']->password === '');

exit($failed === 0 ? 0 : 1);
