<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Card Designer: image cards of a bot (table bot_cards, 0041). The design is
 * kept as the Card Studio sends it (shared/cards/render.mjs makes it safe
 * when drawing); here only its shape and size are checked.
 */
final class CardStore
{
    public const KINDS = ['welcome', 'welcome-back', 'goodbye', 'boost', 'milestone', 'rank', 'custom'];
    private const MAX_DESIGN = 262144;
    private const MAX_LAYERS = 40;
    private const MAX_CARDS = 100;

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return list<array<string, mixed>> newest first */
    public function list(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM bot_cards WHERE bot_id = ? ORDER BY id DESC');
        $stmt->execute([$botId]);
        return array_map(self::row(...), $stmt->fetchAll());
    }

    public function get(int $botId, int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM bot_cards WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        return self::row($stmt->fetch() ?: throw ApiError::notFound('error.card.unknown'));
    }

    public function create(int $botId, mixed $in): array
    {
        $name = self::name($in->name ?? null);
        $kind = self::kind($in->kind ?? 'custom');
        $design = self::design($in->design ?? null);
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $name, $kind, $design): int {
            $count = $pdo->prepare('SELECT COUNT(*) FROM bot_cards WHERE bot_id = ?');
            $count->execute([$botId]);
            if ((int) $count->fetchColumn() >= self::MAX_CARDS) {
                throw new ApiError(409, 'error.card.too_many', ['max' => self::MAX_CARDS]);
            }
            $pdo->prepare('INSERT INTO bot_cards (bot_id, name, kind, design) VALUES (?, ?, ?, ?)')->execute([$botId, $name, $kind, $design]);
            return (int) $pdo->lastInsertId();
        });
        return $this->get($botId, $id);
    }

    /** Changes name, kind and/or design. */
    public function update(int $botId, int $id, mixed $in): array
    {
        $sets = [];
        $params = [];
        if (property_exists($in, 'name')) {
            $sets[] = 'name = ?';
            $params[] = self::name($in->name);
        }
        if (property_exists($in, 'kind')) {
            $sets[] = 'kind = ?';
            $params[] = self::kind($in->kind);
        }
        if (property_exists($in, 'design')) {
            $sets[] = 'design = ?';
            $params[] = self::design($in->design);
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $sets, $params): void {
            $this->get($botId, $id);
            if ($sets) {
                $sets[] = "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
                $pdo->prepare('UPDATE bot_cards SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute([...$params, $id]);
            }
        });
        return $this->get($botId, $id);
    }

    public function delete(int $botId, int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id): void {
            $stmt = $pdo->prepare('DELETE FROM bot_cards WHERE id = ? AND bot_id = ?');
            $stmt->execute([$id, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.card.unknown');
            }
        });
    }

    private static function row(array $r): array
    {
        return ['id' => (int) $r['id'], 'name' => $r['name'], 'kind' => $r['kind'], 'design' => json_decode($r['design'], false),
            'createdAt' => $r['created_at'], 'updatedAt' => $r['updated_at']];
    }

    private static function name(mixed $name): string
    {
        $name = is_string($name) ? trim($name) : '';
        if ($name === '' || mb_strlen($name) > 60) {
            throw new ApiError(422, 'error.card.invalid', ['field' => 'name']);
        }
        return $name;
    }

    private static function kind(mixed $kind): string
    {
        return is_string($kind) && in_array($kind, self::KINDS, true) ? $kind : throw new ApiError(422, 'error.card.invalid', ['field' => 'kind']);
    }

    private static function design(mixed $design): string
    {
        if (!is_object($design) || !is_array($design->layers ?? null) || count($design->layers) > self::MAX_LAYERS) {
            throw new ApiError(422, 'error.card.invalid', ['field' => 'design']);
        }
        foreach (['width', 'height'] as $k) {
            $v = $design->{$k} ?? null;
            if (!is_int($v) && !is_float($v) || $v < 100 || $v > 2048) {
                throw new ApiError(422, 'error.card.invalid', ['field' => $k]);
            }
        }
        $json = json_encode($design, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false || strlen($json) > self::MAX_DESIGN) {
            throw new ApiError(422, 'error.card.too_big');
        }
        return $json;
    }
}
