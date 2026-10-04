<?php

declare(strict_types=1);

namespace BotHub\Internal;

use BotHub\Database\Connection;
use PDO;

/**
 * Docs written in the dashboard (docs_articles, docs_categories). The shipped
 * guides are Markdown files in shared/docs; the dashboard merges both. The
 * content is Markdown and is rendered (escaped) by the dashboard.
 */
final class DocsStore
{
    private const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    private const SLUG = '/^[a-z0-9][a-z0-9-]{1,59}$/';
    private const ARTICLE_SLUG = '/^[a-z0-9][a-z0-9-]{1,79}$/';

    public function __construct(private readonly PDO $pdo)
    {
    }

    /** Every article (drafts too) without content, and the own categories. */
    public function list(): array
    {
        $articles = $this->pdo->query(
            'SELECT id, category, slug, lang, title, summary, published, sort_order, author, created_at, updated_at
             FROM docs_articles ORDER BY category, sort_order, title',
        )->fetchAll();
        return [
            'articles' => array_map(fn (array $r) => $this->article($r, false), $articles),
            'categories' => $this->categories(),
        ];
    }

    public function get(int $id): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM docs_articles WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw ApiError::notFound('error.docs.unknown');
        }
        return $this->article($row, true);
    }

    /** {category, slug, lang, title, summary, content, published, sort} — new when $id is null. */
    public function save(?int $id, array $in, string $author): array
    {
        $category = (string) ($in['category'] ?? '');
        $slug = strtolower(trim((string) ($in['slug'] ?? '')));
        $lang = (string) ($in['lang'] ?? '');
        $title = trim((string) ($in['title'] ?? ''));
        $summary = trim((string) ($in['summary'] ?? ''));
        $content = (string) ($in['content'] ?? '');
        $published = ($in['published'] ?? false) === true ? 1 : 0;
        $sort = $in['sort'] ?? 100;
        if (!preg_match(self::SLUG, $category)) {
            throw new ApiError(422, 'error.validation', ['field' => 'category']);
        }
        if (!preg_match(self::ARTICLE_SLUG, $slug)) {
            throw new ApiError(422, 'error.validation', ['field' => 'slug']);
        }
        if (!in_array($lang, ['', 'en', 'de'], true)) {
            throw new ApiError(422, 'error.validation', ['field' => 'lang']);
        }
        if ($title === '' || mb_strlen($title) > 160) {
            throw new ApiError(422, 'error.validation', ['field' => 'title']);
        }
        if (mb_strlen($summary) > 300) {
            throw new ApiError(422, 'error.validation', ['field' => 'summary']);
        }
        if (strlen($content) > 100000) {
            throw new ApiError(422, 'error.validation', ['field' => 'content']);
        }
        if (!is_int($sort) || $sort < 0 || $sort > 10000) {
            throw new ApiError(422, 'error.validation', ['field' => 'sort']);
        }
        return Connection::write($this->pdo, function (PDO $pdo) use ($id, $category, $slug, $lang, $title, $summary, $content, $published, $sort, $author): array {
            $taken = $pdo->prepare('SELECT id FROM docs_articles WHERE category = ? AND slug = ? AND lang = ?');
            $taken->execute([$category, $slug, $lang]);
            $other = $taken->fetchColumn();
            if ($other !== false && (int) $other !== $id) {
                throw new ApiError(409, 'error.docs.slug_taken');
            }
            if ($id === null) {
                $pdo->prepare('INSERT INTO docs_articles (category, slug, lang, title, summary, content, published, sort_order, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    ->execute([$category, $slug, $lang, $title, $summary, $content, $published, $sort, mb_substr($author, 0, 64)]);
                $id = (int) $pdo->lastInsertId();
            } else {
                $this->get($id);
                $pdo->prepare('UPDATE docs_articles SET category = ?, slug = ?, lang = ?, title = ?, summary = ?, content = ?, published = ?, sort_order = ?, updated_at = ' . self::NOW . ' WHERE id = ?')
                    ->execute([$category, $slug, $lang, $title, $summary, $content, $published, $sort, $id]);
            }
            return $this->get($id);
        });
    }

    public function delete(int $id): void
    {
        $this->get($id);
        $this->pdo->prepare('DELETE FROM docs_articles WHERE id = ?')->execute([$id]);
    }

    public function categories(): array
    {
        return array_map(static fn (array $r) => [
            'slug' => $r['slug'], 'icon' => $r['icon'], 'title' => $r['title'], 'sort' => (int) $r['sort_order'],
        ], $this->pdo->query('SELECT slug, icon, title, sort_order FROM docs_categories ORDER BY sort_order, title')->fetchAll());
    }

    /** {slug, icon, title, sort}: adds or changes an own category. */
    public function saveCategory(array $in): array
    {
        $slug = strtolower(trim((string) ($in['slug'] ?? '')));
        $icon = trim((string) ($in['icon'] ?? ''));
        $title = trim((string) ($in['title'] ?? ''));
        $sort = $in['sort'] ?? 100;
        if (!preg_match(self::SLUG, $slug)) {
            throw new ApiError(422, 'error.validation', ['field' => 'slug']);
        }
        if (mb_strlen($icon) > 8) {
            throw new ApiError(422, 'error.validation', ['field' => 'icon']);
        }
        if ($title === '' || mb_strlen($title) > 80) {
            throw new ApiError(422, 'error.validation', ['field' => 'title']);
        }
        if (!is_int($sort) || $sort < 0 || $sort > 10000) {
            throw new ApiError(422, 'error.validation', ['field' => 'sort']);
        }
        $this->pdo->prepare('INSERT INTO docs_categories (slug, icon, title, sort_order) VALUES (?, ?, ?, ?)
            ON CONFLICT (slug) DO UPDATE SET icon = excluded.icon, title = excluded.title, sort_order = excluded.sort_order')
            ->execute([$slug, $icon, $title, $sort]);
        return $this->categories();
    }

    /** Deletes an own category; its articles must be gone or moved first. */
    public function deleteCategory(string $slug): void
    {
        $used = $this->pdo->prepare('SELECT COUNT(*) FROM docs_articles WHERE category = ?');
        $used->execute([$slug]);
        if ((int) $used->fetchColumn() > 0) {
            throw new ApiError(409, 'error.docs.category_not_empty');
        }
        $stmt = $this->pdo->prepare('DELETE FROM docs_categories WHERE slug = ?');
        $stmt->execute([$slug]);
        if ($stmt->rowCount() === 0) {
            throw ApiError::notFound('error.docs.unknown_category');
        }
    }

    private function article(array $r, bool $withContent): array
    {
        $out = [
            'id' => (int) $r['id'], 'category' => $r['category'], 'slug' => $r['slug'], 'lang' => $r['lang'],
            'title' => $r['title'], 'summary' => $r['summary'], 'published' => (int) $r['published'] === 1,
            'sort' => (int) $r['sort_order'], 'author' => $r['author'], 'createdAt' => $r['created_at'], 'updatedAt' => $r['updated_at'],
        ];
        if ($withContent) {
            $out['content'] = $r['content'];
        }
        return $out;
    }
}
