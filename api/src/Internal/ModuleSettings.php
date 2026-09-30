<?php

declare(strict_types=1);

namespace BotHub\Internal;

/**
 * Settings of the ready-made modules, validated against
 * shared/module-settings/<module>.json (format: README.md there).
 * normalize() returns the full config: known fields only, defaults for
 * missing ones, 422 error.validation.failed {field} for invalid values.
 */
final class ModuleSettings
{
    private const SNOWFLAKE = '/^\d{15,21}$/';
    private const TEXT_MAX = 2000;
    private const LIST_MAX = 100;

    /** @var array<string, array|null> */
    private static array $schemas = [];

    /** The schema of a module, or null when it has no settings file. */
    public static function schema(string $module): ?array
    {
        if (!preg_match('/^[a-z0-9-]{1,40}$/', $module)) {
            return null;
        }
        if (!array_key_exists($module, self::$schemas)) {
            $file = (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . "/module-settings/{$module}.json";
            self::$schemas[$module] = is_file($file) ? json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR) : null;
        }
        return self::$schemas[$module];
    }

    /**
     * Stored config with defaults filled in. Never fails on old data: a
     * field that no longer validates (e.g. after a schema change) falls back
     * to its default, the other fields keep their values.
     */
    public static function read(array $schema, array $stored): array
    {
        return self::fields($schema['fields'], $stored, '', true);
    }

    /** @throws ApiError */
    public static function normalize(array $schema, array $in): array
    {
        return self::fields($schema['fields'], $in, '');
    }

    private static function fields(array $fields, array $in, string $path, bool $lenient = false): array
    {
        $out = [];
        foreach ($fields as $f) {
            $key = $f['key'];
            try {
                $out[$key] = self::value($f, array_key_exists($key, $in) ? $in[$key] : null, $path . $key, !array_key_exists($key, $in), $lenient);
            } catch (ApiError $e) {
                if (!$lenient) {
                    throw $e;
                }
                $out[$key] = self::value($f, null, $path . $key, true, true);
            }
        }
        return $out;
    }

    private static function fail(string $field): never
    {
        throw new ApiError(422, 'error.validation.failed', ['field' => $field]);
    }

