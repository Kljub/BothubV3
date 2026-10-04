// Sends the CSRF token with every htmx request. The API checks it.
document.addEventListener('htmx:configRequest', (event) => {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta && meta.content) {
    event.detail.headers['X-CSRF-Token'] = meta.content;
  }
});

// Dialogs: [data-open-dialog="<id>"] opens, [data-close-dialog] closes the
// surrounding dialog. A click on the backdrop closes it too.
document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-open-dialog]');
  if (opener) {
    const dialog = document.getElementById(opener.dataset.openDialog);
    if (dialog && !dialog.open) dialog.showModal();
    // data-settings-open="<section id>": the settings popup opens on that tab.
    if (dialog && opener.dataset.settingsOpen) dialog.querySelector(`[data-settings-tab="${opener.dataset.settingsOpen}"]`)?.click();
    return;
  }
  if (event.target.closest('[data-close-dialog]')) {
    event.target.closest('dialog')?.close();
    return;
  }
  if (event.target instanceof HTMLDialogElement) {
    event.target.close();
  }
});

// Server asks to close dialogs (e.g. after adding a bot). Forms inside are reset.
document.addEventListener('bothub:close-dialogs', () => {
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    dialog.close();
    dialog.querySelectorAll('form').forEach((form) => form.reset());
    dialog.querySelectorAll('[id$="-error"]').forEach((el) => el.replaceChildren());
  });
});

// After an AJAX page load: keep <html lang> in sync and close open menus.
document.addEventListener('htmx:afterSettle', () => {
  const app = document.querySelector('.app[data-locale]');
  if (app) document.documentElement.lang = app.dataset.locale;
});
// Dropdown menus (bot switcher, user menu, language): a click outside or
// Escape closes them.
const MENUS = 'details.bot-switch[open], details.lang-switch[open], details.user-menu[open]';
document.addEventListener('click', (event) => {
  document.querySelectorAll(MENUS).forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll(MENUS).forEach((menu) => {
    menu.open = false;
  });
});

// Sidebar search filters the navigation entries.
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-nav-filter]');
  if (!input) return;
  const query = input.value.trim().toLowerCase();
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((item) => {
    item.hidden = query !== '' && !item.textContent.toLowerCase().includes(query);
  });
});

// Chart hover layer: crosshair, dot and tooltip at the nearest sample.
// Points come from data-chart-points as [[x, y, time, value], ...] in viewBox units.
function initChart(chart) {
  if (chart.dataset.chartReady) return;
  chart.dataset.chartReady = '1';

  const svg = chart.querySelector('svg');
  const hit = chart.querySelector('.chart-hit');
  const crosshair = chart.querySelector('.chart-crosshair');
  const dot = chart.querySelector('.chart-dot');
  const tooltip = chart.querySelector('.chart-tooltip');
  let points;
  try {
    points = JSON.parse(chart.dataset.chartPoints || '[]');
  } catch {
    return;
  }
  if (!svg || !hit || points.length === 0) return;

  const hide = () => {
    crosshair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };

  hit.addEventListener('pointermove', (event) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());

    let best = points[0];
    for (const p of points) {
      if (Math.abs(p[0] - pt.x) < Math.abs(best[0] - pt.x)) best = p;
    }
    const [x, y, time, value] = best;

    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    crosshair.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');

    tooltip.replaceChildren();
    const t = document.createElement('span');
    t.className = 'chart-tooltip-time';
    t.textContent = time;
    const v = document.createElement('strong');
    v.textContent = value;
    tooltip.append(t, v);
    tooltip.hidden = false;

    // Position in CSS pixels relative to the chart; flip near the right edge.
    const screen = new DOMPoint(x, y).matrixTransform(ctm);
    const box = chart.getBoundingClientRect();
    const left = screen.x - box.left;
    const top = screen.y - box.top;
    const flip = left > box.width - 160;
    tooltip.style.left = `${flip ? left - tooltip.offsetWidth - 12 : left + 12}px`;
    tooltip.style.top = `${Math.max(0, top - tooltip.offsetHeight - 8)}px`;
  });
  hit.addEventListener('pointerleave', hide);
}

