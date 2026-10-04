<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;

/**
 * Closed invites of a bot (migration 0026): while closed, the bot stays only
 * on the allowed servers and leaves every other one (the bot enforces it on
 * join, at start and after outbox bot.guild_access).
 */
final class GuildAccessStore
{
    private const MAX = 200;

    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * The switch and every server that is allowed or the bot is on now.
     *
     * @return array{closed: bool, guilds: list<array{id: string, name: string, iconUrl: ?string, allowed: bool, current: bool}>}
     */
    public function get(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT invites_closed FROM bots WHERE id = ?');
        $stmt->execute([$botId]);
        $closed = $stmt->fetchColumn();
        if ($closed === false) {
            throw ApiError::notFound();
        }
        $stmt = $this->pdo->prepare(
            "SELECT g.guild_id AS id, g.name, g.icon_url, 1 AS current, a.guild_id IS NOT NULL AS allowed
               FROM bot_guilds g LEFT JOIN bot_allowed_guilds a ON a.bot_id = g.bot_id AND a.guild_id = g.guild_id
              WHERE g.bot_id = ? AND g.left_at IS NULL
             UNION ALL
             SELECT a.guild_id, COALESCE(g.name, ''), g.icon_url, 0, 1
               FROM bot_allowed_guilds a LEFT JOIN bot_guilds g ON g.bot_id = a.bot_id AND g.guild_id = a.guild_id
              WHERE a.bot_id = ? AND (g.guild_id IS NULL OR g.left_at IS NOT NULL)
              ORDER BY 2 COLLATE NOCASE, 1"
        );
        $stmt->execute([$botId, $botId]);
        $guilds = array_map(static fn (array $r) => [
            'id' => (string) $r['id'], 'name' => (string) $r['name'], 'iconUrl' => $r['icon_url'] !== null ? (string) $r['icon_url'] : null,
            'allowed' => (bool) $r['allowed'], 'current' => (bool) $r['current'],
        ], $stmt->fetchAll());
        return ['closed' => (int) $closed === 1, 'guilds' => $guilds];
    }

    /** Saves the switch and the allowed servers; closed needs at least one server. */
    public function save(int $botId, array $in, string $actor): array
    {
        $closed = $in['closed'] ?? null;
        $allowed = $in['allowed'] ?? null;
        if (!is_bool($closed) || !is_array($allowed) || !array_is_list($allowed) || count($allowed) > self::MAX) {
            throw new ApiError(422, 'error.validation.failed', ['field' => is_bool($closed) ? 'allowed' : 'closed']);
        }
        $ids = [];
        foreach ($allowed as $id) {
            if (!is_string($id) || !preg_match('/^\d{17,20}$/', $id)) {
                throw new ApiError(422, 'error.validation.failed', ['field' => 'allowed']);
            }
            $ids[$id] = true;
        }
        if ($closed && $ids === []) {
            // The bot would leave every server.
            throw new ApiError(422, 'error.guild_access.empty');
        }
        $this->get($botId); // 404 for an unknown bot
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $closed, $ids, $actor): void {
            $pdo->prepare('UPDATE bots SET invites_closed = ? WHERE id = ?')->execute([$closed ? 1 : 0, $botId]);
            $pdo->prepare('DELETE FROM bot_allowed_guilds WHERE bot_id = ?')->execute([$botId]);
            $add = $pdo->prepare('INSERT INTO bot_allowed_guilds (bot_id, guild_id) VALUES (?, ?)');
            foreach (array_keys($ids) as $id) {
                $add->execute([$botId, (string) $id]);
            }
            $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (?, 'change', 'log.change.guild_access', ?, 'api')")
                ->execute([$botId, json_encode(['closed' => $closed ? 'on' : 'off', 'count' => count($ids), 'actor' => mb_substr($actor, 0, 64)], JSON_THROW_ON_ERROR)]);
            Outbox::add($pdo, 'bot.guild_access', ['botId' => $botId]);
        });
        return $this->get($botId);
    }
}
