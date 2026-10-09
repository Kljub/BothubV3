<?php

declare(strict_types=1);

// Recovery key: shown once, stored hashed, one use, resets only the admin account.

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\RecoveryKey;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-recovery-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$admin = (int) $pdo->query("SELECT id FROM roles WHERE key = 'admin'")->fetchColumn();
$user = (int) $pdo->query("SELECT id FROM roles WHERE key = 'member'")->fetchColumn();
$pdo->prepare("INSERT INTO users (id, username, password_hash, role_id, totp_secret_enc) VALUES (1, 'boss', 'old', ?, x'01'), (2, 'member', 'old2', ?, NULL)")->execute([$admin, $user]);
$pdo->exec("INSERT INTO user_sessions (key_hash, public_id, user_id, csrf, created_at, last_seen_at, expires_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'p1', 1, 'c', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z')");

$r = new RecoveryKey($pdo);
check('no key at first', $r->status()['set'] === false);
try {
    $r->recover('BHRK-AAAAA');
    check('recover without key fails', false);
} catch (\RuntimeException $e) {
    check('recover without key fails', str_contains($e->getMessage(), 'no recovery key'));
}
$key = $r->create('boss');
check('key format', (bool) preg_match('/^BHRK(-[A-Z2-9]{5}){6}$/', $key));
check('only a hash is stored', !str_contains((string) $pdo->query('SELECT key_hash FROM recovery_key')->fetchColumn(), substr($key, 5, 5)) && $r->status()['set']);
try {
    $r->recover('BHRK-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG');
    check('wrong key fails', false);
} catch (\RuntimeException $e) {
    check('wrong key fails', $e->getMessage() === 'wrong recovery key');
}
$out = $r->recover(strtolower(str_replace('-', ' ', $key)));
check('recovers the admin (spaces and case do not matter)', $out['username'] === 'boss' && strlen($out['password']) === 20);
$row = $pdo->query('SELECT password_hash, totp_secret_enc FROM users WHERE id = 1')->fetch();
check('new password works, 2FA off', password_verify($out['password'], $row['password_hash']) && $row['totp_secret_enc'] === null);
check('sessions gone', (int) $pdo->query('SELECT COUNT(*) FROM user_sessions WHERE user_id = 1')->fetchColumn() === 0);
check('other users untouched', $pdo->query('SELECT password_hash FROM users WHERE id = 2')->fetchColumn() === 'old2');
check('key used up', $r->status()['set'] === false);
check('logged', (int) $pdo->query("SELECT COUNT(*) FROM logs WHERE key = 'log.server.admin_recovered'")->fetchColumn() === 1);

exit($failed > 0 ? 1 : 0);