const initCharts = (root) => root.querySelectorAll('.chart[data-chart-points]').forEach(initChart);
document.addEventListener('DOMContentLoaded', () => initCharts(document));
document.addEventListener('htmx:load', (event) => initCharts(event.detail.elt));

// Theme select in the settings dialog applies at once, before the server answers.
document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-theme-select]');
  if (!select) return;
  document.querySelectorAll('[data-theme]').forEach((el) => { el.dataset.theme = select.value; });
});

// Settings dialog search: while searching, every tab shows its matching rows;
// cards, group titles and tabs without a match are hidden.
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-settings-filter]');
  if (!input) return;
  const dialog = input.closest('dialog');
  const query = input.value.trim().toLowerCase();
  dialog.classList.toggle('is-searching', query !== '');
  dialog.querySelectorAll('[data-setting]').forEach((row) => {
    // Label, hint and shown value count, not an opened form inside the row.
    const parts = row.querySelectorAll('.settings-row-text, .settings-value');
    const text = (parts.length ? [...parts].map((el) => el.textContent).join(' ') : row.textContent).toLowerCase();
    row.hidden = query !== '' && !text.includes(query);
  });
  dialog.querySelectorAll('.settings-card').forEach((card) => {
    const rows = card.querySelectorAll('[data-setting]');
    card.hidden = rows.length > 0 && [...rows].every((row) => row.hidden);
    const title = card.previousElementSibling;
    if (title?.classList.contains('settings-group')) title.hidden = card.hidden;
  });
  // Tabs: all with a match while searching, afterwards the current tab again.
  const active = dialog.querySelector('[data-settings-tab][aria-current="page"]')?.dataset.settingsTab;
  dialog.querySelectorAll('.settings-content').forEach((section) => {
    section.hidden = query !== '' ? !section.querySelector('[data-setting]:not([hidden])') : section.id !== active;
  });
  const empty = dialog.querySelector('[data-settings-empty]');
  if (empty) empty.hidden = query === '' || [...dialog.querySelectorAll('.settings-content')].some((section) => !section.hidden);
});

// Expandable rows: [data-expand] shows/hides the next sibling and asks it to
// load its content once (hx-trigger="bothub:expand once").
document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-expand]');
  if (!btn) return;
  const panel = btn.closest('.cmdhub-main')?.nextElementSibling;
  if (!panel) return;
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open && window.htmx) htmx.trigger(panel, 'bothub:expand');
});

// Share code: [data-share-url] loads the command and copies its graph as JSON.
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-share-url]');
  if (!btn) return;
  const label = btn.querySelector('span');
  const before = label?.textContent;
  try {
    const res = await fetch(btn.dataset.shareUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const cmd = await res.json();
    await navigator.clipboard.writeText(JSON.stringify(cmd.graph));
    if (label) label.textContent = btn.dataset.shareDone;
  } catch {
    if (label) label.textContent = '⚠';
  }
  setTimeout(() => { if (label) label.textContent = before; }, 1600);
});

