<?php

declare(strict_types=1);

// Health endpoint and the internal endpoints (/internal/*, see
// InternalRouter). Slim 4, auth and the access middleware for /api/v1
// follow in phase 2 (see plan.md).

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\Jobs;
use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Internal\BotStore;
use BotHub\Internal\CommandStore;
use BotHub\Internal\InternalRouter;
use BotHub\Internal\ProcessStatus;
use BotHub\Internal\TemplateStore;
use BotHub\Internal\CardStore;
use BotHub\Internal\RunStore;
use BotHub\Internal\TwitchAuthStore;
use BotHub\Internal\DataStore;
use BotHub\Internal\BotBackup;
use BotHub\Internal\SdkPolicyStore;
use BotHub\Internal\TimedStore;
use BotHub\Internal\WebhookStore;
use BotHub\Internal\SecretStore;
use BotHub\Internal\StatsStore;
use BotHub\Internal\DocsStore;
use BotHub\Internal\AccountStore;
use BotHub\Internal\CoworkStore;
use BotHub\Internal\InstanceSettings;
use BotHub\Internal\PluginStore;
use BotHub\Internal\GuildAccessStore;
use BotHub\Internal\InviteStore;
use BotHub\Internal\LegalStore;
use BotHub\Internal\LogStore;
use BotHub\Internal\ApiError;
use BotHub\Redis\RedisConnect;

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

header('Content-Type: application/json; charset=utf-8');

$send = static function (int $status, ?array $body): void {
    http_response_code($status);
    if ($body !== null) {
        echo json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
};

if ($path === '/api/health') {
    $send(200, ['status' => 'ok']);
    return;
}

// Public webhook of a plugin (bothub.json services.webhooks): the URL holds an HMAC token.
if (preg_match('#^/api/hooks/plugin/(plugin_[a-z0-9_]{1,57})/(\d+)/([a-z][a-z0-9_]{0,31})/([a-f0-9]{40})$#', $path, $m)) {
    $error = static fn (int $status, string $key) => $send($status, ['error' => ['key' => $key, 'params' => (object) []]]);
    if ($method !== 'POST') {
        $error(405, 'error.method_not_allowed');
        return;
    }
    // Plex sends multipart with a thumbnail: the JSON is in the form field "payload"; the file is ignored.
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 2 * 1024 * 1024) {
        $error(413, 'error.webhook.too_large');
        return;
    }
    $form = isset($_POST['payload']) && is_string($_POST['payload']) ? $_POST['payload'] : null;
    $raw = $form === null ? (string) file_get_contents('php://input', false, null, 0, WebhookStore::MAX_BODY + 1) : '';
    if (strlen($raw) > WebhookStore::MAX_BODY || ($form !== null && strlen($form) > WebhookStore::MAX_BODY)) {
        $error(413, 'error.webhook.too_large');
        return;
    }
    try {
        $redis = RedisConnect::open(RedisConnect::url(), 0.5, true);
        $rl = "bothub:rl:phook:{$m[2]}:{$m[1]}:" . intdiv(time(), 60);
        $calls = $redis->incr($rl);
        if ($calls === 1) {
            $redis->expire($rl, 120);
        }
        if ($calls > 120) {
            $error(429, 'error.webhook.rate_limited');
            return;
        }
    } catch (\RedisException) {
    }
    try {
        (new PluginStore(Connection::open(Connection::defaultPath()), getenv('DATA_DIR') ?: '/data', null, SecretBox::loadOrCreate()))
            ->receiveWebhook((int) $m[2], $m[1], $m[3], $m[4], $raw, $form);
        $send(202, ['ok' => true]);
    } catch (ApiError $e) {
        $error($e->status, $e->key);
    } catch (\Throwable $e) {
        error_log('plugin hooks: ' . $e::class . ': ' . $e->getMessage());
        $error(500, 'error.internal');
    }
    return;
}

// Public webhook receiver (Webhooks module): no session, optional API key.
if (preg_match('#^/api/hooks/(\d+)/([a-z0-9]{1,64})$#', $path, $m)) {
    if ($method !== 'POST') {
        $send(405, ['error' => ['key' => 'error.method_not_allowed', 'params' => (object) []]]);
        return;
    }
    $error = static fn (int $status, string $key) => $send($status, ['error' => ['key' => $key, 'params' => (object) []]]);
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > WebhookStore::MAX_BODY) {
        $error(413, 'error.webhook.too_large');
        return;
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, WebhookStore::MAX_BODY + 1);
    if (strlen($raw) > WebhookStore::MAX_BODY) {
        $error(413, 'error.webhook.too_large');
        return;
    }
    // 60 calls per minute and webhook (Redis counter; without Redis no limit).
    try {
        $redis = RedisConnect::open(RedisConnect::url(), 0.5, true);
        $rl = "bothub:rl:hook:{$m[1]}:{$m[2]}:" . intdiv(time(), 60);
        $calls = $redis->incr($rl);
        if ($calls === 1) {
            $redis->expire($rl, 120);
        }
        if ($calls > 60) {
            $error(429, 'error.webhook.rate_limited');
            return;
        }
    } catch (\RedisException) {
    }
    try {
        (new WebhookStore(Connection::open(Connection::defaultPath())))->receive((int) $m[1], $m[2], $_SERVER['HTTP_AUTHORIZATION'] ?? null, $raw);
        $send(202, ['ok' => true]);
    } catch (ApiError $e) {
        $error($e->status, $e->key);
    } catch (\Throwable $e) {
        error_log('hooks: ' . $e::class . ': ' . $e->getMessage());
        $error(500, 'error.internal');
    }
    return;
}

