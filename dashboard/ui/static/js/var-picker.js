// Variable picker: popup with search and categories (shared/variables.json),
// the Data Storage variables grouped like on their module page, and the
// variables of the current command. Used by the node editor, the message
// editor and the Message Builder page.
//
// BotHubVarPicker.open({ t, el, icon, catalog, graphVars, dataVarsUrl, mode, onPick })
//   mode 'insert' (default): onPick gets a placeholder like "{user.id}".
//   mode 'name': only variables a block can write; onPick gets the name
//   without braces ("var.coins", "Var1").
(() => {
  'use strict';

  const STYLES = ['f', 'F', 'd', 'D', 't', 'T', 'R'];
  const dataCache = new Map();

  async function loadDataVars(url) {
    if (!url) return [];
    if (!dataCache.has(url)) {
      dataCache.set(url, fetch(url, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d) => d.items || [])
        .catch(() => []));
    }
    return dataCache.get(url);
  }

  function open(ctx) {
    const { t, el, icon } = ctx;
    const mode = ctx.mode || 'insert';
    const overlay = el('div', 'bvp');
    const dialog = el('div', 'bvp-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('vars.title'));

    const head = el('header', 'bvp-head');
    const titles = el('div', 'bvp-titles');
    titles.append(el('strong', '', t(mode === 'name' ? 'vars.title_name' : 'vars.title')), el('span', 'bvp-sub', t(mode === 'name' ? 'vars.subtitle_name' : 'vars.subtitle')));
    const x = el('button', 'bform-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('builder.close'));
    x.addEventListener('click', close);
    head.append(titles, x);

    const search = el('input', 'bvp-search');
    search.type = 'search';
    search.placeholder = t('vars.search');
    search.setAttribute('aria-label', t('vars.search'));

    const body = el('div', 'bvp-body');
    const nav = el('nav', 'bvp-nav');
    const list = el('div', 'bvp-list');
    body.append(nav, list);
    dialog.append(head, search, body);
    overlay.append(dialog);
    document.body.append(overlay);

    const prevFocus = document.activeElement;
    function close() {
      overlay.remove();
      prevFocus?.focus?.();
    }
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
    overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });

    const pick = (token) => {
      close();
      ctx.onPick(mode === 'name' ? token.replace(/^\{|\}$/g, '') : token);
    };

    // Sections: [{ key, label, icon, items: [{ name, hint, token }] }]
    const sections = [];
    if (mode === 'insert') {
      for (const c of ctx.catalog?.categories || []) {
        sections.push({
          key: c.key, label: t(`vars.cat.${c.key}`), icon: c.icon,
          items: c.items.map((i) => ({ name: t(`vars.item.${i.id}`), hint: t(`vars.item.${i.id}_hint`), token: i.token })),
        });
      }
    }
    const own = (ctx.graphVars?.() || []).map((v) => {
      const token = v.startsWith('{') ? v : `{${v}}`;
      return { name: v.replace(/^\{|\}$/g, ''), hint: t('vars.own_hint'), token };
    }).filter((v) => mode === 'insert' || !/^\{(option_|user|server|channel|bot|message|command)/.test(v.token));
    sections.push({ key: 'own', label: t('vars.cat.own'), icon: 'grid', items: own });
    let active = 'all';

    function renderNav(dataSections) {
      nav.replaceChildren();
      const button = (key, label, iconName, count) => {
        const b = el('button', 'bvp-cat');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(active === key));
        b.append(icon(iconName), el('span', '', label));
        if (count !== undefined) b.append(el('span', 'bvp-count', String(count)));
        b.addEventListener('click', () => { active = key; renderNav(dataSections); renderList(dataSections); });
        nav.append(b);
      };
      const all = [...sections, ...dataSections];
      button('all', t('vars.cat.all'), 'grid', all.reduce((n, s) => n + s.items.length, 0));
      if (mode === 'insert') button('time-pick', t('vars.cat.pick_time'), 'clock');
      for (const s of sections) if (s.key !== 'own') button(s.key, s.label, s.icon, s.items.length);
      nav.append(el('div', 'bvp-nav-title', t('vars.cat.custom')));
      if (!dataSections.length) nav.append(el('div', 'bvp-nav-empty', t('vars.custom_empty')));
      for (const s of dataSections) button(s.key, s.label, 'folder', s.items.length);
      nav.append(el('div', 'bvp-nav-title', t('vars.cat.this_command')));
      button('own', t('vars.cat.own'), 'grid', own.length);
    }

    function row(item) {
      const b = el('button', 'bvp-item');
      b.type = 'button';
      const text = el('span', 'bvp-item-text');
      text.append(el('strong', '', item.name), el('span', 'bvp-item-hint', item.hint));
      b.append(text, el('code', 'bvp-token', item.token));
      b.addEventListener('click', () => pick(item.token));
      return b;
    }

    function renderTimePicker() {
      const box = el('div', 'bvp-time');
      const when = el('input');
      when.type = 'datetime-local';
      const style = el('select');
      for (const s of STYLES) {
        const o = el('option', '', t(`vars.time_style.${s}`));
        o.value = s;
        style.append(o);
      }
      const out = el('code', 'bvp-token');
      const insert = el('button', 'btn btn-primary btn-sm', t('vars.insert'));
      insert.type = 'button';
      const token = () => {
        const ms = when.value ? new Date(when.value).getTime() : NaN;
        return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style.value}>` : '';
      };
      const update = () => { out.textContent = token() || t('vars.time_empty'); insert.disabled = !token(); };
      when.addEventListener('input', update);
      style.addEventListener('change', update);
      insert.addEventListener('click', () => { const v = token(); if (v) { close(); ctx.onPick(v); } });
      const l1 = el('label', 'bfield', t('vars.time_when'));
      l1.append(when);
      const l2 = el('label', 'bfield', t('vars.time_style'));
      l2.append(style);
      box.append(el('p', 'bfield-hint', t('vars.time_hint')), l1, l2, out, insert);
      update();
      list.append(box);
    }

    function renderList(dataSections) {
      list.replaceChildren();
      if (active === 'time-pick') return renderTimePicker();
      const q = search.value.trim().toLowerCase();
      const shown = [...sections, ...dataSections].filter((s) => active === 'all' || q || s.key === active);
      let any = false;
      for (const s of shown) {
        const items = s.items.filter((i) => !q || `${i.name} ${i.hint} ${i.token}`.toLowerCase().includes(q));
        if (!items.length) continue;
        any = true;
        list.append(el('div', 'bvp-section', s.label));
        for (const i of items) list.append(row(i));
      }
      if (!any) list.append(el('p', 'bfield-hint', t('vars.none')));
    }

    let dataSections = [];
    search.addEventListener('input', () => renderList(dataSections));
    renderNav(dataSections);
    renderList(dataSections);
    search.focus();

    // Data Storage variables, grouped like on their module page.
    loadDataVars(ctx.dataVarsUrl).then((vars) => {
      const groups = new Map();
      for (const v of vars) {
        const g = v.group || t('vars.ungrouped');
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ name: v.name, hint: v.description || t(`data.shape.${v.owner}_${v.perServer}`), token: `{var.${v.key}}` });
      }
      dataSections = [...groups.entries()].map(([label, items], i) => ({ key: `data-${i}`, label, icon: 'folder', items }));
      if (!overlay.isConnected) return;
      renderNav(dataSections);
      renderList(dataSections);
    });
  }

  window.BotHubVarPicker = { open };
})();