// Save bar: forms marked data-savebar save through one bar at the bottom.
// A form is dirty when its values differ from what was loaded; Discard puts
// them back, Save submits every dirty form. Leaving the page with changes is
// blocked and the bar shakes.
document.documentElement.classList.add('js');
const savebar = () => document.getElementById('savebar');
const formState = (form) => {
  const parts = [];
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.type === 'submit') continue;
    parts.push(el.name + '=' + ((el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value));
  }
  return parts.join('&');
};
const snapshot = (form) => { form.dataset.saved = formState(form); form.classList.remove('is-dirty'); };
const dirtyForms = () => [...document.querySelectorAll('form[data-savebar].is-dirty')];
const updateSavebar = () => { const bar = savebar(); if (bar) bar.hidden = dirtyForms().length === 0; };
const trackForms = (root) => {
  root.querySelectorAll?.('form[data-savebar]').forEach((form) => { if (form.dataset.saved === undefined) snapshot(form); });
  if (root.matches?.('form[data-savebar]') && root.dataset.saved === undefined) snapshot(root);
  updateSavebar();
};
['input', 'change'].forEach((type) => document.addEventListener(type, (event) => {
  const form = event.target.closest?.('form[data-savebar]');
  if (!form) return;
  form.classList.toggle('is-dirty', formState(form) !== form.dataset.saved);
  updateSavebar();
}));
document.addEventListener('DOMContentLoaded', () => trackForms(document));
document.addEventListener('htmx:load', (event) => trackForms(event.detail.elt));
document.addEventListener('htmx:afterRequest', (event) => {
  const form = event.detail.elt?.closest?.('form[data-savebar]');
  if (form && event.detail.successful) { snapshot(form); updateSavebar(); }
  // A refused switch (e.g. name clash) flips back to what the server has.
  // Errors come back as a flash message retargeted to #flash.
  const toggle = event.detail.elt?.closest?.('form.cmdhub-toggle');
  const refused = event.detail.failed || Boolean(event.detail.xhr?.getResponseHeader('HX-Retarget'));
  if (toggle && refused) toggle.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = !cb.checked; });
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-savebar-discard]')) {
    dirtyForms().forEach((form) => {
      form.reset();
      form.querySelectorAll('input, select, textarea').forEach((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
      form.classList.remove('is-dirty');
    });
    updateSavebar();
  } else if (event.target.closest('[data-savebar-save]')) {
    dirtyForms().forEach((form) => (form.reportValidity() ? form.requestSubmit() : null));
  }
});
const nudgeSavebar = () => {
  const bar = savebar();
  if (!bar) return;
  bar.classList.remove('is-shaking');
  void bar.offsetWidth;
  bar.classList.add('is-shaking');
};
// Boosted links and page loads while something is unsaved.
document.addEventListener('htmx:beforeRequest', (event) => {
  if (event.detail.boosted && dirtyForms().length) {
    event.preventDefault();
    nudgeSavebar();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirtyForms().length) { event.preventDefault(); event.returnValue = ''; }
});

// Card search: data-card-filter="<grid id>" filters children by data-filter-text.
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-card-filter]');
  if (!input) return;
  const query = input.value.trim().toLowerCase();
  document.getElementById(input.dataset.cardFilter)?.querySelectorAll('[data-filter-text]').forEach((card) => {
    card.hidden = query !== '' && !card.dataset.filterText.toLowerCase().includes(query);
  });
});

// Live preview: data-preview="<element id>" mirrors the input value.
// Character counter: data-counter="<element id>" shows length / maxlength.
function updateMirrors(root) {
  root.querySelectorAll('[data-preview]').forEach((input) => {
    const target = document.getElementById(input.dataset.preview);
    if (target) target.textContent = input.value;
  });
  root.querySelectorAll('[data-counter]').forEach((input) => {
    const target = document.getElementById(input.dataset.counter);
    if (target) target.textContent = `${input.value.length}/${input.maxLength}`;
  });
}
document.addEventListener('input', (event) => {
  if (event.target.matches('[data-preview], [data-counter]')) updateMirrors(event.target.parentElement);
});

// Repeating rows: [data-add-row] clones the form's <template data-row-template>
// into [data-rows]; [data-remove-row] removes its row.
document.addEventListener('click', (event) => {
  const add = event.target.closest('[data-add-row]');
  if (add) {
    const form = add.closest('form');
    const tpl = form.querySelector('template[data-row-template]');
    form.querySelector('[data-rows]').append(tpl.content.cloneNode(true));
    // A save-bar form with a new row has unsaved changes (auto-saving forms wait for input).
    if (form.matches('[data-savebar]')) {
      form.classList.toggle('is-dirty', formState(form) !== form.dataset.saved);
      updateSavebar();
    }
    return;
  }
  const row = event.target.closest('[data-remove-row]')?.closest('.row-entry');
  if (!row) return;
  const form = row.closest('form');
  row.remove();
  // Removing a row changes the form: auto-saving forms save, save-bar forms turn dirty.
  form?.dispatchEvent(new Event('change', { bubbles: true }));
});

// Forms marked data-reset-on="<event>" are cleared when the server sends that event.
document.addEventListener('bothub:reset-forms', () => {
  document.querySelectorAll('form[data-reset-on="bothub:reset-forms"]').forEach((form) => form.reset());
});

