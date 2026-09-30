<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Jobs;
use BotHub\Database\Connection;
use PDO;

/**
 * Message Builder module: saved messages (table message_templates, 0003).
 * A message is the `message` config of action.send_message; the command
 * builder loads templates into that block. Sending goes to the bot as job
 * message.send (channel ID or Discord webhook URL).
 */
final class TemplateStore
{
    private const MAX = 100;
    private const MAX_MESSAGE = 65536;
    /** Sends per bot: at most 5 per 10 seconds (Discord allows about 5/5 s per channel). */
    private const SEND_MAX = 5;
    private const SEND_WINDOW = 10;
    private const SNOWFLAKE = '/^\d{17,20}$/';
    private const WEBHOOK = '#^https://(?:(?:canary|ptb)\.)?discord(?:app)?\.com/api/webhooks/\d{17,20}/[A-Za-z0-9_-]{20,100}$#';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return list<array<string, mixed>> newest first */
    public function list(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM message_templates WHERE bot_id = ? ORDER BY id DESC');
        $stmt->execute([$botId]);
        return array_map(self::json(...), $stmt->fetchAll());
    }

    public function get(int $botId, int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM message_templates WHERE id = ? AND bot_id = ?');
        $stmt->execute([$id, $botId]);
        return self::json($stmt->fetch() ?: throw ApiError::notFound('error.template.unknown'));
    }

    /** @param mixed $in body as objects, so an empty embed stays {} */
    public function create(int $botId, mixed $in): array
    {
        $name = self::name($in->name ?? null);
        $message = self::message($in->message ?? null);
        $id = Connection::write($this->pdo, function (PDO $pdo) use ($botId, $name, $message): int {
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM message_templates WHERE bot_id = ?');
            $stmt->execute([$botId]);
            if ((int) $stmt->fetchColumn() >= self::MAX) {
                throw new ApiError(422, 'error.template.limit', ['max' => self::MAX]);
            }
            $pdo->prepare('INSERT INTO message_templates (bot_id, name, message) VALUES (?, ?, ?)')->execute([$botId, $name, $message]);
            return (int) $pdo->lastInsertId();
        });
        return $this->get($botId, $id);
    }

