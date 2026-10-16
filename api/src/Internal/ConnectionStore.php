<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Auto Assign Roles (module "connection-roles", migration 0048): members link
 * their Discord connections (Steam, GitHub, Twitch …) through the bot's own
 * Discord sign-in. Discord never sends a bot the connections of a member;
 * only the member's OAuth2 sign-in (scopes identify + connections) may read
 * them. The bot owner stores the client secret of the bot's Discord
 * application here (write-only); the public page /connect/<application ID>
 * sends members to Discord, and link() trades the code for tokens, reads the
 * connections and stores both. The bot refreshes the tokens, reads the
 * connections again from time to time and gives the roles.
 */
final class ConnectionStore
{
    public const SCOPES = ['identify', 'connections'];
    private const DISCORD = 'https://discord.com/api/v10';
    private const MAX_CONNECTIONS = 50;

    /** @param \Closure(string, array<string, string>, array<string, string>|null): array{0: int, 1: mixed} $http */
    public function __construct(
        private readonly PDO $pdo,
        private readonly SecretBox $box,
        private readonly ?\Closure $http = null,
    ) {
    }

    /** The sign-in setup of a bot (never the secret) and how many members linked. */
    public function status(int $botId): array
    {
        $bot = $this->bot($botId);
        $stmt = $this->pdo->prepare('SELECT public_url, updated_at FROM bot_oauth_app WHERE bot_id = ?');
        $stmt->execute([$botId]);
        $app = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $count = $this->pdo->prepare('SELECT COUNT(*) FROM member_connections WHERE bot_id = ?');
        $count->execute([$botId]);
        $url = $app ? (string) $app['public_url'] : '';
        $appId = (string) ($bot['application_id'] ?? '');
        return [
            'configured' => $app !== null && $appId !== '',
            'applicationId' => $appId,
            'publicUrl' => $url,
            'redirectUri' => $url !== '' ? $url . '/connect/callback' : '',
            'linkUrl' => $url !== '' && $appId !== '' ? $url . '/connect/' . $appId : '',
            'linked' => (int) $count->fetchColumn(),
            'updatedAt' => $app ? $app['updated_at'] : null,
        ];
    }

