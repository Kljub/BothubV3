# BotHub design system

## Stylesheets

`static/css/bothub.css` is the only stylesheet the pages load. It imports every
component file from `static/css/components/bh-*.css` in cascade order. The
dashboard appends `?v=<hash>` to each import when it serves the file, so there
are no version numbers to maintain. A new component file must be added to the
import list (`TestMainCSSImportsAllComponents` checks this).

**Global components** (usable in module and plugin content):
`bh-base`, `bh-form`, `bh-button`, `bh-toggle`, `bh-chip`, `bh-card`, `bh-section`, `bh-datepicker`, `bh-pagination`, `bh-command`, `bh-gauge`,
`bh-badge`, `bh-alert`, `bh-table`, `bh-utilities`, `bh-permissions` (role/channel pickers and the permissions block, built by `static/js/permissions.js`).

**Page parts** (dashboard chrome only, never in content):
`bh-layout`, `bh-sidebar`, `bh-topbar`, `bh-page`, `bh-modal`, `bh-tiles`,
`bh-bot-card`, `bh-chart`, `bh-terminal`, `bh-mod-card`, `bh-server`,
`bh-status`, `bh-media`, `bh-store`.

## Content rules

All module and plugin content uses **only** classes from the global component
files. A test (`TestContentUsesOnlyComponents`) fails when a template in
`templates/modules/` or `templates/plugins/` uses any other class.

Rules:

- No inline `style=""` (the CSP blocks it anyway) and no own `<style>` blocks.
- No new classes in content templates. If a component is missing, add it to
  the matching global `bh-*.css` file and to this list, then use it.
- Texts are i18n keys (`{{t "..."}}`), never hardcoded.
- Colors come from theme tokens (`var(--…)`), never hex values in components.

## Components

| Class | Use |
|---|---|
| `box` | Card with a head row. Children: `box-head`, `box-body` |
| `box-head` | Head row with `<h2>` title; optional `box-meta` on the right |
| `box-meta` | Small grey text on the right of the head (limits, hints) |
| `box-body` | Content area of a box |
| `empty-state` (+ `empty-state-icon`) | Centered empty state: icon, `<strong>` title, muted hint |
| `box-count` | Small count next to a box title |
| `box-danger` | Red variant for destructive sections |
| `section` + `section-head` (`<h3>`), `section-meta` | Flat section with divider. Use inside popups instead of `box`: no card inside a card |
| `form` | Vertical form layout; `<label>` children stack label and input |
| `field` | Labelled input (uppercase label); `field-label` for a label without `<label>` |
| `hint` | Small grey help text under an input; `hint-top`, `hint-right` for position |
| `inline-form` | Controls in one row (input + button) |
| `input-wide` / `input-medium` / `input-small` | Input widths (420 / 320 / 120 px) |
| `btn` | Default button |
| `btn-primary` | Main action (one per form) |
| `btn-sm` | Small button |
| `btn-block` | Full-width button |
| `btn-danger`, `btn-danger-soft`, `btn-outline-danger` | Destructive actions |
| `btn-outline-success` | Start/enable actions |
| `icon-btn`, `icon-btn-plain` | Square icon button; plain = without border |
| `toggle` | On/off switch (`<input type="checkbox" class="toggle">`); `toggle-sm`, `toggle-lg` for size |
| `command-row` (template `command_row`) | Command with usage chip, title, description, gear and toggle |
| `command-details` + `command-panel` | Expandable row: `<details class="command-details">` with a `command-row` as `<summary>`, content in `command-panel` |
| `toggle-row` | Bordered row: text left, `toggle` right |
| `chips` + `chip` | Single choice as pills (`<label class="chip"><input type="radio">…`) |
| `segmented` + `segment` | Button group; the active one has `aria-pressed="true"` |
| `rows` + `row-entry` | Repeating input rows (add/remove) |
| `preview` | Grey preview area |
| `copy-field` (+ `copy-field-secret`) | Read-only value with a copy button (`data-copy="…"`), e.g. URLs and keys |
| `code-block` (+ `code-block-title`) | Code example that keeps line breaks (`<pre>`) |
| `split` | Two columns (form and preview) that stack on small screens |
| `badge-soft` (+ `-running`, `-stopped`, `-error`), `badge-dot` | Status badge |
| `pill-count` | Small counter pill, e.g. "8/8 active" |
| `beta` | Beta marker |
| `alert` + `alert-error` / `alert-success` | Messages |
| `list` | Plain list with separators |
| `table` (+ `num` on cells) | Data table |
| `gauge` (template `gauge`) | Tachometer 0–100 with needle; green/yellow/red |
| `meter` + `meter-track`, `meter-fill`, `meter-fill-high` | Horizontal load bar (SVG) |
| `pagination` + `page-btn`, `page-gap` | Page numbers; use the `pagination` template |
| `datepicker` (`data-range-picker`) | Date range calendar; see the custom range in admin.html for the markup |
| `muted`, `mono`, `num`, `check`, `icon` | Text helpers |

## Example

```html
<section class="box">
  <header class="box-head">
    <h2>{{t "module.economy.settings.title"}}</h2>
    <span class="box-meta">{{t "module.economy.settings.meta"}}</span>
  </header>
  <div class="box-body">
    <form class="form" hx-post="…" hx-target="#flash">
      <label class="field">{{t "module.economy.currency"}}
        <input name="currency" class="input-small">
        <span class="hint">{{t "module.economy.currency_hint"}}</span>
      </label>
      <label class="toggle-row">
        <span><strong>{{t "module.economy.daily"}}</strong><span class="hint">{{t "module.economy.daily_hint"}}</span></span>
        <input type="checkbox" class="toggle" name="daily" value="true">
      </label>
      <div><button type="submit" class="btn btn-primary">{{t "action.save"}}</button></div>
    </form>
  </div>
</section>
```
