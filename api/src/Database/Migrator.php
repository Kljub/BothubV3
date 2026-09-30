<?php

declare(strict_types=1);

namespace BotHub\Database;

use PDO;

/**
 * Applies api/migrations/NNNN_name.sql in order. Only the API runs
 * migrations; the bot starts once PRAGMA user_version matches
 * shared/db-schema.json.
 *
 * Applied migrations are immutable: a changed file fails the run (checksum),
 * a fix goes into a new migration.
 */
final class Migrator
{
    public function __construct(private PDO $pdo, private string $dir)
    {
    }

    /** @return list<array{version:int,name:string,file:string}> */
    public function available(): array
    {
        $out = [];
        foreach (glob($this->dir . '/*.sql') ?: [] as $file) {
            if (!preg_match('/^(\d{4})_([a-z0-9_]+)\.sql$/', basename($file), $m)) {
                throw new \RuntimeException('Bad migration file name: ' . basename($file));
            }
            $out[] = ['version' => (int) $m[1], 'name' => $m[2], 'file' => $file];
        }
        usort($out, static fn (array $a, array $b): int => $a['version'] <=> $b['version']);
        foreach ($out as $i => $m) {
            if ($m['version'] !== $i + 1) {
                throw new \RuntimeException("Migrations must be numbered 0001, 0002, … without gaps (found {$m['version']})");
            }
        }
        return $out;
    }

    public function currentVersion(): int
    {
        return (int) $this->pdo->query('PRAGMA user_version')->fetchColumn();
    }

    /**
     * @return list<string> names of the migrations applied in this run
     */
    public function migrate(): array
    {
        $this->pdo->exec(
            'CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                checksum   TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'))
            ) STRICT'
        );
        $applied = [];
        foreach ($this->pdo->query('SELECT version, checksum FROM schema_migrations') as $row) {
            $applied[(int) $row['version']] = $row['checksum'];
        }

        $ran = [];
        foreach ($this->available() as $m) {
            $sql = file_get_contents($m['file']);
            if ($sql === false) {
                throw new \RuntimeException("Cannot read {$m['file']}");
            }
            $checksum = hash('sha256', $sql);
            if (isset($applied[$m['version']])) {
                if (!hash_equals($applied[$m['version']], $checksum)) {
                    throw new \RuntimeException("Migration {$m['version']}_{$m['name']} changed after it was applied");
                }
                continue;
            }
            // One transaction per migration: schema, bookkeeping and version
            // change together or not at all.
            Connection::write($this->pdo, function (PDO $pdo) use ($m, $sql, $checksum): void {
                $pdo->exec($sql);
                $stmt = $pdo->prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
                $stmt->execute([$m['version'], $m['name'], $checksum]);
                $pdo->exec('PRAGMA user_version = ' . $m['version']);
            });
            $ran[] = sprintf('%04d_%s', $m['version'], $m['name']);
        }

        $violations = $this->pdo->query('PRAGMA foreign_key_check')->fetchAll();
        if ($violations !== []) {
            throw new \RuntimeException('Foreign key check failed after migrating');
        }
        return $ran;
    }
}