    /** Stores the client secret (empty: keep the stored one) and the dashboard address. */
    public function save(int $botId, array $in): array
    {
        $bot = $this->bot($botId);
        if (($bot['application_id'] ?? '') === '' || $bot['application_id'] === null) {
            throw new ApiError(409, 'error.connections.no_application');
        }
        $secret = is_string($in['clientSecret'] ?? null) ? trim($in['clientSecret']) : '';
        $url = is_string($in['publicUrl'] ?? null) ? rtrim(trim($in['publicUrl']), '/') : '';
        if (!preg_match('#^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$#', $url) || strlen($url) > 300) {
            throw new ApiError(422, 'error.connections.invalid_url');
        }
        if ($secret !== '' && !preg_match('/^[A-Za-z0-9_-]{16,100}$/', $secret)) {
            throw new ApiError(422, 'error.connections.invalid_secret');
        }
        $has = $this->pdo->prepare('SELECT 1 FROM bot_oauth_app WHERE bot_id = ?');
        $has->execute([$botId]);
        if ($secret === '' && $has->fetchColumn() === false) {
            throw new ApiError(422, 'error.connections.invalid_secret');
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $secret, $url): void {
            if ($secret === '') {
                $pdo->prepare("UPDATE bot_oauth_app SET public_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bot_id = ?")->execute([$url, $botId]);
                return;
            }
            $stmt = $pdo->prepare(
                "INSERT INTO bot_oauth_app (bot_id, client_secret_enc, public_url) VALUES (?, ?, ?)
                 ON CONFLICT (bot_id) DO UPDATE SET client_secret_enc = excluded.client_secret_enc, public_url = excluded.public_url,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            );
            $stmt->bindValue(1, $botId, PDO::PARAM_INT);
            $stmt->bindValue(2, $this->box->encrypt($secret), PDO::PARAM_LOB);
            $stmt->bindValue(3, $url);
            $stmt->execute();
        });
        return $this->status($botId);
    }

    /** Forgets the client secret and every linked member of the bot. */
    public function remove(int $botId): void
    {
        Connection::write($this->pdo, function (PDO $pdo) use ($botId): void {
            $pdo->prepare('DELETE FROM bot_oauth_app WHERE bot_id = ?')->execute([$botId]);
            $pdo->prepare('DELETE FROM member_connections WHERE bot_id = ?')->execute([$botId]);
        });
    }

    /** The linked members of a bot, newest first (no tokens). */
    public function members(int $botId, int $limit = 100): array
    {
        $stmt = $this->pdo->prepare('SELECT user_id, user_name, connections, linked_at, checked_at FROM member_connections WHERE bot_id = ? ORDER BY linked_at DESC LIMIT ?');
        $stmt->bindValue(1, $botId, PDO::PARAM_INT);
        $stmt->bindValue(2, max(1, min(500, $limit)), PDO::PARAM_INT);
        $stmt->execute();
        return array_map(static function (array $r): array {
            $list = json_decode((string) $r['connections'], true);
            return [
                'userId' => $r['user_id'],
                'userName' => $r['user_name'],
                'connections' => is_array($list) ? array_values(array_map(static fn ($c) => ['type' => (string) ($c['type'] ?? ''), 'name' => (string) ($c['name'] ?? ''), 'verified' => ($c['verified'] ?? false) === true], $list)) : [],
                'linkedAt' => $r['linked_at'],
                'checkedAt' => $r['checked_at'],
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Unlinks one member; the bot takes the roles away on its next round. */
    public function unlink(int $botId, string $userId): void
    {
        if (!preg_match('/^\d{17,20}$/', $userId)) {
            throw ApiError::notFound();
        }
        $this->pdo->prepare('DELETE FROM member_connections WHERE bot_id = ? AND user_id = ?')->execute([$botId, $userId]);
    }

    /** Public page data of /connect/<application ID>: the bot's name and avatar; null when not set up. */
    public function page(string $appId): ?array
    {
        $bot = $this->botByApp($appId);
        if ($bot === null) {
            return null;
        }
        return ['botName' => $bot['name'], 'avatarUrl' => $bot['avatar_url'], 'applicationId' => $appId, 'scopes' => self::SCOPES];
    }

    /**
     * The member came back from Discord's sign-in: code for tokens, then
     * their user and connections. Answers what the result page shows.
     */
    public function link(string $appId, array $in): array
    {
        $bot = $this->botByApp($appId) ?? throw ApiError::notFound();
        $code = is_string($in['code'] ?? null) ? $in['code'] : '';
        $redirect = is_string($in['redirectUri'] ?? null) ? $in['redirectUri'] : '';
        if (!preg_match('/^[A-Za-z0-9]{10,100}$/', $code) || !preg_match('#^https?://[^\s]{3,300}/connect/callback$#', $redirect)) {
            throw new ApiError(422, 'error.connections.invalid');
        }
        $secret = $this->box->decrypt((string) $bot['client_secret_enc']);
        [$status, $token] = $this->request(self::DISCORD . '/oauth2/token', [], [
            'client_id' => $appId, 'client_secret' => $secret, 'grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => $redirect,
        ]);
        if ($status !== 200 || !is_array($token) || !is_string($token['access_token'] ?? null) || !is_string($token['refresh_token'] ?? null)) {
            throw new ApiError(502, 'error.connections.refused');
        }
        $scopes = explode(' ', (string) ($token['scope'] ?? ''));
        if (!in_array('connections', $scopes, true)) {
            throw new ApiError(422, 'error.connections.scope');
        }
        $auth = ['Authorization' => 'Bearer ' . $token['access_token']];
        [$status, $user] = $this->request(self::DISCORD . '/users/@me', $auth, null);
        if ($status !== 200 || !is_array($user) || !preg_match('/^\d{17,20}$/', (string) ($user['id'] ?? ''))) {
            throw new ApiError(502, 'error.connections.refused');
        }
        [$status, $raw] = $this->request(self::DISCORD . '/users/@me/connections', $auth, null);
        if ($status !== 200 || !is_array($raw)) {
            throw new ApiError(502, 'error.connections.refused');
        }
        $connections = self::clean($raw);
        $name = mb_substr((string) ($user['global_name'] ?? '') ?: (string) ($user['username'] ?? ''), 0, 64) ?: (string) $user['id'];
        $expires = gmdate('Y-m-d\TH:i:s\Z', time() + max(60, (int) ($token['expires_in'] ?? 604800)));
        Connection::write($this->pdo, function (PDO $pdo) use ($bot, $user, $name, $token, $expires, $connections): void {
            $stmt = $pdo->prepare(
                "INSERT INTO member_connections (bot_id, user_id, user_name, access_enc, refresh_enc, expires_at, connections, dirty, failures) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
                 ON CONFLICT (bot_id, user_id) DO UPDATE SET user_name = excluded.user_name, access_enc = excluded.access_enc, refresh_enc = excluded.refresh_enc,
                 expires_at = excluded.expires_at, previous = member_connections.connections, connections = excluded.connections, dirty = 1, failures = 0,
                 checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            );
            $stmt->bindValue(1, (int) $bot['id'], PDO::PARAM_INT);
            $stmt->bindValue(2, (string) $user['id']);
            $stmt->bindValue(3, $name);
            $stmt->bindValue(4, $this->box->encrypt($token['access_token']), PDO::PARAM_LOB);
            $stmt->bindValue(5, $this->box->encrypt($token['refresh_token']), PDO::PARAM_LOB);
            $stmt->bindValue(6, $expires);
            $stmt->bindValue(7, json_encode($connections, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            $stmt->execute();
        });
        return [
            'botName' => $bot['name'],
            'userName' => $name,
            'connections' => array_map(static fn (array $c) => ['type' => $c['type'], 'name' => $c['name'], 'verified' => $c['verified']], $connections),
        ];
    }

    /** Discord's connection objects, without revoked ones: [{type, id, name, verified}]. */
    public static function clean(array $raw): array
    {
        $out = [];
        foreach ($raw as $c) {
            if (!is_array($c) || ($c['revoked'] ?? false) === true || !is_string($c['type'] ?? null) || !preg_match('/^[a-z0-9_-]{1,32}$/', $c['type'])) {
                continue;
            }
            $out[] = [
                'type' => $c['type'],
                'id' => mb_substr((string) ($c['id'] ?? ''), 0, 100),
                'name' => mb_substr((string) ($c['name'] ?? ''), 0, 100),
                'verified' => ($c['verified'] ?? false) === true,
            ];
            if (count($out) >= self::MAX_CONNECTIONS) {
                break;
            }
        }
        return $out;
    }

    private function bot(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT id, name, application_id FROM bots WHERE id = ?');
        $stmt->execute([$botId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: throw ApiError::notFound();
    }

    private function botByApp(string $appId): ?array
    {
        if (!preg_match('/^\d{17,20}$/', $appId)) {
            return null;
        }
        $stmt = $this->pdo->prepare('SELECT b.id, b.name, b.avatar_url, a.client_secret_enc FROM bots b JOIN bot_oauth_app a ON a.bot_id = b.id WHERE b.application_id = ?');
        $stmt->execute([$appId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    /** @return array{0: int, 1: mixed} status and decoded JSON body */
    private function request(string $url, array $headers, ?array $form): array
    {
        if ($this->http !== null) {
            return ($this->http)($url, $headers, $form);
        }
        $ch = curl_init($url);
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "{$k}: {$v}";
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_HTTPHEADER => $lines, CURLOPT_USERAGENT => 'BotHub',
        ]);
        if ($form !== null) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($form));
        }
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$status, is_string($body) ? json_decode($body, true) : null];
    }
}
