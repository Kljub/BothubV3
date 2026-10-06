<?php

declare(strict_types=1);

// Twitch Alerts sign-in: code for tokens, stored encrypted, status without tokens.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\ApiError;
use BotHub\Internal\SecretStore;
use BotHub\Internal\TwitchAuthStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-twitch-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$pdo->exec("INSERT INTO bots (id, name, token_enc, token_fingerprint) VALUES (1, 'Bot', x'00', x'01')");
$box = new SecretBox(random_bytes(32));
$secrets = new SecretStore($pdo, $box);

$calls = [];
$http = static function (string $url, array $headers, ?array $form) use (&$calls): array {
    $calls[] = [$url, $headers, $form];
    if (str_contains($url, 'oauth2/token')) {
        return $form['code'] === 'goodcode1234' ? [200, ['access_token' => 'acc-token', 'refresh_token' => 'ref-token', 'expires_in' => 14000, 'scope' => TwitchAuthStore::SCOPES]] : [400, ['message' => 'Invalid authorization code']];
    }
    return [200, ['data' => [['id' => '12345', 'login' => 'kljub', 'display_name' => 'Kljub']]]];
};
$store = new TwitchAuthStore($pdo, $box, $secrets, $http);
$redirect = 'https://bothub.example/auth/twitch/callback';

$s = $store->status(1, 1);
check('not configured, not connected', $s['configured'] === false && $s['connected'] === false && $s['clientId'] === '');
try {
    $store->connect(1, 1, ['code' => 'goodcode1234', 'redirectUri' => $redirect]);
    check('no Twitch app: refused', false);
} catch (ApiError $e) {
    check('no Twitch app: refused', $e->key === 'error.twitch.not_configured');
}

$secrets->saveSecret(1, 'TWITCH_CLIENT_ID', ['value' => 'client-id-1'], 'test');
$secrets->saveSecret(1, 'TWITCH_CLIENT_SECRET', ['value' => 'client-secret-1'], 'test');
check('configured: client ID for the sign-in link', $store->status(1, 1)['clientId'] === 'client-id-1');

foreach ([['code' => 'x'], ['code' => 'goodcode1234', 'redirectUri' => 'https://evil.example/elsewhere']] as $bad) {
    try {
        $store->connect(1, 1, $bad + ['redirectUri' => $redirect]);
        check('bad input refused', false);
    } catch (ApiError $e) {
        check('bad input refused', $e->key === 'error.twitch.invalid');
    }
}
try {
    $store->connect(1, 1, ['code' => 'wrongcode1234', 'redirectUri' => $redirect]);
    check('code refused by Twitch', false);
} catch (ApiError $e) {
    check('code refused by Twitch', $e->key === 'error.twitch.refused');
}

$s = $store->connect(1, 1, ['code' => 'goodcode1234', 'redirectUri' => $redirect]);
check('connected', $s['connected'] && $s['login'] === 'kljub' && $s['displayName'] === 'Kljub');
check('status has no tokens', !str_contains(json_encode($s), 'acc-token') && !str_contains(json_encode($s), 'ref-token'));
$row = $pdo->query('SELECT * FROM bot_twitch_auth WHERE bot_id = 1')->fetch(PDO::FETCH_ASSOC);
check('tokens stored encrypted', !str_contains((string) $row['access_enc'], 'acc-token') && $box->decrypt($row['access_enc']) === 'acc-token' && $box->decrypt($row['refresh_enc']) === 'ref-token');
check('secret sent to Twitch only in the token request', $calls[count($calls) - 2][2]['client_secret'] === 'client-secret-1' && end($calls)[2] === null);

$store->disconnect(1);
check('disconnected', $store->status(1, 1)['connected'] === false);

exit($failed === 0 ? 0 : 1);
