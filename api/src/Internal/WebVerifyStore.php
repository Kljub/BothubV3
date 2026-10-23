<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use PDO;

/**
 * Web Verify (module "web-verify", migration 0051). Discord never gives a
 * bot the IP address of a member, so members verify on the public page
 * /verify/<token>: the bot posts the link (one per press of the panel
 * button, web_verify_requests), the member signs in with the bot's Discord
 * application (scope identify, client secret from Auto Assign Roles) and
 * check() looks at the address the page was opened from:
 *   - Tor exit list (check.torproject.org, cached for 6 hours),
 *   - VPN, proxy and hosting networks plus the country (proxycheck.io; the
 *     owner's secret PROXYCHECK_API_KEY raises the free daily limit),
 *   - other accounts that verified from the same address on this server
 *     (web_verify_ips, keyed hash only, never the address itself).
 * The result goes into the request row; the bot gives the roles, kicks or
 * bans, and writes the log. The page refuses to work while /privacy does
 * not have the Web Verify section (LegalStore disclosures).
 */
final class WebVerifyStore
{
    public const MODULE = 'web-verify';
    public const SECTION = 'webVerify';
    private const DISCORD = 'https://discord.com/api/v10';
    private const TOR_LIST = 'https://check.torproject.org/torbulkexitlist';
    private const TOR_MAX_AGE = 6 * 3600;
    private const MAX_TRIES = 5;

    /** @param \Closure(string, array<string, string>, array<string, string>|null): array{0: int, 1: mixed} $http */
    public function __construct(
        private readonly PDO $pdo,
        private readonly SecretBox $box,
        private readonly SecretStore $secrets,
        private readonly string $dataDir,
        private readonly ?\Closure $http = null,
        private readonly ?\Closure $torList = null,
    ) {
    }

    /** Public page data of /verify/<token>; null when the link is unknown, used up or expired. */
    public function page(string $token): ?array
    {
        $r = $this->request($token);
        if ($r === null || $r['status'] !== 'open' || $r['expires_at'] < self::now() || !$this->ready((int) $r['bot_id'])) {
            return null;
        }
        $cfg = $this->config((int) $r['bot_id']);
        return [
            'botName' => $r['name'],
            'avatarUrl' => $r['avatar_url'],
            'applicationId' => $r['application_id'],
            'vpnCheck' => $cfg['vpnCheck'] === true || $cfg['countryMode'] !== 'off',
        ];
    }

    /**
     * The member came back from Discord's sign-in: the account must be the
     * one that pressed the button; then the checks run on $ip. Answers the
     * result page: status passed, review, blocked, or retry (VPN or Tor
     * found and the module lets the member try again without it).
     */
    public function check(string $token, array $in, string $ip): array
    {
        $r = $this->request($token) ?? throw ApiError::notFound('error.webverify.expired');
        $botId = (int) $r['bot_id'];
        if ($r['status'] !== 'open' || $r['expires_at'] < self::now() || !$this->ready($botId)) {
            throw ApiError::notFound('error.webverify.expired');
        }
        if ((int) $r['tries'] >= self::MAX_TRIES) {
            throw new ApiError(429, 'error.webverify.tries');
        }
        if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
            throw new ApiError(422, 'error.webverify.invalid');
        }
        $code = is_string($in['code'] ?? null) ? $in['code'] : '';
        $redirect = is_string($in['redirectUri'] ?? null) ? $in['redirectUri'] : '';
        if (!preg_match('/^[A-Za-z0-9]{10,100}$/', $code) || !preg_match('#^https?://[^\s]{3,300}/verify/callback$#', $redirect)) {
            throw new ApiError(422, 'error.webverify.invalid');
        }
        Connection::write($this->pdo, static fn (PDO $pdo) => $pdo->prepare('UPDATE web_verify_requests SET tries = tries + 1 WHERE id = ?')->execute([(int) $r['id']]));

        $userId = $this->discordUser((string) $r['application_id'], $this->box->decrypt((string) $r['client_secret_enc']), $code, $redirect);
        if ($userId !== $r['user_id']) {
            throw new ApiError(403, 'error.webverify.wrong_account');
        }