if (str_starts_with($path, '/internal/')) {
    if (!InternalRouter::authorized($_SERVER['HTTP_X_BOTHUB_INTERNAL'] ?? null)) {
        $send(401, ['error' => ['key' => 'error.auth.required', 'params' => (object) []]]);
        return;
    }
    $raw = (string) file_get_contents('php://input');
    $body = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($body)) {
        $send(400, ['error' => ['key' => 'error.bad_json', 'params' => (object) []]]);
        return;
    }
    if ($path === '/internal/processes/botcore/restart' && $method === 'POST') {
        // The NodeCore exits after the job; its supervisor starts it again.
        try {
            $jobs = new Jobs(RedisConnect::open(RedisConnect::url(), 1.0, true));
            $send(202, ['jobId' => $jobs->dispatch('core.restart', ['requestedAt' => time()])]);
        } catch (\RedisException) {
            $send(503, ['error' => ['key' => 'error.redis.unavailable', 'params' => (object) []]]);
        }
        return;
    }
    if ($path === '/internal/processes' && $method === 'GET') {
        // Resource overview: BotCore heartbeat (Redis) and the database.
        $items = [];
        try {
            $items[] = ProcessStatus::read(RedisConnect::open(RedisConnect::url(), 1.0, true));
        } catch (\RedisException) {
            $items[] = ['key' => 'botcore', 'kind' => 'service', 'status' => 'stopped', 'restarts24h' => 0];
        }
        try {
            $items[] = ProcessStatus::database(Connection::open(Connection::defaultPath()), Connection::defaultPath());
        } catch (\Throwable $e) {
            error_log('processes: ' . $e->getMessage());
            $items[] = ['key' => 'database', 'kind' => 'database', 'status' => 'crashed'];
        }
        $send(200, ['items' => $items]);
        return;
    }
    try {
        $pdo = Connection::open(Connection::defaultPath());
        $secrets = new SecretStore($pdo, SecretBox::loadOrCreate());
        // Signed-in user, set by the auth layer (never by the browser).
        $userId = max(1, (int) ($_SERVER['HTTP_X_BOTHUB_USER'] ?? 1));
        $plugins = new PluginStore($pdo, getenv('DATA_DIR') ?: '/data', static fn (): ?string => $secrets->value(SecretStore::INSTANCE, 'MARKET_GITHUB_TOKEN'), SecretBox::loadOrCreate(), $userId);
        $botStore = new BotStore($pdo, SecretBox::loadOrCreate(), $plugins, $userId);
        $router = new InternalRouter(
            $botStore,
            static fn () => new Jobs(RedisConnect::open(RedisConnect::url(), 1.0, true)),
            new CommandStore($pdo),
            new TimedStore($pdo),
            new WebhookStore($pdo),
            new TemplateStore($pdo),
            new DataStore($pdo),
            new SdkPolicyStore($pdo),
            $secrets,
            mb_substr((string) ($_SERVER['HTTP_X_BOTHUB_ACTOR'] ?? ''), 0, 64),
            $plugins,
            new BotBackup($pdo, $botStore),
            new LogStore($pdo),
            new LegalStore($pdo),
            new InviteStore($pdo),
            new GuildAccessStore($pdo),
            $userId,
            new StatsStore($pdo),
            new DocsStore($pdo),
            new AccountStore($pdo, SecretBox::loadOrCreate()),
            new CoworkStore($pdo),
            new InstanceSettings($pdo, SecretBox::loadOrCreate()),
            new CardStore($pdo),
            new TwitchAuthStore($pdo, SecretBox::loadOrCreate(), $secrets),
            new RunStore($pdo),
        );
        [$status, $out] = $router->handle($method, $path, $body, $raw === '' ? null : json_decode($raw, false), $_GET);
    } catch (\Throwable $e) {
        error_log('internal: ' . $e::class . ': ' . $e->getMessage());
        [$status, $out] = [500, ['error' => ['key' => 'error.internal', 'params' => (object) []]]];
    }
    $send($status, $out);
    return;
}

$send(404, ['error' => ['key' => 'error.not_found']]);
