<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\BotCore\Outbox;
use BotHub\Database\Connection;
use PDO;
use ZipArchive;

/**
 * Plugin install pipeline and plugin data of the API (plan:
 * context/plugin-template-plan.md, "Changes after the Codex review").
 *
 * Install (admin only): zip limits and path checks, SHA-256 against the
 * market index (market) or computed (upload), unpack into a temp dir,
 * validate manifest + lang + commands, move atomically to
 * DATA_DIR/plugins/<id>/<version>, then record it in one transaction and
 * create the plugin's commands as disabled copies for every bot.
 */
final class PluginStore
{
    public const MAX_ZIP = 5 * 1024 * 1024;
    private const MAX_FILES = 200;
    private const MAX_UNPACKED = 20 * 1024 * 1024;
    private const MAX_FILE = 2 * 1024 * 1024;
    private const MAX_FIELDS = 50;
    private const MAX_COMMANDS = 25;
    private const MAX_LANG = 65536;
    private const ID = '/^plugin_[a-z0-9_]{1,57}$/';
    private const VERSION = '/^\d{1,4}\.\d{1,4}\.\d{1,6}$/';
    /** App Store categories: the module groups of shared/modules.json. */
    /** Sign-in helpers the dashboard implements (services.connect). */
    private const CONNECT_PROVIDERS = ['plex'];
    private const ICON = '/^[^\s<>&"\']{1,16}$/u';
    private const CATEGORIES = ['utility', 'security', 'messages', 'fun', 'ticket', 'social'];
    private const FIELD_TYPES = ['bool', 'text', 'number', 'select', 'color', 'channel', 'channels', 'role', 'roles', 'emojis', 'words', 'message', 'list', 'permissions', 'image', 'choices', 'file', 'currency'];

    /** Hosts that may receive the market token; every other host gets the request without it. */
    private const TOKEN_HOSTS = ['api.github.com', 'raw.githubusercontent.com'];
    private const MARKET_INDEX = 'https://raw.githubusercontent.com/Kljub/BothubMarketPlace/main/index.json';

    /**
     * $marketToken returns the GitHub token for a private market repo (secret
     * MARKET_GITHUB_TOKEN) or null; it is read only when the market is used.
     */
    /**
     * $owner: the signed-in user; placeholders, shares and the share state
     * of list() are that user's secrets (a bot uses its owner's).
     */
    public function __construct(private readonly PDO $pdo, private readonly string $dataDir, private readonly ?\Closure $marketToken = null, private readonly ?\BotHub\BotCore\SecretBox $box = null, private readonly int $owner = 1)
    {
    }

    // ---------- install ----------

    /** Upload by the admin: the hash is computed and stored. */
    public function installUpload(string $zipBytes, string $actor): array
    {
        return $this->install($zipBytes, null, $actor);
    }

    /** From the market: the index entry gives URL and SHA-256. */
    public function installMarket(string $id, string $version, string $actor, ?callable $fetch = null): array
    {
        $fetch ??= self::fetch(...);
        $token = $this->marketToken ? ($this->marketToken)() : null;
        $token = is_string($token) && trim($token) !== '' ? trim($token) : null;
        if ($token !== null && !preg_match('/^[!-~]{1,255}$/', $token)) {
            // Printable ASCII only: a bad secret must not inject headers.
            throw new ApiError(422, 'error.plugin.market', ['reason' => 'market token invalid']);
        }
        $index = json_decode((string) $fetch(getenv('BOTHUB_MARKET_INDEX') ?: self::MARKET_INDEX, 1024 * 1024, [], $token), true);
        $entry = null;
        foreach (is_array($index) ? ($index['plugins'] ?? []) : [] as $p) {
            if (($p['id'] ?? null) === $id && ($p['version'] ?? null) === $version) {
                $entry = $p;
            }
        }
        if (!$entry || !is_string($entry['url'] ?? null) || !str_starts_with($entry['url'], 'https://') || !preg_match('/^[a-f0-9]{64}$/', (string) ($entry['sha256'] ?? ''))) {
            throw new ApiError(422, 'error.plugin.market', ['reason' => 'not in the market index']);
        }
        $zip = $token !== null && ($asset = self::releaseAsset($entry['url'])) !== null
            ? self::privateAsset($asset, $token, $fetch)
            : (string) $fetch($entry['url'], self::MAX_ZIP + 1, [], $token);
        return $this->install($zip, $entry['sha256'], $actor, $id, $version);
    }

    /** github.com/<owner>/<repo>/releases/download/<tag>/<file> split into its parts, else null. */
    private static function releaseAsset(string $url): ?array
    {
        if (!preg_match('#^https://github\.com/([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})/releases/download/([^/?\#]{1,200})/([^/?\#]{1,200})$#', $url, $m)) {
            return null;
        }
        return ['owner' => $m[1], 'repo' => $m[2], 'tag' => rawurldecode($m[3]), 'file' => rawurldecode($m[4])];
    }

    /**
     * A release asset of a private repo: the browser URL does not accept a
     * token, so the release is looked up through the API and the asset is
     * downloaded from its API URL (the CDN redirect goes out without token).
     */
    private static function privateAsset(array $a, string $token, callable $fetch): string
    {
        $release = json_decode((string) $fetch('https://api.github.com/repos/' . $a['owner'] . '/' . $a['repo'] . '/releases/tags/' . rawurlencode($a['tag']), 1024 * 1024, ['Accept: application/vnd.github+json'], $token), true);
        foreach (is_array($release) && is_array($release['assets'] ?? null) ? $release['assets'] : [] as $asset) {
            $url = $asset['url'] ?? null;
            if (($asset['name'] ?? null) === $a['file'] && is_string($url) && str_starts_with($url, 'https://api.github.com/')) {
                return (string) $fetch($url, self::MAX_ZIP + 1, ['Accept: application/octet-stream'], $token);
            }
        }
        throw new ApiError(422, 'error.plugin.market', ['reason' => 'release asset not found']);
    }

