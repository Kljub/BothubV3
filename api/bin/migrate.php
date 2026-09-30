<?php

declare(strict_types=1);

// Applies pending migrations to DATA_DIR/bothub.sqlite. Runs on every API
// container start (bin/entrypoint.sh) before the web server.

require __DIR__ . '/../src/Database/Connection.php';
require __DIR__ . '/../src/Database/Migrator.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;

$path = $argv[1] ?? Connection::defaultPath();
$pdo = Connection::open($path);
$migrator = new Migrator($pdo, __DIR__ . '/../migrations');

$before = $migrator->currentVersion();
$ran = $migrator->migrate();
$after = $migrator->currentVersion();

$shared = getenv('SHARED_DIR') ?: __DIR__ . '/../../shared';
$expected = json_decode((string) @file_get_contents($shared . '/db-schema.json'), true)['version'] ?? null;
if ($expected !== null && $expected !== $after) {
    fwrite(STDERR, "migrate: schema version {$after}, shared/db-schema.json expects {$expected}\n");
    exit(1);
}

fwrite(STDOUT, $ran === []
    ? "migrate: schema version {$after}, nothing to do\n"
    : sprintf("migrate: %d -> %d (%s)\n", $before, $after, implode(', ', $ran)));
