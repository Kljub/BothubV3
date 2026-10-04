// Module settings forms (templates/partials/module_settings.html):
// - fields with data-show-if='{"field": ["value", …]}' are shown only while
//   another field of the same form has one of the values (checkboxes count
//   as "true"/"false");
// - role and channel fields (select[data-pick]) get the picker of the node
//   editor (permissions.js); the select stays the form value underneath;
//   data-guild limits the picker to one server;
// - permissions fields ([data-perm-block]) get the permissions block, its
//   JSON goes into the hidden input next to it. data-no-everyone leaves out
//   @everyone, data-no-badge the open/restricted badge; data-texts="<prefix>" takes the card texts from
//   <prefix>.who and <prefix>.<list> / <list>_hint / <list>_empty where those exist.
// - image fields ([data-image-field], plugins): the chosen file is uploaded at
//   once (data-image-upload), the hidden input gets the stored name; the form
//   save keeps it. "Remove" empties the field.
(function () {
  'use strict';

  function valueOf(form, name) {
    const el = form.elements[name];
    if (!el) return null;
    if (el.type === 'checkbox') return String(el.checked);
    return el.value;
  }

  function applyShowIf(root) {
    root.querySelectorAll('[data-show-if]').forEach((el) => {
      let cond;
      try { cond = JSON.parse(el.dataset.showIf); } catch { return; }
      const form = el.closest('form');
      if (!form) return;
      el.hidden = !Object.entries(cond).every(([name, values]) => {
        const v = valueOf(form, name);
        return v === null || values.includes(v);
      });
    });
  }

  // ---- pickers ----

  // Data of the pickers: attributes of a hidden element (hx-boost drops <script> blocks).
  const json = (attr) => {
    const el = document.querySelector(`[${attr}]`);
    if (!el) return null;
    try { return JSON.parse(el.getAttribute(attr)); } catch { return null; }
  };

  function context() {
    const data = json('data-picker-data');
    const texts = json('data-picker-texts') || {};
    if (!data || !window.BotHubPermissions) return null;
    const t = (key, params = {}) => String(texts[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m));
    const byId = Object.fromEntries((data.guilds || []).map((g) => [g.id, g]));
    const source = {
      guilds: async () => (data.guilds || []).map((g) => ({ id: g.id, name: g.name, iconUrl: g.iconUrl })),
      items: async (gid, part) => (byId[gid]?.[part] || []),
    };
    return { t, source, data };
  }

  /** A role or channel <select>: chips + "+ Add" on top, the select hidden but still the form value. */
  function enhanceSelect(select, ctx) {
    if (select.dataset.pickReady) return;
    select.dataset.pickReady = '1';
    const kind = select.dataset.pick;
    const multiple = select.multiple;
    const options = () => [...select.options].filter((o) => o.value);
    const entryOf = (o) => {
      const [guild, id] = o.value.split(':');
      return { id, guild, name: o.dataset.name || o.textContent.replace(/^[#@🔊📁]\s*/u, ''), type: o.dataset.type };
    };
    const value = options().filter((o) => o.selected).map(entryOf);
    const types = (select.dataset.channelTypes || '').split(',').filter(Boolean);
    const label = select.closest('label')?.firstChild?.textContent?.trim() || '';
    // data-guild: a field of one server picks from that server only.
    const only = select.dataset.guild;
    const source = only ? { guilds: async () => (await ctx.source.guilds()).filter((g) => g.id === only), items: ctx.source.items } : ctx.source;
    const widget = window.BotHubPermissions.field({
      kind, multiple, value, t: ctx.t, source, channelTypes: types, title: label,
      onChange: (entries) => {
        const keys = new Set(entries.map((e) => `${e.guild}:${e.id}`));
        // An entry added by ID that the select does not list yet.
        for (const e of entries) {
          if (!options().some((o) => o.value === `${e.guild}:${e.id}`)) {
            const o = new Option(e.name || e.id, `${e.guild}:${e.id}`);
            o.dataset.name = e.name || e.id;
            select.append(o);
          }
        }
        for (const o of [...select.options]) o.selected = keys.has(o.value);
        if (!multiple && !keys.size && select.options[0]?.value === '') select.options[0].selected = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
    select.classList.add('pick-native');
    select.closest('label, .field')?.querySelector('.pick-native-hint')?.setAttribute('hidden', '');
    select.after(widget);
  }

  /** A permissions field: the block writes its JSON into the hidden input. */
  function enhanceBlock(host, ctx) {
    if (host.dataset.pickReady) return;
    host.dataset.pickReady = '1';
    const input = host.parentElement.querySelector('input[type=hidden]');
    let value = {};
    try { value = JSON.parse(input.value || '{}') || {}; } catch { value = {}; }
    let lists = null;
    try { lists = JSON.parse(host.dataset.lists || 'null'); } catch { lists = null; }
    // The API keeps id and guild only; names come from the server data.
    for (const [list, part] of [['allowed_roles', 'roles'], ['banned_roles', 'roles'], ['banned_channels', 'channels']]) {
      for (const e of Array.isArray(value[list]) ? value[list] : []) {
        const item = (ctx.data.guilds || []).find((g) => g.id === e.guild)?.[part]?.find((x) => x.id === e.id);
        if (item && !e.name) Object.assign(e, { name: item.name }, item.type ? { type: item.type } : {});
      }
    }
    // Own texts per list, when the prefix has them.
    const prefix = host.dataset.texts;
    const own = (key) => (prefix && ctx.t(`${prefix}.${key}`) !== `${prefix}.${key}` ? ctx.t(`${prefix}.${key}`) : undefined);
    const texts = {};
    for (const s of window.BotHubPermissions.BLOCK_LISTS) texts[s.list] = { title: own(s.list), hint: own(`${s.list}_hint`), empty: own(`${s.list}_empty`) };
    host.append(window.BotHubPermissions.block({
      value, t: ctx.t, source: ctx.source, title: '', lists: lists && lists.length ? lists : null,
      noEveryone: 'noEveryone' in host.dataset, badge: !('noBadge' in host.dataset), texts, who: own('who'),
      permissionGroups: ctx.data.permissionGroups || [],
      onChange: (v) => {
        input.value = JSON.stringify(v);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    }));
  }

  function enhance(root) {
    const ctx = context();
    if (!ctx) return;
    root.querySelectorAll('select[data-pick]').forEach((s) => enhanceSelect(s, ctx));
    root.querySelectorAll('[data-perm-block]').forEach((h) => enhanceBlock(h, ctx));
  }

  function apply(root) {
    applyShowIf(root);
    enhance(root);
  }

  document.addEventListener('change', (ev) => {
    const form = ev.target.closest && ev.target.closest('.modset-form');
    if (form) applyShowIf(form);
    if (ev.target.matches && ev.target.matches('input[type=file][data-image-upload]')) upload(ev.target);
  });

  // ---- variable picker (field "vars") ----
  // The clipboard icon inside a text field opens the field's list right below
  // that text field; a placeholder goes in at its cursor.

  let varTarget = null;

  function insertAt(field, token) {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.value = field.value.slice(0, start) + token + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + token.length, start + token.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function closeVars() {
    document.querySelectorAll('.modset-vars-pop:not([hidden])').forEach((p) => { p.hidden = true; });
    document.querySelectorAll('.modset-var-tool[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    varTarget = null;
  }

  document.addEventListener('click', (ev) => {
    const tool = ev.target.closest && ev.target.closest('.modset-var-tool');
    if (tool) {
      ev.preventDefault(); // inside a <label>: do not jump into the field first
      const open = tool.getAttribute('aria-expanded') === 'true';
      closeVars();
      if (open) return;
      const wrap = tool.closest('.modset-var-wrap');
      const pop = tool.closest('.modset-field')?.querySelector('.modset-vars-pop');
      if (!wrap || !pop) return;
      varTarget = wrap.querySelector('textarea, input');
      wrap.after(pop); // the list shows under the text field it belongs to
      pop.hidden = false;
      tool.setAttribute('aria-expanded', 'true');
      return;
    }
    const item = ev.target.closest && ev.target.closest('.modset-var');
    if (item) {
      ev.preventDefault();
      if (varTarget) insertAt(varTarget, item.dataset.token);
      closeVars();
      return;
    }
    if (!(ev.target.closest && ev.target.closest('.modset-vars-pop'))) closeVars();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeVars(); });

  // ---- choices fields: the summary shows the picks ----
  document.addEventListener('change', (ev) => {
    const drop = ev.target.closest && ev.target.closest('.choices-drop');
    if (!drop) return;
    const out = drop.querySelector('.choices-picked');
    out.replaceChildren(...[...drop.querySelectorAll('input:checked')].map((box) => {
      const chip = document.createElement('span');
      chip.className = 'badge-soft';
      chip.textContent = box.previousElementSibling?.textContent ?? box.value;
      return chip;
    }));
  });

  // ---- image fields ----

  const IMAGE_MAX = 2 * 1024 * 1024;
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  async function upload(input) {
    const field = input.closest('[data-image-field]');
    const file = input.files && input.files[0];
    if (!field || !file) return;
    const status = field.querySelector('[data-image-status]');
    const hint = status.dataset.hint || status.textContent;
    status.dataset.hint = hint;
    status.classList.remove('error-text');
    if (file.size > (Number(field.dataset.max) || IMAGE_MAX)) {
      status.textContent = status.dataset.tooBig;
      status.classList.add('error-text');
      input.value = '';
      return;
    }
    status.textContent = status.dataset.uploading;
    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch(input.dataset.imageUpload, { method: 'POST', body, headers: { 'X-CSRF-Token': csrf() }, credentials: 'same-origin' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.name) throw new Error(out.error || res.statusText);
      field.querySelector('input[type=hidden]').value = out.name;
      const img = field.querySelector('.modset-image-preview, .modset-audio-preview');
      img.src = out.url;
      img.hidden = false;
      field.querySelector('[data-image-clear]').hidden = false;
      status.textContent = hint;
    } catch (err) {
      status.textContent = String(err.message || err);
      status.classList.add('error-text');
    } finally {
      input.value = '';
    }
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-image-clear]');
    if (!btn) return;
    const field = btn.closest('[data-image-field]');
    field.querySelector('input[type=hidden]').value = '';
    const img = field.querySelector('.modset-image-preview, .modset-audio-preview');
    img.removeAttribute('src');
    img.hidden = true;
    btn.hidden = true;
  });
  document.addEventListener('htmx:afterSwap', (ev) => apply(ev.target));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(document));
  else apply(document);
})();
