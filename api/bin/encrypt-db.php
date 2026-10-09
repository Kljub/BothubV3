<?php

declare(strict_types=1);

// Encrypts a database that is still plain (installs from before the
// encryption at rest), in place, with the key of Connection::key(). Runs at
// every start before the migrations (bin/entrypoint.sh); a database that is
// already encrypted, or no key, is left alone.
//
// While it runs, a plain copy is kept in data/backups/pre-encrypt.sqlite; it
// is deleted once the encrypted database opened with the key and showed the
// same tables and schema version.

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;

$path = Connection::defaultPath();
$key = Connection::key();
if ($key === null || !Connection::isPlain($path)) {
    exit(0);
}

fwrite(STDOUT, "encrypt-db: encrypting {$path}\n");
$plain = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$plain->exec('PRAGMA busy_timeout = 30000');
$version = (int) $plain->query('PRAGMA user_version')->fetchColumn();
$tables = (int) $plain->query('SELECT COUNT(*) FROM sqlite_master')->fetchColumn();

// A plain copy for the moment of the switch.
$dir = dirname($path) . '/backups';
if (!is_dir($dir)) {
    mkdir($dir, 0o700, true);
}
$copy = $dir . '/pre-encrypt.sqlite';
@unlink($copy);
$plain->exec('VACUUM INTO ' . $plain->quote($copy));

// Rekey needs the rollback journal, not WAL.
$plain->exec('PRAGMA wal_checkpoint(TRUNCATE)');
$plain->exec('PRAGMA journal_mode = DELETE');
$plain->exec("PRAGMA cipher = 'sqlcipher'");
$plain->exec('PRAGMA legacy = 4');
$plain->query("PRAGMA hexrekey = '{$key}'")->fetchAll();
$plain->exec('PRAGMA journal_mode = WAL');
$plain = null;

try {
    if (Connection::isPlain($path)) {
        throw new RuntimeException('the file is still plain after the rekey');
    }
    $check = Connection::open($path);
    $ok = (int) $check->query('PRAGMA user_version')->fetchColumn() === $version
        && (int) $check->query('SELECT COUNT(*) FROM sqlite_master')->fetchColumn() === $tables
        && $check->query('PRAGMA quick_check')->fetchColumn() === 'ok';
    $check = null;
    if (!$ok) {
        throw new RuntimeException('the encrypted database does not match');
    }
} catch (Throwable $e) {
    // Back to the plain copy: better a plain database than none.
    copy($copy, $path);
    @unlink($path . '-wal');
    @unlink($path . '-shm');
    fwrite(STDERR, 'encrypt-db: failed, the plain database was put back: ' . $e->getMessage() . "\n");
    exit(1);
}
unlink($copy);
fwrite(STDOUT, "encrypt-db: done (schema {$version}, {$tables} tables)\n");
