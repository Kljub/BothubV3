<?php

declare(strict_types=1);

namespace BotHub\Internal;

use PDO;

/**
 * Bot overview numbers (migration 0031, written by the bot per server and
 * hour): totals, the previous period of the same length, series per bucket
 * and top lists, for one server or all. Active users: distinct members per
 * bucket; the total is the highest number of one day.
 */
final class StatsStore
{
    /** Metric of the overview => rows of bot_stats it adds up. */
    private const METRICS = [
        'newMembers' => ['joins'], 'leaves' => ['leaves'], 'messages' => ['messages'], 'voiceMinutes' => ['voice_minutes'],
        'moderation' => ['mod_commands', 'mod_automod'], 'modCommands' => ['mod_commands'], 'modAutomod' => ['mod_automod'],
        'commands' => ['commands'], 'pluginUsages' => ['plugin_uses'],
    ];
    private const RANGES = ['24h' => [86400, 3600], '7d' => [604800, 21600], '30d' => [2592000, 86400]];
    private const TOP = ['commands' => 'cmd:', 'plugins' => 'plugin:', 'modActions' => 'mod:'];

    /** Paths of the member modules (bot: "path:<group>:<path>"), Stats module. */
    public const PATHS = [
        'welcome' => ['normal', 'returning', 'milestone', 'invite', 'bot', 'raid', 'suspicious', 'spam'],
        'leave' => ['left', 'kicked', 'banned', 'pruned', 'bot'],
        'boost' => ['first', 'again', 'stop'],
    ];

    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * Stats module: the member module paths of the last 7, 30 or 90 days
     * (UTC days, today included): count per path and a daily series per group.
     *
     * @param array<string, string> $query days (7|30|90), guild
     */
    public function paths(int $botId, array $query, ?int $now = null): array
    {
        $now ??= time();
        $days = in_array((int) ($query['days'] ?? 30), [7, 30, 90], true) ? (int) $query['days'] : 30;
        $guild = preg_match('/^\d{17,20}$/', (string) ($query['guild'] ?? '')) ? (string) $query['guild'] : null;
        $first = $now - $now % 86400 - ($days - 1) * 86400;
        $sql = "SELECT hour, metric, SUM(value) AS v FROM bot_stats WHERE bot_id = ? AND metric LIKE 'path:%' AND hour >= ?"
            . ($guild !== null ? ' AND guild_id = ?' : '') . ' GROUP BY hour, metric';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($guild !== null ? [$botId, gmdate('Y-m-d\TH', $first), $guild] : [$botId, gmdate('Y-m-d\TH', $first)]);
        $counts = [];
        $series = [];
        foreach (self::PATHS as $group => $paths) {
            $counts[$group] = array_fill_keys($paths, 0);
            $series[$group] = array_fill(0, $days, 0);
        }
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $parts = explode(':', (string) $r['metric']);
            if (count($parts) !== 3 || !isset($counts[$parts[1]][$parts[2]])) {
                continue;
            }
            $day = intdiv((int) strtotime($r['hour'] . ':00:00Z') - $first, 86400);
            if ($day < 0 || $day >= $days) {
                continue;
            }
            $counts[$parts[1]][$parts[2]] += (int) $r['v'];
            $series[$parts[1]][$day] += (int) $r['v'];
        }
        $out = [];
        foreach ($series as $group => $values) {
            $out[$group] = array_map(static fn (int $i, int $v) => ['t' => gmdate('Y-m-d\TH:i:s\Z', $first + $i * 86400), 'v' => $v], array_keys($values), $values);
        }
        return ['days' => $days, 'counts' => $counts, 'series' => $out];
    }

    /** @param array<string, string> $query range (24h|7d|30d|custom), from, to (custom, ISO), guild */
    public function bot(int $botId, array $query, ?int $now = null): array
    {
        $now ??= time();
        $range = $query['range'] ?? '7d';
        if ($range === 'custom') {
            $from = strtotime((string) ($query['from'] ?? ''));
            $to = strtotime((string) ($query['to'] ?? ''));
            if ($from === false || $to === false || $from >= $to) {
                throw new ApiError(422, 'error.range.invalid');
            }
            if ($to - $from < 300) {
                throw new ApiError(422, 'error.range.too_short_stats');
            }
            $window = $to - $from;
            $step = max(3600, intdiv($window, 60) - intdiv($window, 60) % 3600);
            $end = $to;
        } else {
            $range = isset(self::RANGES[$range]) ? $range : '7d';
            [$window, $step] = self::RANGES[$range];
            $end = $now;
        }
        $guild = preg_match('/^\d{17,20}$/', (string) ($query['guild'] ?? '')) ? (string) $query['guild'] : null;

        // Buckets: the last one holds "now".
        $last = $end - $end % $step;
        $first = $last - $window + $step;
        $buckets = [];
        for ($t = $first; $t <= $last; $t += $step) {
            $buckets[] = $t;
        }
        $bucketOf = static fn (int $t): ?int => $t < $first || $t >= $last + $step ? null : $first + intdiv($t - $first, $step) * $step;

        $rows = $this->rows($botId, $guild, $first - $window, $last + $step);
        $series = array_fill_keys(array_keys(self::METRICS), array_fill_keys($buckets, 0));
        $totals = array_fill_keys(array_keys(self::METRICS), 0);
        $previous = $totals;
        $top = ['commands' => [], 'plugins' => [], 'modActions' => []];
        foreach ($rows as $r) {
            $t = (int) strtotime($r['hour'] . ':00:00Z');
            $current = $t >= $first;
            foreach (self::METRICS as $metric => $sources) {
                if (in_array($r['metric'], $sources, true)) {
                    if ($current) {
                        $b = $bucketOf($t);
                        if ($b !== null) {
                            $series[$metric][$b] += (int) $r['value'];
                            $totals[$metric] += (int) $r['value'];
                        }
                    } else {
                        $previous[$metric] += (int) $r['value'];
                    }
                }
            }
            if ($current) {
                foreach (self::TOP as $list => $prefix) {
                    if (str_starts_with($r['metric'], $prefix)) {
                        $name = substr($r['metric'], strlen($prefix));
                        $top[$list][$name] = ($top[$list][$name] ?? 0) + (int) $r['value'];
                    }
                }
            }
        }

        // Active users: distinct per bucket; total = the busiest day.
        $users = $this->users($botId, $guild, $first - $window, $last + $step);
        $perBucket = [];
        $perDay = [];
        $perDayPrev = [];
        foreach ($users as $u) {
            $t = (int) strtotime($u['hour'] . ':00:00Z');
            $day = substr($u['hour'], 0, 10);
            if ($t >= $first) {
                $b = $bucketOf($t);
                if ($b !== null) {
                    $perBucket[$b][$u['user_id']] = true;
                }
                $perDay[$day][$u['user_id']] = true;
            } else {
                $perDayPrev[$day][$u['user_id']] = true;
            }
        }
        $series['activeUsers'] = [];
        foreach ($buckets as $b) {
            $series['activeUsers'][$b] = count($perBucket[$b] ?? []);
        }
        $totals['activeUsers'] = $perDay === [] ? 0 : max(array_map('count', $perDay));
        $previous['activeUsers'] = $perDayPrev === [] ? 0 : max(array_map('count', $perDayPrev));

        $out = [];
        foreach ($series as $metric => $points) {
            $out[$metric] = array_map(static fn (int $t, int $v) => ['t' => gmdate('Y-m-d\TH:i:s\Z', $t), 'v' => $v], array_keys($points), array_values($points));
        }
        $topOut = [];
        foreach ($top as $list => $counts) {
            arsort($counts);
            $topOut[$list] = array_map(static fn ($name, $count) => ['name' => (string) $name, 'count' => $count], array_keys(array_slice($counts, 0, 5, true)), array_values(array_slice($counts, 0, 5, true)));
        }
        return ['range' => $range, 'guild' => $guild, 'totals' => $totals, 'previous' => $previous, 'series' => $out, 'top' => $topOut];
    }

    private function rows(int $botId, ?string $guild, int $from, int $to): array
    {
        $sql = 'SELECT hour, metric, SUM(value) AS value FROM bot_stats WHERE bot_id = ? AND hour >= ? AND hour < ?' . ($guild ? ' AND guild_id = ?' : '') . ' GROUP BY hour, metric';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute(array_merge([$botId, gmdate('Y-m-d\TH', $from), gmdate('Y-m-d\TH', $to)], $guild ? [$guild] : []));
        return $stmt->fetchAll();
    }

    private function users(int $botId, ?string $guild, int $from, int $to): array
    {
        $sql = 'SELECT DISTINCT hour, user_id FROM bot_stat_users WHERE bot_id = ? AND hour >= ? AND hour < ?' . ($guild ? ' AND guild_id = ?' : '');
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute(array_merge([$botId, gmdate('Y-m-d\TH', $from), gmdate('Y-m-d\TH', $to)], $guild ? [$guild] : []));
        return $stmt->fetchAll();
    }
}