    private static function value(array $f, mixed $v, string $path, bool $missing, bool $lenient = false): mixed
    {
        $default = $f['default'] ?? null;
        switch ($f['type']) {
            case 'bool':
                return $missing || $v === null ? (bool) ($default ?? false) : (is_bool($v) ? $v : self::fail($path));
            case 'text':
                if ($missing || $v === null) {
                    return (string) ($default ?? '');
                }
                if (!is_string($v) || mb_strlen($v) > ($f['max'] ?? self::TEXT_MAX)) {
                    self::fail($path);
                }
                if (isset($f['pattern']) && $v !== '' && !preg_match('#' . str_replace('#', '\\#', $f['pattern']) . '#u', $v)) {
                    self::fail($path);
                }
                return $v;
            case 'number':
                if ($missing || $v === null) {
                    return (int) ($default ?? $f['min'] ?? 0);
                }
                return is_int($v) && $v >= ($f['min'] ?? PHP_INT_MIN) && $v <= ($f['max'] ?? PHP_INT_MAX) ? $v : self::fail($path);
            case 'select':
                if ($missing || $v === null) {
                    return $default ?? $f['options'][0];
                }
                return in_array($v, $f['options'], true) ? $v : self::fail($path);
            case 'color':
                if ($missing || $v === null || $v === '') {
                    return (string) ($default ?? '');
                }
                return is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v) ? strtolower($v) : self::fail($path);
            case 'channel':
            case 'role':
                return $missing || $v === null ? null : self::ref($v, $path);
            case 'channels':
            case 'roles':
                if ($missing || $v === null) {
                    return [];
                }
                if (!is_array($v) || !array_is_list($v) || count($v) > ($f['max'] ?? self::LIST_MAX)) {
                    self::fail($path);
                }
                $refs = [];
                foreach ($v as $r) {
                    $ref = self::ref($r, $path);
                    $refs[$ref['guild'] . ':' . $ref['id']] = $ref;
                }
                return array_values($refs);
            case 'emojis':
            case 'words':
                if ($missing || $v === null) {
                    return [];
                }
                $max = $f['maxLength'] ?? 100;
                if (!is_array($v) || !array_is_list($v) || count($v) > ($f['max'] ?? self::LIST_MAX)) {
                    self::fail($path);
                }
                $list = [];
                foreach ($v as $w) {
                    if (!is_string($w) || trim($w) === '' || mb_strlen($w) > $max) {
                        self::fail($path);
                    }
                    if ($f['type'] === 'emojis' && !self::isEmoji(trim($w))) {
                        self::fail($path);
                    }
                    $list[] = trim($w);
                }
                return array_values(array_unique($list));
            case 'message':
                return self::message($missing || $v === null ? ($default ?? []) : $v, $path);
            case 'list':
                if ($missing || $v === null) {
                    return [];
                }
                if (!is_array($v) || !array_is_list($v) || count($v) > ($f['max'] ?? self::LIST_MAX)) {
                    self::fail($path);
                }
                $items = [];
                $seen = [];
                foreach ($v as $i => $item) {
                    if (!is_array($item)) {
                        if ($lenient) {
                            continue;
                        }
                        self::fail("{$path}.{$i}");
                    }
                    $clean = self::fields($f['item'], $item, "{$path}.{$i}.", $lenient);
                    // unique: no two entries with the same values in these fields
                    if (!empty($f['unique'])) {
                        $sig = json_encode(array_map(static fn ($k) => $clean[$k] ?? null, $f['unique']));
                        if (isset($seen[$sig])) {
                            if ($lenient) {
                                continue;
                            }
                            throw new ApiError(422, 'error.validation.duplicate', ['field' => "{$path}.{$i}"]);
                        }
                        $seen[$sig] = true;
                    }
                    $items[] = $clean;
                }
                return $items;
            default:
                throw new \LogicException("unknown settings field type {$f['type']}");
        }
    }

    /** @return array{id: string, guild: string} */
    private static function ref(mixed $v, string $path): array
    {
        if (!is_array($v) || !is_string($v['id'] ?? null) || !is_string($v['guild'] ?? null)
            || !preg_match(self::SNOWFLAKE, $v['id']) || !preg_match(self::SNOWFLAKE, $v['guild'])) {
            self::fail($path);
        }
        return ['id' => $v['id'], 'guild' => $v['guild']];
    }

    /** Unicode emoji (no letters/digits, max 16 chars) or a custom emoji <:name:id> / <a:name:id>. */
    private static function isEmoji(string $e): bool
    {
        return (bool) preg_match('/^<a?:[A-Za-z0-9_]{2,32}:\d{15,21}>$/', $e)
            || (mb_strlen($e) <= 16 && !preg_match('/[\p{L}\p{N}\s<>:]/u', $e));
    }

    private static function message(mixed $v, string $path): array
    {
        if (!is_array($v)) {
            self::fail($path);
        }
        $mode = $v['mode'] ?? 'text';
        if ($mode !== 'text' && $mode !== 'embed') {
            self::fail("{$path}.mode");
        }
        $limits = ['content' => 2000, 'title' => 256, 'description' => 4000, 'footer' => 2048, 'image' => 500];
        $out = ['mode' => $mode];
        foreach ($limits as $k => $max) {
            $s = $v[$k] ?? '';
            if (!is_string($s) || mb_strlen($s) > $max) {
                self::fail("{$path}.{$k}");
            }
            $out[$k] = $s;
        }
        if ($out['image'] !== '' && !preg_match('#^https://#', $out['image'])) {
            self::fail("{$path}.image");
        }
        $color = $v['color'] ?? '';
        if ($color !== '' && (!is_string($color) || !preg_match('/^#[0-9a-fA-F]{6}$/', $color))) {
            self::fail("{$path}.color");
        }
        $out['color'] = strtolower((string) $color);
        return $out;
    }
}
