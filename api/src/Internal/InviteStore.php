<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Custom invite link (settings key "invite"): instead of Discord's own
 * install link, the Developer Portal points to <domain>/invite/<application
 * ID>. The dashboard page decides who gets the real Discord link:
 * mode "private" = only signed-in dashboard users, "public" = everyone.
 * lookup() is public on purpose (the page shows the bot's name and avatar).
 */
final class InviteStore
{
    private const KEY = 'invite';
    private const MODES = ['private', 'public'];

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** @return array{enabled: bool, mode: string} */
    public function settings(): array
    {
        $stmt = $this->pdo->prepare('SELECT value FROM settings WHERE key = ?');
        $stmt->execute([self::KEY]);
        $v = json_decode((string) ($stmt->fetchColumn() ?: '{}'), true);
        $v = is_array($v) ? $v : [];
        return [
            'enabled' => ($v['enabled'] ?? false) === true,
            'mode' => in_array($v['mode'] ?? null, self::MODES, true) ? $v['mode'] : 'private',
        ];
    }

    public function save(array $in, string $actor): array
    {
        $enabled = $in['enabled'] ?? null;
        $mode = $in['mode'] ?? null;
        if (!is_bool($enabled) || !in_array($mode, self::MODES, true)) {
            throw new ApiError(422, 'error.validation.failed', ['field' => is_bool($enabled) ? 'mode' : 'enabled']);
        }
        $json = json_encode(['enabled' => $enabled, 'mode' => $mode], JSON_THROW_ON_ERROR);
        Connection::write($this->pdo, function (PDO $pdo) use ($json, $actor, $enabled, $mode): void {
            $pdo->prepare("INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                ->execute([self::KEY, $json]);
            $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'change', 'log.server.invite_saved', ?, 'api')")
                ->execute([json_encode(['enabled' => $enabled ? 'on' : 'off', 'mode' => $mode, 'actor' => mb_substr($actor, 0, 64)], JSON_THROW_ON_ERROR)]);
        });
        return $this->settings();
    }

    /**
     * The invite page of one bot: settings plus the bot's public face (name,
     * avatar). null when the link is off or no bot has this application ID.
     *
     * @return array{enabled: bool, mode: string, bot: array{name: string, avatarUrl: ?string, applicationId: string, invitesClosed: bool}}|null
     */
    public function lookup(string $applicationId): ?array
    {
        $settings = $this->settings();
        if (!$settings['enabled'] || !preg_match('/^\d{17,20}$/', $applicationId)) {
            return null;
        }
        $stmt = $this->pdo->prepare('SELECT name, avatar_url, invites_closed FROM bots WHERE application_id = ?');
        $stmt->execute([$applicationId]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        return $settings + ['bot' => [
            'name' => (string) $row['name'], 'avatarUrl' => $row['avatar_url'] !== null ? (string) $row['avatar_url'] : null, 'applicationId' => $applicationId,
            // Closed invites: the bot leaves every server that is not allowed.
            'invitesClosed' => (int) $row['invites_closed'] === 1,
        ]];
    }
}
