<?php

declare(strict_types=1);

namespace BotHub\Internal;

/**
 * Settings of the moderation module (bot_modules.config, module_key
 * 'moderation'). normalize() fills defaults and rejects invalid values; the
 * bot reads the same shape (bot/src/discord/moderation.ts).
 *
 *   moderators          permissions block: who counts as moderator (allowed
 *                       roles, or all required permissions), banned roles and
 *                       banned channels (no moderator rights there)
 *   admins              permissions block, the same for admins (admins are
 *                       also moderators; Discord's Administrator always is one)
 * Configs from before the blocks (defaultPermissions, moderatorRoles,
 * adminRoles) are read into them: roles -> allowed_roles, defaultPermissions
 * -> manage_messages / administrator.
 *   logEnabled          log moderation actions
 *   logChannels         [{id, guild}] one log channel per server
 *   punishmentColor     embed color of the direct message (#rrggbb)
 *   logColor            embed color of the log message (#rrggbb)
 *   dmEnabled           direct message to the punished member
 *   dmMode              'text' or 'embed'
 *   dmMessage           text with {action} {moderator} {time} {case} {reason} {server}
 *   banDeleteMessages   default message deletion of bans: none, 1h, 6h, 12h, 24h, 3d, 7d
 *   autoPunishments     [{trigger: warnings|timeouts, count, action: timeout|kick|ban, duration}]
 */
final class ModerationConfig
{
    public const MODULE = 'moderation';
    private const MAX_REFS = 100;
    private const MAX_RULES = 20;
    private const DELETE_MESSAGES = ['none', '1h', '6h', '12h', '24h', '3d', '7d'];
    private const DURATION = '/^[1-9][0-9]{0,4}[smhd]$/';

    public static function defaults(): array
    {
        return [
            'moderators' => self::block([], ['manage_messages']),
            'admins' => self::block([], ['administrator']),
            'logEnabled' => false,
            'logChannels' => [],
            'punishmentColor' => '#ed4245',
            'logColor' => '#5865f2',
            'dmEnabled' => true,
            'dmMode' => 'embed',
            'dmMessage' => "You received a **{action}** in **{server}**.\nModerator: {moderator}\nDuration: {time}\nCase: #{case}\nReason: {reason}",
            'banDeleteMessages' => 'none',
            'autoPunishments' => [],
        ];
    }

    /** Stored config merged over the defaults (unknown keys dropped). */
    public static function read(array $stored): array
    {
        $out = self::defaults();
        foreach ($out as $k => $_) {
            if (array_key_exists($k, $stored)) {
                $out[$k] = $stored[$k];
            }
        }
        return self::legacy($stored, $out);
    }

    private static function block(array $roles, array $permissions): array
    {
        return ['allowed_roles' => $roles, 'banned_roles' => [], 'required_permissions' => $permissions, 'banned_channels' => []];
    }

    /** Old fields (moderatorRoles, adminRoles, defaultPermissions) become the blocks when those are missing. */
    private static function legacy(array $in, array $out): array
    {
        $default = !array_key_exists('defaultPermissions', $in) || $in['defaultPermissions'] !== false;
        if (!array_key_exists('moderators', $in) && (array_key_exists('moderatorRoles', $in) || array_key_exists('defaultPermissions', $in))) {
            $out['moderators'] = self::block(is_array($in['moderatorRoles'] ?? null) ? self::refs($in['moderatorRoles'], 'moderatorRoles') : [], $default ? ['manage_messages'] : []);
        }
        if (!array_key_exists('admins', $in) && (array_key_exists('adminRoles', $in) || array_key_exists('defaultPermissions', $in))) {
            $out['admins'] = self::block(is_array($in['adminRoles'] ?? null) ? self::refs($in['adminRoles'], 'adminRoles') : [], $default ? ['administrator'] : []);
        }
        return $out;
    }

