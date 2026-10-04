<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Plugin files (migration 0025, SDK permission storage.files): images a plugin
 * keeps per bot. The dashboard uploads them for "image" settings fields; the
 * plugin stores its own through the bot. Only PNG, GIF, WEBP and JPEG,
 * recognized by their first bytes. The name is the first 16 hex characters of
 * the SHA-256 plus the extension, so the same picture is stored once.
 */
final class PluginFileStore
{
    public const MAX_BYTES = 2 * 1024 * 1024;
    public const MAX_FILES = 100;
    public const MAX_TOTAL = 25 * 1024 * 1024;
    public const NAME = '/^[0-9a-f]{16}\.(png|gif|webp|jpg)$/';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return array{mime: string, ext: string}|null */
    public static function sniff(string $data): ?array
    {
        return match (true) {
            str_starts_with($data, "\x89PNG\r\n\x1a\n") => ['mime' => 'image/png', 'ext' => 'png'],
            str_starts_with($data, 'GIF87a') || str_starts_with($data, 'GIF89a') => ['mime' => 'image/gif', 'ext' => 'gif'],
            strlen($data) > 12 && str_starts_with($data, 'RIFF') && substr($data, 8, 4) === 'WEBP' => ['mime' => 'image/webp', 'ext' => 'webp'],
            str_starts_with($data, "\xff\xd8\xff") => ['mime' => 'image/jpeg', 'ext' => 'jpg'],
            default => null,
        };
    }

    public function list(int $botId, string $pluginId): array
    {
        $stmt = $this->pdo->prepare('SELECT name, mime, size, origin, created_at FROM plugin_files WHERE bot_id = ? AND plugin_id = ? ORDER BY created_at');
        $stmt->execute([$botId, $pluginId]);
        return array_map(static fn (array $r) => [
            'name' => $r['name'], 'mime' => $r['mime'], 'size' => (int) $r['size'], 'origin' => $r['origin'], 'createdAt' => $r['created_at'],
        ], $stmt->fetchAll());
    }

    /** @return array{name: string, mime: string, data: string}|null */
    public function get(int $botId, string $pluginId, string $name): ?array
    {
        if (!preg_match(self::NAME, $name)) {
            return null;
        }
        $stmt = $this->pdo->prepare('SELECT name, mime, data FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?');
        $stmt->execute([$botId, $pluginId, $name]);
        $row = $stmt->fetch();
        return $row ? ['name' => $row['name'], 'mime' => $row['mime'], 'data' => (string) $row['data']] : null;
    }

    /** Stores an upload of the dashboard (base64); returns name, mime and size. */
    public function upload(int $botId, string $pluginId, mixed $base64): array
    {
        if (is_string($base64) && strlen($base64) > intdiv(self::MAX_BYTES * 4, 3) + 8) {
            throw new ApiError(413, 'error.files.too_big', ['max' => self::MAX_BYTES]);
        }
        $data = is_string($base64) ? base64_decode($base64, true) : false;
        if ($data === false || $data === '') {
            throw new ApiError(422, 'error.files.bad_type');
        }
        if (strlen($data) > self::MAX_BYTES) {
            throw new ApiError(413, 'error.files.too_big', ['max' => self::MAX_BYTES]);
        }
        $type = self::sniff($data) ?? throw new ApiError(422, 'error.files.bad_type');
        $name = substr(hash('sha256', $data), 0, 16) . '.' . $type['ext'];
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $pluginId, $name, $type, $data): void {
            $exists = $pdo->prepare('SELECT 1 FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?');
            $exists->execute([$botId, $pluginId, $name]);
            if ($exists->fetchColumn()) {
                return;
            }
            $usage = $pdo->prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM plugin_files WHERE bot_id = ? AND plugin_id = ?');
            $usage->execute([$botId, $pluginId]);
            $u = $usage->fetch();
            if ((int) $u['n'] >= self::MAX_FILES || (int) $u['total'] + strlen($data) > self::MAX_TOTAL) {
                throw new ApiError(413, 'error.files.full', ['max' => self::MAX_FILES]);
            }
            $add = $pdo->prepare("INSERT INTO plugin_files (bot_id, plugin_id, name, mime, size, data, origin) VALUES (?, ?, ?, ?, ?, ?, 'dashboard')");
            $add->bindValue(1, $botId, PDO::PARAM_INT);
            $add->bindValue(2, $pluginId);
            $add->bindValue(3, $name);
            $add->bindValue(4, $type['mime']);
            $add->bindValue(5, strlen($data), PDO::PARAM_INT);
            $add->bindValue(6, $data, PDO::PARAM_LOB);
            $add->execute();
        });
        return ['name' => $name, 'mime' => $type['mime'], 'size' => strlen($data)];
    }

    /**
     * After a settings change: removes the files the old settings named but the
     * new ones do not, and dashboard uploads that no setting names (uploaded,
     * then not saved). Files the plugin stored for itself stay.
     */
    public static function prune(PDO $pdo, int $botId, string $pluginId, array $old, array $new): void
    {
        $keep = self::names($new);
        $drop = array_diff(self::names($old), $keep);
        $stmt = $pdo->prepare("SELECT name FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND origin = 'dashboard'");
        $stmt->execute([$botId, $pluginId]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $name) {
            if (!in_array($name, $keep, true)) {
                $drop[] = $name;
            }
        }
        $del = $pdo->prepare('DELETE FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?');
        foreach (array_unique($drop) as $name) {
            $del->execute([$botId, $pluginId, $name]);
        }
    }

    /** File names anywhere in a settings value. */
    public static function names(mixed $v): array
    {
        if (is_string($v)) {
            return preg_match(self::NAME, $v) ? [$v] : [];
        }
        if (!is_array($v)) {
            return [];
        }
        $out = [];
        foreach ($v as $x) {
            array_push($out, ...self::names($x));
        }
        return array_values(array_unique($out));
    }
}
