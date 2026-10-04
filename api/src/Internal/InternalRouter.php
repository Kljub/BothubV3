<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Jobs;

/**
 * /internal/* for services inside the stack (mockapi until the real REST
 * API exists). Never public: the dashboard proxies only /api/*, and every
 * request needs header X-BotHub-Internal = ENV BOTHUB_INTERNAL_KEY. Without
 * that ENV the endpoints are off.
 */
final class InternalRouter
{
    /** @param \Closure(): Jobs $jobs lazy: Redis only for start/stop */
    public function __construct(
        private readonly BotStore $bots,
        private readonly \Closure $jobs,
        private readonly ?CommandStore $commands = null,
        private readonly ?TimedStore $timed = null,
        private readonly ?WebhookStore $webhooks = null,
        private readonly ?TemplateStore $templates = null,
        private readonly ?DataStore $data = null,
        private readonly ?SdkPolicyStore $sdkPolicies = null,
        private readonly ?SecretStore $secrets = null,
        private readonly string $actor = '',
        private readonly ?PluginStore $plugins = null,
        private readonly ?BotBackup $backups = null,
        private readonly ?LogStore $logs = null,
        private readonly ?LegalStore $legal = null,
        private readonly ?InviteStore $invite = null,
        private readonly ?GuildAccessStore $guildAccess = null,
        // The signed-in user (auth layer): owner of their secrets and new bots.
        private readonly int $userId = 1,
        private readonly ?StatsStore $stats = null,
        private readonly ?DocsStore $docs = null,
        private readonly ?AccountStore $accounts = null,
    ) {
    }

    public static function authorized(?string $header): bool
    {
        $key = (string) getenv('BOTHUB_INTERNAL_KEY');
        return strlen($key) >= 32 && is_string($header) && hash_equals($key, $header);
    }