    /** Validates a full config; missing fields keep their defaults. */
    public static function normalize(array $in): array
    {
        $c = self::defaults();
        foreach (['logEnabled', 'dmEnabled'] as $k) {
            if (array_key_exists($k, $in)) {
                $c[$k] = is_bool($in[$k]) ? $in[$k] : self::fail($k);
            }
        }
        if (array_key_exists('defaultPermissions', $in) && !is_bool($in['defaultPermissions'])) {
            self::fail('defaultPermissions');
        }
        $c = self::legacy($in, $c);
        foreach (['moderators', 'admins'] as $k) {
            if (array_key_exists($k, $in)) {
                $c[$k] = ModuleSettings::permissions($in[$k], $k);
                // "everyone" would make every member a moderator.
                foreach ($c[$k]['allowed_roles'] as $r) {
                    $r['id'] === 'everyone' && self::fail("{$k}.allowed_roles");
                }
            }
        }
        if (array_key_exists('logChannels', $in)) {
            $c['logChannels'] = self::refs($in['logChannels'], 'logChannels');
        }
        if ($c['logEnabled'] && $c['logChannels'] === []) {
            throw new ApiError(422, 'error.moderation.log_channel_required', ['field' => 'logChannels']);
        }
        foreach (['punishmentColor', 'logColor'] as $k) {
            if (array_key_exists($k, $in)) {
                $v = $in[$k];
                $c[$k] = is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v) ? strtolower($v) : self::fail($k);
            }
        }
        if (array_key_exists('dmMode', $in)) {
            $c['dmMode'] = in_array($in['dmMode'], ['text', 'embed'], true) ? $in['dmMode'] : self::fail('dmMode');
        }
        if (array_key_exists('dmMessage', $in)) {
            $v = $in['dmMessage'];
            $c['dmMessage'] = is_string($v) && trim($v) !== '' && mb_strlen($v) <= 2000 ? $v : self::fail('dmMessage');
        }
        if (array_key_exists('banDeleteMessages', $in)) {
            $c['banDeleteMessages'] = in_array($in['banDeleteMessages'], self::DELETE_MESSAGES, true) ? $in['banDeleteMessages'] : self::fail('banDeleteMessages');
        }
        if (array_key_exists('autoPunishments', $in)) {
            $c['autoPunishments'] = self::rules($in['autoPunishments']);
        }
        return $c;
    }

    /** @return list<array{id: string, guild: string}> */
    private static function refs(mixed $list, string $field): array
    {
        if (!is_array($list) || !array_is_list($list) || count($list) > self::MAX_REFS) {
            self::fail($field);
        }
        $out = [];
        $seen = [];
        foreach ($list as $r) {
            $id = is_array($r) ? ($r['id'] ?? null) : null;
            $guild = is_array($r) ? ($r['guild'] ?? null) : null;
            if (!is_string($id) || !preg_match('/^\d{15,21}$/', $id) || !is_string($guild) || !preg_match('/^\d{15,21}$/', $guild)) {
                self::fail($field);
            }
            if (!isset($seen[$id])) {
                $seen[$id] = true;
                $out[] = ['id' => $id, 'guild' => $guild];
            }
        }
        return $out;
    }

    private static function rules(mixed $list): array
    {
        if (!is_array($list) || !array_is_list($list)) {
            self::fail('autoPunishments');
        }
        if (count($list) > self::MAX_RULES) {
            throw new ApiError(422, 'error.moderation.too_many_rules', ['max' => self::MAX_RULES]);
        }
        $out = [];
        foreach ($list as $r) {
            if (!is_array($r)) {
                self::fail('autoPunishments');
            }
            $trigger = $r['trigger'] ?? null;
            $action = $r['action'] ?? null;
            $count = $r['count'] ?? null;
            $duration = (string) ($r['duration'] ?? '');
            if (!in_array($trigger, ['warnings', 'timeouts'], true) || !in_array($action, ['timeout', 'kick', 'ban'], true)
                || !is_int($count) || $count < 1 || $count > 100) {
                self::fail('autoPunishments');
            }
            if ($action === 'timeout' && !preg_match(self::DURATION, $duration)) {
                throw new ApiError(422, 'error.moderation.duration_required', ['field' => 'autoPunishments']);
            }
            if ($duration !== '' && !preg_match(self::DURATION, $duration)) {
                self::fail('autoPunishments');
            }
            $out[] = ['trigger' => $trigger, 'count' => $count, 'action' => $action, 'duration' => $duration];
        }
        return $out;
    }

    private static function fail(string $field): never
    {
        throw new ApiError(422, 'error.validation.failed', ['field' => $field]);
    }
}
