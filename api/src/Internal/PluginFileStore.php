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
    public const MAX_TOTAL = 50 * 1024 * 1024;
    public const NAME = '/^[0-9a-f]{16}\.(png|gif|webp|jpg)$/';
    /** Any stored file (images and others, migration 0030). */
    public const FILE = '/^[0-9a-f]{16}\.[a-z0-9]{1,8}$/';
    /** Sounds of "file" fields with accept "audio": extension => type. */
    public const AUDIO = ['mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'wav' => 'audio/wav', 'webm' => 'audio/webm'];
    public const MAX_AUDIO = 8 * 1024 * 1024;

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
        $stmt = $this->pdo->prepare('SELECT name, mime, size, origin, filename, created_at FROM plugin_files WHERE bot_id = ? AND plugin_id = ? ORDER BY created_at');
        $stmt->execute([$botId, $pluginId]);
        return array_map(static fn (array $r) => [
            'name' => $r['name'], 'mime' => $r['mime'], 'size' => (int) $r['size'], 'origin' => $r['origin'], 'filename' => $r['filename'], 'createdAt' => $r['created_at'],
        ], $stmt->fetchAll());
    }

    /** @return array{name: string, mime: string, data: string}|null */
    public function get(int $botId, string $pluginId, string $name): ?array
    {
        if (!preg_match(self::FILE, $name)) {
            return null;
        }
        $stmt = $this->pdo->prepare('SELECT name, mime, filename, data FROM plugin_files WHERE bot_id = ? AND plugin_id = ? AND name = ?');
        $stmt->execute([$botId, $pluginId, $name]);
        $row = $stmt->fetch();
        return $row ? ['name' => $row['name'], 'mime' => $row['mime'], 'filename' => $row['filename'], 'data' => (string) $row['data']] : null;
    }

    /**
     * Stores an upload of the dashboard (base64); returns name, mime and size.
     * accept "image" (image fields) or "audio" ("file" fields: mp3, ogg, wav,
     * webm by the file name's extension, up to 8 MB, the name is kept).
     */
    public function upload(int $botId, string $pluginId, mixed $base64, string $accept = 'image', mixed $filename = ''): array
    {
        $max = $accept === 'audio' ? self::MAX_AUDIO : self::MAX_BYTES;
        if (is_string($base64) && strlen($base64) > intdiv($max * 4, 3) + 8) {
            throw new ApiError(413, 'error.files.too_big', ['max' => $max]);
        }
        $data = is_string($base64) ? base64_decode($base64, true) : false;
        if ($data === false || $data === '') {
            throw new ApiError(422, 'error.files.bad_type');
        }
        if (strlen($data) > $max) {
            throw new ApiError(413, 'error.files.too_big', ['max' => $max]);
        }
        $original = '';
        if ($accept === 'audio') {
            $original = is_string($filename) ? mb_substr(preg_replace('/[^\w.\- ()]/u', '_', basename(str_replace('\\', '/', $filename))), -100) : '';
            $ext = strtolower(pathinfo($original, PATHINFO_EXTENSION));
            $type = isset(self::AUDIO[$ext]) ? ['mime' => self::AUDIO[$ext], 'ext' => $ext] : throw new ApiError(422, 'error.files.bad_type');
        } else {
            $type = self::sniff($data) ?? throw new ApiError(422, 'error.files.bad_type');
        }
        $name = substr(hash('sha256', $data), 0, 16) . '.' . $type['ext'];
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $pluginId, $name, $type, $data, $original): void {
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
            $add = $pdo->prepare("INSERT INTO plugin_files (bot_id, plugin_id, name, mime, size, data, origin, filename) VALUES (?, ?, ?, ?, ?, ?, 'dashboard', ?)");
            $add->bindValue(1, $botId, PDO::PARAM_INT);
            $add->bindValue(2, $pluginId);
            $add->bindValue(3, $name);
            $add->bindValue(4, $type['mime']);
            $add->bindValue(5, strlen($data), PDO::PARAM_INT);
            $add->bindValue(6, $data, PDO::PARAM_LOB);
            $add->bindValue(7, $original);
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
            return preg_match(self::FILE, $v) ? [$v] : [];
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
