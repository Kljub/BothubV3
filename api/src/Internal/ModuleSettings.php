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
            if ($f['type'] === 'section') {
                continue; // a heading in the form, no value
            }
            $key = $f['key'];
            try {
                $out[$key] = self::value($f, array_key_exists($key, $in) ? $in[$key] : null, $path . $key, !array_key_exists($key, $in), $lenient);
                // A top-level field left out (saving one list entry before the
                // rest of the form) is not refused; sent empty, it is.
                $skipped = $path === '' && !array_key_exists($key, $in);
                if (!$lenient && !$skipped && !empty($f['required']) && ($out[$key] === null || $out[$key] === '' || $out[$key] === [])) {
                    self::fail($path . $key);
                }
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
            case 'currency':
                // Key of an Economy currency; empty: the default currency.
                if ($missing || $v === null) {
                    return (string) ($default ?? '');
                }
                return is_string($v) && preg_match('/^[a-z0-9]{0,32}$/', $v) ? $v : self::fail($path);
            case 'card':
                // ID of a card of the Card Designer (bot_cards); empty: no card.
                if ($missing || $v === null || $v === '') {
                    return '';
                }
                return is_string($v) && preg_match('/^[1-9][0-9]{0,9}$/', $v) ? $v : self::fail($path);
            case 'color':
                if ($missing || $v === null || $v === '') {
                    return (string) ($default ?? '');
                }
                return is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v) ? strtolower($v) : self::fail($path);
            case 'file':
                // A sound of plugin_files ("accept": "audio", uploaded in the dashboard); empty = none.
                if ($missing || $v === null || $v === '') {
                    return '';
                }
                return is_string($v) && preg_match(PluginFileStore::FILE, $v) && isset(PluginFileStore::AUDIO[pathinfo($v, PATHINFO_EXTENSION)]) ? $v : self::fail($path);
            case 'image':
                // A file of plugin_files (uploaded in the dashboard); empty = no image.
                if ($missing || $v === null || $v === '') {
                    return '';
                }
                return is_string($v) && preg_match(PluginFileStore::NAME, $v) ? $v : self::fail($path);
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
            case 'choices':
                // Several of the field's options (static "options", or with
                // "dynamic": true the ones the plugin set, ctx.config.setOptions).
                if ($missing || $v === null) {
                    return array_values($default ?? []);
                }
                if (is_string($v)) {
                    $v = preg_split('/[\s,]+/', trim($v), -1, PREG_SPLIT_NO_EMPTY); // older text value: "5, 2:3"
                }
                if (!is_array($v) || !array_is_list($v) || count($v) > ($f['max'] ?? self::LIST_MAX)) {
                    self::fail($path);
                }
                foreach ($v as $c) {
                    if (!is_string($c) || $c === '' || mb_strlen($c) > 100) {
                        self::fail($path);
                    }
                    if (empty($f['dynamic']) && !in_array($c, $f['options'] ?? [], true)) {
                        self::fail($path);
                    }
                }
                return array_values(array_unique($v));
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
            case 'permissions':
                // group: a group of members (e.g. who is exempt), never "everyone"; no value is nobody.
                $group = ($f['group'] ?? false) === true;
                $block = self::permissions($missing || $v === null ? ($default ?? ($group ? [] : ['allowed_roles' => [['id' => 'everyone']]])) : $v, $path);
                if ($group) {
                    foreach ($block['allowed_roles'] as $r) {
                        $r['id'] === 'everyone' && self::fail("{$path}.allowed_roles");
                    }
                }
                return $block;
            case 'message':
                return self::message($missing || $v === null ? ($default ?? []) : $v, $path);
            case 'list':
                if ($missing || $v === null) {
                    return [];
                }
                // "max": 0 = no limit (e.g. the emojis of the Emoji Manager).
                if (!is_array($v) || !array_is_list($v) || (($f['max'] ?? self::LIST_MAX) > 0 && count($v) > ($f['max'] ?? self::LIST_MAX))) {
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
                    // autoFrom: an empty key is made from another field (e.g. the name) on save
                    // and stored, so it stays the same when the name changes later.
                    if (!$lenient) {
                        foreach ($f['item'] as $sub) {
                            if (isset($sub['autoFrom']) && ($clean[$sub['key']] ?? '') === '') {
                                $taken = array_map(static fn (array $x) => $x[$sub['key']] ?? '', $items);
                                $clean[$sub['key']] = self::autoKey((string) ($clean[$sub['autoFrom']] ?? ''), $taken, (int) ($sub['max'] ?? 32));
                            }
                        }
                    }
                    // Stable ID of the entry: kept when valid, else a new one (not on read).
                    $id = $item['_id'] ?? null;
                    if (is_string($id) && preg_match('/^[a-z0-9]{8,16}$/', $id)) {
                        $clean['_id'] = $id;
                    } elseif (!$lenient) {
                        $clean['_id'] = bin2hex(random_bytes(6));
                    }
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

    /** A key from a name: "Gold Münzen" -> "goldmuenzen"; unique among $taken. */
    public static function autoKey(string $name, array $taken, int $max = 32): string
    {
        $s = strtr(mb_strtolower($name), ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss']);
        $s = substr((string) preg_replace('/[^a-z0-9]+/', '', $s), 0, max(1, $max - 3));
        if ($s === '') {
            $s = 'currency';
        }
        $key = $s;
        for ($n = 2; in_array($key, $taken, true); $n++) {
            $key = $s . $n;
        }
        return $key;
    }

    /** @return array{id: string, guild: string} */
    /**
     * The permissions block (same lists as the slash trigger's permissions):
     * allowed_roles (with "everyone"), banned_roles, required_permissions
     * (Discord permission names of trigger.slash), banned_channels.
     */
    public static function permissions(mixed $v, string $path): array
    {
        if (!is_array($v) || array_is_list($v) && $v !== []) {
            self::fail($path);
        }
        $out = ['allowed_roles' => [], 'banned_roles' => [], 'required_permissions' => [], 'banned_channels' => []];
        foreach (array_keys($v) as $k) {
            array_key_exists($k, $out) || $k === 'hide_without_permission' || self::fail($path);
        }
        foreach (['allowed_roles', 'banned_roles', 'banned_channels'] as $list) {
            $items = $v[$list] ?? [];
            if (!is_array($items) || !array_is_list($items) || count($items) > self::LIST_MAX) {
                self::fail("{$path}.{$list}");
            }
            $seen = [];
            foreach ($items as $item) {
                if ($list === 'allowed_roles' && is_array($item) && ($item['id'] ?? null) === 'everyone') {
                    $ref = ['id' => 'everyone'];
                } else {
                    $ref = self::ref($item, "{$path}.{$list}");
                }
                $seen[($ref['guild'] ?? '') . ':' . $ref['id']] = $ref;
            }
            $out[$list] = array_values($seen);
        }
        $perms = $v['required_permissions'] ?? [];
        if (!is_array($perms) || !array_is_list($perms) || count($perms) > 60) {
            self::fail("{$path}.required_permissions");
        }
        $known = self::discordPermissions();
        foreach ($perms as $perm) {
            is_string($perm) && in_array($perm, $known, true) || self::fail("{$path}.required_permissions");
        }
        $out['required_permissions'] = array_values(array_unique($perms));
        return $out;
    }

    /** @return list<string> Discord permission names of the slash trigger's permissions block. */
    private static function discordPermissions(): array
    {
        static $names = null;
        if ($names === null) {
            $file = (getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/nodes/trigger.slash.json';
            $def = json_decode((string) @file_get_contents($file), true);
            $names = [];
            foreach ($def['config']['properties']['permissions']['x-permissionGroups'] ?? [] as $g) {
                foreach ($g['permissions'] ?? [] as $n) {
                    $names[] = $n;
                }
            }
        }
        return $names;
    }

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
        // Older configs stored some messages as plain text (e.g. YouTube).
        if (is_string($v)) {
            $v = ['mode' => 'text', 'content' => $v];
        }
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
