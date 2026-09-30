<?php

declare(strict_types=1);

namespace BotHub\BotCore;

/**
 * Jobs are actions that need Discord (start/stop a bot, ...). The API puts
 * them on bothub:jobs; the bot answers on bothub:results with
 * {jobId, ok, errorKey}; the relay calls finish() for each answer.
 *
 * Job state lives in Redis (bothub:job:<id>, 24 h) and matches the Job
 * schema of GET /api/v1/jobs/{jobId}: queued, then done or failed.
 */
final class Jobs
{
    private const TTL = 86400;

    public function __construct(private readonly \Redis $redis)
    {
    }

    /**
     * Queues a job and returns its id.
     *
     * @param array<string, mixed> $payload e.g. ['botId' => 3]
     * @throws \RedisException when Redis is down (answer 503)
     */
    public function dispatch(string $type, array $payload): string
    {
        StreamContract::assertKnown(StreamContract::JOBS, $type, $payload);
        $id = self::uuid();
        $key = self::key($id);
        $this->redis->multi()
            ->hMSet($key, ['id' => $id, 'type' => $type, 'status' => 'queued', 'createdAt' => self::now()])
            ->expire($key, self::TTL)
            ->exec();
        $data = json_encode(['type' => $type, 'jobId' => $id] + $payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $this->redis->xAdd(StreamContract::JOBS, '*', ['data' => $data], StreamContract::MAXLEN, true);
        return $id;
    }

    /**
     * @return array{id: string, type: string, status: string, errorKey: ?string, createdAt: string, finishedAt: ?string}|null
     */
    public function get(string $id): ?array
    {
        $job = $this->redis->hGetAll(self::key($id));
        if (!is_array($job) || $job === []) {
            return null;
        }
        return [
            'id' => $job['id'],
            'type' => $job['type'],
            'status' => $job['status'],
            'errorKey' => ($job['errorKey'] ?? '') !== '' ? $job['errorKey'] : null,
            'createdAt' => $job['createdAt'],
            'finishedAt' => $job['finishedAt'] ?? null,
        ];
    }

    /**
     * Stores the bot's answer. Unknown or expired job ids are ignored.
     *
     * @param array<string, mixed> $result entry of bothub:results
     */
    public function finish(array $result): void
    {
        $id = $result['jobId'] ?? null;
        if (!is_string($id) || !$this->redis->exists(self::key($id))) {
            return;
        }
        $ok = ($result['ok'] ?? false) === true;
        $this->redis->hMSet(self::key($id), [
            'status' => $ok ? 'done' : 'failed',
            'errorKey' => $ok ? '' : (string) ($result['errorKey'] ?? 'error.job.failed'),
            'finishedAt' => self::now(),
        ]);
    }

    /**
     * Fixed-window rate limit: true while $key was used fewer than $max times
     * in the current $seconds window (e.g. sending saved messages).
     *
     * @throws \RedisException
     */
    public function allow(string $key, int $max, int $seconds): bool
    {
        $k = 'bothub:rate:' . $key;
        $n = (int) $this->redis->incr($k);
        if ($n === 1) {
            $this->redis->expire($k, $seconds);
        }
        return $n <= $max;
    }

    private static function key(string $id): string
    {
        return 'bothub:job:' . $id;
    }

    private static function now(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
