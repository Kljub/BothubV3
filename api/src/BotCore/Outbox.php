<?php

declare(strict_types=1);

namespace BotHub\BotCore;

use PDO;

/**
 * Transactional outbox (plan.md, section 1). Repositories call add() inside
 * Connection::write(), so the change and its event commit together. The
 * relay (bin/relay.php) moves open rows to the Redis stream.
 *
 *   Connection::write($pdo, function (PDO $pdo) use ($botId, $id) {
 *       // ... UPDATE commands ...
 *       Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => $id]);
 *   });
 */
final class Outbox
{
    /** @param array<string, mixed> $payload */
    public static function add(PDO $pdo, string $type, array $payload, string $stream = StreamContract::EVENTS): int
    {
        if (!$pdo->inTransaction()) {
            throw new \LogicException('Outbox::add must run inside Connection::write()');
        }
        StreamContract::assertKnown($stream, $type, $payload);
        $stmt = $pdo->prepare('INSERT INTO outbox (stream, type, payload) VALUES (?, ?, ?)');
        $stmt->execute([$stream, $type, json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
        return (int) $pdo->lastInsertId();
    }
}
