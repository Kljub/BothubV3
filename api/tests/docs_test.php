<?php

declare(strict_types=1);

// Docs written in the dashboard: php tests/docs_test.php

require __DIR__ . '/../src/autoload.php';

use BotHub\Database\Connection;
use BotHub\Database\Migrator;
use BotHub\Internal\BotStore;
use BotHub\Internal\DocsStore;
use BotHub\Internal\InternalRouter;
use BotHub\BotCore\SecretBox;

$failed = 0;
function check(string $name, bool $ok): void
{
    global $failed;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failed++;
    }
}

$tmp = sys_get_temp_dir() . '/bothub-docs-' . bin2hex(random_bytes(4));
mkdir($tmp);
putenv('DATA_DIR=' . $tmp);
$pdo = Connection::open($tmp . '/bothub.sqlite');
(new Migrator($pdo, __DIR__ . '/../migrations'))->migrate();
$router = new InternalRouter(new BotStore($pdo, SecretBox::loadOrCreate()), static fn () => throw new \RuntimeException('no jobs'), actor: 'admin', docs: new DocsStore($pdo));
$call = fn (string $m, string $p, array $b = []) => $router->handle($m, $p, $b, null, []);

$r = $call('POST', '/internal/docs', ['category' => 'updates', 'slug' => 'release-1', 'lang' => 'de', 'title' => 'Version 1', 'summary' => 'Neu', 'content' => "# Hallo\n\nText", 'published' => true, 'sort' => 1]);
check('create', $r[0] === 201 && $r[1]['id'] > 0 && $r[1]['author'] === 'admin' && $r[1]['published'] === true);
$id = $r[1]['id'];
check('duplicate refused', $call('POST', '/internal/docs', ['category' => 'updates', 'slug' => 'release-1', 'lang' => 'de', 'title' => 'X', 'content' => ''])[0] === 409);
$r = $call('POST', '/internal/docs', ['category' => 'updates', 'slug' => 'release-1', 'lang' => 'en', 'title' => 'Version 1', 'content' => 'Text']);
check('same slug in another language', $r[0] === 201 && $r[1]['published'] === false);
check('bad category refused', $call('POST', '/internal/docs', ['category' => 'Bad Slug', 'slug' => 'x1', 'title' => 'X', 'content' => ''])[0] === 422);
$list = $call('GET', '/internal/docs')[1];
check('list without content', count($list['articles']) === 2 && !isset($list['articles'][0]['content']));
$r = $call('PUT', "/internal/docs/{$id}", ['category' => 'updates', 'slug' => 'release-1', 'lang' => 'de', 'title' => 'Version 1.0', 'content' => 'Neu', 'published' => false]);
check('update', $r[0] === 200 && $r[1]['title'] === 'Version 1.0' && $r[1]['content'] === 'Neu' && $r[1]['published'] === false);
$r = $call('POST', '/internal/docs/categories', ['slug' => 'faq', 'icon' => '❓', 'title' => 'FAQ', 'sort' => 5]);
check('category', $r[0] === 200 && $r[1]['items'][0]['slug'] === 'faq');
$call('POST', '/internal/docs', ['category' => 'faq', 'slug' => 'q1', 'title' => 'Q', 'content' => 'A']);
check('category with articles stays', $call('DELETE', '/internal/docs/categories/faq')[0] === 409);
$q1 = array_values(array_filter($call('GET', '/internal/docs')[1]['articles'], fn ($a) => $a['slug'] === 'q1'))[0]['id'];
check('delete article', $call('DELETE', "/internal/docs/{$q1}")[0] === 204);
check('delete category', $call('DELETE', '/internal/docs/categories/faq')[0] === 204 && $call('GET', '/internal/docs/categories')[1]['items'] === []);

exit($failed === 0 ? 0 : 1);
