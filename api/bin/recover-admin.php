<?php

declare(strict_types=1);

// Gets the admin account back with the recovery key (Admin → Security in the
// dashboard). Run through the app container:
//
//   docker compose exec app start-app recover-admin <RECOVERY-KEY> [username]
//
// The admin (or the named account) gets a new password, printed here; its
// 2FA, recovery codes, passkeys and sessions are removed and the key is used
// up. Nothing else of the database can be read or changed with it.

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;
use BotHub\Internal\RecoveryKey;

$key = (string) ($argv[1] ?? '');
$username = (string) ($argv[2] ?? '');
if ($key === '') {
    fwrite(STDERR, "usage: start-app recover-admin <RECOVERY-KEY> [username]\n");
    exit(2);
}

try {
    $result = (new RecoveryKey(Connection::open(Connection::defaultPath())))->recover($key, $username);
} catch (\RuntimeException $e) {
    // A wrong key costs time, so it cannot be guessed quickly.
    sleep(3);
    fwrite(STDERR, 'recover-admin: ' . $e->getMessage() . "\n");
    exit(1);
}

fwrite(STDOUT, "Account:      {$result['username']}\n");
fwrite(STDOUT, "New password: {$result['password']}\n\n");
fwrite(STDOUT, "2FA, passkeys and sessions of this account were removed; the recovery key is used up.\n");
fwrite(STDOUT, "Sign in, change the password and create a new recovery key (Admin → Security).\n");
