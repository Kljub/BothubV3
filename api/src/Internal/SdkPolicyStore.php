<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;

/**
 * SDK policies (admin > SDK Policies): which SDK permissions plugins may use
 * at all, for every bot. The permissions come from
 * shared/sdk-permissions.json; a permission without a row in sdk_policies
 * uses its default (risk low = on, otherwise off). A change writes outbox
 * sdk.policies.changed; the bot restarts the plugins.
 */
final class SdkPolicyStore
{
    /** @param string|null $file shared/sdk-permissions.json (tests pass their own) */
    public function __construct(private readonly PDO $pdo, private readonly ?string $file = null)
    {
    }

    /** @return list<array{permission: string, risk: string, calls: list<string>, implemented: int, mode: string, enabled: bool, default: bool}> */
    public function list(): array
    {
        $rows = $this->pdo->query('SELECT permission, enabled FROM sdk_policies')->fetchAll(PDO::FETCH_KEY_PAIR);
        return array_map(static function (array $p) use ($rows): array {
            $default = ($p['risk'] ?? '') === 'low';
            return [
                'permission' => $p['key'],
                'group' => is_string($p['group'] ?? null) ? $p['group'] : 'other',
                // BotHub module of a modules.<module>.* permission ("all" = modules.read), else "".
                'module' => is_string($p['module'] ?? null) ? $p['module'] : '',
                'risk' => $p['risk'] ?? 'medium',
                'calls' => array_values($p['calls'] ?? []),
                // How many of the calls the bot answers today (the rest: sdk.call.not_available).
                'implemented' => count(array_intersect($p['calls'] ?? [], $p['implemented'] ?? [])),
                // allow / deny: a row; default: no row, the risk decides.
                'mode' => array_key_exists($p['key'], $rows) ? ((int) $rows[$p['key']] === 1 ? 'allow' : 'deny') : 'default',
                'enabled' => array_key_exists($p['key'], $rows) ? (int) $rows[$p['key']] === 1 : $default,
                'default' => $default,
            ];
        }, $this->permissions());
    }

    /**
     * Sets one permission to allow (always on), deny (always off) or default
     * (the risk decides: low = on); answers the full list.
     */
    public function set(string $permission, mixed $mode): array
    {
        if (!in_array($permission, array_column($this->permissions(), 'key'), true)) {
            throw ApiError::notFound('error.sdk.unknown_permission');
        }
        if (!in_array($mode, ['allow', 'default', 'deny'], true)) {
            throw new ApiError(422, 'error.validation.failed', ['field' => 'mode']);
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($permission, $mode): void {
            if ($mode === 'default') {
                $pdo->prepare('DELETE FROM sdk_policies WHERE permission = ?')->execute([$permission]);
            } else {
                $pdo->prepare("INSERT INTO sdk_policies (permission, enabled) VALUES (?, ?)
                    ON CONFLICT (permission) DO UPDATE SET enabled = excluded.enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                    ->execute([$permission, $mode === 'allow' ? 1 : 0]);
            }
            Outbox::add($pdo, 'sdk.policies.changed', []);
        });
        return $this->list();
    }

    /** @return list<array<string, mixed>> */
    private function permissions(): array
    {
        $file = $this->file ?? ((getenv('SHARED_DIR') ?: __DIR__ . '/../../../shared') . '/sdk-permissions.json');
        $doc = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        return array_values(array_filter($doc['permissions'] ?? [], static fn ($p) => is_array($p) && is_string($p['key'] ?? null)));
    }
}
