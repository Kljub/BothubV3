<?php

declare(strict_types=1);

// Plugin install pipeline, command copies and plugin settings:
// php tests/plugins_test.php. Exit code 0 = all passed.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\InternalRouter;
use BotHub\Internal\PluginStore;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-plugins-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$plugins = new PluginStore($pdo, $tmp);
$bots = new BotStore($pdo, new SecretBox(random_bytes(32)), $plugins);
$router = new InternalRouter($bots, static fn () => throw new \RuntimeException('no jobs'), actor: 'admin', plugins: $plugins);

function call(string $method, string $path, ?array $body = null, array $query = []): array
{
    global $router;
    return $router->handle($method, $path, $body ?? [], null, $query);
}

/** @param array<string, string> $files */
function zipOf(array $files, array $symlinks = []): string
{
    $file = tempnam(sys_get_temp_dir(), 'zip');
    $zip = new ZipArchive();
    $zip->open($file, ZipArchive::OVERWRITE);
    foreach ($files as $name => $data) {
        $zip->addFromString($name, $data);
    }
    foreach ($symlinks as $name) {
        $zip->addFromString($name, '/etc/passwd');
        $zip->setExternalAttributesName($name, ZipArchive::OPSYS_UNIX, (0o120777 << 16));
    }
    $zip->close();
    $bytes = (string) file_get_contents($file);
    unlink($file);
    return $bytes;
}

function graph(string $name, string $extraType = ''): array
{
    $nodes = [['id' => 't', 'type' => 'trigger.slash', 'typeVersion' => 1, 'config' => ['command_name' => $name], 'position' => ['x' => 0, 'y' => 0]]];
    if ($extraType !== '') {
        $nodes[] = ['id' => 'b', 'type' => $extraType, 'typeVersion' => 1, 'config' => (object) [], 'position' => ['x' => 0, 'y' => 100]];
    }
    return ['schemaVersion' => 1, 'nodes' => $nodes, 'edges' => []];
}

/**
 * A plugin folder in the bothub.json format. $change uses the normalized
 * names (permissions, settings, tasks, endpoints) or bothub.json keys.
 */
function pluginFiles(string $version = '1.0.0', array $commands = ['hello'], array $change = []): array
{
    $settings = ['fields' => [['key' => 'greeting', 'type' => 'text', 'max' => 100, 'default' => 'Hi']]];
    if (array_key_exists('settings', $change)) {
        $settings = $change['settings'];
        unset($change['settings']);
    }
    $sdk = ['version' => 1, 'permissions' => $change['permissions'] ?? []];
    $services = array_filter(['tasks' => $change['tasks'] ?? null, 'endpoints' => $change['endpoints'] ?? null, 'secrets' => $change['secrets'] ?? null], static fn ($v) => $v !== null);
    unset($change['permissions'], $change['tasks'], $change['endpoints'], $change['secrets']);
    $manifest = array_merge([
        'schemaVersion' => 1, 'id' => 'plugin_greeter', 'name' => 'Greeter', 'version' => $version,
        'description' => 'Says hello.', 'developer' => ['name' => 'BotHub', 'url' => 'https://github.com/Kljub'], 'license' => 'MIT',
        'sdk' => $sdk, 'main' => 'index.js',
        'commands' => array_map(static fn ($c) => "commands/{$c}.json", $commands),
        'nodes' => ['wave'], 'dashboard' => ['settings' => 'dashboard/settings.json'],
        'lang' => ['en' => 'lang/en.json', 'de' => 'lang/de.json'],
    ], $services === [] ? [] : ['services' => $services], $change);
    $files = [
        'bothub.json' => json_encode($manifest),
        'index.js' => 'export default {};',
        'nodes/wave.json' => json_encode(['category' => 'actions', 'labelKey' => 'plugin.plugin_greeter.wave']),
        'nodes/wave.js' => 'export default async () => ({});',
        'dashboard/settings.json' => json_encode($settings),
        'lang/en.json' => json_encode(['plugin.plugin_greeter.name' => 'Greeter']),
        'lang/de.json' => json_encode(['plugin.plugin_greeter.name' => 'Begrüßer']),
    ];
    foreach ($commands as $c) {
        $files["commands/{$c}.json"] = json_encode(['name' => $c, 'description' => 'Says hello', 'graph' => graph($c, 'plugin.plugin_greeter.wave')]);
    }
    return $files;
}

function install(string $zip): array
{
    return call('POST', '/internal/admin/plugins/install', ['zip' => base64_encode($zip)]);
}

function errKey(array $r): string
{
    return (string) ($r[1]['error'] ?? $r[1]['key'] ?? json_encode($r[1]));
}

// A bot before the install gets copies at install time.
$bot1 = (int) call('POST', '/internal/bots', ['name' => 'One', 'token' => 'x.' . str_repeat('a', 60)])[1]['id'];

