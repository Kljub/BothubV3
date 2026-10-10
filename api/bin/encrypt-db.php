<?php

declare(strict_types=1);

// Encrypts a database that is still plain (installs from before the
// encryption at rest), or switches one encrypted with the passphrase form to
// the raw key, in place, with the key of Connection::key(). Runs at every
// start before the migrations (bin/entrypoint.sh); a database with the raw
// key, or no key, is left alone. KEYS_DIR/db.raw marks the raw key.
//
// While it runs, a copy is kept in data/backups/pre-encrypt.sqlite; it is
// deleted once the database opened with the raw key and showed the same
// tables and schema version.

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;

$path = Connection::defaultPath();
$key = Connection::key();
if ($key === null || !is_file($path)) {
    exit(0);
}
$plain = Connection::isPlain($path);
if (!$plain && Connection::rawKey()) {
    exit(0); // encrypted with the raw key: nothing to do
}

// Plain: encrypt. Encrypted with the passphrase form (older installs): switch
// to the raw key, which opens in about a millisecond instead of 130.
fwrite(STDOUT, 'encrypt-db: ' . ($plain ? 'encrypting' : 'switching to the raw key of') . " {$path}\n");
$db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
if (!$plain) {
    Connection::applyKey($db, $key, false);
}
$db->exec('PRAGMA busy_timeout = 30000');
$version = (int) $db->query('PRAGMA user_version')->fetchColumn();
$tables = (int) $db->query('SELECT COUNT(*) FROM sqlite_master')->fetchColumn();

// Rekey needs the rollback journal, not WAL; a file copy is kept for the switch.
$db->exec('PRAGMA wal_checkpoint(TRUNCATE)');
$db->exec('PRAGMA journal_mode = DELETE');
$dir = dirname($path) . '/backups';
if (!is_dir($dir)) {
    mkdir($dir, 0o700, true);
}
$copy = $dir . '/pre-encrypt.sqlite';
if (!copy($path, $copy)) {
    fwrite(STDERR, "encrypt-db: cannot copy the database, nothing changed\n");
    exit(1);
}
if ($plain) {
    $db->exec("PRAGMA cipher = 'sqlcipher'");
    $db->exec('PRAGMA legacy = 4');
}
$db->query("PRAGMA rekey = \"x'{$key}'\"")->fetchAll();
$db->exec('PRAGMA journal_mode = WAL');
$db = null;

$marker = Connection::rawMarker();
try {
    if (Connection::isPlain($path)) {
        throw new RuntimeException('the file is still plain after the rekey');
    }
    if (file_put_contents($marker, "raw key (SQLCipher x'...'); remove only together with a passphrase-encrypted database\n") === false) {
        throw new RuntimeException("cannot write {$marker}");
    }
    @chgrp($marker, 1000);
    @chmod($marker, 0o640);
    $check = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    Connection::applyKey($check, $key, true);
    $ok = (int) $check->query('PRAGMA user_version')->fetchColumn() === $version
        && (int) $check->query('SELECT COUNT(*) FROM sqlite_master')->fetchColumn() === $tables
        && $check->query('PRAGMA quick_check')->fetchColumn() === 'ok';
    $check = null;
    if (!$ok) {
        throw new RuntimeException('the database does not match after the rekey');
    }
} catch (Throwable $e) {
    // Back to the copy: better the old form than no database.
    copy($copy, $path);
    @unlink($path . '-wal');
    @unlink($path . '-shm');
    @unlink($marker);
    fwrite(STDERR, 'encrypt-db: failed, the database was put back: ' . $e->getMessage() . "\n");
    exit(1);
}
unlink($copy);
fwrite(STDOUT, "encrypt-db: done (schema {$version}, {$tables} tables)\n");
