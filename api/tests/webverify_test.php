<?php

declare(strict_types=1);

// Web Verify: the verdict of the checks, the one-time link with the Discord
// sign-in, address hashes and second accounts, and the privacy latch (the
// first activation needs the owner's confirmation and adds the /privacy
// section for good).

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\ApiError;
use BotHub\Internal\CommandStore;
use BotHub\Internal\LegalStore;
use BotHub\Internal\SecretStore;
use BotHub\Internal\WebVerifyStore;

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
        check($name . " ({$e->key})", $e->key === $key);
    }
}

// ---------- verdict ----------

$cfg = [
    'torCheck' => true, 'torAction' => 'retry', 'vpnCheck' => true, 'vpnAction' => 'retry',
    'altCheck' => true, 'altAction' => 'review', 'countryMode' => 'off', 'countries' => [], 'countryAction' => 'review',
];
$clean = ['tor' => false, 'vpn' => false, 'country' => 'DE', 'alts' => []];
check('no findings pass', WebVerifyStore::decide($cfg, $clean) === ['status' => 'passed', 'reasons' => []]);
check('unknown checks pass', WebVerifyStore::decide($cfg, ['tor' => null, 'vpn' => null, 'country' => '', 'alts' => []])['status'] === 'passed');
check('vpn: try again', WebVerifyStore::decide($cfg, ['vpn' => true] + $clean) === ['status' => 'retry', 'reasons' => ['vpn']]);
check('vpn off: no finding', WebVerifyStore::decide(['vpnCheck' => false] + $cfg, ['vpn' => true] + $clean)['status'] === 'passed');
check('alt beats retry', WebVerifyStore::decide($cfg, ['vpn' => true, 'alts' => ['3']] + $clean) === ['status' => 'review', 'reasons' => ['vpn', 'alt']]);
check('block beats review', WebVerifyStore::decide(['torAction' => 'block'] + $cfg, ['tor' => true, 'alts' => ['3']] + $clean)['status'] === 'blocked');
check('alt only logged', WebVerifyStore::decide(['altAction' => 'log'] + $cfg, ['alts' => ['3']] + $clean) === ['status' => 'passed', 'reasons' => ['alt']]);
$allow = ['countryMode' => 'allow', 'countries' => ['de', 'AT']] + $cfg;
check('allow list: listed country passes (any case)', WebVerifyStore::decide($allow, $clean)['status'] === 'passed');
check('allow list: other country', WebVerifyStore::decide($allow, ['country' => 'US'] + $clean) === ['status' => 'review', 'reasons' => ['country']]);
check('allow list: unknown country goes to review', WebVerifyStore::decide($allow, ['country' => ''] + $clean) === ['status' => 'review', 'reasons' => ['country_unknown']]);
$block = ['countryMode' => 'block', 'countries' => ['RU'], 'countryAction' => 'block'] + $cfg;
check('block list', WebVerifyStore::decide($block, ['country' => 'RU'] + $clean)['status'] === 'blocked' && WebVerifyStore::decide($block, $clean)['status'] === 'passed');
check('block list: unknown country passes', WebVerifyStore::decide($block, ['country' => ''] + $clean)['status'] === 'passed');

check('IPv4 kept', WebVerifyStore::network('203.0.113.7') === '203.0.113.7');
check('IPv6 as /64', WebVerifyStore::network('2001:db8:1:2:aaaa:bbbb:cccc:dddd') === '2001:db8:1:2::/64' && WebVerifyStore::network('2001:db8:1:2::9') === '2001:db8:1:2::/64');
check('private addresses are not public', !WebVerifyStore::isPublic('192.168.1.5') && !WebVerifyStore::isPublic('127.0.0.1') && WebVerifyStore::isPublic('203.0.114.7'));

// ---------- database ----------

