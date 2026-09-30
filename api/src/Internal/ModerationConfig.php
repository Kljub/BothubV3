<?php

declare(strict_types=1);

namespace BotHub\Internal;

/**
 * Settings of the moderation module (bot_modules.config, module_key
 * 'moderation'). normalize() fills defaults and rejects invalid values; the
 * bot reads the same shape (bot/src/discord/moderation.ts).
 *
 *   defaultPermissions  Manage Messages counts as moderator, Administrator as admin
 *   moderatorRoles      [{id, guild}] roles for moderator commands
 *   adminRoles          [{id, guild}] roles for admin commands (and moderator commands)
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
            'defaultPermissions' => true,
            'moderatorRoles' => [],
            'adminRoles' => [],
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
        return $out;
    }

    /** Validates a full config; missing fields keep their defaults. */
    public static function normalize(array $in): array
    {
        $c = self::defaults();
        foreach (['defaultPermissions', 'logEnabled', 'dmEnabled'] as $k) {
            if (array_key_exists($k, $in)) {
                $c[$k] = is_bool($in[$k]) ? $in[$k] : self::fail($k);
            }
        }
        foreach (['moderatorRoles', 'adminRoles', 'logChannels'] as $k) {
            if (array_key_exists($k, $in)) {
                $c[$k] = self::refs($in[$k], $k);
            }
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