// Cooldown ring: counts down to data-reset-at, then asks htmx to reload the card.
function tickCooldowns() {
  const now = Date.now();
  document.querySelectorAll('.cooldown[data-reset-at]').forEach((el) => {
    const reset = Date.parse(el.dataset.resetAt);
    const windowMs = Number(el.dataset.window) * 1000;
    const left = Math.max(0, reset - now);
    const ring = el.querySelector('.cooldown-ring');
    if (ring) ring.setAttribute('stroke-dashoffset', String(100 - (left / windowMs) * 100));
    const secs = Math.ceil(left / 1000);
    el.querySelector('.cooldown-text').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (left === 0 && !el.dataset.done) {
      el.dataset.done = '1';
      htmx.trigger(el, 'bothub:cooldown-done');
    }
  });
}
setInterval(tickCooldowns, 1000);

document.addEventListener('DOMContentLoaded', () => { updateMirrors(document); tickCooldowns(); });
document.addEventListener('htmx:load', (event) => { updateMirrors(event.detail.elt); tickCooldowns(); });

// Consoles stick to the newest line (bottom) unless the user scrolled up;
// then a refresh keeps the position.
const consoleScroll = new Map(); // element id -> scrollTop, or null for bottom
document.addEventListener('htmx:beforeSwap', (event) => {
  event.detail.target.querySelectorAll?.('[data-scroll-bottom]').forEach((el) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    consoleScroll.set(event.detail.target.id, atBottom ? null : el.scrollTop);
  });
});
function scrollConsoles(root) {
  root.querySelectorAll('[data-scroll-bottom]').forEach((el) => {
    const owner = el.closest('[id]');
    const saved = owner ? consoleScroll.get(owner.id) : undefined;
    el.scrollTop = saved == null ? el.scrollHeight : saved;
  });
}
document.addEventListener('DOMContentLoaded', () => scrollConsoles(document));
document.addEventListener('htmx:load', (event) => scrollConsoles(event.detail.elt));

// Popup navigation (admin settings): mark the clicked section and filter by search.
document.addEventListener('click', (event) => {
  const item = event.target.closest('[data-dialog-section]');
  if (!item) return;
  item.parentElement.querySelectorAll('[data-dialog-section]').forEach((el) => el.removeAttribute('aria-current'));
  item.setAttribute('aria-current', 'page');
});
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-dialog-nav-filter]');
  if (!input) return;
  const query = input.value.trim().toLowerCase();
  input.parentElement.querySelectorAll('[data-dialog-section]').forEach((el) => {
    el.hidden = query !== '' && !el.textContent.toLowerCase().includes(query);
  });
});

// Settings popup tabs: [data-settings-tab="<section id>"] shows that section.
document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-settings-tab]');
  if (!tab) return;
  const dialog = tab.closest('dialog');
  // A tab click ends a search: back to the normal one-tab view.
  const search = dialog.querySelector('[data-settings-filter]');
  if (search && search.value) {
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  }
  dialog.querySelectorAll('[data-settings-tab]').forEach((el) => el.removeAttribute('aria-current'));
  tab.setAttribute('aria-current', 'page');
  dialog.querySelectorAll('.settings-content').forEach((el) => { el.hidden = el.id !== tab.dataset.settingsTab; });
});

