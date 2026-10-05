<?php

declare(strict_types=1);

// Module settings schemas (shared/module-settings): php tests/module_settings_test.php
// Exit code 0 = all passed.

require __DIR__ . '/../src/autoload.php';

use BotHub\Internal\ApiError;
use BotHub\Internal\ModuleSettings;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}
function rejects2(array $schema, array $in): string
{
    try {
        ModuleSettings::normalize($schema, $in);
        return 'ok';
    } catch (ApiError $e) {
        return $e->key;
    }
}
function rejects(array $schema, array $in, string $field): bool
{
    try {
        ModuleSettings::normalize($schema, $in);
        return false;
    } catch (ApiError $e) {
        return $e->key === 'error.validation.failed' && ($e->params['field'] ?? '') === $field;
    }
}

$dir = (getenv('SHARED_DIR') ?: __DIR__ . '/../../shared') . '/module-settings';
$modules = json_decode((string) file_get_contents(dirname($dir) . '/modules.json'), true)['modules'];
$known = array_column($modules, 'key');

// Every schema belongs to a known module and gives valid defaults.
foreach (glob($dir . '/*.json') as $file) {
    $key = basename($file, '.json');
    $schema = ModuleSettings::schema($key);
    check("{$key}: module in modules.json", in_array($key, $known, true) && $schema['module'] === $key);
    $defaults = ModuleSettings::normalize($schema, []);
    check("{$key}: defaults validate again", ModuleSettings::normalize($schema, $defaults) === $defaults);
}

$ar = ModuleSettings::schema('auto-responder');
$ref = ['id' => '111111111111111111', 'guild' => '222222222222222222'];
$cfg = ModuleSettings::normalize($ar, ['responders' => [[
    'keywords' => ['hello', ' hello ', 'hi'],
    'message' => ['mode' => 'embed', 'title' => 'Hey', 'color' => '#ABCDEF'],
    'channelMode' => 'only', 'channels' => [$ref, $ref],
]]]);
$r = $cfg['responders'][0];
check('list item gets defaults', $r['match'] === 'contains' && $r['cooldown'] === 5 && $r['reply'] === true);
check('words trimmed and unique', $r['keywords'] === ['hello', 'hi']);
check('refs deduplicated', $r['channels'] === [$ref]);
check('message normalized', $r['message']['color'] === '#abcdef' && $r['message']['content'] === '' && $r['message']['mode'] === 'embed');
check('unknown fields dropped', !array_key_exists('extra', ModuleSettings::normalize($ar, ['extra' => 1])));
check('bad select', rejects($ar, ['responders' => [['match' => 'regex']]], 'responders.0.match'));
check('bad ref', rejects($ar, ['responders' => [['channels' => [['id' => 'x', 'guild' => '1']]]]], 'responders.0.channels'));
check('number range', rejects($ar, ['responders' => [['cooldown' => 99999]]], 'responders.0.cooldown'));
check('number type', rejects($ar, ['responders' => [['cooldown' => '5']]], 'responders.0.cooldown'));
check('list max', rejects($ar, ['responders' => array_fill(0, 101, [])], 'responders'));

$react = ModuleSettings::schema('autoreact');
check('emoji ok', ModuleSettings::normalize($react, ['emojis' => ['👍', '<:bh:123456789012345678>', '<a:x_y:123456789012345678>']])['emojis'][1] === '<:bh:123456789012345678>');
check('text is not an emoji', rejects($react, ['emojis' => ['hello']], 'emojis'));
check('emoji max', rejects($react, ['emojis' => array_fill(0, 21, '👍')], 'emojis'));

