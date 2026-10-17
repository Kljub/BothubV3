import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverFeed } from './feeds-extra.js';

test('a web page links its feed; relative links become absolute', () => {
  const page = '<html><head><link rel="stylesheet" href="/a.css"><link rel="alternate" type="application/rss+xml" title="Blog" href="/feed.xml"></head></html>';
  assert.equal(discoverFeed(page, 'https://example.com/blog/'), 'https://example.com/feed.xml');
  const atom = "<link type='application/atom+xml' rel='alternate' href='https://cdn.example.com/atom.xml?x=1&amp;y=2'>";
  assert.equal(discoverFeed(atom, 'https://example.com/'), 'https://cdn.example.com/atom.xml?x=1&y=2');
  assert.equal(discoverFeed('<link rel="icon" href="/i.png">', 'https://example.com/'), null);
});