// Date range picker ([data-range-picker]), design per the user's reference:
// head with the selected dates written out, month row with ▲/▼, 6-week grid
// (Monday first, other months dimmed). Two clicks pick the range in any
// order; days in between are shown in blue. Hidden inputs "from"/"to" receive
// "YYYY-MM-DDTHH:MM": start day 00:00 and end day 23:59.
function initRangePicker(root) {
  if (root.dataset.pickerReady) return;
  root.dataset.pickerReady = '1';

  const lang = document.documentElement.lang || 'en';
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (v) => (v ? new Date(v) : null);
  const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const min = parse(root.dataset.min);
  const max = parse(root.dataset.max);
  let start = root.dataset.from ? dayOnly(parse(root.dataset.from)) : null;
  let end = root.dataset.to ? dayOnly(parse(root.dataset.to)) : null;
  const anchor = end || max || new Date();
  let view = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  let collapsed = false;

  const cal = root.querySelector('.datepicker-calendar');
  const hiddenFrom = root.querySelector('input[name="from"]');
  const hiddenTo = root.querySelector('input[name="to"]');

  const minDay = min ? dayKey(min) : '';
  const maxDay = max ? dayKey(max) : '';
  const fmtShort = new Intl.DateTimeFormat(lang, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtLong = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' });

  function sync() {
    // Whole days: start 00:00, end 23:59; a single click means one day.
    const last = end || start;
    hiddenFrom.value = start ? `${dayKey(start)}T00:00` : '';
    hiddenTo.value = last ? `${dayKey(last)}T23:59` : '';
    root.querySelector('[data-range-label="from"]').textContent = start ? fmtShort.format(start) : '–';
    root.querySelector('[data-range-label="to"]').textContent = last ? fmtShort.format(last) : '–';
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    cal.replaceChildren();
    if (collapsed) cal.setAttribute('data-collapsed', '');
    else cal.removeAttribute('data-collapsed');

    // Head: the selection written out, plus the collapse button.
    const head = el('div', 'datepicker-selected');
    let text = '–';
    if (start && end && dayKey(start) !== dayKey(end)) text = `${fmtLong.format(start)} – ${fmtLong.format(end)}`;
    else if (start) text = fmtLong.format(start);
    const toggle = el('button', 'datepicker-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', root.dataset.labelToggle || '');
    toggle.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    toggle.addEventListener('click', () => { collapsed = !collapsed; render(); });
    head.append(el('span', '', text), toggle);

    const body = el('div', 'datepicker-body');
    const monthRow = el('div', 'datepicker-head');
    const nav = el('div', 'datepicker-nav');
    const prev = el('button', '', '▲');
    const next = el('button', '', '▼');
    prev.type = next.type = 'button';
    prev.setAttribute('aria-label', root.dataset.labelPrev);
    next.setAttribute('aria-label', root.dataset.labelNext);
    prev.disabled = minDay !== '' && dayKey(view) <= minDay;
    next.disabled = maxDay !== '' && dayKey(new Date(view.getFullYear(), view.getMonth() + 1, 0)) >= maxDay;
    prev.addEventListener('click', () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); render(); });
    next.addEventListener('click', () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); render(); });
    nav.append(prev, next);
    monthRow.append(el('span', 'datepicker-title', new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(view)), nav);

    const grid = el('div', 'datepicker-grid');
    grid.setAttribute('role', 'grid');
    const wd = new Intl.DateTimeFormat(lang, { weekday: 'short' });
    for (let i = 0; i < 7; i++) {
      grid.append(el('span', 'datepicker-weekday', wd.format(new Date(2024, 0, 1 + i)).replace('.', ''))); // 2024-01-01 is a Monday
    }

    const today = dayKey(new Date());
    const startKey = start ? dayKey(start) : '';
    const endKey = end ? dayKey(end) : '';
    const first = new Date(view.getFullYear(), view.getMonth(), 1 - ((view.getDay() + 6) % 7));
    for (let i = 0; i < 42; i++) {
      const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      const key = dayKey(date);
      const cell = el('span', 'datepicker-cell');
      const b = el('button', 'datepicker-day', String(date.getDate()));
      b.type = 'button';
      b.setAttribute('aria-label', fmtLong.format(date));
      b.disabled = Boolean((minDay && key < minDay) || (maxDay && key > maxDay));
      if (date.getMonth() !== view.getMonth()) b.classList.add('datepicker-day-outside');
      if (key === today) b.classList.add('datepicker-day-today');
      const selected = key === startKey || key === endKey;
      if (selected) b.classList.add('datepicker-day-selected');
      b.setAttribute('aria-selected', String(selected));
      if (startKey && endKey && startKey !== endKey) {
        if (key === startKey) cell.classList.add('datepicker-cell-start');
        if (key === endKey) cell.classList.add('datepicker-cell-end');
        if (key > startKey && key < endKey) cell.classList.add('datepicker-cell-in-range');
      }
      b.addEventListener('click', () => {
        // First click: one end. Second click: the other end, in any order;
        // the earlier date becomes the start. A third click starts over.
        if (!start || end) {
          start = date;
          end = null;
        } else if (date < start) {
          end = start;
          start = date;
        } else {
          end = date;
        }
        if (date.getMonth() !== view.getMonth()) view = new Date(date.getFullYear(), date.getMonth(), 1);
        sync();
        render();
      });
      cell.append(b);
      grid.append(cell);
    }
    body.append(monthRow, grid);
    cal.append(head, body);
  }

  sync();
  render();
  floatBesideDialog(cal);
}

