<?php

declare(strict_types=1);

// Runs on every API start (bin/entrypoint.sh), after the migrations:
// - creates DATA_DIR/secret.key unless BOTHUB_SECRET_KEY is set;
// - lets the bot read the key and write the database.
// The API runs as root, the bot as node (uid/gid 1000, BOTHUB_SHARED_GID):
// key 0640, database files 0660, group = the bot's group.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;

SecretBox::loadOrCreate();

$dataDir = rtrim(getenv('DATA_DIR') ?: '/data', '/');
$gid = (int) (getenv('BOTHUB_SHARED_GID') ?: 1000);
$root = function_exists('posix_geteuid') && posix_geteuid() === 0;

$share = static function (string $file, int $mode) use ($gid, $root): void {
    if (!is_file($file)) {
        return;
    }
    if ($root) {
        @chgrp($file, $gid);
    }
    @chmod($file, $mode);
};

$share($dataDir . '/secret.key', 0o640);
// SQLite gives new -wal/-shm files the owner and mode of the database file.
foreach (['', '-wal', '-shm'] as $suffix) {
    $share($dataDir . '/bothub.sqlite' . $suffix, 0o660);
}
fwrite(STDOUT, "share-data: ready\n");