$wel = ModuleSettings::schema('welcommer');
check('bad image url', rejects($wel, ['message' => ['mode' => 'embed', 'image' => 'http://x/y.png']], 'message.image'));
check('bad color', rejects(ModuleSettings::schema('starboard'), ['color' => 'yellow'], 'color'));
check('read() survives broken stored data', ModuleSettings::read($wel, ['channel' => 'garbage'])['channelEnabled'] === true);
$rr = ModuleSettings::schema('reaction-roles');
$entry = ['channel' => $ref, 'messageId' => '123456789012345678', 'emoji' => ['👍']];
check('unique list entries', rejects2($rr, ['entries' => [$entry, $entry]]) === 'error.validation.duplicate');
check('different emoji is fine', count(ModuleSettings::normalize($rr, ['entries' => [$entry, ['emoji' => ['👎']] + $entry]])['entries']) === 2);
check('read() drops duplicates and keeps the rest', count(ModuleSettings::read($rr, ['entries' => [$entry, $entry, 'junk']])['entries']) === 1);
$old = ModuleSettings::read($ar, ['responders' => [['keywords' => ['hi'], 'cooldown' => 0]]]);
check('read() repairs one field, keeps the others', $old['responders'][0]['cooldown'] === 5 && $old['responders'][0]['keywords'] === ['hi']);
$hp = ModuleSettings::schema('honeypot');
$hpc = ModuleSettings::normalize($hp, ['traps' => [['channel' => $ref]]]);
check('honeypot defaults', $hpc['traps'][0]['action'] === 'softban' && $hpc['exempt']['required_permissions'] === ['manage_messages'] && $hpc['exempt']['allowed_roles'] === []);
check('group block: no everyone', rejects($hp, ['exempt' => ['allowed_roles' => [['id' => 'everyone']]]], 'exempt.allowed_roles'));
check('honeypot: one trap per channel', rejects2($hp, ['traps' => [['channel' => $ref], ['channel' => $ref]]]) === 'error.validation.duplicate');
check('cooldown minimum', rejects($ar, ['responders' => [['cooldown' => 0]]], 'responders.0.cooldown'));
$tm = ModuleSettings::schema('timed-messages');
check('required channel', rejects($tm, ['messages' => [['name' => 'x']]], 'messages.0.channel'));
$req = ['fields' => [['key' => 'channel', 'type' => 'channel', 'required' => true], ['key' => 'sites', 'type' => 'list', 'item' => [['key' => 'url', 'type' => 'text', 'required' => true]]]]];
check('required top field: sent empty is refused', rejects($req, ['channel' => null, 'sites' => []], 'channel'));
check('required top field: left out (list entry saved first) passes', ModuleSettings::normalize($req, ['sites' => [['url' => 'https://a.b']]])['channel'] === null);
check('required list field: still refused', rejects($req, ['sites' => [['url' => '']]], 'sites.0.url'));
$saved = ModuleSettings::normalize($tm, ['messages' => [['name' => 'x', 'channel' => $ref]]]);
$id = $saved['messages'][0]['_id'] ?? '';
check('list entry gets a stable id', preg_match('/^[a-z0-9]{12}$/', $id) === 1);
check('id kept on save', ModuleSettings::normalize($tm, $saved)['messages'][0]['_id'] === $id);
check('bad id replaced', ModuleSettings::normalize($tm, ['messages' => [['channel' => $ref, '_id' => 'X!']]])['messages'][0]['_id'] !== 'X!');
$tc = ['fields' => [['key' => 'libs', 'type' => 'choices', 'dynamic' => true, 'max' => 3], ['key' => 'kind', 'type' => 'choices', 'options' => ['a', 'b']]]];
check('choices: picks kept once, default empty', ModuleSettings::normalize($tc, ['libs' => ['1:5', '1:5', '2:3']])['libs'] === ['1:5', '2:3'] && ModuleSettings::normalize($tc, [])['kind'] === []);
check('choices: older text value split', ModuleSettings::read($tc, ['libs' => '5, 2:3'])['libs'] === ['5', '2:3']);
check('choices: static options only', (function () use ($tc) { try { ModuleSettings::normalize($tc, ['kind' => ['c']]); return false; } catch (\Throwable) { return true; } })());
// Economy: an empty currency key is made from the name and stays; currency fields take keys only.
$eco = ModuleSettings::schema('economy');
$saved = ModuleSettings::normalize($eco, ['currencies' => [['name' => 'Social Credit Punkte', 'key' => ''], ['name' => 'Gold Münzen'], ['name' => 'Social Credit Punkte!', 'key' => '']]]);
check('currency key from the name', array_column($saved['currencies'], 'key') === ['socialcreditpunkte', 'goldmuenzen', 'socialcreditpunkte2']);
$renamed = $saved;
$renamed['currencies'][0]['name'] = 'Karma';
check('currency key kept on rename', ModuleSettings::normalize($eco, $renamed)['currencies'][0]['key'] === 'socialcreditpunkte');
check('negative balances off by default', ($saved['currencies'][0]['allowNegative'] ?? null) === false);
check('shop currency: a key', (function () use ($eco) { try { ModuleSettings::normalize($eco, ['shop' => [['name' => 'X', 'key' => 'x', 'currency' => 'Bad Key']]]); return false; } catch (\Throwable) { return true; } })());
check('no schema for unknown module', ModuleSettings::schema('nope') === null && ModuleSettings::schema('../x') === null);

exit($failed === 0 ? 0 : 1);
