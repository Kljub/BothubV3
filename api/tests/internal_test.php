<?php

declare(strict_types=1);

// Internal endpoints (/internal/*) without HTTP: php tests/internal_test.php
// Exit code 0 = all passed.

require __DIR__ . '/../src/autoload.php';

use BotHub\BotCore\SecretBox;
use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\CommandStore;
use BotHub\Internal\InternalRouter;
use BotHub\Internal\TemplateStore;
use BotHub\Internal\DataStore;
use BotHub\Internal\BotBackup;
use BotHub\Internal\SdkPolicyStore;
use BotHub\Internal\TimedStore;
use BotHub\Internal\WebhookStore;
use BotHub\Internal\ApiError;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-internal-' . bin2hex(random_bytes(4));
mkdir($tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$botStore = new BotStore($pdo, new SecretBox(random_bytes(32)));
$router = new InternalRouter($botStore, static fn () => throw new \RedisException('no redis in test'), new CommandStore($pdo), new TimedStore($pdo), new WebhookStore($pdo), new TemplateStore($pdo), new DataStore($pdo), new SdkPolicyStore($pdo, __DIR__ . '/../../shared/sdk-permissions.json'),
    backups: new BotBackup($pdo, $botStore, __DIR__ . '/../../shared'), logs: new \BotHub\Internal\LogStore($pdo));

/** Sends like index.php: body as arrays and as objects. */
function call(string $method, string $path, ?string $json = null, array $query = []): array
{
    global $router;
    [$status, $out] = $router->handle($method, $path, $json === null ? [] : json_decode($json, true), $json === null ? null : json_decode($json, false), $query);
    return [$status, $out === null ? null : json_decode(json_encode($out), true), $out === null ? '' : json_encode($out)];
}
$outbox = fn (string $type) => (int) $pdo->query("SELECT COUNT(*) FROM outbox WHERE type = '{$type}'")->fetchColumn();

$token = str_repeat('a', 24) . '.' . str_repeat('b', 6) . '.' . str_repeat('c', 38);
[$s, $bot] = call('POST', '/internal/bots', json_encode(['name' => 'Bot', 'token' => $token]));
check('bot created', $s === 201 && $bot['tokenSet'] === true && !isset($bot['token']));
$b = "/internal/bots/{$bot['id']}";

// logs: the bot's rows (oldest first), level filter, clear; the instance log separately
$pdo->exec("INSERT INTO logs (bot_id, level, code, key, params, source) VALUES ({$bot['id']}, 'update', NULL, 'log.update.bot_started', '{\"name\":\"Bot\"}', 'bot'), ({$bot['id']}, 'error', 'ERR-1005', '', '{\"command\":\"launchtoday\",\"reason\":\"error.run.block_failed: AniList: HTTP 500\"}', 'bot'), (NULL, 'change', NULL, 'log.server.plugin_enabled', '{}', 'api')");
[$s, $logs] = call('GET', "{$b}/logs", null, ['limit' => '500']);
check('bot log, oldest first', $s === 200 && array_column($logs['items'], 'level') === ['update', 'error'] && $logs['items'][1]['params']['reason'] === 'error.run.block_failed: AniList: HTTP 500');
check('log level filter', array_column(call('GET', "{$b}/logs", null, ['level' => 'error'])[1]['items'], 'code') === ['ERR-1005']);
check('instance log has only rows without bot', array_column(call('GET', '/internal/admin/logs')[1]['items'], 'key') === ['log.server.plugin_enabled']);
check('clear bot log', call('DELETE', "{$b}/logs")[0] === 204 && call('GET', "{$b}/logs")[1]['items'] === []);

[$s, $list] = call('GET', "{$b}/commands");
$purge = array_values(array_filter($list['items'], fn ($c) => $c['name'] === 'purge'))[0] ?? null;
check('presets listed without graph', $s === 200 && count($list['items']) > 50 && $purge !== null && !isset($purge['graph']) && $purge['enabled'] === false);
[, , $raw] = call('GET', "{$b}/commands/{$purge['id']}");
check('preset graph keeps {} configs', !str_contains($raw, '"config":[]'));
[$s, $groups] = call('GET', "{$b}/command-groups");
check('preset groups count only visible commands', $s === 200 && in_array(['Moderation', 0], array_map(fn ($g) => [$g['name'], $g['commands']], $groups['items']), true));
check('preset copies hidden', $purge['hidden'] === true);
$purgeGraph = json_decode($raw, true)['graph'];
[$s, $saved] = call('PUT', "{$b}/commands/{$purge['id']}", json_encode(['name' => 'purge', 'description' => $purge['description'], 'enabled' => false, 'graph' => $purgeGraph]));
check('saving a preset copy shows it', $s === 200 && $saved['hidden'] === false);
check('preset copy knows its preset', $saved['preset'] === 'purge');
$edited = $purgeGraph;
$edited['nodes'][0]['note'] = 'changed by user';
call('PUT', "{$b}/commands/{$purge['id']}", json_encode(['name' => 'purge2', 'description' => 'Mine', 'enabled' => false, 'graph' => $edited]));
[$s] = call('DELETE', "{$b}/commands/{$purge['id']}");
[, $reset] = call('GET', "{$b}/commands/{$purge['id']}");
check('deleting a module copy resets it', $s === 204 && $reset['name'] === 'purge' && $reset['hidden'] === true && $reset['description'] === $purge['description']);
check('reset copy not in recently deleted', !in_array($purge['id'], array_column(call('GET', "{$b}/commands/deleted")[1]['items'], 'id'), true));
[, , $rawReset] = call('GET', "{$b}/commands/{$purge['id']}");
check('reset graph is the preset', !str_contains($rawReset, 'changed by user'));
call('PUT', "{$b}/commands/{$purge['id']}", json_encode(['name' => 'purge', 'description' => $purge['description'], 'enabled' => false, 'graph' => $purgeGraph]));
check('saved copy counted in group', in_array(['Moderation', 1], array_map(fn ($g) => [$g['name'], $g['commands']], call('GET', "{$b}/command-groups")[1]['items']), true));

// create, save, versions
[$s, $cmd] = call('POST', "{$b}/commands", '{"name":"hello","description":"Say hi","enabled":true}');
check('command created with starter graph', $s === 201 && $cmd['graph']['nodes'][0]['type'] === 'trigger.slash');
[$s, $err] = call('POST', "{$b}/commands", '{"name":"hello"}');
check('duplicate name 409', $s === 409 && $err['error']['key'] === 'error.command.name_taken');
[$s, $err] = call('POST', "{$b}/commands", '{"name":"Bad Name!"}');
check('bad name 422', $s === 422 && $err['error']['key'] === 'error.command.name');

$c = "{$b}/commands/{$cmd['id']}";
$graph = fn (int $n) => json_encode(['name' => 'hello', 'description' => 'Say hi', 'enabled' => true, 'graph' => [
    'schemaVersion' => 1,
    'nodes' => [['id' => 't', 'type' => 'trigger.slash', 'typeVersion' => 1, 'config' => ['command_name' => 'hello']], ['id' => 'n', 'type' => 'action.note', 'typeVersion' => 1, 'config' => new \stdClass(), 'label' => "v{$n}"]],
    'edges' => [],
]]);
for ($i = 1; $i <= 4; $i++) {
    [$s, , $raw] = call('PUT', $c, $graph($i));
}
check('save returns graph with {} config', $s === 200 && str_contains($raw, '"config":{}'));
[$s, $versions] = call('GET', "{$c}/versions");
check('only 3 versions kept, newest first', $s === 200 && count($versions['items']) === 3 && $versions['items'][0]['id'] > $versions['items'][2]['id']);
$oldest = $versions['items'][2]['id'];
[$s, $v] = call('GET', "{$c}/versions/{$oldest}");
check('version with graph', $s === 200 && $v['graph']['nodes'][1]['label'] === 'v2');
[$s, $restored] = call('POST', "{$c}/versions/{$oldest}/restore");
check('restore version saves it as newest', $s === 200 && $restored['graph']['nodes'][1]['label'] === 'v2' && count(call('GET', "{$c}/versions")[1]['items']) === 3);
[$s, $err] = call('PUT', $c, '{"name":"hello","graph":{"schemaVersion":2,"nodes":[],"edges":[]}}');
check('invalid graph 422', $s === 422 && $err['error']['key'] === 'error.graph.invalid');

$bad = fn (array $g) => call('PUT', $c, json_encode(['name' => 'hello', 'graph' => ['schemaVersion' => 1] + $g]))[1]['error']['key'] ?? 'ok';
$t = ['id' => 't', 'type' => 'trigger.slash', 'typeVersion' => 1, 'config' => new \stdClass()];
check('graph: duplicate node id', $bad(['nodes' => [$t, $t], 'edges' => []]) === 'error.graph.duplicate_node');
check('graph: unknown block type', $bad(['nodes' => [$t, ['id' => 'x', 'type' => 'action.nope', 'config' => new \stdClass()]], 'edges' => []]) === 'error.graph.unknown_type');
$note = ['id' => 'n', 'type' => 'action.note', 'typeVersion' => 1, 'config' => new \stdClass()];
check('graph: unknown port', $bad(['nodes' => [$t, $note], 'edges' => [['from' => ['node' => 't', 'port' => 'nope'], 'to' => ['node' => 'n', 'port' => 'in']]]]) === 'error.graph.bad_port');
check('graph: error path port ok', $bad(['nodes' => [$t, $note], 'edges' => [['from' => ['node' => 't', 'port' => 'next'], 'to' => ['node' => 'n', 'port' => 'in']], ['from' => ['node' => 'n', 'port' => 'error'], 'to' => ['node' => 't', 'port' => 'options']]]]) !== 'error.graph.bad_port');
check('graph: edge to missing node', $bad(['nodes' => [$t], 'edges' => [['from' => ['node' => 't', 'port' => 'next'], 'to' => ['node' => 'gone', 'port' => 'in']]]]) === 'error.graph.bad_edge');

// patch, groups
[, $g] = call('POST', "{$b}/command-groups", '{"name":"Fun","position":3}');
[$s, $patched] = call('PATCH', $c, json_encode(['enabled' => false, 'groupId' => $g['id']]));
check('patch enabled and group', $s === 200 && $patched['enabled'] === false && $patched['groupId'] === $g['id']);
[$s] = call('PATCH', $c, '{"groupId":99999}');
check('unknown group 422', $s === 422);
// Module groups are system groups: no rename, delete or moving in or out.
$moderation = array_values(array_filter(call('GET', "{$b}/command-groups")[1]['items'], fn ($x) => $x['name'] === 'Moderation'))[0];
check('module group is a system group', $moderation['system'] === true && $g['system'] === false);
[$s] = call('DELETE', "{$b}/command-groups/{$moderation['id']}");
check('system group delete refused', $s === 403);
[$s] = call('PUT', "{$b}/command-groups/{$moderation['id']}", '{"name":"Mine","position":0}');
check('system group rename refused', $s === 403);
[$s, $err] = call('PATCH', $c, json_encode(['groupId' => $moderation['id']]));
check('moving into a system group refused', $s === 422 && ($err['error']['key'] ?? $err['key'] ?? '') === 'error.group.system');
[$s] = call('PATCH', "{$b}/commands/{$purge['id']}", json_encode(['groupId' => $g['id']]));
check('moving a module copy out refused', $s === 422 && call('GET', "{$b}/commands/{$purge['id']}")[1]['groupId'] === $moderation['id']);
check('copy flag on module copy', call('GET', "{$b}/commands/{$purge['id']}")[1]['copy'] === true && call('GET', $c)[1]['copy'] === false);
[$s] = call('DELETE', "{$b}/command-groups/{$g['id']}");
check('delete group keeps command', $s === 204 && call('GET', $c)[1]['groupId'] === null);

// delete, restore
[$s] = call('DELETE', $c);
check('delete 204, gone from list', $s === 204 && call('GET', $c)[0] === 404);
[, $deleted] = call('GET', "{$b}/commands/deleted");
check('listed under recently deleted', ($deleted['items'][0]['name'] ?? '') === 'hello');
[$s, $again] = call('POST', "{$b}/commands/deleted/{$cmd['id']}/restore");
check('restore deleted', $s === 200 && $again['name'] === 'hello');

// events
[$s, $ev] = call('POST', "{$b}/events", '{"name":"Welcome","eventType":"member_join","enabled":true}');
check('event created', $s === 201 && $ev['kind'] === 'event' && $ev['eventType'] === 'member_join' && $ev['graph']['nodes'][0]['type'] === 'trigger.event');
[$s] = call('POST', "{$b}/events", '{"name":"X","eventType":"nope"}');
check('unknown event type 422', $s === 422);
check('events and commands apart', call('GET', "{$b}/commands/{$ev['id']}")[0] === 404 && count(call('GET', "{$b}/events")[1]['items']) === 1);

// modules
[$s, $m] = call('PUT', "{$b}/modules/moderation", '{"enabled":false}');
check('module switch stored', $s === 200 && call('GET', "{$b}/modules")[1]['items'] === [['key' => 'moderation', 'enabled' => false]]);
[$s] = call('PUT', "{$b}/modules/nope", '{"enabled":true}');
check('unknown module 404', $s === 404);

// module settings (moderation)
[$s, $mc] = call('GET', "{$b}/modules/moderation/config");
check('moderation config defaults', $s === 200 && $mc['moderators']['required_permissions'] === ['manage_messages'] && $mc['admins']['required_permissions'] === ['administrator'] && $mc['autoPunishments'] === [] && $mc['dmMode'] === 'embed');
$cfg = '{"logEnabled":true,"logChannels":[{"id":"111111111111111111","guild":"222222222222222222"}],"punishmentColor":"#AABBCC",'
    . '"autoPunishments":[{"trigger":"warnings","count":3,"action":"timeout","duration":"1h"},{"trigger":"timeouts","count":2,"action":"ban","duration":""}]}';
[$s, $mc] = call('PUT', "{$b}/modules/moderation/config", $cfg);
check('moderation config stored', $s === 200 && $mc['punishmentColor'] === '#aabbcc' && count($mc['autoPunishments']) === 2
    && call('GET', "{$b}/modules/moderation/config")[1]['logChannels'][0]['id'] === '111111111111111111');
check('module switch kept after config', call('GET', "{$b}/modules")[1]['items'] === [['key' => 'moderation', 'enabled' => false]]);
[$s, $e] = call('PUT', "{$b}/modules/moderation/config", '{"logEnabled":true,"logChannels":[]}');
check('log without channel 422', $s === 422 && $e['error']['key'] === 'error.moderation.log_channel_required');
[$s, $e] = call('PUT', "{$b}/modules/moderation/config", '{"autoPunishments":[{"trigger":"warnings","count":3,"action":"timeout","duration":""}]}');
check('timeout rule without duration 422', $s === 422 && $e['error']['key'] === 'error.moderation.duration_required');
[$s] = call('PUT', "{$b}/modules/moderation/config", '{"moderatorRoles":[{"id":"x","guild":"1"}]}');
check('bad role ref 422', $s === 422);
[$s, $mc] = call('PUT', "{$b}/modules/moderation/config", '{"defaultPermissions":false,"moderatorRoles":[{"id":"333333333333333333","guild":"222222222222222222"}]}');
check('old role fields become blocks', $s === 200 && $mc['moderators']['allowed_roles'][0]['id'] === '333333333333333333'
    && $mc['moderators']['required_permissions'] === [] && $mc['admins']['required_permissions'] === [] && !isset($mc['moderatorRoles']));
$blk = '{"moderators":{"allowed_roles":[{"id":"333333333333333333","guild":"222222222222222222"}],"banned_channels":[{"id":"111111111111111111","guild":"222222222222222222"}],"required_permissions":["manage_messages"]}}';
[$s, $mc] = call('PUT', "{$b}/modules/moderation/config", $blk);
check('moderator block stored', $s === 200 && $mc['moderators']['banned_channels'][0]['id'] === '111111111111111111' && $mc['admins']['required_permissions'] === ['administrator']);
check('moderator block: everyone 422', call('PUT', "{$b}/modules/moderation/config", '{"moderators":{"allowed_roles":[{"id":"everyone"}]}}')[0] === 422);
check('moderator block: unknown permission 422', call('PUT', "{$b}/modules/moderation/config", '{"admins":{"required_permissions":["fly"]}}')[0] === 422);
[$s, $e] = call('GET', "{$b}/modules/economy/config");
check('module without settings 404', $s === 404 && $e['error']['key'] === 'error.module.no_settings');

// presence
[$s, $pr] = call('GET', "{$b}/presence");
check('presence defaults', $s === 200 && $pr['status'] === 'online' && $pr['activity']['type'] === 'none' && $pr['rotation']['intervalSeconds'] === 300);
[$s, $pr] = call('PATCH', "{$b}/presence", '{"status":"dnd","activity":{"type":"watching","name":"you"}}');
check('presence merges fields', $s === 200 && $pr['status'] === 'dnd' && $pr['activity']['name'] === 'you' && $pr['customStatus'] === '');
[$s, $pr] = call('PATCH', "{$b}/presence", '{"customStatus":"Hi","rotation":{"enabled":true,"intervalSeconds":60,"entries":[{"type":"playing","name":"A"}]}}');
check('presence keeps earlier fields', $s === 200 && $pr['status'] === 'dnd' && $pr['rotation']['entries'][0]['name'] === 'A' && call('GET', "{$b}/presence")[1] == $pr);
check('presence validation', call('PATCH', "{$b}/presence", '{"status":"busy"}')[0] === 422 && call('PATCH', "{$b}/presence", '{"rotation":{"intervalSeconds":5}}')[0] === 422);
check('presence outbox', $outbox('bot.presence') === 2);

// timed events
[$s, $te] = call('POST', "{$b}/timed-events", '{"name":"Every 30s","kind":"interval","intervalSeconds":30,"weekdays":[5,1,1]}');
check('interval timed event', $s === 201 && $te['intervalSeconds'] === 30 && $te['weekdays'] === [1, 5] && $te['enabled'] === true);
[$s, $ts] = call('POST', "{$b}/timed-events", '{"name":"Morning","kind":"schedule","times":["20:30","08:00:00","08:00"]}');
check('schedule times normalized and sorted', $s === 201 && $ts['times'] === ['08:00:00', '20:30:00'] && $ts['intervalSeconds'] === null);
check('interval below 10s refused', call('POST', "{$b}/timed-events", '{"name":"x","kind":"interval","intervalSeconds":5}')[1]['error']['key'] === 'error.timed.interval');
check('bad time refused', call('POST', "{$b}/timed-events", '{"name":"x","kind":"schedule","times":["25:00"]}')[0] === 422);
[$s, $up] = call('PUT', "{$b}/timed-events/{$te['id']}", '{"name":"Hourly","kind":"interval","intervalSeconds":3600,"enabled":false}');
check('timed event updated', $s === 200 && $up['name'] === 'Hourly' && $up['enabled'] === false && $up['weekdays'] === []);
check('timed event list', count(call('GET', "{$b}/timed-events")[1]['items']) === 2);
check('timed event delete', call('DELETE', "{$b}/timed-events/{$ts['id']}")[0] === 204 && call('GET', "{$b}/timed-events/{$ts['id']}")[0] === 404);
[$s, $set] = call('PATCH', "{$b}/timed-settings", '{"timezone":"Europe/Berlin","defaultServerId":"123456789012345678"}');
check('timed settings stored', $s === 200 && call('GET', "{$b}/timed-settings")[1] === ['timezone' => 'Europe/Berlin', 'defaultServerId' => '123456789012345678']);
check('bad timezone refused', call('PATCH', "{$b}/timed-settings", '{"timezone":"Mars/Base"}')[0] === 422 && call('PATCH', "{$b}/timed-settings", '{"timezone":"+01:00"}')[0] === 422);
check('timed outbox', $outbox('timed.changed') === 5);

// webhooks
$ev = str_repeat('a', 24);
[$s, $wh] = call('POST', "{$b}/webhooks", json_encode(['eventId' => $ev, 'name' => 'Deploy', 'requireKey' => true]));
check('webhook created', $s === 201 && $wh['url'] === "/api/hooks/{$bot['id']}/{$ev}" && $wh['calls'] === 0 && $wh['enabled'] === true);
check('webhook event id taken', call('POST', "{$b}/webhooks", json_encode(['eventId' => $ev, 'name' => 'x']))[1]['error']['key'] === 'error.webhook.event_taken');
check('webhook bad event id', call('POST', "{$b}/webhooks", '{"eventId":"Short!","name":"x"}')[1]['error']['key'] === 'error.webhook.event_id');
[$s, $list] = call('GET', "{$b}/webhooks");
check('webhook list without key', $s === 200 && count($list['items']) === 1 && $list['apiKey']['set'] === false);
[$s, $k] = call('POST', "{$b}/webhook-key");
check('webhook key shown once', $s === 201 && str_starts_with($k['apiKey'], 'bh_') && call('GET', "{$b}/webhooks")[1]['apiKey']['hint'] === '…' . substr($k['apiKey'], -4));
$store = new WebhookStore($pdo);
$recv = function (?string $auth, string $body = '{}') use ($store, $bot, $ev): string {
    try {
        $store->receive($bot['id'], $ev, $auth, $body);
        return 'ok';
    } catch (ApiError $e) {
        return $e->key;
    }
};
check('webhook needs key', $recv(null) === 'error.webhook.key' && $recv('wrong') === 'error.webhook.key');
$before = $outbox('webhook.called');
check('webhook accepts key and Bearer', $recv($k['apiKey'], '{"variables":{"version":"1.2"}}') === 'ok' && $recv('Bearer ' . $k['apiKey']) === 'ok');
check('webhook bad json', $recv($k['apiKey'], '{nope') === 'error.webhook.json');
$last = json_decode($pdo->query("SELECT payload FROM outbox WHERE type = 'webhook.called' ORDER BY id DESC LIMIT 1 OFFSET 1")->fetchColumn(), true);
check('webhook event payload', $outbox('webhook.called') === $before + 2 && $last['variables'] === ['version' => '1.2'] && $last['name'] === 'Deploy');
check('webhook variables forms', WebhookStore::variables(['variables' => [['name' => 'a', 'value' => 1], ['name' => 'bad name', 'value' => 2]]]) === ['a' => '1']);
[$s, $wh2] = call('PATCH', "{$b}/webhooks/{$wh['id']}", '{"requireKey":false,"enabled":false}');
check('webhook disabled is unknown', $s === 200 && $recv(null) === 'error.webhook.unknown');
call('PATCH', "{$b}/webhooks/{$wh['id']}", '{"enabled":true}');
check('webhook without key requirement', $recv(null) === 'ok' && call('GET', "{$b}/webhooks/{$wh['id']}")[1]['calls'] === 3);
check('webhook test counts', call('POST', "{$b}/webhooks/{$wh['id']}/test", '{"variables":{"x":"y"}}')[0] === 202 && call('GET', "{$b}/webhooks/{$wh['id']}")[1]['calls'] === 4);
check('webhook delete', call('DELETE', "{$b}/webhooks/{$wh['id']}")[0] === 204 && $recv(null) === 'error.webhook.unknown');

// message builder: saved messages
[$s, $tpl] = call('POST', "{$b}/message-templates", '{"name":"Welcome","message":{"mode":"normal","content":"Hi","embeds":[{}]}}');
check('template created', $s === 201 && $tpl['name'] === 'Welcome');
[, , $raw] = call('GET', "{$b}/message-templates/{$tpl['id']}");
check('template keeps {} embeds', str_contains($raw, '"embeds":[{}]'));
[$s, $tpl2] = call('PUT', "{$b}/message-templates/{$tpl['id']}", '{"name":"Welcome 2"}');
check('template renamed, message kept', $s === 200 && $tpl2['name'] === 'Welcome 2' && $tpl2['message']['content'] === 'Hi');
check('template message schema', call('POST', "{$b}/message-templates", '{"name":"x","message":{"mode":"normal","evil":1}}')[1]['error']['key'] === 'error.template.message'
    && call('POST', "{$b}/message-templates", json_encode(['name' => 'x', 'message' => ['embeds' => array_fill(0, 11, (object) [])]]))[0] === 422
    && call('POST', "{$b}/message-templates", '{"name":"x","message":{"embeds":[{"title":"' . str_repeat('a', 257) . '"}]}}')[0] === 422
    && call('POST', "{$b}/message-templates", '{"name":"ok","message":{"mode":"normal","content":"Hi","embeds":[{"color":"#ff0000","fields":[{"name":"a","value":"b","inline":true}],"footer":{"text":"f"}}]}}')[0] === 201);
check('template invalid', call('POST', "{$b}/message-templates", '{"name":"","message":{}}')[0] === 422 && call('POST', "{$b}/message-templates", '{"name":"x","message":"no"}')[0] === 422);
check('template send needs one target', call('POST', "{$b}/message-templates/{$tpl['id']}/send", '{}')[1]['error']['key'] === 'error.template.target');
check('template send checks channel', call('POST', "{$b}/message-templates/{$tpl['id']}/send", '{"channelId":"abc"}')[1]['error']['key'] === 'error.template.channel');
check('template send checks webhook', call('POST', "{$b}/message-templates/{$tpl['id']}/send", '{"webhookUrl":"https://evil.example/api/webhooks/1/x"}')[1]['error']['key'] === 'error.template.webhook');
check('template send without redis 503', call('POST', "{$b}/message-templates/{$tpl['id']}/send", '{"channelId":"123456789012345678"}')[0] === 503);
check('templates listed', count(call('GET', "{$b}/message-templates")[1]['items']) === 2);
check('template delete', call('DELETE', "{$b}/message-templates/{$tpl['id']}")[0] === 204 && call('GET', "{$b}/message-templates/{$tpl['id']}")[0] === 404);

// data storage
[$s, $coins] = call('POST', "{$b}/data/variables", '{"name":"Daily Coins","type":"number","owner":"member","perServer":true,"defaultValue":"0","group":"Economy"}');
check('data variable created, key from name', $s === 201 && $coins['key'] === 'daily_coins' && $coins['values'] === 0);
check('data key taken', call('POST', "{$b}/data/variables", '{"name":"x","key":"daily_coins","type":"text","owner":"shared","perServer":false}')[0] === 409);
check('data number rejects NaN and Inf', call('POST', "{$b}/data/variables", '{"name":"n","type":"number","owner":"shared","perServer":false,"defaultValue":"NaN"}')[0] === 422
    && !DataStore::validValue('number', 'INF') && !DataStore::validValue('number', '1e999') && DataStore::validValue('number', '-3e2'));
$vb = "{$b}/data/variables/{$coins['id']}/values";
check('data value needs ids', call('PUT', $vb, '{"ownerId":"123456789012345678","value":"5"}')[1]['error']['key'] === 'error.data.ids');
check('data value set', call('PUT', $vb, '{"serverId":"223456789012345678","ownerId":"123456789012345678","value":"5"}')[0] === 200);
check('data value wrong type', call('PUT', $vb, '{"serverId":"223456789012345678","ownerId":"123456789012345678","value":"abc"}')[1]['error']['key'] === 'error.data.value');
[$s, $page] = call('GET', $vb, null, ['q' => '2234']);
check('data values listed with search', $s === 200 && $page['total'] === 1 && $page['items'][0]['value'] === '5');
check('data values search is literal', call('GET', $vb, null, ['q' => '%'])[1]['total'] === 0);
check('data lookup', count(call('GET', "{$b}/data/lookup", null, ['id' => '123456789012345678'])[1]['items']) === 1);
[, $cmd2] = call('POST', "{$b}/commands", '{"name":"bal","description":"Balance","enabled":false}');
$g = $cmd2['graph']; $g['nodes'][] = ['id' => 'note', 'type' => 'action.note', 'typeVersion' => 1, 'config' => ['text' => 'You have {var.daily_coins}'], 'position' => ['x' => 0, 'y' => 0]];
call('PUT', "{$b}/commands/{$cmd2['id']}", json_encode(['name' => 'bal', 'description' => 'Balance', 'enabled' => false, 'graph' => $g]));
check('data used in counts graphs', call('GET', "{$b}/data/variables/{$coins['id']}")[1]['usedIn'] === 1);
[$s, $coins2] = call('PUT', "{$b}/data/variables/{$coins['id']}", '{"name":"Coins","type":"number","owner":"shared","perServer":true}');
check('data owner change drops values', $s === 200 && $coins2['values'] === 0 && $coins2['key'] === 'daily_coins');
check('data delete', call('DELETE', "{$b}/data/variables/{$coins['id']}")[0] === 204 && call('GET', "{$b}/data/variables/{$coins['id']}")[0] === 404);

// SDK policies (global): allow / default / deny
[$s, $pol] = call('GET', '/internal/admin/sdk-policies');
$byKey = array_column($pol['items'], 'enabled', 'permission');
$modes = array_column($pol['items'], 'mode', 'permission');
check('sdk policies default by risk', $s === 200 && $byKey['storage'] === true && $byKey['discord.messages.send'] === false && $byKey['modules.read'] === false && $modes['storage'] === 'default');
[$s, $pol] = call('PUT', '/internal/admin/sdk-policies/discord.messages.send', '{"mode":"allow"}');
$p = array_column($pol['items'], null, 'permission')['discord.messages.send'];
check('sdk policy allow', $s === 200 && $p['mode'] === 'allow' && $p['enabled'] === true && $outbox('sdk.policies.changed') === 1);
[, $pol] = call('PUT', '/internal/admin/sdk-policies/storage', '{"mode":"deny"}');
$p = array_column($pol['items'], null, 'permission')['storage'];
check('sdk policy deny beats low risk', $p['mode'] === 'deny' && $p['enabled'] === false);
[, $pol] = call('PUT', '/internal/admin/sdk-policies/storage', '{"mode":"default"}');
$p = array_column($pol['items'], null, 'permission')['storage'];
check('sdk policy back to default', $p['mode'] === 'default' && $p['enabled'] === true && (int) $pdo->query("SELECT COUNT(*) FROM sdk_policies WHERE permission = 'storage'")->fetchColumn() === 0);
check('sdk policy unknown / bad value', call('PUT', '/internal/admin/sdk-policies/db.raw', '{"mode":"allow"}')[0] === 404 && call('PUT', '/internal/admin/sdk-policies/storage', '{"mode":"yes"}')[0] === 422);

check('outbox events written', $outbox('command.saved') >= 8 && $outbox('command.deleted') === 1 && $outbox('module.changed') === 4);
// bot backups and templates
[$s, $exp] = call('GET', "{$b}/backup");
[, , $rawExp] = call('GET', "{$b}/backup");
check('backup export', $s === 200 && $exp['format'] === 'bothub-bot-backup' && count($exp['commands']) > 0 && !str_contains(strtolower($rawExp), 'token_enc') && !str_contains($rawExp, $token));
$namesBefore = array_column(call('GET', "{$b}/commands")[1]['items'], 'name');
[$s, $saved] = call('POST', "{$b}/backups", '{"name":"Before test","kind":"backup"}');
check('backup saved', $s === 201 && $saved['kind'] === 'backup');
[$s, $list] = call('GET', "{$b}/backups");
$ids = array_column($list['items'], 'kind', 'id');
check('backups listed with ready-made templates', $s === 200 && ($ids[$saved['id']] ?? '') === 'backup' && ($ids['builtin:starter'] ?? '') === 'builtin');
[$s, $res] = call('POST', "{$b}/restore", '{"id":"builtin:starter","name":"Starter"}');
$names = array_column(call('GET', "{$b}/commands")[1]['items'], 'name');
check('restore ready-made template', $s === 200 && in_array('ping', $names, true) && in_array('coins', $names, true) && !in_array('hello', $names, true));
check('restore keeps data storage by key', in_array('coins', array_column(call('GET', "{$b}/data/variables")[1]['items'], 'key'), true));
$auto = array_values(array_filter(call('GET', "{$b}/backups")[1]['items'], fn ($i) => $i['auto']));
check('automatic backup before restore', count($auto) === 1 && $auto[0]['kind'] === 'backup');
[$s] = call('POST', "{$b}/restore", json_encode(['id' => $auto[0]['id']]));
$names = array_column(call('GET', "{$b}/commands")[1]['items'], 'name');
sort($names);
sort($namesBefore);
check('restore the automatic backup', $s === 200 && $names === $namesBefore);
$hiddenBefore = (int) $pdo->query("SELECT COUNT(*) FROM commands WHERE bot_id = {$bot['id']} AND hidden = 1")->fetchColumn();
check('restore keeps hidden copies hidden', $hiddenBefore > 0 && count(array_filter($exp['commands'], fn ($c) => $c['hidden'])) === $hiddenBefore);
check('upload: wrong format', call('POST', "{$b}/restore", '{"data":{"format":"x"}}')[1]['error']['key'] === 'error.backup.format');
$bad = $exp;
$bad['commands'][0]['name'] = 'Bad Name!';
[$s, $err] = call('POST', "{$b}/restore", json_encode(['data' => $bad, 'name' => 'bad.json']));
check('upload: invalid part is rejected, nothing changed', $s === 422 && $err['error']['key'] === 'error.backup.part' && in_array('hello', array_column(call('GET', "{$b}/commands")[1]['items'], 'name'), true));
[$s, $t] = call('POST', "{$b}/backups", '{"name":"Shared","kind":"template","description":"for all bots"}');
check('save as global template', $s === 201 && $t['kind'] === 'template');
check('ready-made template cannot be deleted', call('DELETE', "{$b}/backups/builtin:starter")[0] === 403);
check('delete saved backup', call('DELETE', "{$b}/backups/{$saved['id']}")[0] === 204 && call('GET', "{$b}/backups/{$saved['id']}")[0] === 404);

check('unknown bot 404', call('GET', '/internal/bots/999/commands')[0] === 404);

exit($failed === 0 ? 0 : 1);
