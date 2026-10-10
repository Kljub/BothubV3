<?php

declare(strict_types=1);

namespace BotHub\Database;

use PDO;

/**
 * Opens the main SQLite database with the write rules from plan.md:
 * WAL, busy_timeout 5000, foreign keys on. Writers use BEGIN IMMEDIATE and
 * keep transactions short; no network call inside a transaction.
 *
 * Encryption at rest: the database file is encrypted (SQLite3 Multiple
 * Ciphers, SQLCipher 4 format) when a key is set: ENV BOTHUB_DB_KEY or
 * KEYS_DIR/db.key (made by start-app). Without the key the file, its WAL
 * and its backups are unreadable. A database that is still plain (older
 * installs) opens without the key until bin/encrypt-db.php encrypted it.
 */
final class Connection
{
    /** SQLite's file header: a database that is not encrypted. */
    private const PLAIN_HEADER = "SQLite format 3\0";

    /** The raw key as 64 hex characters, or null when encryption is off. */
    public static function key(): ?string
    {
        $env = getenv('BOTHUB_DB_KEY');
        $raw = is_string($env) && $env !== '' ? $env : null;
        if ($raw === null) {
            $keys = getenv('KEYS_DIR');
            $file = is_string($keys) && $keys !== '' ? rtrim($keys, '/') . '/db.key' : '';
            $raw = $file !== '' && is_readable($file) ? trim((string) file_get_contents($file)) : null;
        }
        if ($raw === null || $raw === '') {
            return null;
        }
        // 64 hex characters are the key itself; any other text is hashed to one (same rule as the bot).
        return preg_match('/^[0-9a-fA-F]{64}$/', $raw) ? strtolower($raw) : hash('sha256', $raw);
    }

    /** The file exists and is not encrypted. */
    public static function isPlain(string $path): bool
    {
        if (!is_file($path) || filesize($path) < 16) {
            return false;
        }
        $h = fopen($path, 'rb');
        $head = $h === false ? '' : (string) fread($h, 16);
        if ($h !== false) {
            fclose($h);
        }
        return $head === self::PLAIN_HEADER;
    }

    /** Sets the cipher and key on a fresh connection. */
    public static function applyKey(PDO $pdo, string $hexKey): void
    {
        $pdo->exec("PRAGMA cipher = 'sqlcipher'");
        $pdo->exec('PRAGMA legacy = 4');
        $pdo->exec("PRAGMA hexkey = '{$hexKey}'");
    }

    public static function open(string $path): PDO
    {
        $dir = dirname($path);
        if ($path !== ':memory:' && !is_dir($dir) && !mkdir($dir, 0o750, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create data directory {$dir}");
        }
        // The main database stays open per PHP thread (persistent): opening an
        // encrypted database derives its key (PBKDF2, about 130 ms), which
        // every request would pay otherwise.
        $persistent = $path === self::defaultPath();
        $pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_STRINGIFY_FETCHES => false,
            PDO::ATTR_PERSISTENT => $persistent,
        ]);
        $key = $path === ':memory:' ? null : self::key();
        if ($key !== null && !self::isPlain($path) && !($persistent && self::readable($pdo))) {
            self::applyKey($pdo, $key);
        }
        if ($persistent) {
            // A request that died inside a transaction must not leave it open for the next.
            try {
                $pdo->exec('ROLLBACK');
            } catch (\PDOException) {
                // no transaction open: the normal case
            }
        }
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA synchronous = NORMAL');
        $pdo->exec('PRAGMA foreign_keys = ON');
        return $pdo;
    }

    /** A reused connection already has its key (an unkeyed one cannot read the schema). */
    private static function readable(PDO $pdo): bool
    {
        try {
            $pdo->query('SELECT count(*) FROM sqlite_master')->fetchColumn();
            return true;
        } catch (\PDOException) {
            return false;
        }
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
