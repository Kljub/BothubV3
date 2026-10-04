// Package i18n loads the dashboard's translation files and resolves keys.
//
// Files are flat JSON objects (`"nav.bots": "Bots"`) named `<locale>.json`.
// Placeholders use `{name}`. English is the fallback for missing keys.
package i18n

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"sort"
	"strings"
	"sync"

	"golang.org/x/text/language"
)

// Fallback is the locale used when a key or locale is missing.
const Fallback = "en"

// Bundle holds all loaded locales.
type Bundle struct {
	messages map[string]map[string]string
	locales  []string
	matcher  language.Matcher

	warned sync.Map // missing keys already logged

	pluginMu sync.RWMutex
	plugins  map[string]map[string]map[string]string // plugin id -> locale -> key -> text
}

// Plugin text limits (shared/plugin-manifest.schema.json, lang).
const (
	pluginTextMax = 500
	pluginKeysMax = 2000
)

// Load reads every `*.json` file in dir of fsys.
func Load(fsys fs.FS, dir string) (*Bundle, error) {
	files, err := fs.Glob(fsys, path.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}

	b := &Bundle{messages: map[string]map[string]string{}}
	for _, f := range files {
		raw, err := fs.ReadFile(fsys, f)
		if err != nil {
			return nil, err
		}
		msgs := map[string]string{}
		if err := json.Unmarshal(raw, &msgs); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		locale := strings.TrimSuffix(path.Base(f), ".json")
		b.messages[locale] = msgs
		b.locales = append(b.locales, locale)
	}
	if _, ok := b.messages[Fallback]; !ok {
		return nil, fmt.Errorf("i18n: fallback locale %q missing in %s", Fallback, dir)
	}

	// Fallback first, so the matcher prefers it on ties.
	sort.Slice(b.locales, func(i, j int) bool {
		if b.locales[i] == Fallback {
			return true
		}
		if b.locales[j] == Fallback {
			return false
		}
		return b.locales[i] < b.locales[j]
	})
	tags := make([]language.Tag, len(b.locales))
	for i, l := range b.locales {
		tags[i] = language.Make(l)
	}
	b.matcher = language.NewMatcher(tags)
	return b, nil
}

// Locales returns all loaded locale codes, fallback first.
func (b *Bundle) Locales() []string { return b.locales }

// Has reports whether locale is loaded.
func (b *Bundle) Has(locale string) bool {
	_, ok := b.messages[locale]
	return ok
}

// Match picks the best loaded locale for an Accept-Language header.
func (b *Bundle) Match(acceptLanguage string) string {
	tags, _, err := language.ParseAcceptLanguage(acceptLanguage)
	if err != nil || len(tags) == 0 {
		return Fallback
	}
	_, idx, _ := b.matcher.Match(tags...)
	return b.locales[idx]
}

// T translates key. args are name/value pairs for `{name}` placeholders.
// A missing key returns the key itself and is logged once.
func (b *Bundle) T(locale, key string, args ...any) string {
	msg, ok := b.messages[locale][key]
	if !ok {
		msg, ok = b.messages[Fallback][key]
	}
	if !ok && strings.HasPrefix(key, "plugin.") {
		msg, ok = b.pluginText(locale, key)
	}
	if !ok {
		if _, seen := b.warned.LoadOrStore(key, true); !seen {
			slog.Warn("i18n key missing", "key", key)
		}
		return key
	}
	for i := 0; i+1 < len(args); i += 2 {
		msg = strings.ReplaceAll(msg, "{"+fmt.Sprint(args[i])+"}", fmt.Sprint(args[i+1]))
	}
	return msg
}

// Lookup is T without the warning: ok false when the key has no text
// (e.g. optional "how it works" texts of the docs).
func (b *Bundle) Lookup(locale, key string) (string, bool) {
	msg, ok := b.messages[locale][key]
	if !ok {
		msg, ok = b.messages[Fallback][key]
	}
	return msg, ok
}

// SetPlugin replaces the texts of one installed plugin (its lang files).
// Only keys under "plugin.<id>." are kept, so a plugin can never change
// dashboard texts or another plugin's texts; long values are dropped.
func (b *Bundle) SetPlugin(id string, lang map[string]map[string]string) {
	prefix := "plugin." + id + "."
	clean := map[string]map[string]string{}
	for locale, msgs := range lang {
		if !b.Has(locale) {
			continue
		}
		m := map[string]string{}
		for k, v := range msgs {
			if strings.HasPrefix(k, prefix) && len(k) <= 200 && len([]rune(v)) <= pluginTextMax && len(m) < pluginKeysMax {
				m[k] = v
			}
		}
		clean[locale] = m
	}
	b.pluginMu.Lock()
	defer b.pluginMu.Unlock()
	if b.plugins == nil {
		b.plugins = map[string]map[string]map[string]string{}
	}
	b.plugins[id] = clean
}

// pluginText looks a plugin key up in the locale, then in English.
func (b *Bundle) pluginText(locale, key string) (string, bool) {
	id, _, _ := strings.Cut(strings.TrimPrefix(key, "plugin."), ".")
	b.pluginMu.RLock()
	defer b.pluginMu.RUnlock()
	texts := b.plugins[id]
	if msg, ok := texts[locale][key]; ok {
		return msg, true
	}
	msg, ok := texts[Fallback][key]
	return msg, ok
}

// Keys returns all keys of locale. Used by tests.
func (b *Bundle) Keys(locale string) []string {
	keys := make([]string, 0, len(b.messages[locale]))
	for k := range b.messages[locale] {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
