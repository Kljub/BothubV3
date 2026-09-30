<?php

declare(strict_types=1);

namespace BotHub\Redis;

/** Opens a phpredis connection from a redis:// URL (ENV REDIS_URL). */
final class RedisConnect
{
    public static function url(): string
    {
        return getenv('REDIS_URL') ?: 'redis://redis:6379';
    }

    /**
     * @param bool $persistent reuse the socket across requests (FrankenPHP
     *                         workers); long-running CLI processes pass false
     * @throws \RedisException
     */
    public static function open(string $url, float $timeout, bool $persistent, float $readTimeout = 0.0): \Redis
    {
        $parts = parse_url($url);
        if ($parts === false || !isset($parts['host'])) {
            throw new \RedisException('invalid REDIS_URL');
        }
        $redis = new \Redis();
        $port = $parts['port'] ?? 6379;
        if ($persistent) {
            $redis->pconnect($parts['host'], $port, $timeout, 'bothub');
        } else {
            $redis->connect($parts['host'], $port, $timeout);
        }
        $redis->setOption(\Redis::OPT_READ_TIMEOUT, $readTimeout > 0 ? $readTimeout : $timeout);
        if (isset($parts['pass'])) {
            $pass = rawurldecode($parts['pass']);
            $redis->auth(isset($parts['user']) ? [rawurldecode($parts['user']), $pass] : $pass);
        }
        $db = (int) ltrim($parts['path'] ?? '', '/');
        if ($db > 0) {
            $redis->select($db);
        }
        return $redis;
    }
}