$tmp = sys_get_temp_dir() . '/bothub-wv-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$pdo->exec("INSERT INTO bots (id, name, application_id, token_enc, token_fingerprint) VALUES (1, 'Bot', '111111111111111111', x'00', x'01')");
$box = new SecretBox(random_bytes(32));
$app = $pdo->prepare("INSERT INTO bot_oauth_app (bot_id, client_secret_enc, public_url) VALUES (1, ?, 'https://bothub.example')");
$app->bindValue(1, $box->encrypt('S3cretClientSecret_x'), PDO::PARAM_LOB);
$app->execute();

// ---------- privacy latch ----------

$commands = new CommandStore($pdo);
refused('first activation needs the confirmation', 'error.module.privacy_ack', fn () => $commands->setModule(1, 'web-verify', ['enabled' => true]));
check('nothing disclosed yet', !LegalStore::disclosed($pdo, 'webVerify'));
check('switching off needs no confirmation', $commands->setModule(1, 'web-verify', ['enabled' => false])['enabled'] === false);
check('confirmed: on', $commands->setModule(1, 'web-verify', ['enabled' => true, 'privacyAck' => true])['enabled'] === true);
$d = LegalStore::disclosures($pdo);
check('section added with module and date', ($d['webVerify']['module'] ?? '') === 'web-verify' && preg_match('/^\d{4}-\d\d-\d\dT/', $d['webVerify']['since'] ?? '') === 1);
check('server log entry', (int) $pdo->query("SELECT COUNT(*) FROM logs WHERE key = 'log.server.privacy_section_added'")->fetchColumn() === 1);
$commands->setModule(1, 'web-verify', ['enabled' => false]);
check('section stays after switching off', LegalStore::disclosed($pdo, 'webVerify'));
check('second activation needs no confirmation', $commands->setModule(1, 'web-verify', ['enabled' => true])['enabled'] === true);
check('date kept', LegalStore::disclosures($pdo)['webVerify']['since'] === $d['webVerify']['since']);
check('legal answer lists the section', isset(((array) (new LegalStore($pdo))->get()['disclosures'])['webVerify']));
check('modules without a section are untouched', $commands->setModule(1, 'polls', ['enabled' => true])['enabled'] === true && count(LegalStore::disclosures($pdo)) === 1);

// ---------- link, sign-in and checks ----------

$pdo->prepare("UPDATE bot_modules SET config = ? WHERE bot_id = 1 AND module_key = 'web-verify'")->execute([json_encode($cfg + ['retentionDays' => 30, 'channel' => null])]);
$G = '900000000000000001';
$link = static function (string $user, ?string $expires = null) use ($pdo, $G): string {
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $pdo->prepare('INSERT INTO web_verify_requests (bot_id, guild_id, user_id, token_hash, expires_at) VALUES (1, ?, ?, ?, ?)')
        ->execute([$G, $user, hash('sha256', $token), $expires ?? gmdate('Y-m-d\TH:i:s.000\Z', time() + 1800)]);
    return $token;
};

$signedIn = '222222222222222222';
$vpn = false;
$calls = [];
$http = static function (string $url, array $headers, ?array $form) use (&$calls, &$signedIn, &$vpn): array {
    $calls[] = $url;
    if (str_ends_with($url, '/oauth2/token')) {
        return $form['code'] === 'goodcode1234' && $form['client_secret'] === 'S3cretClientSecret_x' ? [200, ['access_token' => 'acc']] : [400, ['error' => 'invalid_grant']];
    }
    if (str_ends_with($url, '/oauth2/token/revoke')) {
        return [200, []];
    }
    if (str_ends_with($url, '/users/@me')) {
        return [200, ['id' => $signedIn]];
    }
    if (str_contains($url, 'proxycheck.io')) {
        $ip = explode('?', substr($url, strlen('https://proxycheck.io/v2/')))[0];
        return [200, json_encode(['status' => 'ok', $ip => ['proxy' => $vpn ? 'yes' : 'no', 'type' => $vpn ? 'VPN' : 'Residential', 'isocode' => 'DE']])];
    }
    return [404, null];
};
$store = new WebVerifyStore($pdo, $box, new SecretStore($pdo, $box), $tmp, $http, static fn () => ['198.51.100.99' => true]);
$in = ['code' => 'goodcode1234', 'redirectUri' => 'https://bothub.example/verify/callback'];
$ip = '203.0.114.7';