// In a settings popup the calendar floats right of the popup when the
// viewport has room; the popup moves left by half the calendar width.
function floatBesideDialog(cal) {
  const dialog = cal.closest('dialog.settings-dialog');
  if (!dialog) return;
  const gap = 12;
  const fits = () => dialog.offsetWidth + gap + cal.offsetWidth + 32 <= window.innerWidth;
  const place = () => {
    const on = cal.isConnected && fits();
    cal.classList.toggle('datepicker-float', on);
    dialog.classList.toggle('side-open', on);
  };
  place();
  window.addEventListener('resize', place);
}

// Remove the side offset when the panel with the floating calendar is gone.
document.addEventListener('htmx:afterSettle', () => {
  document.querySelectorAll('dialog.side-open').forEach((d) => {
    if (!d.querySelector('.datepicker-float')) d.classList.remove('side-open');
  });
});
document.addEventListener('close', (event) => {
  if (event.target instanceof HTMLDialogElement) event.target.classList.remove('side-open');
}, true);

const initRangePickers = (root) => root.querySelectorAll('[data-range-picker]').forEach(initRangePicker);
document.addEventListener('DOMContentLoaded', () => initRangePickers(document));
document.addEventListener('htmx:load', (event) => initRangePickers(event.detail.elt));

// Passkeys (WebAuthn). The browser talks to /api/v1/auth/passkeys/* through the
// dashboard's /api proxy; the server verifies everything. Errors show in
// #passkey-error as the API's i18n text (data-error-* on the element).
const b64u = {
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer,
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

function passkeySupported() {
  return window.PublicKeyCredential !== undefined && navigator.credentials !== undefined;
}

function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  const o = { ...json, challenge: b64u.decode(json.challenge), user: { ...json.user, id: b64u.decode(json.user.id) } };
  o.excludeCredentials = (json.excludeCredentials || []).map((c) => ({ ...c, id: b64u.decode(c.id) }));
  return o;
}

function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  const o = { ...json, challenge: b64u.decode(json.challenge) };
  o.allowCredentials = (json.allowCredentials || []).map((c) => ({ ...c, id: b64u.decode(c.id) }));
  return o;
}

function credentialJSON(cred) {
  if (cred.toJSON) return cred.toJSON();
  const r = cred.response;
  const response = { clientDataJSON: b64u.encode(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b64u.encode(r.attestationObject);
    if (r.getTransports) response.transports = r.getTransports();
  } else {
    response.authenticatorData = b64u.encode(r.authenticatorData);
    response.signature = b64u.encode(r.signature);
    if (r.userHandle) response.userHandle = b64u.encode(r.userHandle);
  }
  return { id: cred.id, rawId: b64u.encode(cred.rawId), type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults() };
}

async function apiPost(url, body) {
  const meta = document.querySelector('meta[name="csrf-token"]');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(meta && meta.content ? { 'X-CSRF-Token': meta.content } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.key || 'error.passkey.failed');
  return data;
}

// Client texts: a JSON island in <head> (id=i18n-client) with the keys the
// scripts need in the current language.
function clientText(key) {
  try {
    return JSON.parse(document.getElementById('i18n-client')?.textContent || '{}')[key] || key;
  } catch {
    return key;
  }
}

function showPasskeyError(key) {
  const box = document.getElementById('passkey-error');
  if (!box) return;
  const alert = document.createElement('div');
  alert.className = 'alert alert-error';
  alert.textContent = clientText(key);
  box.replaceChildren(alert);
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-passkey-register]');
  if (!form) return;
  event.preventDefault();
  document.getElementById('passkey-error')?.replaceChildren();
  try {
    const begin = await apiPost('/api/v1/auth/passkeys/register/begin');
    const cred = await navigator.credentials.create({ publicKey: creationOptions(begin.options.publicKey) });
    const q = new URLSearchParams({ ceremony: begin.ceremony, name: form.elements.name.value.trim() });
    await apiPost('/api/v1/auth/passkeys/register/finish?' + q, credentialJSON(cred));
    form.reset();
    htmx.ajax('GET', '/account/passkeys', { target: '#passkeys', swap: 'outerHTML' });
  } catch (err) {
    // NotAllowedError = the user cancelled the browser dialog.
    showPasskeyError(err.name === 'NotAllowedError' ? 'error.passkey.cancelled' : err.message);
  }
});

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-passkey-login]');
  if (!btn) return;
  document.getElementById('passkey-error')?.replaceChildren();
  try {
    const begin = await apiPost('/api/v1/auth/passkeys/login/begin');
    const cred = await navigator.credentials.get({ publicKey: requestOptions(begin.options.publicKey) });
    await apiPost('/api/v1/auth/passkeys/login/finish?ceremony=' + encodeURIComponent(begin.ceremony), credentialJSON(cred));
    window.location.href = '/';
  } catch (err) {
    showPasskeyError(err.name === 'NotAllowedError' ? 'error.passkey.cancelled' : err.message);
  }
});