    /** Changes name and/or message. */
    public function update(int $botId, int $id, mixed $in): array
    {
        $name = property_exists($in, 'name') ? self::name($in->name) : null;
        $message = property_exists($in, 'message') ? self::message($in->message) : null;
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id, $name, $message): void {
            $this->get($botId, $id);
            if ($name !== null) {
                $pdo->prepare('UPDATE message_templates SET name = ? WHERE id = ?')->execute([$name, $id]);
            }
            if ($message !== null) {
                $pdo->prepare('UPDATE message_templates SET message = ? WHERE id = ?')->execute([$message, $id]);
            }
        });
        return $this->get($botId, $id);
    }

    public function delete(int $botId, int $id): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $id): void {
            $stmt = $pdo->prepare('DELETE FROM message_templates WHERE id = ? AND bot_id = ?');
            $stmt->execute([$id, $botId]);
            if ($stmt->rowCount() === 0) {
                throw ApiError::notFound('error.template.unknown');
            }
        });
    }

    /**
     * Queues sending to a channel or webhook; the answer is the job.
     *
     * @param array<string, mixed> $in {channelId} or {webhookUrl}
     * @param \Closure(): Jobs $jobs opened only after the input is valid
     */
    public function send(int $botId, int $id, array $in, \Closure $jobs): array
    {
        $this->get($botId, $id);
        $channel = is_string($in['channelId'] ?? null) ? trim($in['channelId']) : '';
        $webhook = is_string($in['webhookUrl'] ?? null) ? trim($in['webhookUrl']) : '';
        if (($channel === '') === ($webhook === '')) {
            throw new ApiError(422, 'error.template.target');
        }
        if ($channel !== '' && !preg_match(self::SNOWFLAKE, $channel)) {
            throw new ApiError(422, 'error.template.channel');
        }
        if ($webhook !== '' && !preg_match(self::WEBHOOK, $webhook)) {
            throw new ApiError(422, 'error.template.webhook');
        }
        $queue = $jobs();
        if (!$queue->allow('message-send:' . $botId, self::SEND_MAX, self::SEND_WINDOW)) {
            throw new ApiError(429, 'error.template.rate_limited', ['seconds' => self::SEND_WINDOW]);
        }
        $jobId = $queue->dispatch('message.send', ['botId' => $botId, 'templateId' => $id, 'target' => $channel !== '' ? $channel : $webhook]);
        return $queue->get($jobId) ?? ['id' => $jobId, 'type' => 'message.send', 'status' => 'queued'];
    }

    private static function name(mixed $name): string
    {
        $name = is_string($name) ? trim($name) : '';
        if ($name === '' || mb_strlen($name) > 60) {
            throw new ApiError(422, 'error.template.invalid');
        }
        return $name;
    }

    private static function message(mixed $message): string
    {
        if (!is_object($message) || !self::validMessage($message)) {
            throw new ApiError(422, 'error.template.message');
        }
        $json = json_encode($message, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > self::MAX_MESSAGE) {
            throw new ApiError(422, 'error.template.invalid');
        }
        return $json;
    }

    /**
     * The `message` config of action.send_message (shared/nodes): normal
     * (content + up to 10 embeds) or v2 (up to 40 text, separator, media
     * components). Only known fields, Discord's length limits.
     */
    public static function validMessage(object $m): bool
    {
        $allowed = static fn (object $o, array $keys): bool => array_diff(array_keys(get_object_vars($o)), $keys) === [];
        $str = static fn ($v, int $max): bool => $v === null || (is_string($v) && mb_strlen($v) <= $max);
        $color = static fn ($v): bool => $v === null || (is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v) === 1);
        if (!$allowed($m, ['mode', 'content', 'embeds', 'accent', 'components']) || !in_array($m->mode ?? 'normal', ['normal', 'v2'], true)
            || !$str($m->content ?? null, 2000) || !$color($m->accent ?? null)) {
            return false;
        }
        $embeds = $m->embeds ?? [];
        if (!is_array($embeds) || count($embeds) > 10) {
            return false;
        }
        $total = 0;
        foreach ($embeds as $e) {
            if (!is_object($e) || !$allowed($e, ['color', 'title', 'url', 'description', 'author', 'fields', 'image_url', 'thumbnail_url', 'footer', 'timestamp'])
                || !$color($e->color ?? null) || !$str($e->title ?? null, 256) || !$str($e->url ?? null, 2000) || !$str($e->description ?? null, 4096)
                || !$str($e->image_url ?? null, 2000) || !$str($e->thumbnail_url ?? null, 2000) || !(is_bool($e->timestamp ?? false))) {
                return false;
            }
            $author = $e->author ?? null;
            if ($author !== null && (!is_object($author) || !$allowed($author, ['name', 'url', 'icon_url']) || !$str($author->name ?? null, 256) || !$str($author->url ?? null, 2000) || !$str($author->icon_url ?? null, 2000))) {
                return false;
            }
            $footer = $e->footer ?? null;
            if ($footer !== null && (!is_object($footer) || !$allowed($footer, ['text', 'icon_url']) || !$str($footer->text ?? null, 2048) || !$str($footer->icon_url ?? null, 2000))) {
                return false;
            }
            $fields = $e->fields ?? [];
            if (!is_array($fields) || count($fields) > 25) {
                return false;
            }
            foreach ($fields as $f) {
                if (!is_object($f) || !$allowed($f, ['name', 'value', 'inline']) || !is_string($f->name ?? null) || !is_string($f->value ?? null)
                    || mb_strlen($f->name) > 256 || mb_strlen($f->value) > 1024 || !is_bool($f->inline ?? false)) {
                    return false;
                }
                $total += mb_strlen($f->name) + mb_strlen($f->value);
            }
            $total += mb_strlen($e->title ?? '') + mb_strlen($e->description ?? '') + mb_strlen($author->name ?? '') + mb_strlen($footer->text ?? '');
        }
        if ($total > 6000) {
            return false;
        }
        $components = $m->components ?? [];
        if (!is_array($components) || count($components) > 40) {
            return false;
        }
        foreach ($components as $c) {
            if (!is_object($c) || !$allowed($c, ['type', 'content', 'divider', 'spacing', 'urls']) || !in_array($c->type ?? null, ['text', 'separator', 'media'], true)
                || !$str($c->content ?? null, 4000) || !is_bool($c->divider ?? false) || !in_array($c->spacing ?? 'small', ['small', 'large'], true)) {
                return false;
            }
            $urls = $c->urls ?? [];
            if (!is_array($urls) || count($urls) > 10 || array_filter($urls, static fn ($u) => !is_string($u) || mb_strlen($u) > 2000) !== []) {
                return false;
            }
        }
        return true;
    }

    private static function json(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'name' => $row['name'],
            'message' => json_decode($row['message'], false, 512, JSON_THROW_ON_ERROR),
            'createdAt' => $row['created_at'],
        ];
    }
}
