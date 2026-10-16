<?php

declare(strict_types=1);

// Auto Assign Roles: the bot's Discord sign-in (client secret write-only),
// the public member page and the code exchange that stores tokens and connections.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\ApiError;
use BotHub\Internal\ConnectionStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

function refused(string $name, string $key, callable $fn): void
{
    try {
        $fn();
        check($name, false);
    } catch (ApiError $e) {
        check($name, $e->key === $key);
    }
}

$tmp = sys_get_temp_dir() . '/bothub-conn-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$pdo->exec("INSERT INTO bots (id, name, application_id, token_enc, token_fingerprint) VALUES (1, 'Bot', '111111111111111111', x'00', x'01')");
$pdo->exec("INSERT INTO bots (id, name, token_enc, token_fingerprint) VALUES (2, 'No app', x'00', x'02')");
$box = new SecretBox(random_bytes(32));

$calls = [];
$http = static function (string $url, array $headers, ?array $form) use (&$calls): array {
    $calls[] = [$url, $headers, $form];
    if (str_ends_with($url, '/oauth2/token')) {
        if ($form['code'] === 'nocodescope1') {
            return [200, ['access_token' => 'acc', 'refresh_token' => 'ref', 'expires_in' => 604800, 'scope' => 'identify']];
        }
        return $form['code'] === 'goodcode1234' && $form['client_secret'] === 'S3cretClientSecret_x' ? [200, ['access_token' => 'acc-token', 'refresh_token' => 'ref-token', 'expires_in' => 604800, 'scope' => 'identify connections']] : [400, ['error' => 'invalid_grant']];
    }
    if (str_ends_with($url, '/users/@me')) {
        return [200, ['id' => '222222222222222222', 'username' => 'kljub', 'global_name' => 'Kljub']];
    }
    return [200, [
        ['type' => 'steam', 'id' => '7656119', 'name' => 'Entity', 'verified' => true, 'visibility' => 1],
        ['type' => 'github', 'id' => '42', 'name' => 'Kljub', 'verified' => true],
        ['type' => 'twitch', 'id' => '9', 'name' => 'old', 'verified' => true, 'revoked' => true],
        ['type' => 'bad type!', 'id' => '1', 'name' => 'x'],
    ]];
};
$store = new ConnectionStore($pdo, $box, $http);
$redirect = 'https://bothub.example/connect/callback';

$s = $store->status(1);
check('not configured', $s['configured'] === false && $s['linked'] === 0 && $s['linkUrl'] === '');
check('no public page before setup', $store->page('111111111111111111') === null);
refused('a bot without application ID cannot be set up', 'error.connections.no_application', fn () => $store->save(2, ['clientSecret' => 'S3cretClientSecret_x', 'publicUrl' => 'https://bothub.example']));
refused('first save needs the secret', 'error.connections.invalid_secret', fn () => $store->save(1, ['publicUrl' => 'https://bothub.example']));
refused('bad address refused', 'error.connections.invalid_url', fn () => $store->save(1, ['clientSecret' => 'S3cretClientSecret_x', 'publicUrl' => 'javascript:alert(1)']));

$s = $store->save(1, ['clientSecret' => 'S3cretClientSecret_x', 'publicUrl' => 'https://bothub.example/']);
check('configured: link and redirect address', $s['configured'] && $s['linkUrl'] === 'https://bothub.example/connect/111111111111111111' && $s['redirectUri'] === $redirect);
check('status has no secret', !str_contains(json_encode($s), 'S3cret'));
$enc = $pdo->query('SELECT client_secret_enc FROM bot_oauth_app WHERE bot_id = 1')->fetchColumn();
check('secret stored encrypted', !str_contains((string) $enc, 'S3cret') && $box->decrypt($enc) === 'S3cretClientSecret_x');
$store->save(1, ['publicUrl' => 'https://bothub.example']);
check('address changed, secret kept', $box->decrypt($pdo->query('SELECT client_secret_enc FROM bot_oauth_app WHERE bot_id = 1')->fetchColumn()) === 'S3cretClientSecret_x');

$page = $store->page('111111111111111111');
check('public page: name, scopes, no secret', $page['botName'] === 'Bot' && $page['scopes'] === ['identify', 'connections'] && !str_contains(json_encode($page), 'S3cret'));

refused('bad code refused', 'error.connections.invalid', fn () => $store->link('111111111111111111', ['code' => 'x', 'redirectUri' => $redirect]));
refused('foreign redirect refused', 'error.connections.invalid', fn () => $store->link('111111111111111111', ['code' => 'goodcode1234', 'redirectUri' => 'https://evil.example/x']));
refused('code refused by Discord', 'error.connections.refused', fn () => $store->link('111111111111111111', ['code' => 'wrongcode1234', 'redirectUri' => $redirect]));
refused('sign-in without the connections scope', 'error.connections.scope', fn () => $store->link('111111111111111111', ['code' => 'nocodescope1', 'redirectUri' => $redirect]));

$out = $store->link('111111111111111111', ['code' => 'goodcode1234', 'redirectUri' => $redirect]);
check('linked: name and clean connections', $out['userName'] === 'Kljub' && array_column($out['connections'], 'type') === ['steam', 'github']);
$row = $pdo->query("SELECT * FROM member_connections WHERE bot_id = 1 AND user_id = '222222222222222222'")->fetch(PDO::FETCH_ASSOC);
check('tokens stored encrypted', !str_contains((string) $row['access_enc'], 'acc-token') && $box->decrypt($row['access_enc']) === 'acc-token' && $box->decrypt($row['refresh_enc']) === 'ref-token');
check('marked for the bot', (int) $row['dirty'] === 1 && count(json_decode($row['connections'], true)) === 2);
check('client secret only in the token request', $calls[count($calls) - 3][2]['client_secret'] === 'S3cretClientSecret_x' && $calls[count($calls) - 1][2] === null);

$pdo->exec("UPDATE member_connections SET dirty = 0");
$store->link('111111111111111111', ['code' => 'goodcode1234', 'redirectUri' => $redirect]);
$row = $pdo->query('SELECT dirty, previous FROM member_connections')->fetch(PDO::FETCH_ASSOC);
check('linking again: one row, previous kept, dirty again', (int) $row['dirty'] === 1 && count(json_decode($row['previous'], true)) === 2 && (int) $pdo->query('SELECT COUNT(*) FROM member_connections')->fetchColumn() === 1);

$members = $store->members(1);
check('members list without tokens', count($members) === 1 && $members[0]['connections'][0] === ['type' => 'steam', 'name' => 'Entity', 'verified' => true] && !str_contains(json_encode($members), 'token'));
$store->unlink(1, '222222222222222222');
check('unlinked', $store->status(1)['linked'] === 0);

$store->link('111111111111111111', ['code' => 'goodcode1234', 'redirectUri' => $redirect]);
$store->remove(1);
check('removed: secret and members gone', $store->status(1)['configured'] === false && $store->status(1)['linked'] === 0);

exit($failed === 0 ? 0 : 1);
