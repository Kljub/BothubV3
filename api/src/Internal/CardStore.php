<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Jobs;
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
    private const MAX_IMAGES = 50;
    private const MAX_IMAGE = 2097152;
    private const SNOWFLAKE = '/^\d{17,20}$/';
    /** Test sends per bot: at most 5 per 30 seconds. */
    private const SEND_MAX = 5;
    private const SEND_WINDOW = 30;

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

    // ---------- your pictures ----------

    /** @return list<array<string, mixed>> without the data */
    public function images(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT id, name, mime, size, created_at FROM bot_card_images WHERE bot_id = ? ORDER BY id DESC');
        $stmt->execute([$botId]);
        return array_map(static fn (array $r) => ['id' => (int) $r['id'], 'name' => $r['name'], 'mime' => $r['mime'], 'size' => (int) $r['size'], 'createdAt' => $r['created_at']], $stmt->fetchAll());
    }

    /** One picture with its data (base64), for the Card Studio preview. */
    public function image(int $botId, int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT id, name, mime, data FROM bot_card_images WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        $r = $stmt->fetch() ?: throw ApiError::notFound('error.card.image_unknown');
        return ['id' => (int) $r['id'], 'name' => $r['name'], 'mime' => $r['mime'], 'data' => base64_encode((string) $r['data'])];
    }

    /** Stores an upload: {name, data (base64)}; the type comes from the file's first bytes. */
    public function addImage(int $botId, array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        $name = $name === '' ? 'picture' : mb_substr($name, 0, 80);
        $data = base64_decode((string) ($in['data'] ?? ''), true);
        if ($data === false || $data === '' || strlen($data) > self::MAX_IMAGE) {
            throw new ApiError(422, 'error.card.image_invalid', ['max' => '2 MB']);
        }
        $mime = match (true) {
            str_starts_with($data, "\x89PNG\r\n\x1a\n") => 'image/png',
            str_starts_with($data, "\xff\xd8\xff") => 'image/jpeg',
            str_starts_with($data, 'GIF87a'), str_starts_with($data, 'GIF89a') => 'image/gif',
            str_starts_with($data, 'RIFF') && substr($data, 8, 4) === 'WEBP' => 'image/webp',
            default => throw new ApiError(422, 'error.card.image_invalid', ['max' => '2 MB']),
        };
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $name, $mime, $data): int {
            $count = $pdo->prepare('SELECT COUNT(*) FROM bot_card_images WHERE bot_id = ?');
            $count->execute([$botId]);
            if ((int) $count->fetchColumn() >= self::MAX_IMAGES) {
                throw new ApiError(409, 'error.card.too_many_images', ['max' => self::MAX_IMAGES]);
            }
            $stmt = $pdo->prepare('INSERT INTO bot_card_images (bot_id, name, mime, size, data) VALUES (?, ?, ?, ?, ?)');
            $stmt->bindValue(1, $botId, PDO::PARAM_INT);
            $stmt->bindValue(2, $name);
            $stmt->bindValue(3, $mime);
            $stmt->bindValue(4, strlen($data), PDO::PARAM_INT);
            $stmt->bindValue(5, $data, PDO::PARAM_LOB);
            $stmt->execute();
            return (int) $pdo->lastInsertId();
        });
        return ['id' => $id, 'name' => $name, 'mime' => $mime, 'size' => strlen($data)];
    }

    public function deleteImage(int $botId, int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM bot_card_images WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        if ($stmt->rowCount() === 0) {
            throw ApiError::notFound('error.card.image_unknown');
        }
    }

    // ---------- test send ----------

    /**
     * Queues a test post of the card in a channel (job card.send); the bot
     * draws it with sample values and its own user as the member.
     *
     * @param \Closure(): Jobs $jobs opened only after the input is valid
     */
    public function send(int $botId, int $id, array $in, \Closure $jobs): array
    {
        $this->get($botId, $id);
        $channel = is_string($in['channelId'] ?? null) ? trim($in['channelId']) : '';
        if (!preg_match(self::SNOWFLAKE, $channel)) {
            throw new ApiError(422, 'error.card.channel');
        }
        $queue = $jobs();
        if (!$queue->allow('card-send:' . $botId, self::SEND_MAX, self::SEND_WINDOW)) {
            throw new ApiError(429, 'error.card.rate_limited', ['seconds' => self::SEND_WINDOW]);
        }
        $jobId = $queue->dispatch('card.send', ['botId' => $botId, 'cardId' => $id, 'target' => $channel]);
        return $queue->get($jobId) ?? ['id' => $jobId, 'type' => 'card.send', 'status' => 'queued'];
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