// Show passkey controls only where the browser supports them.
function initPasskeyUI(root) {
  const ok = passkeySupported();
  root.querySelectorAll('[data-passkey-login]').forEach((el) => { el.hidden = !ok; });
  root.querySelectorAll('[data-passkey-register]').forEach((el) => { el.hidden = !ok; });
  root.querySelectorAll('[data-passkey-unsupported]').forEach((el) => { el.hidden = ok; });
}
document.addEventListener('DOMContentLoaded', () => initPasskeyUI(document));
document.addEventListener('htmx:load', (event) => initPasskeyUI(event.detail.elt));

// Copy buttons: [data-copy] puts its text on the clipboard; the inner <span>
// shows data-copy-done for a moment.
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-copy]');
  if (!btn) return;
  event.preventDefault();
  const label = btn.querySelector('span');
  const before = label?.textContent;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    if (label && btn.dataset.copyDone) label.textContent = btn.dataset.copyDone;
  } catch {
    if (label) label.textContent = '⚠';
  }
  setTimeout(() => { if (label) label.textContent = before; }, 1600);
});

// Copy buttons: [data-copy] puts its value on the clipboard and shows
// data-copy-done for a moment.
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const old = btn.textContent;
    btn.textContent = btn.dataset.copyDone || old;
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch { /* clipboard blocked: the value stays visible to copy by hand */ }
});

// Webhook form: the example request follows the event ID and the key switch.
document.addEventListener('input', (event) => updateWebhookExample(event.target.closest('[data-webhook-form]')));
document.addEventListener('change', (event) => updateWebhookExample(event.target.closest('[data-webhook-form]')));
function updateWebhookExample(form) {
  if (!form) return;
  const pre = form.parentElement.querySelector('[data-webhook-example]');
  if (!pre) return;
  const id = form.querySelector('[name="event_id"]').value.trim().toLowerCase();
  const key = form.querySelector('[name="require_key"]').checked;
  const lines = [`curl -X POST "${pre.dataset.base}${id}" \\`, '  -H "Content-Type: application/json" \\'];
  if (key) lines.push('  -H "Authorization: YOUR_API_KEY" \\');
  lines.push(`  -d '{"variables":{"message":"Hello from a webhook"}}'`);
  pre.textContent = lines.join('\n');
}

// Placeholder chips: [data-insert] puts its text into the last focused
// [data-vars-target] field (e.g. bot status texts) and saves like typing.
let lastVarsTarget = null;
document.addEventListener('focusin', (event) => {
  if (event.target.matches?.('[data-vars-target]')) lastVarsTarget = event.target;
});
document.addEventListener('mousedown', (event) => {
  if (event.target.closest('[data-insert]')) event.preventDefault(); // keep the cursor in the field
});
document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-insert]');
  if (!btn) return;
  const form = btn.closest('form');
  let input = lastVarsTarget && document.contains(lastVarsTarget) && (!form || form.contains(lastVarsTarget)) ? lastVarsTarget : null;
  input ??= form?.querySelector('[data-vars-target]');
  if (!input) return;
  const text = btn.dataset.insert;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const max = input.maxLength > 0 ? input.maxLength : Infinity;
  input.value = (input.value.slice(0, start) + text + input.value.slice(end)).slice(0, max);
  input.focus();
  input.setSelectionRange(start + text.length, start + text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
