<?php

declare(strict_types=1);

// Resource overview rows (ProcessStatus) without Redis: php tests/process_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\ProcessStatus;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$now = new DateTimeImmutable('2026-09-30T12:00:00Z');

$down = ProcessStatus::botcore(null, ['2026-09-30T10:00:00Z|crash'], $now);
check('no heartbeat = stopped', $down['status'] === 'stopped' && $down['restarts24h'] === 1);

$hb = ['pid' => 42, 'cpuPercent' => 3.5, 'memoryBytes' => 1000, 'startedAt' => '2026-09-30T11:00:00Z', 'bots' => 2];
$starts = ['2026-09-28T09:00:00Z|crash', '2026-09-30T08:00:00Z|clean', '2026-09-30T09:00:00Z', '2026-09-30T11:00:00Z|crash'];
$up = ProcessStatus::botcore($hb, $starts, $now);
check('heartbeat = running with uptime', $up['status'] === 'running' && $up['uptimeSeconds'] === 3600 && $up['pid'] === 42 && $up['bots'] === 2);
check('only crashes of the last 24 h count as restarts', $up['restarts24h'] === 1);

$tmp = sys_get_temp_dir() . '/bothub-process-' . bin2hex(random_bytes(4));
mkdir($tmp);
$path = $tmp . '/bothub.sqlite';
$pdo = Connection::open($path);
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$db = ProcessStatus::database($pdo, $path);
check('database row: response time, size, free disk', $db['status'] === 'running' && $db['latencyMs'] >= 0 && $db['storageBytes'] > 0 && $db['diskFreeBytes'] > 0);

exit($failed === 0 ? 0 : 1);