    /**
     * @param array<string, mixed> $body
     * @param mixed $bodyObject the same body decoded to objects (graphs keep {})
     * @param array<string, mixed> $query query string ($_GET)
     * @return array{int, array<string, mixed>|null}
     */
    public function handle(string $method, string $path, array $body, mixed $bodyObject = null, array $query = []): array
    {
        try {
            if ($this->backups !== null && preg_match('#^/internal/bots/(\d+)/(backup|backups|restore)(?:/([a-z0-9:-]{1,60}))?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->backupRoute($method, (int) $m[1], $m[2], $m[3] ?? '', $body);
            }
            // Logs: one bot (GET, DELETE) and the instance log (GET); ?level=…&limit=…
            if ($this->logs !== null && preg_match('#^/internal/(?:bots/(\d+)|admin)/logs$#', $path, $m)) {
                $botId = isset($m[1]) && $m[1] !== '' ? (int) $m[1] : null;
                return match (true) {
                    $method === 'GET' && $botId !== null => [200, ['items' => $this->logs->forBot($botId, $query['level'] ?? null, $query['limit'] ?? null)]],
                    $method === 'GET' => [200, ['items' => $this->logs->server($query['level'] ?? null, $query['limit'] ?? null)]],
                    $method === 'DELETE' && $botId !== null => (function () use ($botId) {
                        $this->logs->clear($botId);
                        return [204, null];
                    })(),
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
            if ($this->sdkPolicies !== null && preg_match('#^/internal/admin/sdk-policies(?:/([a-z0-9._]{1,64}))?$#', $path, $m)) {
                $permission = $m[1] ?? '';
                return match (true) {
                    $permission === '' && $method === 'GET' => [200, ['items' => $this->sdkPolicies->list()]],
                    $permission !== '' && $method === 'PUT' => [200, ['items' => $this->sdkPolicies->set($permission, $body['mode'] ?? null)]],
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
            if ($this->data !== null && preg_match('#^/internal/bots/(\d+)/data/(variables|lookup)(?:/(\d+)(/values)?)?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->dataRoute($method, (int) $m[1], $m[2], isset($m[3]) && $m[3] !== '' ? (int) $m[3] : null, isset($m[4]), $body, array_map(static fn ($v) => is_string($v) ? $v : '', $query));
            }
            // Closed invites: the servers a bot may be on.
            if ($this->guildAccess !== null && preg_match('#^/internal/bots/(\d+)/guild-access$#', $path, $m)) {
                return match ($method) {
                    'GET' => [200, $this->guildAccess->get((int) $m[1])],
                    'PUT' => [200, $this->guildAccess->save((int) $m[1], $body, $this->actor)],
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
            // Custom invite link: settings (admin) and the public page data of one bot.
            if ($this->invite !== null && $path === '/internal/admin/invite-settings') {
                return match ($method) {
                    'GET' => [200, $this->invite->settings()],
                    'PUT' => [200, $this->invite->save($body, $this->actor)],
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
            if ($this->invite !== null && preg_match('#^/internal/invite/(\d{17,20})$#', $path, $m)) {
                return $method === 'GET'
                    ? [200, $this->invite->lookup($m[1]) ?? throw ApiError::notFound()]
                    : throw new ApiError(405, 'error.method_not_allowed');
            }
            // Operator details of the public Terms and Privacy pages (GET public in the dashboard, PUT admin).
            if ($this->legal !== null && in_array($path, ['/internal/legal', '/internal/admin/legal'], true)) {
                return match (true) {
                    $method === 'GET' => [200, $this->legal->get()],
                    $method === 'PUT' && $path === '/internal/admin/legal' => [200, $this->legal->save($body, $this->actor)],
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
            if ($this->plugins !== null && preg_match('#^/internal/admin/plugins/([a-z0-9_-]{2,64})/secrets$#', $path, $m)) {
                return $method === 'PUT'
                    ? [200, ['secretShares' => $this->plugins->shareSecrets($m[1], $body['shared'] ?? null, $this->actor)]]
                    : throw new ApiError(405, 'error.method_not_allowed');
            }
            if ($this->plugins !== null && preg_match('#^/internal/admin/plugins(?:/([a-z0-9_-]{2,64}))?$#', $path, $m)) {
                return $this->adminPluginRoute($method, $m[1] ?? null, $body, $query);
            }
            if ($this->plugins !== null && preg_match('#^/internal/bots/(\d+)/plugins/([a-z0-9_-]{2,64})/files(?:/([0-9a-f]{16}\.[a-z0-9]{1,8}))?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                $files = $this->plugins->files((int) $m[1], $m[2]);
                return match (true) {
                    !isset($m[3]) && $method === 'GET' => [200, ['items' => $files->list((int) $m[1], $m[2])]],
                    !isset($m[3]) && $method === 'POST' => [201, $files->upload((int) $m[1], $m[2], $body['data'] ?? null, ($body['accept'] ?? 'image') === 'audio' ? 'audio' : 'image', $body['filename'] ?? '')],
                    isset($m[3]) && $method === 'GET' => (static function (?array $f): array {
                        $f ?? throw ApiError::notFound();
                        return [200, ['name' => $f['name'], 'mime' => $f['mime'], 'data' => base64_encode($f['data'])]];
                    })($files->get((int) $m[1], $m[2], $m[3])),
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
            if ($this->plugins !== null && preg_match('#^/internal/bots/(\d+)/plugins(?:/([a-z0-9_-]{2,64})(/config|/commands|/options)?)?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->botPluginRoute($method, (int) $m[1], $m[2] ?? null, $m[3] ?? '', $body);
            }
            if ($this->accounts !== null && preg_match('#^/internal/accounts(?:/(users|roles|passkeys)/([^/]{1,400}))?$#', $path, $m)) {
                return $this->accountsRoute($method, $m[1] ?? '', isset($m[2]) ? rawurldecode($m[2]) : '', $body);
            }
            if ($this->docs !== null && preg_match('#^/internal/docs(?:/categories(?:/([a-z0-9-]{1,60}))?|/(\d+))?$#', $path, $m)) {
                return $this->docsRoute($method, $path, $m, $body);
            }
            if ($this->stats !== null && preg_match('#^/internal/bots/(\d+)/stats$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $method === 'GET' ? [200, $this->stats->bot((int) $m[1], $query)] : throw new ApiError(405, 'error.method_not_allowed');
            }
            if ($this->secrets !== null && preg_match('#^/internal/admin/secrets(?:/([^/]+))?$#', $path, $m)) {
                return $this->secretRoute(SecretStore::INSTANCE, $method, isset($m[1]) ? rawurldecode($m[1]) : null, $body);
            }
            if ($this->secrets !== null && preg_match('#^/internal/me/secrets(?:/([^/]+))?$#', $path, $m)) {
                return $this->secretRoute($this->userId, $method, isset($m[1]) ? rawurldecode($m[1]) : null, $body);
            }
            if ($this->webhooks !== null && preg_match('#^/internal/bots/(\d+)/(webhooks|webhook-key)(?:/(\d+)(/test)?)?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->webhookRoute($method, (int) $m[1], $m[2], isset($m[3]) && $m[3] !== '' ? (int) $m[3] : null, isset($m[4]), $body);
            }
            if ($this->templates !== null && preg_match('#^/internal/bots/(\d+)/message-templates(?:/(\d+)(/send)?)?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->templateRoute($method, (int) $m[1], isset($m[2]) && $m[2] !== '' ? (int) $m[2] : null, isset($m[3]), $body, $bodyObject);
            }
            if ($this->timed !== null && preg_match('#^/internal/bots/(\d+)/(timed-events|timed-settings)(?:/(\d+))?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->timedRoute($method, (int) $m[1], $m[2], isset($m[3]) ? (int) $m[3] : null, $body);
            }
            if ($this->commands !== null && preg_match('#^/internal/bots/(\d+)/(commands|events|command-groups|modules)(/.*)?$#', $path, $m)) {
                $this->bots->find((int) $m[1]) ?? throw ApiError::notFound();
                return $this->commandRoute($method, (int) $m[1], $m[2], $m[3] ?? '', $body, $bodyObject);
            }
            return $this->route($method, $path, $body);
        } catch (ApiError $e) {
            return [$e->status, ['error' => ['key' => $e->key, 'params' => (object) $e->params]]];
        }
    }

    private function route(string $method, string $path, array $body): array
    {
        if ($path === '/internal/bots') {
            return match ($method) {
                'GET' => [200, ['items' => $this->bots->all()]],
                'POST' => [201, $this->bots->create(self::createInput($body))],
                default => throw new ApiError(405, 'error.method_not_allowed'),
            };
        }
        if (preg_match('#^/internal/bots/(\d+)/presence$#', $path, $m)) {
            return match ($method) {
                'GET' => [200, $this->bots->presence((int) $m[1])],
                'PATCH' => [200, $this->bots->patchPresence((int) $m[1], $body)],
                default => throw new ApiError(405, 'error.method_not_allowed'),
            };
        }
        if (preg_match('#^/internal/bots/(\d+)(?:/(token|start|stop|restart))?$#', $path, $m)) {
            $id = (int) $m[1];
            $action = $m[2] ?? '';
            if ($action === 'token' && $method === 'GET') {
                $token = $this->bots->token($id) ?? throw ApiError::notFound();
                return [200, ['token' => $token]];
            }
            if ($action !== '' && $action !== 'token' && $method === 'POST') {
                $this->bots->find($id) ?? throw ApiError::notFound();
                try {
                    $jobs = ($this->jobs)();
                    $job = $jobs->get($jobs->dispatch('bot.' . $action, ['botId' => $id]));
                } catch (\RedisException) {
                    throw new ApiError(503, 'error.redis.unavailable');
                }
                return [202, $job];
            }
            if ($action === '') {
                return match ($method) {
                    'GET' => [200, $this->bots->find($id) ?? throw ApiError::notFound()],
                    'PATCH' => [200, $this->bots->update($id, self::updateInput($body))],
                    'DELETE' => (function () use ($id) {
                        $this->bots->delete($id);
                        return [204, null];
                    })(),
                    default => throw new ApiError(405, 'error.method_not_allowed'),
                };
            }
        }
        if (preg_match('#^/internal/jobs/([0-9a-f-]{36})$#', $path, $m) && $method === 'GET') {
            try {
                return [200, ($this->jobs)()->get($m[1]) ?? throw ApiError::notFound('error.job.not_found')];
            } catch (\RedisException) {
                throw new ApiError(503, 'error.redis.unavailable');
            }
        }
        throw ApiError::notFound('error.not_found');
    }

    /**
     * "API / Secrets": the instance's (admin tab) or the user's own (user
     * settings). Secrets are write-only, never returned.
     */
    private function secretRoute(int $owner, string $method, ?string $key, array $body): array
    {
        $s = $this->secrets;
        if ($key === null) {
            return $method === 'GET' ? [200, ['items' => $s->secrets($owner)]] : throw new ApiError(405, 'error.method_not_allowed');
        }
        return match ($method) {
            'PUT' => [200, $s->saveSecret($owner, $key, $body, $this->actor)],
            'DELETE' => (function () use ($s, $owner, $key) {
                $s->deleteSecret($owner, $key, $this->actor);
                return [204, null];
            })(),
            default => throw new ApiError(405, 'error.method_not_allowed'),
        };
    }

    /**
     * Plugins (admin): list, install (upload: base64 zip; market: id +
     * version from the market index), switch on/off for every bot (PATCH
     * {enabled}), uninstall (?deleteCommands=1 also deletes the Custom
     * Command copies).
     */
    private function adminPluginRoute(string $method, ?string $id, array $body, array $query): array
    {
        $p = $this->plugins;
        if ($id === null) {
            return $method === 'GET' ? [200, ['items' => $p->list()]] : throw new ApiError(405, 'error.method_not_allowed');
        }
        if ($id === 'market') {
            return $method === 'GET'
                ? [200, $p->market(in_array($query['refresh'] ?? '0', ['1', 'true'], true), null, ($query['cached'] ?? '0') === '1')]
                : throw new ApiError(405, 'error.method_not_allowed');
        }
        if ($id === 'install') {
            if ($method !== 'POST') {
                throw new ApiError(405, 'error.method_not_allowed');
            }
            if (($body['source'] ?? 'upload') === 'market') {
                $pid = $body['id'] ?? null;
                $version = $body['version'] ?? null;
                if (!is_string($pid) || !is_string($version)) {
                    throw new ApiError(422, 'error.plugin.market', ['reason' => 'id and version are required']);
                }
                return [201, $p->installMarket($pid, $version, $this->actor)];
            }
            $zip = is_string($body['zip'] ?? null) ? base64_decode($body['zip'], true) : false;
            if ($zip === false || $zip === '') {
                throw new ApiError(422, 'error.plugin.zip', ['reason' => 'zip must be base64']);
            }
            return [201, $p->installUpload($zip, $this->actor)];
        }
        if ($method === 'PATCH') {
            return [200, $p->setInstanceEnabled($id, $body['enabled'] ?? null, $this->actor)];
        }
        if ($method !== 'DELETE') {
            throw new ApiError(405, 'error.method_not_allowed');
        }
        $p->uninstall($id, in_array($query['deleteCommands'] ?? '0', ['1', 'true'], true), $this->actor);
        return [204, null];
    }

    /** Plugins of one bot: list, switch on/off, settings, command copies. */
    private function botPluginRoute(string $method, int $botId, ?string $pid, string $rest, array $body): array
    {
        $p = $this->plugins;
        return match (true) {
            $pid === null && $method === 'GET' => [200, ['items' => $p->listForBot($botId)]],
            $pid !== null && $rest === '' && $method === 'PATCH' => [200, $p->setEnabled($botId, $pid, $body['enabled'] ?? null)],
            $rest === '/config' && $method === 'GET' => [200, ['config' => (object) $p->settings($botId, $pid)]],
            $rest === '/config' && $method === 'PUT' => [200, ['config' => (object) $p->saveSettings($botId, $pid, $body['config'] ?? $body)]],
            $rest === '/commands' && $method === 'POST' => [200, $p->syncBot($botId, $pid)],
            $rest === '/options' && $method === 'GET' => [200, ['options' => (object) $p->fieldOptions($botId, $pid)]],
            default => throw new ApiError(405, 'error.method_not_allowed'),
        };
    }

    /** Webhooks module: list, create, change, delete, test, API key. */
    private function webhookRoute(string $method, int $botId, string $section, ?int $id, bool $test, array $body): array
    {
        $w = $this->webhooks;
        $methodNotAllowed = static fn () => throw new ApiError(405, 'error.method_not_allowed');
        if ($section === 'webhook-key') {
            return $id === null && $method === 'POST' ? [201, ['apiKey' => $w->newKey($botId)]] : $methodNotAllowed();
        }
        if ($id === null) {
            return match ($method) {
                'GET' => [200, $w->list($botId)],
                'POST' => [201, $w->create($botId, $body)],
                default => $methodNotAllowed(),
            };
        }
        if ($test) {
            if ($method !== 'POST') {
                $methodNotAllowed();
            }
            $w->test($botId, $id, $body);
            return [202, ['ok' => true]];
        }
        return match ($method) {
            'GET' => [200, $w->get($botId, $id)],
            'PATCH' => [200, $w->patch($botId, $id, $body)],
            'DELETE' => (function () use ($w, $botId, $id) {
                $w->delete($botId, $id);
                return [204, null];
            })(),
            default => $methodNotAllowed(),
        };
    }

    /** Bot backups and templates: export, saved entries, restore. */
    private function backupRoute(string $method, int $botId, string $section, string $id, array $body): array
    {
        $b = $this->backups;
        return match (true) {
            $section === 'backup' && $id === '' && $method === 'GET' => [200, $b->export($botId)],
            $section === 'backups' && $id === '' && $method === 'GET' => [200, ['items' => $b->list($botId)]],
            $section === 'backups' && $id === '' && $method === 'POST' => [201, $b->save($botId, $body)],
            $section === 'backups' && $id !== '' && $method === 'GET' => [200, $b->data($botId, $id)],
            $section === 'backups' && $id !== '' && $method === 'DELETE' => (function () use ($b, $botId, $id) {
                $b->delete($botId, $id);
                return [204, null];
            })(),
            // {id: saved entry or "builtin:<key>"} or {data: uploaded backup, name: file name}
            $section === 'restore' && $id === '' && $method === 'POST' => [200, is_string($body['id'] ?? null)
                ? $b->restore($botId, $b->data($botId, $body['id']), (string) ($body['name'] ?? $body['id']))
                : $b->restore($botId, is_array($body['data'] ?? null) ? $body['data'] : [], mb_substr((string) ($body['name'] ?? 'upload'), 0, 50))],
            default => throw new ApiError(405, 'error.method_not_allowed'),
        };
    }

    /** Data Storage: variables, their values, member lookup. */
    private function dataRoute(string $method, int $botId, string $section, ?int $id, bool $values, array $body, array $query): array
    {
        $d = $this->data;
        $methodNotAllowed = static fn () => throw new ApiError(405, 'error.method_not_allowed');
        if ($section === 'lookup') {
            return $id === null && $method === 'GET' ? [200, $d->lookup($botId, trim($query['id'] ?? ''))] : $methodNotAllowed();
        }
        if ($id === null) {
            return match ($method) {
                'GET' => [200, ['items' => $d->list($botId)]],
                'POST' => [201, $d->create($botId, $body)],
                default => $methodNotAllowed(),
            };
        }
        if ($values) {
            return match ($method) {
                'GET' => [200, $d->values($botId, $id, $query)],
                'PUT' => [200, $d->setValue($botId, $id, $body)],
                'DELETE' => (function () use ($d, $botId, $id, $query) {
                    $d->deleteValues($botId, $id, $query);
                    return [204, null];
                })(),
                default => $methodNotAllowed(),
            };
        }
        return match ($method) {
            'GET' => [200, $d->get($botId, $id)],
            'PUT' => [200, $d->update($botId, $id, $body)],
            'DELETE' => (function () use ($d, $botId, $id) {
                $d->delete($botId, $id);
                return [204, null];
            })(),
            default => $methodNotAllowed(),
        };
    }

    /** Message Builder: saved messages and sending them. */
    private function templateRoute(string $method, int $botId, ?int $id, bool $send, array $body, mixed $bodyObject): array
    {
        $t = $this->templates;
        $obj = is_object($bodyObject) ? $bodyObject : new \stdClass();
        $methodNotAllowed = static fn () => throw new ApiError(405, 'error.method_not_allowed');
        if ($id === null) {
            return match ($method) {
                'GET' => [200, ['items' => $t->list($botId)]],
                'POST' => [201, $t->create($botId, $obj)],
                default => $methodNotAllowed(),
            };
        }
        if ($send) {
            if ($method !== 'POST') {
                $methodNotAllowed();
            }
            try {
                return [202, $t->send($botId, $id, $body, $this->jobs)];
            } catch (\RedisException) {
                throw new ApiError(503, 'error.redis.unavailable');
            }
        }
        return match ($method) {
            'GET' => [200, $t->get($botId, $id)],
            'PUT', 'PATCH' => [200, $t->update($botId, $id, $obj)],
            'DELETE' => (function () use ($t, $botId, $id) {
                $t->delete($botId, $id);
                return [204, null];
            })(),
            default => $methodNotAllowed(),
        };
    }

    /** Timed events and the bot's time settings. */
    private function timedRoute(string $method, int $botId, string $section, ?int $id, array $body): array
    {
        $t = $this->timed;
        $methodNotAllowed = static fn () => throw new ApiError(405, 'error.method_not_allowed');
        if ($section === 'timed-settings') {
            return match (true) {
                $id !== null => throw ApiError::notFound('error.not_found'),
                $method === 'GET' => [200, $t->settings($botId)],
                $method === 'PATCH' => [200, $t->setSettings($botId, $body)],
                default => $methodNotAllowed(),
            };
        }
        if ($id === null) {
            return match ($method) {
                'GET' => [200, ['items' => $t->list($botId)]],
                'POST' => [201, $t->create($botId, $body)],
                default => $methodNotAllowed(),
            };
        }
        return match ($method) {
            'GET' => [200, $t->get($botId, $id)],
            'PUT' => [200, $t->update($botId, $id, $body)],
            'DELETE' => (function () use ($t, $botId, $id) {
                $t->delete($botId, $id);
                return [204, null];
            })(),
            default => $methodNotAllowed(),
        };
    }

    /** Command builder routes, same paths as /api/v1/bots/{id}/... of the mock. */
    private function commandRoute(string $method, int $botId, string $section, string $rest, array $body, mixed $bodyObject): array
    {
        $c = $this->commands;
        $methodNotAllowed = static fn () => throw new ApiError(405, 'error.method_not_allowed');

        if ($section === 'command-groups') {
            if ($rest === '') {
                return match ($method) {
                    'GET' => [200, ['items' => $c->groups($botId)]],
                    'POST' => [201, $c->createGroup($botId, $body)],
                    default => $methodNotAllowed(),
                };
            }
            $gid = preg_match('#^/(\d+)$#', $rest, $m) ? (int) $m[1] : throw ApiError::notFound('error.not_found');
            return match ($method) {
                'PUT' => [200, $c->updateGroup($botId, $gid, $body)],
                'DELETE' => (function () use ($c, $botId, $gid) {
                    $c->deleteGroup($botId, $gid);
                    return [204, null];
                })(),
                default => $methodNotAllowed(),
            };
        }

        if ($section === 'modules') {
            if ($rest === '' && $method === 'GET') {
                return [200, ['items' => $c->modules($botId)]];
            }
            if (preg_match('#^/([a-z0-9-]{1,40})$#', $rest, $m) && $method === 'PUT') {
                return [200, $c->setModule($botId, $m[1], $body)];
            }
            if (preg_match('#^/([a-z0-9-]{1,40})/config$#', $rest, $m)) {
                return match ($method) {
                    'GET' => [200, $c->moduleConfig($botId, $m[1])],
                    'PUT' => [200, $c->setModuleConfig($botId, $m[1], $body)],
                    default => $methodNotAllowed(),
                };
            }
            throw ApiError::notFound('error.not_found');
        }

        $kind = $section === 'events' ? 'event' : 'command';
        if ($rest === '') {
            return match ($method) {
                'GET' => [200, ['items' => $c->list($botId, $kind)]],
                'POST' => [201, $c->create($botId, $kind, $body)],
                default => $methodNotAllowed(),
            };
        }
        if ($rest === '/deleted' && $method === 'GET') {
            return [200, ['items' => $c->listDeleted($botId, $kind)]];
        }
        if (preg_match('#^/deleted/(\d+)/restore$#', $rest, $m) && $method === 'POST') {
            return [200, $c->restoreDeleted($botId, $kind, (int) $m[1])];
        }
        if (!preg_match('#^/(\d+)(?:/versions(?:/(\d+)(/restore)?)?)?$#', $rest, $m)) {
            throw ApiError::notFound('error.not_found');
        }
        $id = (int) $m[1];
        $versions = str_contains($rest, '/versions');
        $vid = isset($m[2]) && $m[2] !== '' ? (int) $m[2] : null;
        if ($versions) {
            return match (true) {
                $vid === null && $method === 'GET' => [200, ['items' => $c->versions($botId, $kind, $id)]],
                $vid !== null && isset($m[3]) && $method === 'POST' => [200, $c->restoreVersion($botId, $kind, $id, $vid)],
                $vid !== null && !isset($m[3]) && $method === 'GET' => [200, $c->version($botId, $kind, $id, $vid)],
                default => $methodNotAllowed(),
            };
        }
        return match ($method) {
            'GET' => [200, $c->get($botId, $kind, $id)],
            'PATCH' => [200, $c->patch($botId, $kind, $id, $body)],
            'PUT' => [200, $c->save($botId, $kind, $id, $body, is_object($bodyObject) ? ($bodyObject->graph ?? null) : null)],
            'DELETE' => (function () use ($c, $botId, $kind, $id) {
                $c->delete($botId, $kind, $id);
                return [204, null];
            })(),
            default => $methodNotAllowed(),
        };
    }

    /** @return array{name: string, token: string, applicationId: ?string, avatarUrl: ?string, autostart: bool} */
    private static function createInput(array $b): array
    {
        return [
            'name' => self::name($b['name'] ?? null),
            'token' => self::token($b['token'] ?? null),
            'applicationId' => self::snowflake($b['applicationId'] ?? null),
            'avatarUrl' => self::url($b['avatarUrl'] ?? null),
            'autostart' => ($b['autostart'] ?? true) === true,
        ];
    }

    private static function updateInput(array $b): array
    {
        $out = [];
        if (array_key_exists('name', $b)) {
            $out['name'] = self::name($b['name']);
        }
        if (array_key_exists('token', $b)) {
            $out['token'] = self::token($b['token']);
        }
        if (array_key_exists('autostart', $b)) {
            if (!is_bool($b['autostart'])) {
                throw new ApiError(422, 'error.validation', ['field' => 'autostart']);
            }
            $out['autostart'] = $b['autostart'];
        }
        if (array_key_exists('avatarUrl', $b)) {
            $out['avatarUrl'] = self::url($b['avatarUrl']);
        }
        if (array_key_exists('applicationId', $b)) {
            $out['applicationId'] = self::snowflake($b['applicationId']);
        }
        return $out;
    }

    private static function name(mixed $v): string
    {
        if (!is_string($v) || trim($v) === '' || mb_strlen($v) > 80) {
            throw new ApiError(422, 'error.validation', ['field' => 'name']);
        }
        return trim($v);
    }

    private static function token(mixed $v): string
    {
        if (!is_string($v) || !preg_match('/^[A-Za-z0-9._-]{50,200}$/', trim($v))) {
            throw new ApiError(422, 'error.bot.token_invalid', ['field' => 'token']);
        }
        return trim($v);
    }

    private static function snowflake(mixed $v): ?string
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (!is_string($v) || !preg_match('/^\d{15,21}$/', $v)) {
            throw new ApiError(422, 'error.validation', ['field' => 'applicationId']);
        }
        return $v;
    }

    private static function url(mixed $v): ?string
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (!is_string($v) || !preg_match('#^https://#', $v) || strlen($v) > 500) {
            throw new ApiError(422, 'error.validation', ['field' => 'avatarUrl']);
        }
        return $v;
    }

    /** Docs of the dashboard: list, one article, save, delete; own categories. */
    private function docsRoute(string $method, string $path, array $m, array $body): array
    {
        $d = $this->docs;
        if (str_starts_with($path, '/internal/docs/categories')) {
            $slug = $m[1] ?? '';
            return match (true) {
                $slug === '' && $method === 'GET' => [200, ['items' => $d->categories()]],
                $slug === '' && $method === 'POST' => [200, ['items' => $d->saveCategory($body)]],
                $slug !== '' && $method === 'DELETE' => (function () use ($d, $slug): array {
                    $d->deleteCategory($slug);
                    return [204, null];
                })(),
                default => throw new ApiError(405, 'error.method_not_allowed'),
            };
        }
        $id = isset($m[2]) && $m[2] !== '' ? (int) $m[2] : null;
        return match (true) {
            $id === null && $method === 'GET' => [200, $d->list()],
            $id === null && $method === 'POST' => [201, $d->save(null, $body, $this->actor)],
            $id !== null && $method === 'GET' => [200, $d->get($id)],
            $id !== null && $method === 'PUT' => [200, $d->save($id, $body, $this->actor)],
            $id !== null && $method === 'DELETE' => (function () use ($d, $id): array {
                $d->delete($id);
                return [204, null];
            })(),
            default => throw new ApiError(405, 'error.method_not_allowed'),
        };
    }

    /** Accounts of the gateway (users, roles, passkeys): load all, save or delete one. */
    private function accountsRoute(string $method, string $kind, string $id, array $body): array
    {
        $a = $this->accounts;
        if ($kind === '') {
            return $method === 'GET' ? [200, $a->all()] : throw new ApiError(405, 'error.method_not_allowed');
        }
        $num = ctype_digit($id) ? (int) $id : 0;
        match (true) {
            $kind === 'users' && $method === 'PUT' => $a->saveUser($num, $body),
            $kind === 'users' && $method === 'DELETE' => $a->deleteUser($num),
            $kind === 'roles' && $method === 'PUT' => $a->saveRole($num, $body),
            $kind === 'roles' && $method === 'DELETE' => $a->deleteRole($num),
            $kind === 'passkeys' && $method === 'PUT' => $a->savePasskey($id, $body),
            $kind === 'passkeys' && $method === 'DELETE' => $a->deletePasskey($id),
            default => throw new ApiError(405, 'error.method_not_allowed'),
        };
        return [204, null];
    }
}