// ---------- zip checks ----------
$r = install('not a zip');
check('not a zip refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'error.plugin.zip'));
$r = install(zipOf(['../evil.js' => 'x'] + pluginFiles()));
check('.. path refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'bad path'));
$r = install(zipOf(['/abs.js' => 'x'] + pluginFiles()));
check('absolute path refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'error.plugin.zip'));
$r = install(zipOf(pluginFiles(), ['link.js']));
check('symlink refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'symlink'));
$r = install(zipOf(pluginFiles() + ['A.js' => 'x', 'a.js' => 'y']));
check('duplicate name refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'duplicate'));
$r = install(zipOf(pluginFiles() + ['big.bin' => str_repeat('x', 2 * 1024 * 1024 + 1)]));
check('file > 2 MB refused', $r[0] === 422 && str_contains(json_encode($r[1]), '2 MB'));
$many = pluginFiles();
for ($i = 0; $i < 200; $i++) {
    $many["f/{$i}.txt"] = 'x';
}
$r = install(zipOf($many));
check('more than 200 files refused', $r[0] === 422 && str_contains(json_encode($r[1]), '200 files'));
check('no temp dirs left', glob($tmp . '/plugins/.tmp-*') === []);

// ---------- manifest checks ----------
$r = install(zipOf(pluginFiles(change: ['id' => 'Bad_Id'])));
check('bad id refused', $r[0] === 422 && str_contains(json_encode($r[1]), '"id"'));
$req = pluginFiles('0.0.1');
$req['dashboard/settings.json'] = json_encode(['fields' => [['key' => 'channel', 'type' => 'channel', 'required' => true]]]);
$r = install(zipOf($req));
check('required setting field accepted at install', $r[0] === 200 || $r[0] === 201);
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
$r = install(zipOf(pluginFiles(change: ['id' => 'greeter'])));
check('id without plugin_ prefix refused', $r[0] === 422 && str_contains(json_encode($r[1]), '"id"'));
$r = install(zipOf(pluginFiles(change: ['settings' => ['fields' => [['key' => 'token', 'type' => 'secret']]]])));
check('secret setting type refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'settings'));
$r = install(zipOf(pluginFiles(change: ['settings' => ['fields' => [['key' => 'l', 'type' => 'list', 'item' => [['key' => 'n', 'type' => 'list', 'item' => [['key' => 'x', 'type' => 'bool']]]]]]]])));
check('nested list refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'settings'));
$r = install(zipOf(pluginFiles(change: ['settings' => ['fields' => [['key' => 'logo', 'type' => 'image']]]])));
check('image field needs storage.files', $r[0] === 422 && str_contains(json_encode($r[1]), 'storage.files'));
$bad = pluginFiles();
$bad['lang/en.json'] = json_encode(['other.key' => 'x']);
$r = install(zipOf($bad));
check('lang key without prefix refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'error.plugin.lang'));
$bad = pluginFiles();
$bad['commands/hello.json'] = json_encode(['name' => 'hello', 'graph' => graph('hello', 'plugin.other.block')]);
$r = install(zipOf($bad));
check('foreign plugin block refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'error.plugin.command'));
$bad['commands/hello.json'] = json_encode(['name' => 'hello', 'graph' => ['schemaVersion' => 1, 'nodes' => [['id' => 'a', 'type' => 'plugin.plugin_greeter.wave']], 'edges' => []]]);
$r = install(zipOf($bad));
check('command without slash trigger refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'trigger.slash'));

$r = install(zipOf(pluginFiles(change: ['secrets' => ['WEATHER_KEY']])));
check('secrets need secrets.read', $r[0] === 422 && str_contains(json_encode($r[1]), 'secrets.read'));
$r = install(zipOf(pluginFiles(change: ['secrets' => ['weather key'], 'permissions' => ['secrets.read']])));
check('bad secret name refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'secrets'));
$r = install(zipOf(pluginFiles(change: ['endpoints' => ['WEATHER_API'], 'permissions' => ['secrets.use']])));
check('services.endpoints refused (gone)', $r[0] === 422 && str_contains(json_encode($r[1]), 'ctx.http.secret'));
$r = install(zipOf(pluginFiles('0.7.5', change: ['secrets' => ['WEATHER_URL'], 'permissions' => ['secrets.use']])));
check('secrets with secrets.use accepted', $r[0] === 201);
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
$r = install(zipOf(pluginFiles(change: ['events' => ['noSuchEvent'], 'permissions' => ['discord.events']])));
check('unknown event refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'events'));
$r = install(zipOf(pluginFiles(change: ['tasks' => [['name' => 'tick', 'every' => '30s']], 'permissions' => ['scheduler']])));
check('task under 1 minute refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'tasks'));
$r = install(zipOf(pluginFiles(change: ['tasks' => [['name' => 'tick', 'every' => '5m', 'cron' => '* * * * *']], 'permissions' => ['scheduler']])));
check('task with every and cron refused', $r[0] === 422);
$r = install(zipOf(pluginFiles('0.9.0', change: [
    'secrets' => ['WEATHER_KEY'], 'events' => ['messageCreate', 'guildMemberAdd'],
    'tasks' => [['name' => 'tick', 'every' => '5m'], ['name' => 'daily', 'cron' => '0 8 * * *']],
    'permissions' => ['secrets.read', 'discord.events', 'scheduler', 'discord.voice'],
]) + ['sounds/ding.ogg' => 'OggS']));
check('secrets, events, tasks and sounds accepted', $r[0] === 201);
$item = call('GET', '/internal/admin/plugins')[1]['items'][0];
check('secret share state: empty placeholder, shared', $item['secretShares']->WEATHER_KEY === ['exists' => true, 'set' => false, 'shared' => true]);
check('missing secret cannot be shared', call('PUT', '/internal/admin/plugins/plugin_greeter/secrets', ['shared' => ['WEATHER_KEY', 'OTHER_KEY']])[0] === 422);
$pdo->exec("UPDATE secrets SET value_enc = x'00' WHERE key = 'WEATHER_KEY'");
$pdo->exec("INSERT INTO secrets (owner_id, key, value_enc) VALUES (1, 'OTHER_KEY', x'00')");
$r = call('PUT', '/internal/admin/plugins/plugin_greeter/secrets', ['shared' => ['OTHER_KEY']]);
check('undeclared secret refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'error.plugin.secret'));
$r = call('PUT', '/internal/admin/plugins/plugin_greeter/secrets', ['shared' => ['WEATHER_KEY']]);
check('secret shared', $r[0] === 200 && $r[1]['secretShares']->WEATHER_KEY === ['exists' => true, 'set' => true, 'shared' => true]);
$pdo->exec("DELETE FROM secrets WHERE key = 'WEATHER_KEY'");
$r = call('PUT', '/internal/admin/plugins/plugin_greeter/secrets', ['shared' => ['WEATHER_KEY']]);
check('switching on a missing secret creates its placeholder', $r[0] === 200 && $r[1]['secretShares']->WEATHER_KEY === ['exists' => true, 'set' => false, 'shared' => true]);
check('secret share logged', str_contains((string) $pdo->query("SELECT params FROM logs WHERE key = 'log.server.plugin_secrets_shared'")->fetchColumn(), 'WEATHER_KEY'));
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
check('uninstall deletes secret shares', (int) $pdo->query('SELECT COUNT(*) FROM secret_plugin_shares')->fetchColumn() === 0);

$r = install(zipOf(array_diff_key(pluginFiles(), ['bothub.json' => 1])));
check('missing bothub.json refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'bothub.json'));
$r = install(zipOf(pluginFiles(change: ['developer' => ['name' => 'X', 'url' => 'http://insecure.test']])));
check('developer url must be https', $r[0] === 422 && str_contains(json_encode($r[1]), 'developer'));
$bad = pluginFiles();
$bad['nodes/wave.json'] = json_encode(['labelKey' => 'x']);
$r = install(zipOf($bad));
check('node without category refused', $r[0] === 422 && str_contains(json_encode($r[1], JSON_UNESCAPED_SLASHES), 'nodes/wave.json'));
$r = install(zipOf(pluginFiles() + ['sounds/ding.ogg' => 'OggS']));
check('sounds need discord.voice', $r[0] === 422 && str_contains(json_encode($r[1]), 'discord.voice'));
$withSchema = pluginFiles('0.8.0', change: ['$schema' => '../../schema/plugin-manifest.schema.json']);
$withSchema['nodes/wave.json'] = json_encode(['$schema' => '../schema/node.json', 'category' => 'actions', 'labelKey' => 'plugin.plugin_greeter.wave']);
$withSchema['dashboard/settings.json'] = json_encode(['$schema' => '../schema/settings.json', 'fields' => []]);
$r = install(zipOf($withSchema));
check('$schema accepted and dropped', $r[0] === 201 && !isset($r[1]['manifest']['$schema']) && !isset($r[1]['manifest']['blocks'][0]['definition']['$schema']) && !isset($r[1]['manifest']['settings']['$schema']));
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
$r = install(zipOf(pluginFiles(change: ['unknownKey' => 1])));
check('unknown bothub.json key refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'unknownKey'));
$r = install(zipOf(pluginFiles(change: ['permissions' => ['secrets.use'], 'services' => ['secrets' => ['PLEX_TOKEN'], 'connect' => ['OTHER_TOKEN' => 'plex']]])));
check('connect only for declared secrets', $r[0] === 422 && str_contains(json_encode($r[1]), 'services.connect'));
$r = install(zipOf(pluginFiles(change: ['permissions' => ['secrets.use'], 'services' => ['secrets' => ['PLEX_TOKEN'], 'connect' => ['PLEX_TOKEN' => 'github']]])));
check('connect only known providers', $r[0] === 422);
// Permission split: old coarse keys are read as the finer ones; each event needs its own permission.
$r = install(zipOf(pluginFiles('0.6.0', change: ['permissions' => ['discord.members.manage', 'storage']])));
check('old permission key expanded', $r[0] === 201 && $r[1]['manifest']['permissions'] === ['discord.members.nicknames', 'discord.roles.assign', 'discord.members.timeout', 'discord.members.kick', 'discord.members.ban', 'storage']);
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
$r = install(zipOf(pluginFiles(change: ['events' => ['guildMemberAdd'], 'permissions' => ['discord.events.messages']])));
check('event needs its own discord.events.* permission', $r[0] === 422 && str_contains(json_encode($r[1]), 'discord.events.members'));
$r = install(zipOf(pluginFiles(change: ['icon' => '<b>'])));
check('icon with markup refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'icon'));
$r = install(zipOf(pluginFiles(change: ['category' => 'casino'])));
check('unknown category refused', $r[0] === 422 && str_contains(json_encode($r[1]), 'category'));
$r = install(zipOf(pluginFiles('0.7.1', change: ['icon' => '🌤️', 'category' => 'fun'])));
check('icon and category kept in the manifest', $r[0] === 201 && $r[1]['manifest']['icon'] === '🌤️' && $r[1]['manifest']['category'] === 'fun');
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);

// ---------- install ----------
$changesBefore = (int) $pdo->query("SELECT COUNT(*) FROM outbox WHERE type = 'plugins.changed'")->fetchColumn();
$zip = zipOf(array_combine(array_map(static fn ($k) => "plugin_greeter/{$k}", array_keys(pluginFiles())), pluginFiles()));
$r = install($zip);
check('install 201 (top folder removed)', $r[0] === 201 && $r[1]['id'] === 'plugin_greeter' && $r[1]['version'] === '1.0.0');
check('sha256 stored', ($r[1]['sha256'] ?? '') === hash('sha256', $zip));
check('one copy created', ($r[1]['commands']['created'] ?? null) === 1);
check('files in place', is_file($tmp . '/plugins/plugin_greeter/1.0.0/bothub.json'));
$stored = json_decode((string) $pdo->query("SELECT manifest FROM plugins WHERE id = 'plugin_greeter' AND version = '1.0.0'")->fetchColumn(), true);
check('normalized manifest stored', $stored['author'] === 'BotHub' && $stored['sdk'] === 1 && $stored['permissions'] === []
    && $stored['blocks'][0]['name'] === 'wave' && $stored['blocks'][0]['definition']['category'] === 'actions'
    && $stored['settings']['fields'][0]['key'] === 'greeting' && $stored['license'] === 'MIT' && $stored['developer']['url'] === 'https://github.com/Kljub');
$cmd = $pdo->query("SELECT * FROM commands WHERE plugin_id = 'plugin_greeter'")->fetch();
check('copy disabled, hidden, with provenance', $cmd && $cmd['enabled'] === 0 && $cmd['hidden'] === 1 && $cmd['plugin_version'] === '1.0.0' && $cmd['preset_name'] === 'hello' && (int) $cmd['bot_id'] === $bot1);
$group = $pdo->query('SELECT name FROM command_groups WHERE id = ' . (int) $cmd['group_id'])->fetchColumn();
check('copy in plugin group', $group === 'Greeter');
check('plugin group is a system group', (int) $pdo->query('SELECT system FROM command_groups WHERE id = ' . (int) $cmd['group_id'])->fetchColumn() === 1);
check('version row written', (int) $pdo->query('SELECT COUNT(*) FROM command_versions WHERE command_id = ' . (int) $cmd['id'])->fetchColumn() === 1);
check('plugins.changed in outbox', (int) $pdo->query("SELECT COUNT(*) FROM outbox WHERE type = 'plugins.changed'")->fetchColumn() === $changesBefore + 1);
check('install logged with actor', str_contains((string) $pdo->query("SELECT params FROM logs WHERE key = 'log.server.plugin_installed'")->fetchColumn(), '"actor":"admin"'));

$r = install($zip);
check('same zip again: no new copies', $r[0] === 201 && $r[1]['commands']['created'] === 0);
$other = pluginFiles();
$other['index.js'] = 'export default {x: 1};';
$r = install(zipOf($other));
check('other zip same version refused', $r[0] === 409);

// New bot gets copies at creation.
$bot2 = (int) call('POST', '/internal/bots', ['name' => 'Two', 'token' => 'y.' . str_repeat('b', 60)])[1]['id'];
check('new bot gets copies', (int) $pdo->query("SELECT COUNT(*) FROM commands WHERE plugin_id = 'plugin_greeter' AND bot_id = {$bot2}")->fetchColumn() === 1);

// Update: new command added, changed one reported, user edits kept.
$pdo->exec("UPDATE commands SET enabled = 1 WHERE plugin_id = 'plugin_greeter' AND bot_id = {$bot1}");
$v2 = pluginFiles('1.1.0', ['hello', 'bye']);
$v2['commands/hello.json'] = json_encode(['name' => 'hello', 'description' => 'Changed', 'graph' => graph('hello')]);
$r = install(zipOf($v2));
check('update 201', $r[0] === 201 && $r[1]['version'] === '1.1.0');
check('update adds only new', $r[1]['commands']['created'] === 2 && $r[1]['commands']['changed'] === ['hello']);
check('user state kept', (int) $pdo->query("SELECT enabled FROM commands WHERE plugin_id = 'plugin_greeter' AND preset_name = 'hello' AND bot_id = {$bot1}")->fetchColumn() === 1);
$v3 = pluginFiles('1.2.0', ['bye']);
install(zipOf($v3));
check('copy of a dropped preset switched off', (int) $pdo->query("SELECT enabled FROM commands WHERE plugin_id = 'plugin_greeter' AND preset_name = 'hello' AND bot_id = {$bot1}")->fetchColumn() === 0);
$pdo->exec("UPDATE commands SET enabled = 1 WHERE plugin_id = 'plugin_greeter' AND preset_name = 'hello' AND bot_id = {$bot1}");
install(zipOf(pluginFiles('1.3.0', ['hello', 'bye'])));

// ---------- per bot ----------
$r = call('GET', "/internal/bots/{$bot1}/plugins");
$item = $r[1]['items'][0] ?? [];
check('bot list', $r[0] === 200 && $item['id'] === 'plugin_greeter' && $item['enabled'] === true && $item['version'] === '1.3.0');
check('bot list has lang', ($item['lang']['de']->{'plugin.plugin_greeter.name'} ?? null) === 'Begrüßer');
$r = call('PATCH', "/internal/bots/{$bot1}/plugins/plugin_greeter", ['enabled' => false]);
check('switch off for bot', $r[0] === 200 && $r[1]['enabled'] === false);
check('other bot still on', call('GET', "/internal/bots/{$bot2}/plugins")[1]['items'][0]['enabled'] === true);

$r = call('GET', "/internal/bots/{$bot1}/plugins/plugin_greeter/config");
check('config defaults', $r[0] === 200 && ($r[1]['config']->greeting ?? null) === 'Hi');
$r = call('PUT', "/internal/bots/{$bot1}/plugins/plugin_greeter/config", ['config' => ['greeting' => 'Hello there']]);
check('config saved', $r[0] === 200 && $r[1]['config']->greeting === 'Hello there');
$r = call('PUT', "/internal/bots/{$bot1}/plugins/plugin_greeter/config", ['config' => ['greeting' => str_repeat('x', 101)]]);
check('config validated', $r[0] === 422);
check('config read back', call('GET', "/internal/bots/{$bot1}/plugins/plugin_greeter/config")[1]['config']->greeting === 'Hello there');
check('unknown plugin 404', call('GET', "/internal/bots/{$bot1}/plugins/nope/config")[0] === 404);

// Plugin files: dashboard uploads (base64), type by first bytes, same picture = same name.
$png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
$filesPath = "/internal/bots/{$bot1}/plugins/plugin_greeter/files";
$r = call('POST', $filesPath, ['data' => base64_encode($png)]);
$fileName = $r[1]['name'] ?? '';
check('upload png', $r[0] === 201 && preg_match('/^[0-9a-f]{16}\.png$/', $fileName) === 1 && $r[1]['mime'] === 'image/png');
check('same picture, same name', call('POST', $filesPath, ['data' => base64_encode($png)])[1]['name'] === $fileName);
check('not an image refused', call('POST', $filesPath, ['data' => base64_encode('<svg></svg>')])[0] === 422);
check('too big refused', call('POST', $filesPath, ['data' => base64_encode("\x89PNG\r\n\x1a\n" . str_repeat('x', 2 * 1024 * 1024))])[0] === 413);
$r = call('GET', "{$filesPath}/{$fileName}");
check('file read back', $r[0] === 200 && base64_decode($r[1]['data']) === $png);
check('file list', count(call('GET', $filesPath)[1]['items']) === 1);
check('unknown file 404', call('GET', "{$filesPath}/0000000000000000.png")[0] === 404);
check('files of unknown plugin 404', call('GET', "/internal/bots/{$bot1}/plugins/nope/files")[0] === 404);
// An upload no setting names is dropped on the next save; a plugin's own file stays.
$pdo->exec("INSERT INTO plugin_files (bot_id, plugin_id, name, mime, size, data) VALUES ({$bot1}, 'plugin_greeter', 'aaaaaaaaaaaaaaaa.png', 'image/png', 1, x'00')");
call('PUT', "/internal/bots/{$bot1}/plugins/plugin_greeter/config", ['config' => ['greeting' => 'Hello there']]);
check('unsaved upload pruned, plugin file kept', array_column(call('GET', $filesPath)[1]['items'], 'name') === ['aaaaaaaaaaaaaaaa.png']);
check('image setting value', \BotHub\Internal\ModuleSettings::normalize(['fields' => [['key' => 'logo', 'type' => 'image']]], ['logo' => $fileName])['logo'] === $fileName);
try {
    \BotHub\Internal\ModuleSettings::normalize(['fields' => [['key' => 'logo', 'type' => 'image']]], ['logo' => '../x.png']);
    check('image setting refuses other values', false);
} catch (\BotHub\Internal\ApiError) {
    check('image setting refuses other values', true);
}

$pdo->exec("DELETE FROM commands WHERE plugin_id = 'plugin_greeter' AND preset_name = 'bye' AND bot_id = {$bot2}");
$r = call('POST', "/internal/bots/{$bot2}/plugins/plugin_greeter/commands");
check('sync recreates missing copy', $r[0] === 200 && $r[1]['created'] === 1);

$r = call('GET', '/internal/admin/plugins');
check('admin list', $r[0] === 200 && count($r[1]['items']) === 1 && $r[1]['items'][0]['sha256'] !== '');

// ---------- switch for every bot, SDK policies block ----------
$r = call('PATCH', '/internal/admin/plugins/plugin_greeter', ['enabled' => false]);
check('switch off for every bot', $r[0] === 200 && $r[1]['enabled'] === false && (int) $pdo->query("SELECT enabled FROM plugin_installs WHERE plugin_id = 'plugin_greeter'")->fetchColumn() === 0);
check('switch needs a bool', call('PATCH', '/internal/admin/plugins/plugin_greeter', ['enabled' => 'yes'])[0] === 422);
call('PATCH', '/internal/admin/plugins/plugin_greeter', ['enabled' => true]);
$pdo->exec("UPDATE plugins SET manifest = json_set(manifest, '$.permissions', json('[\"storage\",\"http.outbound\"]')) WHERE id = 'plugin_greeter'");
$listed = array_values(array_filter(call('GET', '/internal/admin/plugins')[1]['items'], fn ($p) => $p['id'] === 'plugin_greeter'))[0];
check('blockedBy lists SDKs that are off (http.outbound is high risk)', $listed['blockedBy'] === ['http.outbound']);
$pdo->exec("INSERT INTO sdk_policies (permission, enabled) VALUES ('http.outbound', 1)");
$listed = array_values(array_filter(call('GET', '/internal/admin/plugins')[1]['items'], fn ($p) => $p['id'] === 'plugin_greeter'))[0];
check('blockedBy empty once the SDK is on', $listed['blockedBy'] === []);
$pdo->exec("DELETE FROM sdk_policies WHERE permission = 'http.outbound'");

// ---------- uninstall ----------
$r = call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
check('uninstall 204', $r[0] === 204);
check('copies deleted', (int) $pdo->query("SELECT COUNT(*) FROM commands WHERE plugin_id = 'plugin_greeter'")->fetchColumn() === 0);
check('empty plugin group removed', (int) $pdo->query("SELECT COUNT(*) FROM command_groups WHERE name = 'Greeter'")->fetchColumn() === 0);
check('settings deleted', (int) $pdo->query("SELECT COUNT(*) FROM plugin_settings")->fetchColumn() === 0);
check('plugin files deleted', (int) $pdo->query("SELECT COUNT(*) FROM plugin_files")->fetchColumn() === 0);
check('files removed', !is_dir($tmp . '/plugins/plugin_greeter'));
check('uninstall unknown 404', call('DELETE', '/internal/admin/plugins/plugin_greeter')[0] === 404);
// Declared secrets become empty placeholders ([NULL]) shared with the plugin; existing ones stay untouched.
$box = new SecretBox(random_bytes(32));
$secretStore = new \BotHub\Internal\SecretStore($pdo, $box);
$secretStore->saveSecret(1, 'GREETER_URL', ['value' => 'https://admin.example'], 'admin');
$r = install(zipOf(pluginFiles('2.0.0', change: ['permissions' => ['secrets.use'], 'secrets' => ['GREETER_KEY', 'GREETER_URL']])));
check('install with secrets', $r[0] === 201);
$rows = $pdo->query("SELECT key, length(value_enc) AS len, description FROM secrets ORDER BY key")->fetchAll(PDO::FETCH_ASSOC);
$byKey = array_column($rows, null, 'key');
check('placeholder created empty', isset($byKey['GREETER_KEY']) && (int) $byKey['GREETER_KEY']['len'] === 0 && str_contains($byKey['GREETER_KEY']['description'], 'Greeter'));
check('placeholder shared with the plugin', (bool) $pdo->query("SELECT 1 FROM secret_plugin_shares WHERE secret_key = 'GREETER_KEY' AND plugin_id = 'plugin_greeter'")->fetchColumn());
check('existing secret not shared automatically', !$pdo->query("SELECT 1 FROM secret_plugin_shares WHERE secret_key = 'GREETER_URL'")->fetchColumn());
check('placeholder has no value', $secretStore->value(1, 'GREETER_KEY') === null);
$listed = array_column($secretStore->secrets(1), 'set', 'key');
check('secrets list marks [NULL]', $listed['GREETER_KEY'] === false && $listed['GREETER_URL'] === true);
$shares = array_values(array_filter(call('GET', '/internal/admin/plugins')[1]['items'], fn ($p) => $p['id'] === 'plugin_greeter'))[0]['secretShares'];
check('store shows set and shared', $shares->GREETER_KEY['set'] === false && $shares->GREETER_KEY['shared'] === true);
call('DELETE', '/internal/admin/plugins/plugin_greeter', null, ['deleteCommands' => '1']);
$left = $pdo->query("SELECT key FROM secrets")->fetchAll(PDO::FETCH_COLUMN);
check('empty placeholder removed with the plugin, admin secret kept', !in_array('GREETER_KEY', $left, true) && in_array('GREETER_URL', $left, true));


// Market: hash must match the index.
$index = json_encode(['plugins' => [['id' => 'plugin_greeter', 'version' => '1.0.0', 'sha256' => str_repeat('0', 64), 'url' => 'https://example.test/g.zip']]]);
$fetch = static fn (string $url) => str_ends_with($url, '.zip') ? $zip : $index;
try {
    $plugins->installMarket('plugin_greeter', '1.0.0', 'admin', $fetch);
    check('market hash mismatch refused', false);
} catch (\BotHub\Internal\ApiError $e) {
    check('market hash mismatch refused', $e->key === 'error.plugin.hash');
}
$index = json_encode(['plugins' => [['id' => 'plugin_greeter', 'version' => '1.0.0', 'sha256' => hash('sha256', $zip), 'url' => 'https://example.test/g.zip']]]);
$fetch = static fn (string $url) => str_ends_with($url, '.zip') ? $zip : $index;
$r = $plugins->installMarket('plugin_greeter', '1.0.0', 'admin', $fetch);
check('market install', $r['version'] === '1.0.0');
try {
    $plugins->installMarket('plugin_greeter', '9.9.9', 'admin', $fetch);
    check('market unknown version refused', false);
} catch (\BotHub\Internal\ApiError $e) {
    check('market unknown version refused', $e->key === 'error.plugin.market');
}

// Private market: release assets go through the API, the token only to GitHub API hosts.
$plugins->uninstall('plugin_greeter', true, 'admin');
$private = new PluginStore($pdo, $tmp, static fn (): ?string => 'ghp_test');
$release = 'https://github.com/Kljub/BothubMarketPlace/releases/download/plugin_greeter-1.0.0/plugin_greeter-1.0.0.zip';
$index = json_encode(['plugins' => [['id' => 'plugin_greeter', 'version' => '1.0.0', 'sha256' => hash('sha256', $zip), 'url' => $release]]]);
$calls = [];
$fetch = static function (string $url, int $max, array $headers = [], ?string $token = null) use (&$calls, $zip, $index): string {
    $calls[] = [$url, $headers, $token];
    return match (true) {
        str_contains($url, '/releases/tags/') => json_encode(['assets' => [
            ['name' => 'other.zip', 'url' => 'https://api.github.com/repos/Kljub/BothubMarketPlace/releases/assets/1'],
            ['name' => 'plugin_greeter-1.0.0.zip', 'url' => 'https://api.github.com/repos/Kljub/BothubMarketPlace/releases/assets/2'],
        ]]),
        str_ends_with($url, '/assets/2') => $zip,
        default => $index,
    };
};
$r = $private->installMarket('plugin_greeter', '1.0.0', 'admin', $fetch);
check('private market install', $r['version'] === '1.0.0' && count($calls) === 3);
check('private market uses the release API', str_ends_with($calls[1][0], '/releases/tags/plugin_greeter-1.0.0') && in_array('Accept: application/octet-stream', $calls[2][1], true));
check('private market never fetches the browser URL', !in_array($release, array_column($calls, 0), true));
check('private market passes the token', $calls[0][2] === 'ghp_test' && $calls[2][2] === 'ghp_test');
$calls = [];
$fetch = static function (string $url, int $max, array $headers = [], ?string $token = null) use (&$calls, $index): string {
    $calls[] = $url;
    return str_contains($url, '/releases/tags/') ? json_encode(['assets' => [['name' => 'x.zip', 'url' => 'https://api.github.com/x']]]) : $index;
};
$plugins->uninstall('plugin_greeter', true, 'admin');
try {
    $private->installMarket('plugin_greeter', '1.0.0', 'admin', $fetch);
    check('private market missing asset refused', false);
} catch (\BotHub\Internal\ApiError $e) {
    check('private market missing asset refused', $e->key === 'error.plugin.market' && !str_contains(json_encode($e->params), 'ghp_test'));
}

try {
    (new PluginStore($pdo, $tmp, static fn (): ?string => "ghp_x\r\nX-Evil: 1"))->installMarket('plugin_greeter', '1.0.0', 'admin', $fetch);
    check('market token with CR/LF refused', false);
} catch (\BotHub\Internal\ApiError $e) {
    check('market token with CR/LF refused', $e->params === ['reason' => 'market token invalid']);
}

// ---------- market list: repo folders + index, Template left out ----------
$calls = [];
$fetch = static function (string $url, int $max, array $headers = [], ?string $token = null) use (&$calls): string {
    $calls[] = [$url, $token];
    if (str_ends_with($url, '/index.json')) {
        return json_encode(['plugins' => [
            ['id' => 'plugin_greeter', 'version' => '1.0.0', 'name' => 'Greeter'],
            ['id' => 'plugin_greeter', 'version' => '1.2.0', 'name' => 'Greeter', 'size' => 2048, 'layers' => ['commands' => 2, 'nodes' => 1, 'bogus' => 9]],
        ]]);
    }
    if (str_ends_with($url, '/contents/')) {
        return json_encode([
            ['name' => 'Template', 'type' => 'dir'], ['name' => 'plugin_greeter', 'type' => 'dir'],
            ['name' => 'plugin_draft', 'type' => 'dir'], ['name' => 'index.json', 'type' => 'file'], ['name' => 'stuff', 'type' => 'dir'],
        ]);
    }
    if (str_contains($url, '/plugin_draft/bothub.json')) {
        return json_encode(['id' => 'plugin_draft', 'name' => '<b>Draft</b>', 'version' => '0.1.0', 'icon' => '"><x', 'category' => 'nope', 'sdk' => ['permissions' => ['storage']]]);
    }
    if (str_contains($url, '/plugin_greeter/bothub.json')) {
        return json_encode(['id' => 'plugin_greeter', 'name' => 'Greeter', 'version' => '1.2.0', 'developer' => ['name' => 'BotHub'], 'icon' => '👋', 'category' => 'social', 'services' => ['secrets' => ['GREET_KEY']]]);
    }
    throw new \BotHub\Internal\ApiError(502, 'error.plugin.market', ['reason' => 'download failed (HTTP 404)']);
};
$m = $private->market(true, $fetch);
$ids = array_column($m['items'], 'id');
check('market lists repo plugins, no Template', $ids === ['plugin_draft', 'plugin_greeter']);
$installedGreeter = $pdo->query("SELECT version FROM plugin_installs WHERE plugin_id = 'plugin_greeter'")->fetchColumn() ?: null;
check('market: newest published version, installed version', $m['items'][1]['published'] === '1.2.0' && $m['items'][1]['installed'] === $installedGreeter);
check('market: unpublished folder has no version to install', $m['items'][0]['published'] === null && $m['items'][0]['installed'] === null);
check('market: icon, category, secrets from bothub.json', $m['items'][1]['icon'] === '👋' && $m['items'][1]['category'] === 'social' && $m['items'][1]['secrets'] === ['GREET_KEY']);
check('market: bad icon dropped, unknown category = utility', $m['items'][0]['icon'] === '' && $m['items'][0]['category'] === 'utility');
check('market: release layers and size, unknown layer keys dropped', $m['items'][1]['size'] === 2048
    && $m['items'][1]['layers'] === ['commands' => 2, 'events' => 0, 'services' => 0, 'nodes' => 1, 'dashboard' => 0]);
check('market: no release = no layers', $m['items'][0]['layers'] === null && $m['items'][0]['size'] === 0);
check('market: token sent to GitHub', count(array_filter($calls, fn ($c) => $c[1] === 'ghp_test')) === count($calls));
$calls = [];
$private->market(false, $fetch);
check('market list cached', $calls === []);
$down = static function (): string {
    throw new \BotHub\Internal\ApiError(502, 'error.plugin.market', ['reason' => 'download failed']);
};
$cachedOnly = $private->market(false, $down, true);
check('cached only: last list without a download', array_column($cachedOnly['items'], 'id') === ['plugin_draft', 'plugin_greeter'] && is_bool($cachedOnly['fresh']));
$stale = $private->market(true, $down);
check('market down: last list, marked stale', ($stale['stale'] ?? false) === true && array_column($stale['items'], 'id') === ['plugin_draft', 'plugin_greeter']);
@unlink($tmp . '/plugins/.market-cache.json');
try {
    $private->market(true, $down);
    check('market down without cache: error', false);
} catch (\BotHub\Internal\ApiError $e) {
    check('market down without cache: error', $e->key === 'error.plugin.market');
}

// ---------- inbound webhooks: HMAC token per bot, plugin and name ----------
$hooks = new PluginStore($pdo, $tmp, null, new \BotHub\BotCore\SecretBox(random_bytes(32)));
$token = $hooks->hookToken(1, 'plugin_greeter', 'media');
check('webhook token: 40 hex, stable, bound to bot/plugin/name', preg_match('/^[a-f0-9]{40}$/', $token) === 1 && $token === $hooks->hookToken(1, 'plugin_greeter', 'media')
    && $token !== $hooks->hookToken(2, 'plugin_greeter', 'media') && $token !== $hooks->hookToken(1, 'plugin_greeter', 'other'));
foreach ([['plugin_greeter', 'media', str_repeat('0', 40)], ['plugin_greeter', 'media', $token]] as [$pid, $name, $tok]) {
    try {
        $hooks->receiveWebhook(1, $pid, $name, $tok, '{}', null);
        check("webhook refused ({$tok})", false);
    } catch (\BotHub\Internal\ApiError $e) {
        // Wrong token, and the right token for a plugin that does not declare the webhook: both 404.
        check('webhook refused: ' . ($tok === $token ? 'not declared' : 'bad token'), $e->status === 404);
    }
}

PluginStore::removeDir($tmp);
echo $failed === 0 ? "all passed\n" : "{$failed} failed\n";
exit($failed === 0 ? 0 : 1);
