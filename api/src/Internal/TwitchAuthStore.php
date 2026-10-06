<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Twitch Alerts: the Twitch channel of a bot (table bot_twitch_auth, 0043).
 * The dashboard sends the channel owner to Twitch; Twitch sends back a code,
 * connect() trades it for tokens with the owner's Twitch app (Admin → API /
 * Secrets → Integrations) and stores them encrypted. The bot refreshes them
 * and listens to the channel through EventSub. Tokens never leave this class
 * and the bot.
 */
final class TwitchAuthStore
{
    /** What Twitch Alerts reads: follows, subs (and gifts, resubs), bits. Raids need none. */
    public const SCOPES = ['moderator:read:followers', 'channel:read:subscriptions', 'bits:read'];

    /** @param \Closure(string, array<string, string>, array<string, string>|null): array{0: int, 1: mixed} $http */
    public function __construct(
        private readonly PDO $pdo,
        private readonly SecretBox $box,
        private readonly SecretStore $secrets,
        private readonly ?\Closure $http = null,
    ) {
    }

    /** Connection state (never the tokens) and what the dashboard needs to start a sign-in. */
    public function status(int $botId, int $owner): array
    {
        $stmt = $this->pdo->prepare('SELECT login, display_name, scopes, connected_at FROM bot_twitch_auth WHERE bot_id = ?');
        $stmt->execute([$botId]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        $clientId = $this->secrets->value($owner, 'TWITCH_CLIENT_ID');
        return [
            'configured' => $clientId !== null && $this->secrets->value($owner, 'TWITCH_CLIENT_SECRET') !== null,
            'clientId' => $clientId ?? '',
            'scopes' => self::SCOPES,
            'connected' => $r !== false,
            'login' => $r ? $r['login'] : '',
            'displayName' => $r ? $r['display_name'] : '',
            'connectedAt' => $r ? $r['connected_at'] : null,
        ];
    }

    /** Trades the code of Twitch's sign-in for tokens and stores the channel. */
    public function connect(int $botId, int $owner, array $in): array
    {
        $code = is_string($in['code'] ?? null) ? $in['code'] : '';
        $redirect = is_string($in['redirectUri'] ?? null) ? $in['redirectUri'] : '';
        if (!preg_match('/^[A-Za-z0-9]{10,100}$/', $code) || !preg_match('#^https?://[^\s]{3,300}/auth/twitch/callback$#', $redirect)) {
            throw new ApiError(422, 'error.twitch.invalid');
        }
        $id = $this->secrets->value($owner, 'TWITCH_CLIENT_ID');
        $secret = $this->secrets->value($owner, 'TWITCH_CLIENT_SECRET');
        if ($id === null || $secret === null) {
            throw new ApiError(409, 'error.twitch.not_configured');
        }
        [$status, $token] = $this->request('https://id.twitch.tv/oauth2/token', [], [
            'client_id' => $id, 'client_secret' => $secret, 'code' => $code, 'grant_type' => 'authorization_code', 'redirect_uri' => $redirect,
        ]);
        if ($status !== 200 || !is_array($token) || !is_string($token['access_token'] ?? null) || !is_string($token['refresh_token'] ?? null)) {
            throw new ApiError(502, 'error.twitch.refused');
        }
        $scopes = array_values(array_filter((array) ($token['scope'] ?? []), 'is_string'));
        [$status, $users] = $this->request('https://api.twitch.tv/helix/users', ['Authorization' => 'Bearer ' . $token['access_token'], 'Client-Id' => $id], null);
        $user = is_array($users) ? ($users['data'][0] ?? null) : null;
        if ($status !== 200 || !is_array($user) || !preg_match('/^\d{1,32}$/', (string) ($user['id'] ?? ''))) {
            throw new ApiError(502, 'error.twitch.refused');
        }
        $expires = gmdate('Y-m-d\TH:i:s\Z', time() + max(60, (int) ($token['expires_in'] ?? 3600)));
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $user, $scopes, $token, $expires): void {
            $stmt = $pdo->prepare(
                "INSERT INTO bot_twitch_auth (bot_id, twitch_id, login, display_name, scopes, access_enc, refresh_enc, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (bot_id) DO UPDATE SET twitch_id = excluded.twitch_id, login = excluded.login, display_name = excluded.display_name, scopes = excluded.scopes,
                 access_enc = excluded.access_enc, refresh_enc = excluded.refresh_enc, expires_at = excluded.expires_at,
                 connected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            );
            $stmt->bindValue(1, $botId, PDO::PARAM_INT);
            $stmt->bindValue(2, (string) $user['id']);
            $stmt->bindValue(3, mb_substr((string) ($user['login'] ?? ''), 0, 32) ?: (string) $user['id']);
            $stmt->bindValue(4, mb_substr((string) ($user['display_name'] ?? $user['login'] ?? ''), 0, 64) ?: (string) $user['id']);
            $stmt->bindValue(5, implode(' ', $scopes));
            $stmt->bindValue(6, $this->box->encrypt($token['access_token']), PDO::PARAM_LOB);
            $stmt->bindValue(7, $this->box->encrypt($token['refresh_token']), PDO::PARAM_LOB);
            $stmt->bindValue(8, $expires);
            $stmt->execute();
        });
        return $this->status($botId, $owner);
    }

    /** Forgets the channel; the bot closes its EventSub connection on its next check. */
    public function disconnect(int $botId): void
    {
        $this->pdo->prepare('DELETE FROM bot_twitch_auth WHERE bot_id = ?')->execute([$botId]);
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
