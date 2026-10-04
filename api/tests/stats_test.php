<?php

declare(strict_types=1);

// Bot overview numbers: php tests/stats_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\StatsStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-stats-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$pdo->exec("INSERT INTO bots (id, name, token_enc, token_fingerprint) VALUES (1, 'Bot', x'00', x'01')");
$now = strtotime('2026-10-04T12:30:00Z');
$g1 = '100000000000000001';
$g2 = '100000000000000002';
$add = $pdo->prepare('INSERT INTO bot_stats (bot_id, guild_id, hour, metric, value) VALUES (1, ?, ?, ?, ?)');
foreach ([[$g1, '2026-10-04T12', 'messages', 5], [$g1, '2026-10-04T11', 'messages', 3], [$g2, '2026-10-04T12', 'messages', 2],
          [$g1, '2026-10-04T12', 'joins', 2], [$g1, '2026-10-04T12', 'leaves', 1], [$g1, '2026-10-04T12', 'mod_automod', 1], [$g1, '2026-10-04T12', 'mod_commands', 4],
          [$g1, '2026-10-04T12', 'cmd:ping', 6], [$g1, '2026-10-04T12', 'cmd:help', 2], [$g1, '2026-10-03T10', 'messages', 7]] as $r) {
    $add->execute($r);
}
$u = $pdo->prepare('INSERT INTO bot_stat_users (bot_id, guild_id, hour, user_id) VALUES (1, ?, ?, ?)');
foreach ([[$g1, '2026-10-04T12', 'a'], [$g1, '2026-10-04T11', 'a'], [$g1, '2026-10-04T11', 'b'], [$g2, '2026-10-04T12', 'c']] as $r) {
    $u->execute($r);
}
$s = (new StatsStore($pdo))->bot(1, ['range' => '24h'], $now);
check('24 hourly buckets', count($s['series']['messages']) === 24 && end($s['series']['messages'])['t'] === '2026-10-04T12:00:00Z');
check('totals over all servers', $s['totals']['messages'] === 10 && $s['totals']['newMembers'] === 2 && $s['totals']['moderation'] === 5);
check('previous day', $s['previous']['messages'] === 7);
check('active users: busiest day', $s['totals']['activeUsers'] === 3);
check('top commands', $s['top']['commands'][0] === ['name' => 'ping', 'count' => 6]);
$one = (new StatsStore($pdo))->bot(1, ['range' => '24h', 'guild' => $g2], $now);
check('one server', $one['totals']['messages'] === 2 && $one['totals']['activeUsers'] === 1);
check('7 days in 6 hour buckets', count((new StatsStore($pdo))->bot(1, ['range' => '7d'], $now)['series']['messages']) === 28);
try {
    (new StatsStore($pdo))->bot(1, ['range' => 'custom', 'from' => '2026-10-04T12:00:00Z', 'to' => '2026-10-04T12:01:00Z'], $now);
    check('short custom range refused', false);
} catch (\BotHub\Internal\ApiError) {
    check('short custom range refused', true);
}
exit($failed === 0 ? 0 : 1);
