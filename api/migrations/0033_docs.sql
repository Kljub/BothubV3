-- Docs written in the dashboard (the shipped guides live in shared/docs as
-- Markdown). docs_categories: own categories next to the shipped ones
-- (getting-started, modules, builder, plugins, updates). docs_articles: an
-- article in a shipped or own category; lang '' = every language; drafts
-- (published = 0) show only in the editor list.

CREATE TABLE docs_categories (
    slug       TEXT PRIMARY KEY CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 2 AND 60 AND slug NOT GLOB '*[^a-z0-9-]*'),
    icon       TEXT NOT NULL DEFAULT '' CHECK (length(icon) <= 16),
    title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE docs_articles (
    id         INTEGER PRIMARY KEY,
    category   TEXT NOT NULL CHECK (length(category) BETWEEN 2 AND 60),
    slug       TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 2 AND 80 AND slug NOT GLOB '*[^a-z0-9-]*'),
    lang       TEXT NOT NULL DEFAULT '' CHECK (lang IN ('', 'en', 'de')),
    title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    summary    TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 300),
    content    TEXT NOT NULL CHECK (length(content) <= 100000),
    published  INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 100,
    author     TEXT NOT NULL DEFAULT '' CHECK (length(author) <= 64),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (category, slug, lang)
) STRICT;