        $cfg = $this->config($botId);
        $public = self::isPublic($ip);
        $facts = ['tor' => null, 'vpn' => null, 'country' => '', 'alts' => []];
        if ($public && $cfg['torCheck'] === true) {
            $facts['tor'] = $this->isTor($ip);
        }
        if ($public && ($cfg['vpnCheck'] === true || $cfg['countryMode'] !== 'off')) {
            [$facts['vpn'], $facts['country']] = $this->proxyCheck($ip, $this->owner($botId));
        }
        $hash = $this->box->keyedHash('bothub web-verify ip', $botId . ':' . $r['guild_id'] . ':' . self::network($ip));
        if ($cfg['altCheck'] === true) {
            $since = gmdate('Y-m-d\TH:i:s\Z', time() - 86400 * max(1, (int) $cfg['retentionDays']));
            $stmt = $this->pdo->prepare('SELECT user_id FROM web_verify_ips WHERE bot_id = ? AND guild_id = ? AND ip_hash = ? AND user_id <> ? AND seen_at >= ? ORDER BY seen_at DESC LIMIT 10');
            $stmt->execute([$botId, $r['guild_id'], $hash, $r['user_id'], $since]);
            $facts['alts'] = array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN));
        }
        $result = self::decide($cfg, $facts);

        Connection::write($this->pdo, function (PDO $pdo) use ($r, $botId, $hash, $result, $facts): void {
            $reasons = json_encode($result['reasons'], JSON_THROW_ON_ERROR);
            if ($result['status'] === 'retry') {
                $pdo->prepare('UPDATE web_verify_requests SET reasons = ? WHERE id = ?')->execute([$reasons, (int) $r['id']]);
                return;
            }
            $pdo->prepare("UPDATE web_verify_requests SET status = ?, reasons = ?, matches = ?, country = ?, done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'open'")
                ->execute([$result['status'], $reasons, json_encode($facts['alts'], JSON_THROW_ON_ERROR), $facts['country'], (int) $r['id']]);
            $pdo->prepare("INSERT INTO web_verify_ips (bot_id, guild_id, ip_hash, user_id) VALUES (?, ?, ?, ?)
                ON CONFLICT (bot_id, guild_id, ip_hash, user_id) DO UPDATE SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                ->execute([$botId, $r['guild_id'], $hash, $r['user_id']]);
        });
        return ['botName' => $r['name'], 'status' => $result['status'], 'reasons' => $result['reasons']];
    }

    /**
     * The verdict from the facts of the checks (pure, tested). facts: tor and
     * vpn true/false or null (unknown), country ("" unknown), alts (user
     * IDs). The strongest action of the hits wins: block > review > retry.
     *
     * @return array{status: string, reasons: list<string>}
     */
    public static function decide(array $cfg, array $facts): array
    {
        $hits = [];
        if ($cfg['torCheck'] === true && $facts['tor'] === true) {
            $hits['tor'] = (string) $cfg['torAction'];
        }
        if ($cfg['vpnCheck'] === true && $facts['vpn'] === true) {
            $hits['vpn'] = (string) $cfg['vpnAction'];
        }
        if ($cfg['altCheck'] === true && $facts['alts'] !== []) {
            $hits['alt'] = (string) $cfg['altAction'];
        }
        $mode = (string) $cfg['countryMode'];
        if ($mode !== 'off') {
            $country = strtoupper((string) $facts['country']);
            $list = array_map('strtoupper', (array) $cfg['countries']);
            if ($country === '') {
                // Unknown (check failed or not public): an allow list cannot pass it.
                if ($mode === 'allow') {
                    $hits['country_unknown'] = 'review';
                }
            } elseif (($mode === 'allow') !== in_array($country, $list, true)) {
                $hits['country'] = (string) $cfg['countryAction'];
            }
        }
        $rank = ['log' => 0, 'retry' => 1, 'review' => 2, 'block' => 3];
        $worst = 'log';
        foreach ($hits as $action) {
            if (($rank[$action] ?? 0) > $rank[$worst]) {
                $worst = $action;
            }
        }
        $status = match ($worst) {
            'block' => 'blocked',
            'review' => 'review',
            'retry' => 'retry',
            default => 'passed',
        };
        return ['status' => $status, 'reasons' => array_keys($hits)];
    }

    /** IPv4 as it is; IPv6 as its /64 network (one line often rotates the rest). */
    public static function network(string $ip): string
    {
        $bin = @inet_pton($ip);
        if ($bin === false || strlen($bin) !== 16) {
            return $ip;
        }
        return inet_ntop(substr($bin, 0, 8) . str_repeat("\0", 8)) . '/64';
    }

    /** False for private, loopback and reserved addresses (development, LAN). */
    public static function isPublic(string $ip): bool
    {
        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    }

    // ---------- checks ----------

    /** Is the address a Tor exit? null when the list cannot be loaded. */
    private function isTor(string $ip): ?bool
    {
        $list = $this->torList !== null ? ($this->torList)() : $this->loadTorList();
        return $list === null ? null : isset($list[$ip]);
    }

    /** @return array<string, true>|null the exit addresses (cached file, refreshed every 6 hours) */
    private function loadTorList(): ?array
    {
        $file = $this->dataDir . '/cache/tor-exits.txt';
        $fresh = is_file($file) && time() - (int) filemtime($file) < self::TOR_MAX_AGE;
        if (!$fresh) {
            [$status, $body] = $this->get(self::TOR_LIST);
            if ($status === 200 && is_string($body) && str_contains($body, '.')) {
                @mkdir(dirname($file), 0o750, true);
                @file_put_contents($file, $body, LOCK_EX);
            }
        }
        $raw = is_file($file) ? (string) file_get_contents($file) : '';
        if ($raw === '') {
            return null;
        }
        $out = [];
        foreach (preg_split('/\R/', $raw) ?: [] as $line) {
            $line = trim($line);
            if ($line !== '' && $line[0] !== '#') {
                $out[$line] = true;
            }
        }
        return $out;
    }

    /**
     * proxycheck.io: [vpn/proxy/hosting found (null: unknown), ISO country code].
     *
     * @return array{0: ?bool, 1: string}
     */
    private function proxyCheck(string $ip, int $owner): array
    {
        $key = $this->secrets->value($owner, 'PROXYCHECK_API_KEY');
        $url = 'https://proxycheck.io/v2/' . rawurlencode($ip) . '?vpn=1&asn=1' . ($key !== null ? '&key=' . rawurlencode($key) : '');
        [$status, $body] = $this->get($url);
        $data = is_string($body) ? json_decode($body, true) : null;
        $info = is_array($data) && is_array($data[$ip] ?? null) ? $data[$ip] : null;
        if ($status !== 200 || $info === null || !in_array($data['status'] ?? '', ['ok', 'warning'], true)) {
            return [null, ''];
        }
        $country = is_string($info['isocode'] ?? null) && preg_match('/^[A-Z]{2}$/', $info['isocode']) ? $info['isocode'] : '';
        return [($info['proxy'] ?? '') === 'yes', $country];
    }

    /** Trades the sign-in code for the member's Discord user ID. */
    private function discordUser(string $appId, string $secret, string $code, string $redirect): string
    {
        [$status, $token] = $this->discord(self::DISCORD . '/oauth2/token', [], [
            'client_id' => $appId, 'client_secret' => $secret, 'grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => $redirect,
        ]);
        if ($status !== 200 || !is_array($token) || !is_string($token['access_token'] ?? null)) {
            throw new ApiError(502, 'error.webverify.refused');
        }
        [$status, $user] = $this->discord(self::DISCORD . '/users/@me', ['Authorization' => 'Bearer ' . $token['access_token']], null);
        if ($status !== 200 || !is_array($user) || !preg_match('/^\d{17,20}$/', (string) ($user['id'] ?? ''))) {
            throw new ApiError(502, 'error.webverify.refused');
        }
        // The token is not needed any more: revoke it at once (best effort).
        $this->discord(self::DISCORD . '/oauth2/token/revoke', [], ['client_id' => $appId, 'client_secret' => $secret, 'token' => $token['access_token']]);
        return (string) $user['id'];
    }

    // ---------- helpers ----------

    private function request(string $token): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            return null;
        }
        $stmt = $this->pdo->prepare(
            'SELECT r.*, b.name, b.avatar_url, b.application_id, a.client_secret_enc FROM web_verify_requests r
             JOIN bots b ON b.id = r.bot_id JOIN bot_oauth_app a ON a.bot_id = r.bot_id WHERE r.token_hash = ?',
        );
        $stmt->execute([hash('sha256', $token)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false && ($row['application_id'] ?? '') !== '' ? $row : null;
    }

    /** The module is on and set up on the bot, and /privacy names it. */
    private function ready(int $botId): bool
    {
        $stmt = $this->pdo->prepare("SELECT 1 FROM bot_modules WHERE bot_id = ? AND module_key = ? AND enabled = 1 AND config <> '{}'");
        $stmt->execute([$botId, self::MODULE]);
        return $stmt->fetchColumn() !== false && LegalStore::disclosed($this->pdo, self::SECTION);
    }

    private function config(int $botId): array
    {
        $stmt = $this->pdo->prepare('SELECT config FROM bot_modules WHERE bot_id = ? AND module_key = ?');
        $stmt->execute([$botId, self::MODULE]);
        $stored = json_decode((string) $stmt->fetchColumn(), true);
        return ModuleSettings::read(ModuleSettings::schema(self::MODULE) ?? [], is_array($stored) ? $stored : []);
    }

    private function owner(int $botId): int
    {
        $stmt = $this->pdo->prepare('SELECT owner_id FROM bots WHERE id = ?');
        $stmt->execute([$botId]);
        return (int) ($stmt->fetchColumn() ?: 1);
    }

    private static function now(): string
    {
        return gmdate('Y-m-d\TH:i:s.v\Z');
    }

    /** @return array{0: int, 1: mixed} status and raw body */
    private function get(string $url): array
    {
        if ($this->http !== null) {
            return ($this->http)($url, [], null);
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 6, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_USERAGENT => 'BotHub',
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$status, is_string($body) ? $body : null];
    }

    /** @return array{0: int, 1: mixed} status and decoded JSON body */
    private function discord(string $url, array $headers, ?array $form): array
    {
        if ($this->http !== null) {
            [$status, $body] = ($this->http)($url, $headers, $form);
            return [$status, is_string($body) ? json_decode($body, true) : $body];
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
