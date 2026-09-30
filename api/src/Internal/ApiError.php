<?php

declare(strict_types=1);

namespace BotHub\Internal;

/** An error answer: {"error": {"key": ..., "params": {...}}}. */
final class ApiError extends \RuntimeException
{
    /** @param array<string, mixed> $params */
    public function __construct(public readonly int $status, public readonly string $key, public readonly array $params = [])
    {
        parent::__construct($key);
    }

    public static function notFound(string $key = 'error.bot.not_found'): self
    {
        return new self(404, $key);
    }
}