    private function install(string $zipBytes, ?string $expectedSha, string $actor, ?string $expectId = null, ?string $expectVersion = null): array
    {
        if (strlen($zipBytes) > self::MAX_ZIP) {
            throw new ApiError(413, 'error.plugin.zip', ['reason' => 'larger than 5 MB']);
        }
        $sha = hash('sha256', $zipBytes);
        if ($expectedSha !== null && !hash_equals($expectedSha, $sha)) {
            throw new ApiError(422, 'error.plugin.hash');
        }
        $tmp = $this->tempDir();
        try {
            $this->unpack($zipBytes, $tmp);
            $plugin = $this->validate($tmp);
            $m = $plugin['manifest'];
            if (($expectId !== null && $m['id'] !== $expectId) || ($expectVersion !== null && $m['version'] !== $expectVersion)) {
                throw new ApiError(422, 'error.plugin.manifest', ['field' => 'id/version do not match the market index']);
            }
            $known = $this->pdo->prepare('SELECT sha256 FROM plugins WHERE id = ? AND version = ?');
            $known->execute([$m['id'], $m['version']]);
            $knownSha = $known->fetchColumn();
            if ($knownSha !== false && $knownSha !== $sha) {
                throw new ApiError(409, 'error.plugin.version_exists', ['version' => $m['version']]);
            }
            $target = $this->pluginDir($m['id'], $m['version']);
            if (!is_dir($target)) {
                @mkdir(dirname($target), 0o755, true);
                if (!@rename($tmp, $target)) {
                    throw new ApiError(500, 'error.plugin.zip', ['reason' => 'cannot store the files']);
                }
                $tmp = null;
            }
            $result = Connection::write($this->pdo, function (PDO $pdo) use ($m, $sha, $plugin, $actor): array {
                $pdo->prepare('INSERT OR IGNORE INTO plugins (id, version, sha256, manifest) VALUES (?, ?, ?, ?)')
                    ->execute([$m['id'], $m['version'], $sha, json_encode($m, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
                $pdo->prepare("INSERT INTO plugin_installs (plugin_id, version) VALUES (?, ?)
                    ON CONFLICT (plugin_id) DO UPDATE SET version = excluded.version, installed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                    ->execute([$m['id'], $m['version']]);
                $this->createSecretPlaceholders($pdo, $m, $actor);
                $created = 0;
                $updated = 0;
                $changed = [];
                foreach ($pdo->query('SELECT id FROM bots')->fetchAll(PDO::FETCH_COLUMN) as $botId) {
                    $r = $this->copyCommands($pdo, (int) $botId, $m, $plugin['commands']);
                    $created += $r['created'];
                    $updated += $r['updated'];
                    if ($r['created'] > 0) {
                        Outbox::add($pdo, 'commands.changed', ['botId' => (int) $botId]);
                    }
                    $changed = array_values(array_unique([...$changed, ...$r['changed']]));
                }
                Outbox::add($pdo, 'plugins.changed', []);
                $this->log($pdo, 'log.server.plugin_installed', ['plugin' => $m['id'], 'version' => $m['version'], 'actor' => $actor]);
                return ['created' => $created, 'updated' => $updated, 'changed' => $changed];
            });
            return ['id' => $m['id'], 'version' => $m['version'], 'sha256' => $sha, 'manifest' => $m, 'commands' => $result];
        } finally {
            if ($tmp !== null) {
                self::removeDir($tmp);
            }
        }
    }

    // ---------- zip ----------

    /** Unpacks with all checks; never uses extractTo (paths are built here). */
    public function unpack(string $zipBytes, string $dir): void
    {
        $file = $dir . '.zip';
        file_put_contents($file, $zipBytes);
        $zip = new ZipArchive();
        $opened = false;
        try {
            if (($opened = $zip->open($file, ZipArchive::RDONLY)) !== true) {
                throw new ApiError(422, 'error.plugin.zip', ['reason' => 'not a zip file']);
            }
            if ($zip->numFiles > self::MAX_FILES) {
                throw new ApiError(422, 'error.plugin.zip', ['reason' => 'more than 200 files']);
            }
            $names = [];
            $total = 0;
            $entries = [];
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $st = $zip->statIndex($i);
                $name = (string) $st['name'];
                if (!mb_check_encoding($name, 'UTF-8') || $name === '' || str_contains($name, "\\") || str_starts_with($name, '/')
                    || preg_match('#(^|/)\.\.(/|$)#', $name) || preg_match('#^[A-Za-z]:#', $name) || str_contains($name, "\0")) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'bad path: ' . mb_substr($name, 0, 80)]);
                }
                $zip->getExternalAttributesIndex($i, $os, $attr);
                if ($os === ZipArchive::OPSYS_UNIX && (($attr >> 16) & 0o170000) === 0o120000) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'symlink: ' . mb_substr($name, 0, 80)]);
                }
                $key = mb_strtolower(rtrim($name, '/'));
                if (isset($names[$key])) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'duplicate name: ' . mb_substr($name, 0, 80)]);
                }
                $names[$key] = true;
                if (str_ends_with($name, '/')) {
                    continue;
                }
                if ($st['size'] > self::MAX_FILE) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'file larger than 2 MB: ' . mb_substr($name, 0, 80)]);
                }
                $total += $st['size'];
                if ($total > self::MAX_UNPACKED) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'more than 20 MB unpacked']);
                }
                $entries[] = [$i, $name];
            }
            // One top folder around everything (as zip tools create it) is removed.
            $prefix = self::commonFolder(array_column($entries, 1));
            foreach ($entries as [$i, $name]) {
                $rel = substr($name, strlen($prefix));
                $path = $dir . '/' . $rel;
                @mkdir(dirname($path), 0o755, true);
                $in = $zip->getStream($name);
                if ($in === false) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'cannot read ' . mb_substr($name, 0, 80)]);
                }
                // The real size is checked while copying (the header may lie).
                $data = stream_get_contents($in, self::MAX_FILE + 1);
                fclose($in);
                if ($data === false || strlen($data) > self::MAX_FILE) {
                    throw new ApiError(422, 'error.plugin.zip', ['reason' => 'file larger than 2 MB: ' . mb_substr($name, 0, 80)]);
                }
                file_put_contents($path, $data);
            }
        } finally {
            if ($opened === true) {
                $zip->close();
            }
            @unlink($file);
        }
    }

    private static function commonFolder(array $names): string
    {
        if ($names === [] || in_array('bothub.json', $names, true)) {
            return '';
        }
        $first = explode('/', $names[0])[0] . '/';
        foreach ($names as $n) {
            if (!str_starts_with($n, $first)) {
                return '';
            }
        }
        return $first;
    }

    // ---------- validation ----------

    /** @return array{manifest: array, commands: array<string, array>, lang: array} */
    public function validate(string $dir): array
    {
        $fail = static fn (string $field) => throw new ApiError(422, 'error.plugin.manifest', ['field' => $field]);
        $m = self::normalize($dir, $fail);
        is_string($m['id'] ?? null) && preg_match(self::ID, $m['id']) || $fail('id');
        is_string($m['name'] ?? null) && trim($m['name']) !== '' && mb_strlen($m['name']) <= 60 || $fail('name');
        is_string($m['version'] ?? null) && preg_match(self::VERSION, $m['version']) || $fail('version');
        is_string($m['main'] ?? null) && preg_match('#^[A-Za-z0-9_./-]{1,100}\.m?js$#', $m['main']) && !str_contains($m['main'], '..') && is_file($dir . '/' . $m['main']) || $fail('main');
        $perms = $m['permissions'] ?? [];
        is_array($perms) && array_is_list($perms) && count($perms) <= 40 && count(array_unique($perms, SORT_REGULAR)) === count($perms) || $fail('permissions');
        foreach ($perms as $perm) {
            is_string($perm) && preg_match('/^[a-z][a-z0-9.]{1,63}$/', $perm) || $fail('permissions');
        }
        is_array($m['blocks'] ?? []) || $fail('blocks');
        $id = $m['id'];
        self::checkDeclarations($m, $perms, $fail);

        // settings: module-settings format, without secrets, limited
        if (isset($m['settings'])) {
            $fields = $m['settings']['fields'] ?? null;
            is_array($fields) && array_is_list($fields) && count($fields) <= self::MAX_FIELDS || $fail('settings.fields');
            self::checkFields($fields, false, $fail);
            // Image fields keep their files in plugin_files: the plugin needs storage.files.
            !self::hasImageField($fields) || in_array('storage.files', $perms, true) || $fail('settings: image fields need permission storage.files');
            try {
                // Shape and defaults only: "required" is checked when the user saves.
                ModuleSettings::normalize(['fields' => self::withoutRequired($fields)], []);
            } catch (\Throwable) {
                $fail('settings.fields');
            }
        }

        // lang: exactly en + de, flat plugin.<id>.* keys
        $lang = [];
        if (isset($m['lang'])) {
            // en is required; missing German texts fall back to English.
            is_array($m['lang']) && ($m['lang']['en'] ?? null) === 'lang/en.json' && ($m['lang']['de'] ?? 'lang/de.json') === 'lang/de.json'
                && array_diff(array_keys($m['lang']), ['en', 'de']) === [] || $fail('lang');
            foreach (array_keys($m['lang']) as $code) {
                $file = $dir . '/lang/' . $code . '.json';
                if (!is_file($file) || filesize($file) > self::MAX_LANG) {
                    throw new ApiError(422, 'error.plugin.lang', ['file' => "lang/{$code}.json"]);
                }
                $texts = json_decode((string) file_get_contents($file), true);
                if (!is_array($texts) || array_is_list($texts) && $texts !== []) {
                    throw new ApiError(422, 'error.plugin.lang', ['file' => "lang/{$code}.json"]);
                }
                foreach ($texts as $k => $v) {
                    if (!is_string($k) || !str_starts_with($k, "plugin.{$id}.") || !is_string($v) || mb_strlen($v) > 500) {
                        throw new ApiError(422, 'error.plugin.lang', ['file' => "lang/{$code}.json", 'key' => mb_substr((string) $k, 0, 100)]);
                    }
                }
                $lang[$code] = $texts;
            }
        }

        // commands: graphs of built-in blocks or this plugin's own blocks
        $own = array_map(static fn ($b) => "plugin.{$id}." . ($b['name'] ?? ''), is_array($m['blocks'] ?? null) ? $m['blocks'] : []);
        $commands = [];
        $files = $m['commands'] ?? [];
        is_array($files) && array_is_list($files) && count($files) <= self::MAX_COMMANDS || $fail('commands');
        foreach ($files as $path) {
            if (!is_string($path) || !preg_match('#^commands/([a-z0-9_-]{1,32})\.json$#', $path, $mm)) {
                $fail('commands');
            }
            $cmd = is_file($dir . '/' . $path) ? json_decode((string) file_get_contents($dir . '/' . $path), true) : null;
            $graph = is_array($cmd) ? json_decode(json_encode($cmd['graph'] ?? null), false) : null;
            if (!is_array($cmd) || !is_string($cmd['name'] ?? null) || !preg_match('/^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$/', $cmd['name'])
                || mb_strlen((string) ($cmd['description'] ?? '')) > 100) {
                throw new ApiError(422, 'error.plugin.command', ['file' => $path, 'reason' => 'name or description']);
            }
            $slash = array_filter(is_array($cmd['graph']['nodes'] ?? null) ? $cmd['graph']['nodes'] : [], static fn ($n) => is_array($n) && ($n['type'] ?? null) === 'trigger.slash');
            if (count($slash) !== 1) {
                throw new ApiError(422, 'error.plugin.command', ['file' => $path, 'reason' => 'needs exactly one trigger.slash block']);
            }
            try {
                $nodes = CommandStore::validGraph($cmd['graph'] ?? null, $own);
            } catch (ApiError $e) {
                throw new ApiError(422, 'error.plugin.command', ['file' => $path, 'reason' => $e->key]);
            }
            $commands[$mm[1]] = ['name' => $cmd['name'], 'description' => (string) ($cmd['description'] ?? ''), 'graph' => $graph, 'nodes' => $nodes];
        }
        return ['manifest' => $m, 'commands' => $commands, 'lang' => $lang];
    }

    /**
     * Reads bothub.json (shared/plugin-format.md) and the files it names and
     * returns the normalized manifest the rest of BotHub works with:
     * author/developer/license, sdk = sdk.version, permissions =
     * sdk.permissions, tasks/endpoints from services, blocks from nodes/,
     * settings from dashboard/settings.json.
     */
    private static function normalize(string $dir, callable $fail): array
    {
        $file = $dir . '/bothub.json';
        $raw = is_file($file) && filesize($file) <= self::MAX_LANG ? file_get_contents($file) : false;
        $p = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($p) || array_is_list($p)) {
            $fail('bothub.json');
        }
        $known = ['$schema', 'schemaVersion', 'id', 'name', 'version', 'description', 'developer', 'license', 'icon', 'category', 'sdk', 'main', 'commands', 'events', 'services', 'nodes', 'dashboard', 'lang'];
        foreach (array_keys($p) as $key) {
            in_array($key, $known, true) || $fail((string) $key);
        }
        // "$schema" (editor autocompletion) is allowed in every plugin JSON file and ignored.
        !isset($p['$schema']) || is_string($p['$schema']) && strlen($p['$schema']) <= 300 || $fail('$schema');
        ($p['schemaVersion'] ?? null) === 1 || $fail('schemaVersion');
        is_string($p['description'] ?? null) && trim($p['description']) !== '' && mb_strlen($p['description']) <= 300 || $fail('description');
        $dev = $p['developer'] ?? null;
        is_array($dev) && array_diff(array_keys($dev), ['name', 'url', 'email']) === []
            && is_string($dev['name'] ?? null) && trim($dev['name']) !== '' && mb_strlen($dev['name']) <= 60
            && (!isset($dev['url']) || is_string($dev['url']) && strlen($dev['url']) <= 200 && str_starts_with($dev['url'], 'https://'))
            && (!isset($dev['email']) || is_string($dev['email']) && strlen($dev['email']) <= 200 && filter_var($dev['email'], FILTER_VALIDATE_EMAIL) !== false)
            || $fail('developer');
        !isset($p['license']) || is_string($p['license']) && mb_strlen($p['license']) <= 40 || $fail('license');
        !isset($p['icon']) || is_string($p['icon']) && preg_match(self::ICON, $p['icon']) || $fail('icon');
        !isset($p['category']) || in_array($p['category'], self::CATEGORIES, true) || $fail('category');
        $sdk = $p['sdk'] ?? null;
        is_array($sdk) && array_diff(array_keys($sdk), ['version', 'permissions']) === [] && ($sdk['version'] ?? null) === 1 && array_key_exists('permissions', $sdk) || $fail('sdk');
        $services = $p['services'] ?? [];
        is_array($services) && array_diff(array_keys($services), ['tasks', 'endpoints', 'secrets', 'hosts', 'webhooks', 'connect']) === [] || $fail('services');
        $dashboard = $p['dashboard'] ?? [];
        is_array($dashboard) && array_diff(array_keys($dashboard), ['settings']) === []
            && (!isset($dashboard['settings']) || $dashboard['settings'] === 'dashboard/settings.json') || $fail('dashboard');

        $m = [
            'id' => $p['id'] ?? null, 'name' => $p['name'] ?? null, 'version' => $p['version'] ?? null,
            'description' => $p['description'], 'main' => $p['main'] ?? null,
            'author' => $dev['name'], 'developer' => $dev,
            // Old coarse keys count as their finer replacements (SdkCatalog).
            'sdk' => 1, 'permissions' => SdkCatalog::expand($sdk['permissions']),
            'commands' => $p['commands'] ?? [], 'events' => $p['events'] ?? [],
            'tasks' => $services['tasks'] ?? [], 'endpoints' => $services['endpoints'] ?? [], 'secrets' => $services['secrets'] ?? [], 'hosts' => $services['hosts'] ?? [], 'webhooks' => $services['webhooks'] ?? [],
            // Sign-in helpers: secret name => provider (App Store page).
            'connect' => (object) ($services['connect'] ?? []),
            'blocks' => [],
        ];
        if (isset($p['license'])) {
            $m['license'] = $p['license'];
        }
        if (isset($p['lang'])) {
            $m['lang'] = $p['lang'];
        }
        foreach (['icon', 'category'] as $key) {
            if (isset($p[$key])) {
                $m[$key] = $p[$key];
            }
        }
        is_string($m['id']) && preg_match(self::ID, $m['id']) || $fail('id');

        // Nodes: nodes/<name>.json is the node definition (type = plugin.<id>.<name>).
        $nodes = $p['nodes'] ?? [];
        is_array($nodes) && array_is_list($nodes) && count($nodes) <= 50 && count(array_unique($nodes, SORT_REGULAR)) === count($nodes) || $fail('nodes');
        foreach ($nodes as $name) {
            is_string($name) && preg_match('/^[a-z][a-z0-9_]{0,31}$/', $name) || $fail('nodes');
            $path = "{$dir}/nodes/{$name}.json";
            $def = self::withoutSchema(is_file($path) && filesize($path) <= self::MAX_LANG ? json_decode((string) file_get_contents($path), true) : null);
            if (!is_array($def) || array_is_list($def) || !is_string($def['category'] ?? null) || !is_string($def['labelKey'] ?? null)
                || (isset($def['type']) && $def['type'] !== "plugin.{$m['id']}.{$name}")) {
                $fail("nodes/{$name}.json");
            }
            $m['blocks'][] = ['name' => $name, 'definition' => $def];
        }

        // Dashboard: settings page per bot.
        if (isset($dashboard['settings'])) {
            $path = $dir . '/dashboard/settings.json';
            $settings = self::withoutSchema(is_file($path) && filesize($path) <= self::MAX_LANG ? json_decode((string) file_get_contents($path), true) : null);
            is_array($settings) && array_keys($settings) === ['fields'] || $fail('dashboard/settings.json');
            $m['settings'] = $settings;
        }

        // Sounds are played with voice.play.
        if (is_dir($dir . '/sounds') && glob($dir . '/sounds/*') !== []) {
            is_array($m['permissions']) && in_array('discord.voice.speak', $m['permissions'], true) || $fail('sounds: needs permission discord.voice.speak');
            foreach (glob($dir . '/sounds/*') as $sound) {
                is_file($sound) && preg_match('/\.(ogg|mp3|wav)$/i', $sound) || $fail('sounds');
            }
        }
        return $m;
    }

    /** Drops an editor "$schema" string; anything else is returned as it is. */
    private static function withoutSchema(mixed $doc): mixed
    {
        if (is_array($doc) && array_key_exists('$schema', $doc) && is_string($doc['$schema']) && strlen($doc['$schema']) <= 300) {
            unset($doc['$schema']);
        }
        return $doc;
    }

    /**
     * endpoints, events and tasks (shared/plugin-manifest.schema.json); each
     * declared field needs its SDK permission in the manifest's permissions.
     */
    private static function checkDeclarations(array $m, array $perms, callable $fail): void
    {
        $list = static fn (mixed $v, int $max) => is_array($v) && array_is_list($v) && count($v) <= $max;
        // API endpoints are gone: an address is a secret too (services.secrets + ctx.http.secret).
        ($m['endpoints'] ?? []) === [] || $fail('services.endpoints: API endpoints are gone; declare the address and the key in services.secrets and use ctx.http.secret');
        // Secrets the plugin reads by name (secrets.read): only these names, each shared by the admin.
        if (array_key_exists('secrets', $m)) {
            $list($m['secrets'], 20) && count(array_unique($m['secrets'], SORT_REGULAR)) === count($m['secrets']) || $fail('secrets');
            foreach ($m['secrets'] as $key) {
                is_string($key) && preg_match('/^[A-Z][A-Z0-9_]{1,39}$/', $key) || $fail('secrets');
            }
            $m['secrets'] === [] || array_intersect(['secrets.read', 'secrets.use'], $perms) !== [] || $fail('secrets: needs permission secrets.read or secrets.use');
        }
        $connect = (array) ($m['connect'] ?? []);
        count($connect) <= 10 || $fail('services.connect');
        foreach ($connect as $key => $provider) {
            // Only declared secrets, only known providers.
            in_array($key, $m['secrets'] ?? [], true) && in_array($provider, self::CONNECT_PROVIDERS, true) || $fail('services.connect');
        }
        if (array_key_exists('hosts', $m)) {
            $list($m['hosts'], 20) && count(array_unique($m['hosts'], SORT_REGULAR)) === count($m['hosts']) || $fail('hosts');
            foreach ($m['hosts'] as $host) {
                is_string($host) && preg_match('/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/', $host) || $fail('hosts');
            }
            // Hosts: for http.get/post/... (http.outbound) or fixed https URLs of ctx.http.secret (secrets.use).
            $m['hosts'] === [] || array_intersect(['http.outbound', 'secrets.use'], $perms) !== [] || $fail('hosts: needs permission http.outbound or secrets.use');
        }
        if (array_key_exists('webhooks', $m)) {
            $list($m['webhooks'], 10) && count(array_unique($m['webhooks'], SORT_REGULAR)) === count($m['webhooks']) || $fail('webhooks');
            foreach ($m['webhooks'] as $name) {
                is_string($name) && preg_match('/^[a-z][a-z0-9_]{0,31}$/', $name) || $fail('webhooks');
            }
            $m['webhooks'] === [] || in_array('webhooks.inbound', $perms, true) || $fail('webhooks: needs permission webhooks.inbound');
        }
        if (array_key_exists('events', $m)) {
            $needs = SdkCatalog::eventPermissions();
            $list($m['events'], count($needs)) && count(array_unique($m['events'], SORT_REGULAR)) === count($m['events']) || $fail('events');
            foreach ($m['events'] as $event) {
                is_string($event) && isset($needs[$event]) || $fail('events');
                // Each event needs its discord.events.* permission (messages, members, server, voice, interactions).
                in_array($needs[$event], $perms, true) || $fail("events: {$event} needs permission {$needs[$event]}");
            }
        }
        if (array_key_exists('tasks', $m)) {
            $list($m['tasks'], 20) || $fail('tasks');
            $names = [];
            foreach ($m['tasks'] as $task) {
                $ok = is_array($task) && array_diff(array_keys($task), ['name', 'every', 'cron']) === []
                    && is_string($task['name'] ?? null) && preg_match('/^[a-z][a-z0-9_]{0,31}$/', $task['name']) && !isset($names[$task['name']])
                    && (isset($task['every']) xor isset($task['cron']))
                    && (!isset($task['every']) || is_string($task['every']) && preg_match('/^([1-9][0-9]{0,4}[mhd]|([6-9][0-9]|[1-9][0-9]{2,4})s)$/', $task['every']))
                    && (!isset($task['cron']) || is_string($task['cron']) && strlen($task['cron']) <= 100 && preg_match('/^\S+( \S+){4}$/', $task['cron']));
                $ok || $fail('tasks');
                $names[$task['name']] = true;
            }
            $m['tasks'] === [] || in_array('scheduler', $perms, true) || $fail('tasks: needs permission scheduler');
        }
    }

    private static function hasImageField(array $fields): bool
    {
        foreach ($fields as $f) {
            if (in_array($f['type'] ?? null, ['image', 'file'], true) || (($f['type'] ?? null) === 'list' && is_array($f['item'] ?? null) && self::hasImageField($f['item']))) {
                return true;
            }
        }
        return false;
    }

    private static function checkFields(array $fields, bool $inList, callable $fail): void
    {
        foreach ($fields as $f) {
            if (!is_array($f) || !is_string($f['key'] ?? null) || !preg_match('/^[a-z][a-zA-Z0-9_]{0,31}$/', $f['key'])
                || !in_array($f['type'] ?? null, self::FIELD_TYPES, true)) {
                $fail('settings.fields');
            }
            if (in_array($f['type'], ['text', 'words', 'emojis'], true) && (($f['max'] ?? 0) > 2000 || ($f['maxLength'] ?? 0) > 2000)) {
                $fail("settings.{$f['key']}.max");
            }
            if ($f['type'] === 'file' && ($f['accept'] ?? null) !== 'audio') {
                $fail("settings.{$f['key']}.accept");
            }
            if ($f['type'] === 'choices') {
                $opts = $f['options'] ?? [];
                $ok = is_bool($f['dynamic'] ?? false) && is_array($opts) && array_is_list($opts) && count($opts) <= 200
                    && array_filter($opts, static fn ($o) => !is_string($o) || $o === '' || mb_strlen($o) > 100) === []
                    && (($f['dynamic'] ?? false) || $opts !== []);
                $ok || $fail("settings.{$f['key']}");
            }
            if ($f['type'] === 'list') {
                if ($inList || ($f['max'] ?? 50) > 50 || !is_array($f['item'] ?? null)) {
                    $fail("settings.{$f['key']}");
                }
                self::checkFields($f['item'], true, $fail);
            }
        }
    }

    // ---------- commands ----------

    /**
     * Creates missing disabled copies of the plugin's commands for one bot,
     * in a group named after the plugin. Copies the user never saved
     * (hidden = 1) follow a new plugin version (graph and version; the
     * enabled switch stays); saved copies are never overwritten, their
     * changed graph is reported.
     *
     * @return array{created: int, updated: int, changed: list<string>, conflicts: list<string>}
     */
    public function copyCommands(PDO $pdo, int $botId, array $m, array $commands): array
    {
        $out = ['created' => 0, 'updated' => 0, 'changed' => [], 'conflicts' => []];
        if ($commands === []) {
            return $out;
        }
        $group = null;
        $find = $pdo->prepare('SELECT id, graph, hidden FROM commands WHERE bot_id = ? AND plugin_id = ? AND preset_name = ? AND deleted_at IS NULL');
        $taken = $pdo->prepare("SELECT 1 FROM commands WHERE bot_id = ? AND kind = 'command' AND builtin = 0 AND deleted_at IS NULL AND name = ?");
        foreach ($commands as $preset => $c) {
            $graph = json_encode($c['graph'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $find->execute([$botId, $m['id'], $preset]);
            $existing = $find->fetch();
            if ($existing) {
                // Compare decoded: key order or escaping alone is no change.
                if (json_decode((string) $existing['graph'], true) == json_decode($graph, true)) {
                    continue;
                }
                if ((int) $existing['hidden'] === 1) {
                    // The visibility chosen on the plugin page (hide_replies) stays.
                    $graph = self::keepVisibility((string) $existing['graph'], $graph);
                    if (json_decode((string) $existing['graph'], true) == json_decode($graph, true)) {
                        continue;
                    }
                    $pdo->prepare("UPDATE commands SET graph = ?, description = ?, plugin_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
                        ->execute([$graph, mb_substr($c['description'], 0, 100), $m['version'], (int) $existing['id']]);
                    $pdo->prepare('INSERT INTO command_versions (command_id, nodes, graph) VALUES (?, ?, ?)')->execute([(int) $existing['id'], $c['nodes'], $graph]);
                    Outbox::add($pdo, 'command.saved', ['botId' => $botId, 'commandId' => (int) $existing['id']]);
                    $out['updated']++;
                } else {
                    $out['changed'][] = $preset;
                }
                continue;
            }
            $taken->execute([$botId, $c['name']]);
            if ($taken->fetchColumn() !== false) {
                $out['conflicts'][] = $c['name']; // a user command already has this name
                continue;
            }
            if ($group === null) {
                $name = mb_substr($m['name'], 0, 40);
                $g = $pdo->prepare('SELECT id FROM command_groups WHERE bot_id = ? AND name = ? AND system = 1');
                $g->execute([$botId, $name]);
                $group = $g->fetchColumn();
                if ($group === false) {
                    $pdo->prepare('INSERT INTO command_groups (bot_id, name, position, system) VALUES (?, ?, (SELECT MIN(999, COALESCE(MAX(position) + 1, 0)) FROM command_groups WHERE bot_id = ?), 1)')->execute([$botId, $name, $botId]);
                    $group = (int) $pdo->lastInsertId();
                }
            }
            $pdo->prepare("INSERT INTO commands (bot_id, kind, name, description, builtin, enabled, hidden, group_id, graph, plugin_id, plugin_version, preset_name)
                VALUES (?, 'command', ?, ?, 0, 0, 1, ?, ?, ?, ?, ?)")
                ->execute([$botId, $c['name'], mb_substr($c['description'], 0, 100), $group, $graph, $m['id'], $m['version'], $preset]);
            $pdo->prepare('INSERT INTO command_versions (command_id, nodes, graph) VALUES (?, ?, ?)')->execute([(int) $pdo->lastInsertId(), $c['nodes'], $graph]);
            $out['created']++;
        }
        // Copies of presets the new version no longer has (e.g. /emoji-menu became
        // /emoji-menu show) are switched off, so they cannot block the new commands.
        $marks = implode(', ', array_fill(0, count($commands), '?'));
        $pdo->prepare("UPDATE commands SET enabled = 0 WHERE bot_id = ? AND plugin_id = ? AND deleted_at IS NULL AND enabled = 1 AND preset_name NOT IN ({$marks})")
            ->execute([$botId, $m['id'], ...array_map('strval', array_keys($commands))]);
        return $out;
    }

    /** The new graph with hide_replies of the old copy's slash trigger, when it set one. */
    private static function keepVisibility(string $old, string $new): string
    {
        $hide = null;
        foreach (json_decode($old, true)['nodes'] ?? [] as $n) {
            if (($n['type'] ?? '') === 'trigger.slash' && is_bool($n['config']['hide_replies'] ?? null)) {
                $hide = $n['config']['hide_replies'];
            }
        }
        if ($hide === null) {
            return $new;
        }
        $graph = json_decode($new, false, 512, JSON_THROW_ON_ERROR);
        foreach ($graph->nodes ?? [] as $n) {
            if (($n->type ?? '') === 'trigger.slash') {
                $n->config = (object) ($n->config ?? []);
                $n->config->hide_replies = $hide;
            }
        }
        return json_encode($graph, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /** Copies of an installed plugin for one bot (idempotent). */
    public function syncBot(int $botId, string $pluginId): array
    {
        $plugin = $this->installed($pluginId);
        $data = $this->validate($this->pluginDir($pluginId, $plugin['version']));
        return Connection::write($this->pdo, function (PDO $pdo) use ($botId, $data): array {
            $r = $this->copyCommands($pdo, $botId, $data['manifest'], $data['commands']);
            if ($r['created'] > 0) {
                Outbox::add($pdo, 'commands.changed', ['botId' => $botId]);
            }
            return $r;
        });
    }

    /** Switches an installed plugin on or off for one bot (bot_plugin_disabled). */
    /** Switches a plugin on or off for every bot (Admin, App Store). */
    public function setInstanceEnabled(string $pluginId, mixed $enabled, string $actor): array
    {
        if (!is_bool($enabled)) {
            throw new ApiError(422, 'error.validation', ['field' => 'enabled']);
        }
        $plugin = $this->installed($pluginId);
        Connection::write($this->pdo, function (PDO $pdo) use ($pluginId, $enabled, $actor, $plugin): void {
            $pdo->prepare('UPDATE plugin_installs SET enabled = ? WHERE plugin_id = ?')->execute([$enabled ? 1 : 0, $pluginId]);
            Outbox::add($pdo, 'plugins.changed', []);
            $this->log($pdo, $enabled ? 'log.server.plugin_enabled' : 'log.server.plugin_disabled', ['plugin' => $pluginId, 'version' => $plugin['version'], 'actor' => $actor]);
        });
        foreach ($this->list() as $p) {
            if ($p['id'] === $pluginId) {
                return $p;
            }
        }
        throw ApiError::notFound('error.plugin.unknown');
    }

    public function setEnabled(int $botId, string $pluginId, mixed $enabled): array
    {
        if (!is_bool($enabled)) {
            throw new ApiError(422, 'error.validation', ['field' => 'enabled']);
        }
        $this->installed($pluginId);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $pluginId, $enabled): void {
            $pdo->prepare($enabled ? 'DELETE FROM bot_plugin_disabled WHERE bot_id = ? AND plugin_id = ?' : 'INSERT OR IGNORE INTO bot_plugin_disabled (bot_id, plugin_id) VALUES (?, ?)')
                ->execute([$botId, $pluginId]);
            Outbox::add($pdo, 'plugins.changed', []);
        });
        foreach ($this->listForBot($botId) as $p) {
            if ($p['id'] === $pluginId) {
                return $p;
            }
        }
        throw ApiError::notFound('error.plugin.unknown');
    }

    /** New bot: copies of every installed plugin (inside the bot's create transaction). */
    public function seedBot(PDO $pdo, int $botId): void
    {
        foreach ($pdo->query('SELECT plugin_id, version FROM plugin_installs')->fetchAll() as $row) {
            try {
                $data = $this->validate($this->pluginDir($row['plugin_id'], $row['version']));
                $this->copyCommands($pdo, $botId, $data['manifest'], $data['commands']);
            } catch (ApiError) {
                // broken plugin files: the bot is created anyway
            }
        }
    }

    // ---------- market list ----------

    /**
     * Every plugin of the market for the Plugin Manager: the folders in the
     * market repo root (bothub.json each; Template/ is left out) merged with
     * the published versions of index.json. Only published plugins can be
     * installed. Cached 5 minutes ($refresh skips the cache).
     *
     * $cachedOnly: the last list of any age, never a download ("fresh":
     * younger than 5 minutes; no list yet: no items, "fresh" false). The App
     * Store shows it at once and fetches the current list in the background.
     *
     * @return array{items: list<array<string, mixed>>, fetchedAt: string}
     */
    public function market(bool $refresh = false, ?callable $fetch = null, bool $cachedOnly = false): array
    {
        $cache = rtrim($this->dataDir, '/') . '/plugins/.market-cache.json';
        if ($cachedOnly) {
            $cached = is_file($cache) ? json_decode((string) file_get_contents($cache), true) : null;
            if (!is_array($cached) || !isset($cached['items'])) {
                return ['items' => [], 'fetchedAt' => null, 'fresh' => false];
            }
            return $this->withInstalled($cached + ['fresh' => filemtime($cache) > time() - 300]);
        }
        if (!$refresh && is_file($cache) && filemtime($cache) > time() - 300) {
            $cached = json_decode((string) file_get_contents($cache), true);
            if (is_array($cached) && isset($cached['items'])) {
                return $this->withInstalled($cached);
            }
        }
        try {
            return $this->withInstalled($this->fetchMarket($cache, $fetch));
        } catch (ApiError $e) {
            // GitHub down, rate limit or a restart: the last good list (any
            // age) beats an error page; "stale" tells the dashboard.
            $cached = is_file($cache) ? json_decode((string) file_get_contents($cache), true) : null;
            if (is_array($cached) && isset($cached['items'])) {
                return $this->withInstalled($cached + ['stale' => true]);
            }
            throw $e;
        }
    }

    /** Reads index.json and the repo folders and writes the cache. */
    private function fetchMarket(string $cache, ?callable $fetch): array
    {
        $fetch ??= self::fetch(...);
        $token = $this->marketToken ? ($this->marketToken)() : null;
        $token = is_string($token) && preg_match('/^[!-~]{1,255}$/', trim($token)) ? trim($token) : null;

        // Published versions: the highest one per id.
        $index = json_decode((string) $fetch(getenv('BOTHUB_MARKET_INDEX') ?: self::MARKET_INDEX, 1024 * 1024, [], $token), true);
        $published = [];
        foreach (is_array($index) ? ($index['plugins'] ?? []) : [] as $p) {
            $id = $p['id'] ?? null;
            if (is_string($id) && preg_match(self::ID, $id) && is_string($p['version'] ?? null)
                && (!isset($published[$id]) || version_compare($p['version'], $published[$id]['version'], '>'))) {
                $published[$id] = $p;
            }
        }

        // Folders in the repo root (needs the GitHub API; skipped for a custom index).
        $items = [];
        $repo = getenv('BOTHUB_MARKET_REPO') ?: 'Kljub/BothubMarketPlace';
        if (!getenv('BOTHUB_MARKET_INDEX') && preg_match('#^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$#', $repo)) {
            $root = json_decode((string) $fetch("https://api.github.com/repos/{$repo}/contents/", 1024 * 1024, ['Accept: application/vnd.github+json'], $token), true);
            foreach (is_array($root) ? $root : [] as $entry) {
                $name = $entry['name'] ?? '';
                if (($entry['type'] ?? '') !== 'dir' || $name === 'Template' || !is_string($name) || !preg_match(self::ID, $name)) {
                    continue;
                }
                try {
                    $b = json_decode((string) $fetch("https://raw.githubusercontent.com/{$repo}/main/{$name}/bothub.json", 256 * 1024, [], $token), true);
                } catch (ApiError) {
                    continue; // folder without bothub.json: not a plugin
                }
                if (!is_array($b) || ($b['id'] ?? null) !== $name) {
                    continue;
                }
                $items[$name] = self::marketItem($name, $b);
            }
        }
        foreach ($published as $id => $p) {
            $items[$id] ??= self::marketItem($id, $p);
            $items[$id]['published'] = $p['version'];
            // Contents and size are known only for a release (index.json).
            $layers = is_array($p['layers'] ?? null) ? $p['layers'] : [];
            $items[$id]['layers'] = array_map(fn ($n) => is_int($n) ? $n : 0, array_merge(self::LAYERS, array_intersect_key($layers, self::LAYERS)));
            $items[$id]['size'] = is_int($p['size'] ?? null) ? $p['size'] : 0;
        }
        ksort($items);
        $out = ['items' => array_values(array_map(fn (array $i) => $i + ['published' => null, 'layers' => null, 'size' => 0], $items)), 'fetchedAt' => gmdate('Y-m-d\TH:i:s\Z')];
        @mkdir(dirname($cache), 0o775, true);
        @file_put_contents($cache, json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $out;
    }

    private const LAYERS = ['commands' => 0, 'events' => 0, 'services' => 0, 'nodes' => 0, 'dashboard' => 0];

    /**
     * One App Store entry from a bothub.json or an index.json entry (both
     * carry id, name, description, developer, version, license, icon,
     * category, sdk.permissions and, for bothub.json, services).
     */
    private static function marketItem(string $id, array $b): array
    {
        $icon = $b['icon'] ?? null;
        $category = $b['category'] ?? null;
        $str = fn (mixed $v, int $max) => is_string($v) ? mb_substr($v, 0, $max) : '';
        return [
            'id' => $id,
            'name' => $str($b['name'] ?? $id, 60) ?: $id,
            'description' => $str($b['description'] ?? '', 300),
            'developer' => $str($b['developer']['name'] ?? '', 60),
            'version' => $str($b['version'] ?? '', 20),
            'license' => $str($b['license'] ?? '', 40),
            'icon' => is_string($icon) && preg_match(self::ICON, $icon) ? $icon : '',
            'category' => in_array($category, self::CATEGORIES, true) ? $category : 'utility',
            'permissions' => SdkCatalog::expand(array_values(array_filter($b['sdk']['permissions'] ?? [], 'is_string'))),
            'secrets' => array_values(array_filter($b['secrets'] ?? $b['services']['secrets'] ?? [], 'is_string')),
        ];
    }

    /** Adds the installed version (or null) to each market item. */
    private function withInstalled(array $market): array
    {
        $installed = $this->pdo->query('SELECT plugin_id, version FROM plugin_installs')->fetchAll(PDO::FETCH_KEY_PAIR);
        foreach ($market['items'] as &$item) {
            $item['installed'] = $installed[$item['id']] ?? null;
        }
        return $market;
    }

    // ---------- list, uninstall, settings ----------

    public function list(): array
    {
        $rows = $this->pdo->query('SELECT i.plugin_id, i.version, i.enabled, i.installed_at, p.sha256, p.manifest FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id AND p.version = i.version ORDER BY i.plugin_id')->fetchAll();
        $keys = $this->pdo->prepare('SELECT key, length(value_enc) > 0 FROM secrets WHERE owner_id = ?');
        $keys->execute([$this->owner]);
        $secretKeys = $keys->fetchAll(PDO::FETCH_KEY_PAIR);
        $secretShares = [];
        $shares = $this->pdo->prepare('SELECT plugin_id, secret_key FROM secret_plugin_shares WHERE owner_id = ?');
        $shares->execute([$this->owner]);
        foreach ($shares->fetchAll() as $s) {
            $secretShares[$s['plugin_id']][$s['secret_key']] = true;
        }
        $on = array_column(array_filter((new SdkPolicyStore($this->pdo))->list(), fn ($p) => $p['enabled']), 'permission');
        return array_map(function (array $r) use ($secretKeys, $secretShares, $on) {
            $manifest = json_decode($r['manifest'], true);
            // Stored before the permission split: read with the finer keys.
            $manifest['permissions'] = SdkCatalog::expand($manifest['permissions'] ?? []);
            $secretShareMap = [];
            foreach ($manifest['secrets'] ?? [] as $key) {
                $secretShareMap[$key] = [
                    'exists' => isset($secretKeys[$key]), 'set' => (bool) ($secretKeys[$key] ?? false),
                    'shared' => isset($secretShares[$r['plugin_id']][$key]),
                ];
            }
            return [
                'id' => $r['plugin_id'], 'version' => $r['version'], 'sha256' => $r['sha256'], 'enabled' => $r['enabled'] === 1,
                // SDK permissions the plugin declares that the SDK policies switch off: the bot does not start it.
                'blockedBy' => array_values(array_diff(is_array($manifest['permissions'] ?? null) ? $manifest['permissions'] : [], $on)),
                'installedAt' => $r['installed_at'], 'manifest' => $manifest, 'lang' => $this->lang($r['plugin_id'], $r['version']),
                'secretShares' => (object) $secretShareMap,
            ];
        }, $rows);
    }

    /**
     * Sets the secrets a plugin may read by name (secrets.read): only names the
     * manifest declares and that exist under Admin -> API / Secrets. A plugin
     * can never list secrets; it has to know and declare each name.
     *
     * @return object map key => {exists, shared} (stays {} when empty)
     */
    /**
     * Every secret the plugin declares that does not exist yet becomes an
     * empty placeholder ([NULL]) in Admin > API / Secrets, shared with the
     * plugin: the admin only pastes the value. Secrets a sign-in helper
     * (services.connect) fills, token and address, are left out. Existing
     * secrets are never touched or shared here.
     */
    private function createSecretPlaceholders(PDO $pdo, array $m, string $actor): void
    {
        $skip = [];
        foreach (array_keys((array) ($m['connect'] ?? [])) as $token) {
            $skip[$token] = true;
            $i = strrpos($token, '_TOKEN');
            $skip[$i === false ? $token . '_URL' : substr($token, 0, $i) . '_URL' . substr($token, $i + 6)] = true;
        }
        $exists = $pdo->prepare('SELECT 1 FROM secrets WHERE owner_id = ? AND key = ?');
        $add = $pdo->prepare("INSERT INTO secrets (owner_id, key, value_enc, description) VALUES (?, ?, x'', ?)");
        $share = $pdo->prepare('INSERT OR IGNORE INTO secret_plugin_shares (owner_id, secret_key, plugin_id) VALUES (?, ?, ?)');
        $count = $pdo->prepare('SELECT COUNT(*) FROM secrets WHERE owner_id = ?');
        $made = [];
        foreach ($m['secrets'] ?? [] as $key) {
            if (!is_string($key) || isset($skip[$key])) {
                continue;
            }
            $exists->execute([$this->owner, $key]);
            if ($exists->fetchColumn() !== false) {
                continue;
            }
            $count->execute([$this->owner]);
            if ((int) $count->fetchColumn() >= 100) {
                break; // the page's limit; the rest the user adds by hand
            }
            $add->execute([$this->owner, $key, mb_substr("Plugin {$m['name']}", 0, 200)]);
            $share->execute([$this->owner, $key, $m['id']]);
            $made[] = $key;
        }
        if ($made !== []) {
            Outbox::add($pdo, 'secrets.changed', []);
            $this->log($pdo, 'log.server.plugin_secret_placeholders', ['plugin' => $m['id'], 'secrets' => implode(', ', $made), 'actor' => $actor]);
        }
    }

    public function shareSecrets(string $pluginId, mixed $shared, string $actor): object
    {
        $manifest = $this->installed($pluginId)['manifest'];
        $declared = $manifest['secrets'] ?? [];
        if (!is_array($shared) || !array_is_list($shared) || count($shared) > 20) {
            throw new ApiError(422, 'error.validation', ['field' => 'shared']);
        }
        $keys = array_values(array_unique($shared, SORT_REGULAR));
        foreach ($keys as $key) {
            if (!is_string($key) || !in_array($key, $declared, true)) {
                throw new ApiError(422, 'error.plugin.secret', ['key' => is_string($key) ? mb_substr($key, 0, 40) : '']);
            }
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($pluginId, $keys, $actor, $manifest): void {
            // Switched on but not in API / Secrets yet: an empty placeholder
            // ([NULL]) is created, the admin pastes the value there.
            $exists = $pdo->prepare('SELECT 1 FROM secrets WHERE owner_id = ? AND key = ?');
            $create = $pdo->prepare("INSERT INTO secrets (owner_id, key, value_enc, description) VALUES (?, ?, x'', ?)");
            $count = $pdo->prepare('SELECT COUNT(*) FROM secrets WHERE owner_id = ?');
            $made = [];
            foreach ($keys as $key) {
                $exists->execute([$this->owner, $key]);
                if ($exists->fetchColumn() !== false) {
                    continue;
                }
                $count->execute([$this->owner]);
                if ((int) $count->fetchColumn() >= 100) {
                    throw new ApiError(422, 'error.secret.limit', ['max' => 100]);
                }
                $create->execute([$this->owner, $key, mb_substr('Plugin ' . ($manifest['name'] ?? $pluginId), 0, 200)]);
                $made[] = $key;
            }
            if ($made !== []) {
                $this->log($pdo, 'log.server.plugin_secret_placeholders', ['plugin' => $pluginId, 'secrets' => implode(', ', $made), 'actor' => $actor]);
            }
            $pdo->prepare('DELETE FROM secret_plugin_shares WHERE owner_id = ? AND plugin_id = ?')->execute([$this->owner, $pluginId]);
            $add = $pdo->prepare('INSERT INTO secret_plugin_shares (owner_id, secret_key, plugin_id) VALUES (?, ?, ?)');
            foreach ($keys as $key) {
                $add->execute([$this->owner, $key, $pluginId]);
            }
            Outbox::add($pdo, 'secrets.changed', []);
            $this->log($pdo, 'log.server.plugin_secrets_shared', ['plugin' => $pluginId, 'secrets' => implode(', ', $keys), 'actor' => $actor]);
        });
        foreach ($this->list() as $p) {
            if ($p['id'] === $pluginId) {
                return $p['secretShares'];
            }
        }
        return (object) [];
    }

    public function listForBot(int $botId): array
    {
        $disabled = $this->pdo->prepare('SELECT plugin_id FROM bot_plugin_disabled WHERE bot_id = ?');
        $disabled->execute([$botId]);
        $off = array_flip($disabled->fetchAll(PDO::FETCH_COLUMN));
        return array_map(fn (array $p) => [
            'id' => $p['id'], 'version' => $p['version'], 'name' => $p['manifest']['name'] ?? $p['id'],
            'description' => $p['manifest']['description'] ?? '', 'icon' => $p['manifest']['icon'] ?? '',
            'enabled' => $p['enabled'] && !isset($off[$p['id']]), 'manifest' => $p['manifest'], 'lang' => $p['lang'],
            'instanceEnabled' => $p['enabled'], 'blockedBy' => $p['blockedBy'],
            // Inbound webhooks of the plugin: path relative to the dashboard (it proxies /api/*).
            'webhooks' => array_map(fn (string $name) => ['name' => $name, 'path' => "/api/hooks/plugin/{$p['id']}/{$botId}/{$name}/" . $this->hookToken($botId, $p['id'], $name)], $this->box ? ($p['manifest']['webhooks'] ?? []) : []),
        ], $this->list());
    }

    // ---------- inbound webhooks (services.webhooks) ----------

    /** Secret of a webhook URL: HMAC of bot, plugin and name with the instance key; no table needed. */
    /** Fields without "required" (also in list items), for the install-time check. */
    private static function withoutRequired(array $fields): array
    {
        return array_map(static function (mixed $f): mixed {
            if (!is_array($f)) {
                return $f;
            }
            unset($f['required']);
            if (is_array($f['item'] ?? null)) {
                $f['item'] = self::withoutRequired($f['item']);
            }
            return $f;
        }, $fields);
    }

    public function hookToken(int $botId, string $pluginId, string $name): string
    {
        if ($this->box === null) {
            throw new \LogicException('PluginStore needs the SecretBox for webhooks');
        }
        return bin2hex(substr($this->box->fingerprint("plugin-hook:{$botId}:{$pluginId}:{$name}"), 0, 20));
    }

    /**
     * A call of a plugin webhook (POST /api/hooks/plugin/<id>/<bot>/<name>/<token>).
     * Body: JSON, or the "payload" field of a form (Plex sends multipart).
     * Goes to the bot as plugin.webhook; the plugin's webhooks[name] handles it.
     */
    public function receiveWebhook(int $botId, string $pluginId, string $name, string $token, string $raw, ?string $formPayload): void
    {
        if (!preg_match(self::ID, $pluginId) || !preg_match('/^[a-z][a-z0-9_]{0,31}$/', $name) || !hash_equals($this->hookToken($botId, $pluginId, $name), $token)) {
            throw ApiError::notFound('error.webhook.unknown');
        }
        $row = $this->pdo->prepare(
            'SELECT p.manifest FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id AND p.version = i.version JOIN bots b ON b.id = ?
             WHERE i.plugin_id = ? AND i.enabled = 1 AND NOT EXISTS (SELECT 1 FROM bot_plugin_disabled d WHERE d.bot_id = b.id AND d.plugin_id = i.plugin_id)',
        );
        $row->execute([$botId, $pluginId]);
        $manifest = json_decode((string) $row->fetchColumn(), true);
        if (!is_array($manifest) || !in_array($name, $manifest['webhooks'] ?? [], true)) {
            throw ApiError::notFound('error.webhook.unknown');
        }
        $text = $formPayload ?? $raw;
        $payload = $text === '' ? [] : json_decode($text, true);
        if (!is_array($payload)) {
            throw new ApiError(400, 'error.bad_json');
        }
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $pluginId, $name, $payload): void {
            Outbox::add($pdo, 'plugin.webhook', ['botId' => $botId, 'pluginId' => $pluginId, 'name' => $name, 'payload' => (object) $payload]);
        });
    }

    public function uninstall(string $pluginId, bool $deleteCommands, string $actor): void
    {
        $plugin = $this->installed($pluginId);
        Connection::write($this->pdo, function (PDO $pdo) use ($pluginId, $deleteCommands, $actor, $plugin): void {
            if ($deleteCommands) {
                $pdo->prepare('DELETE FROM commands WHERE plugin_id = ?')->execute([$pluginId]);
                // The plugin's system groups are empty now; the user cannot delete them.
                $pdo->exec('DELETE FROM command_groups WHERE system = 1 AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.group_id = command_groups.id)');
            }
            $pdo->prepare('DELETE FROM plugin_installs WHERE plugin_id = ?')->execute([$pluginId]);
            Outbox::add($pdo, 'plugins.changed', []);
            if ($deleteCommands) {
                foreach ($pdo->query('SELECT id FROM bots')->fetchAll(PDO::FETCH_COLUMN) as $botId) {
                    Outbox::add($pdo, 'commands.changed', ['botId' => (int) $botId]);
                }
            }
            $pdo->prepare('DELETE FROM plugin_settings WHERE plugin_id = ?')->execute([$pluginId]);
            // Placeholders still without a value, used by no other plugin, go with it.
            $pdo->prepare("DELETE FROM secrets WHERE length(value_enc) = 0
                AND EXISTS (SELECT 1 FROM secret_plugin_shares s WHERE s.owner_id = secrets.owner_id AND s.secret_key = secrets.key AND s.plugin_id = ?)
                AND NOT EXISTS (SELECT 1 FROM secret_plugin_shares s WHERE s.owner_id = secrets.owner_id AND s.secret_key = secrets.key AND s.plugin_id <> ?)")->execute([$pluginId, $pluginId]);
            $pdo->prepare('DELETE FROM secret_plugin_shares WHERE plugin_id = ?')->execute([$pluginId]);
            $pdo->prepare('DELETE FROM plugin_files WHERE plugin_id = ?')->execute([$pluginId]);
            // Variables the plugin created (with their values) go with it.
            $pdo->prepare('DELETE FROM data_variables WHERE plugin_id = ?')->execute([$pluginId]);
            $pdo->prepare('DELETE FROM plugin_field_options WHERE plugin_id = ?')->execute([$pluginId]);
            $this->log($pdo, 'log.server.plugin_uninstalled', ['plugin' => $pluginId, 'version' => $plugin['version'], 'actor' => $actor]);
        });
        self::removeDir($this->dataDir . '/plugins/' . $pluginId);
    }

    /** Options the plugin set for its dynamic "choices" fields: field => [{value, label}]. */
    public function fieldOptions(int $botId, string $pluginId): array
    {
        $this->installed($pluginId);
        $stmt = $this->pdo->prepare('SELECT field, options FROM plugin_field_options WHERE bot_id = ? AND plugin_id = ?');
        $stmt->execute([$botId, $pluginId]);
        $out = [];
        foreach ($stmt->fetchAll() as $r) {
            $out[$r['field']] = json_decode($r['options'], true) ?: [];
        }
        return $out;
    }

    public function settings(int $botId, string $pluginId): array
    {
        $schema = $this->settingsSchema($pluginId);
        $stmt = $this->pdo->prepare('SELECT config FROM plugin_settings WHERE bot_id = ? AND plugin_id = ?');
        $stmt->execute([$botId, $pluginId]);
        $stored = json_decode((string) ($stmt->fetchColumn() ?: '{}'), true);
        return ModuleSettings::read($schema, is_array($stored) ? $stored : []);
    }

    public function saveSettings(int $botId, string $pluginId, array $in): array
    {
        $config = ModuleSettings::normalize($this->settingsSchema($pluginId), $in);
        $json = json_encode((object) $config, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        Connection::write($this->pdo, function (PDO $pdo) use ($botId, $pluginId, $json, $config): void {
            $old = $pdo->prepare('SELECT config FROM plugin_settings WHERE bot_id = ? AND plugin_id = ?');
            $old->execute([$botId, $pluginId]);
            $before = json_decode((string) ($old->fetchColumn() ?: '{}'), true);
            PluginFileStore::prune($pdo, $botId, $pluginId, is_array($before) ? $before : [], $config);
            $pdo->prepare("INSERT INTO plugin_settings (bot_id, plugin_id, config) VALUES (?, ?, ?)
                ON CONFLICT (bot_id, plugin_id) DO UPDATE SET config = excluded.config, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                ->execute([$botId, $pluginId, $json]);
            Outbox::add($pdo, 'module.changed', ['botId' => $botId, 'module' => "plugin:{$pluginId}"]);
        });
        return $config;
    }

    /** The plugin's files of one bot (images of image settings fields and the plugin's own). */
    public function files(int $botId, string $pluginId): PluginFileStore
    {
        $this->installed($pluginId);
        return new PluginFileStore($this->pdo);
    }

    private function settingsSchema(string $pluginId): array
    {
        $m = $this->installed($pluginId)['manifest'];
        return ['fields' => $m['settings']['fields'] ?? []];
    }

    private function installed(string $pluginId): array
    {
        $stmt = $this->pdo->prepare('SELECT i.version, p.manifest FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id AND p.version = i.version WHERE i.plugin_id = ?');
        $stmt->execute([$pluginId]);
        $row = $stmt->fetch() ?: throw ApiError::notFound('error.plugin.unknown');
        return ['version' => $row['version'], 'manifest' => json_decode($row['manifest'], true)];
    }

    private function lang(string $id, string $version): array
    {
        $out = [];
        foreach (['en', 'de'] as $code) {
            $file = $this->pluginDir($id, $version) . "/lang/{$code}.json";
            $texts = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
            $out[$code] = is_array($texts) ? (object) $texts : new \stdClass();
        }
        return $out;
    }

    // ---------- helpers ----------

    private function pluginDir(string $id, string $version): string
    {
        return rtrim($this->dataDir, '/') . "/plugins/{$id}/{$version}";
    }

    private function tempDir(): string
    {
        $dir = rtrim($this->dataDir, '/') . '/plugins/.tmp-' . bin2hex(random_bytes(6));
        if (!@mkdir($dir, 0o755, true)) {
            throw new ApiError(500, 'error.plugin.zip', ['reason' => 'cannot create a temp directory']);
        }
        return $dir;
    }

    public static function removeDir(string $dir): void
    {
        if (!is_dir($dir) || is_link($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
        @rmdir($dir);
    }

    private function log(PDO $pdo, string $key, array $params): void
    {
        $pdo->prepare("INSERT INTO logs (bot_id, level, key, params, source) VALUES (NULL, 'change', ?, ?, 'api')")
            ->execute([$key, json_encode($params, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)]);
    }

    /**
     * HTTPS download with a size limit. Redirects are followed by hand (at
     * most 3, https only) so the token reaches only TOKEN_HOSTS. Errors
     * never carry the URL, the token or the response body.
     */
    private static function fetch(string $url, int $max, array $headers = [], ?string $token = null): string
    {
        for ($hop = 0; $hop <= 3; $hop++) {
            if (!str_starts_with($url, 'https://')) {
                throw new ApiError(422, 'error.plugin.market', ['reason' => 'only https']);
            }
            $send = $headers;
            if ($token !== null && in_array(strtolower((string) parse_url($url, PHP_URL_HOST)), self::TOKEN_HOSTS, true)) {
                $send[] = 'Authorization: Bearer ' . $token;
                $send[] = 'X-GitHub-Api-Version: 2022-11-28';
            }
            $ctx = stream_context_create(['http' => [
                'timeout' => 20, 'follow_location' => 0, 'ignore_errors' => true, 'user_agent' => 'BotHub', 'header' => $send,
            ]]);
            $in = @fopen($url, 'rb', false, $ctx);
            if ($in === false) {
                throw new ApiError(502, 'error.plugin.market', ['reason' => 'download failed']);
            }
            $meta = stream_get_meta_data($in)['wrapper_data'] ?? [];
            $status = 0;
            $location = null;
            foreach (is_array($meta) ? $meta : [] as $line) {
                if (preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $line, $m)) {
                    $status = (int) $m[1];
                    $location = null;
                } elseif (stripos((string) $line, 'location:') === 0) {
                    $location = trim(substr((string) $line, 9));
                }
            }
            if ($status >= 300 && $status < 400 && $location !== null) {
                fclose($in);
                $url = $location;
                continue;
            }
            if ($status !== 200) {
                fclose($in);
                throw new ApiError(502, 'error.plugin.market', ['reason' => 'download failed (HTTP ' . $status . ')']);
            }
            $data = stream_get_contents($in, $max);
            fclose($in);
            if ($data === false || strlen($data) >= $max) {
                throw new ApiError(413, 'error.plugin.zip', ['reason' => 'download too large']);
            }
            return $data;
        }
        throw new ApiError(502, 'error.plugin.market', ['reason' => 'too many redirects']);
    }
}