$t = $link($signedIn);
$page = $store->page($t);
check('page: bot and VPN note', ($page['botName'] ?? '') === 'Bot' && $page['applicationId'] === '111111111111111111' && $page['vpnCheck'] === true);
check('page: unknown token', $store->page(str_repeat('a', 43)) === null && $store->page('short') === null);
check('page: expired link', $store->page($link($signedIn, '2000-01-01T00:00:00.000Z')) === null);

refused('bad code', 'error.webverify.invalid', fn () => $store->check($t, ['code' => 'x'] + $in, $ip));
refused('bad address', 'error.webverify.invalid', fn () => $store->check($t, $in, 'nope'));
refused('Discord refuses the code', 'error.webverify.refused', fn () => $store->check($t, ['code' => 'wrongcode123'] + $in, $ip));
$signedIn = '333333333333333333';
refused('another account', 'error.webverify.wrong_account', fn () => $store->check($t, $in, $ip));
$signedIn = '222222222222222222';

$vpn = true;
$r = $store->check($t, $in, $ip);
check('VPN: try again, link stays open', $r['status'] === 'retry' && $r['reasons'] === ['vpn'] && $store->page($t) !== null);
check('VPN: no address stored', (int) $pdo->query('SELECT COUNT(*) FROM web_verify_ips')->fetchColumn() === 0);
$vpn = false;
$r = $store->check($t, $in, $ip);
check('clean: passed', $r['status'] === 'passed' && $r['reasons'] === []);
$row = $pdo->query("SELECT status, country, applied, done_at FROM web_verify_requests WHERE user_id = '222222222222222222' AND status <> 'open'")->fetch();
check('result in the row for the bot', $row['status'] === 'passed' && $row['country'] === 'DE' && (int) $row['applied'] === 0 && $row['done_at'] !== null);
check('token revoked at Discord', in_array('https://discord.com/api/v10/oauth2/token/revoke', $calls, true));
$hash = (string) $pdo->query('SELECT ip_hash FROM web_verify_ips')->fetchColumn();
check('address only as keyed hash', preg_match('/^[0-9a-f]{64}$/', $hash) === 1 && !str_contains($hash, $ip) && $hash !== hash('sha256', $ip));
refused('used link', 'error.webverify.expired', fn () => $store->check($t, $in, $ip));
check('used link has no page', $store->page($t) === null);

$signedIn = '444444444444444444';
$r = $store->check($link($signedIn), $in, $ip);
check('same address, other account: review', $r['status'] === 'review' && $r['reasons'] === ['alt']);
$matches = json_decode((string) $pdo->query("SELECT matches FROM web_verify_requests WHERE user_id = '444444444444444444'")->fetchColumn(), true);
check('match names the other account', $matches === ['222222222222222222']);

$signedIn = '555555555555555555';
check('Tor exit: try again', $store->check($link($signedIn), $in, '198.51.100.99')['reasons'] === ['tor']);
check('other address: passed', $store->check($link($signedIn), $in, '203.0.114.8')['status'] === 'passed');

$t2 = $link('666666666666666666');
$signedIn = '777777777777777777';
for ($i = 0; $i < 5; $i++) {
    try {
        $store->check($t2, $in, $ip);
    } catch (ApiError) {
    }
}
refused('five tries per link', 'error.webverify.tries', fn () => $store->check($t2, $in, $ip));

$pdo->exec("UPDATE bot_modules SET enabled = 0 WHERE module_key = 'web-verify'");
check('module off: no page', $store->page($link('222222222222222222')) === null);

exit($failed > 0 ? 1 : 0);
