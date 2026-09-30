<?php

declare(strict_types=1);

namespace BotHub\Database;

use PDO;

/**
 * Opens the main SQLite database with the write rules from plan.md:
 * WAL, busy_timeout 5000, foreign keys on. Writers use BEGIN IMMEDIATE and
 * keep transactions short; no network call inside a transaction.
 */
final class Connection
{
    public static function open(string $path): PDO
    {
        $dir = dirname($path);
        if ($path !== ':memory:' && !is_dir($dir) && !mkdir($dir, 0o750, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create data directory {$dir}");
        }
        $pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA synchronous = NORMAL');
        $pdo->exec('PRAGMA foreign_keys = ON');
        return $pdo;
    }

    /** Path of the main database inside DATA_DIR. */
    public static function defaultPath(): string
    {
        $dataDir = getenv('DATA_DIR') ?: '/data';
        return rtrim($dataDir, '/') . '/bothub.sqlite';
    }

    /**
     * Runs $fn in a write transaction (BEGIN IMMEDIATE takes the write lock
     * up front, so two writers never deadlock on a lock upgrade).
     *
     * @template T
     * @param callable(PDO): T $fn
     * @return T
     */
    public static function write(PDO $pdo, callable $fn): mixed
    {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $result = $fn($pdo);
            $pdo->exec('COMMIT');
            return $result;
        } catch (\Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }
}
