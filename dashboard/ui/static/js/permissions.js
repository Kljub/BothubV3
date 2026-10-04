// Role, channel and permission pickers and the permissions block (allowed
// roles, banned roles, required permissions, banned channels, optional
// "hide" switch). Shared by the node editor (builder.js, data from the API)
// and the module and plugin settings pages (data rendered into the page).
// Styles: components/bh-permissions.css. Icons: icons.js (window.BotHubIcons).
//
//   BotHubPermissions.block({ value, onChange, t, source, lists?, hide?, permissionGroups, pseudoRoles?, noEveryone?, badge?, texts?, who? })
//   BotHubPermissions.field({ kind: 'role'|'channel', multiple, value, onChange, t, source, channelTypes?, title?, hint? })
//
// source = { guilds(): Promise<[{id, name, iconUrl?}]>, items(guildId, 'roles'|'channels'): Promise<[…]> }
// Entries: roles/channels { id, guild, name, color?, type? }, permissions = keys like "manage_messages".
(function () {
  'use strict';

  const CHANNEL_ICON = { category: 'folder', text: 'hash', voice: 'volume', stage: 'volume', announcement: 'megaphone', forum: 'forum' };
  const SNOWFLAKE = /^[0-9]{17,20}$/;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function icon(name, cls = 'bicon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = (window.BotHubIcons || {})[name] || '';
    return svg;
  }

  /** The four lists of the block, in this order. */
  const BLOCK_LISTS = [
    { list: 'allowed_roles', icon: 'users', kind: 'role', add: 'builder.perm.add' },
    { list: 'banned_roles', icon: 'userX', kind: 'role', add: 'builder.perm.add_role' },
    { list: 'required_permissions', icon: 'key', kind: 'permission', add: 'builder.perm.add_permission' },
    { list: 'banned_channels', icon: 'hash', kind: 'channel', add: 'builder.perm.add_channel' },
  ];

  /**
   * One picker instance: cards with chips, an "+ Add" button each and one
   * popover at a time (servers -> roles/channels, or the permission list).
   * specs: [{ list, kind, icon, add, title?, hint?, empty?, multiple?, channelTypes? }]
   * get(list) / set(list, entries) read and write the lists.
   */
  function picker(opts) {
    const { t, source, specs, get, set } = opts;
    const pseudoRoles = opts.pseudoRoles || {};
    const root = el('div', opts.className || 'bperm');
    const rows = {};
    // { list, step: 'guilds'|'items', guild, search, idMode }; opts.keep (an object)
    // keeps it across re-renders, so an open popover stays open.
    let state = opts.keep?.state && opts.keep.state.list in Object.fromEntries(specs.map((x) => [x.list, 1])) ? opts.keep.state : null;
    const setState = (v) => { state = v; if (opts.keep) opts.keep.state = v; };

    const changed = () => { opts.onChange(); refresh(); };

    function chip(label, iconName, color, onRemove) {
      const c = el('span', 'bperm-chip');
      if (color !== undefined) {
        const dot = el('span', 'bpick-dot');
        if (color) dot.style.background = color;
        c.append(dot);
      } else if (iconName) c.append(icon(iconName, 'bicon bperm-chip-icon'));
      c.append(el('span', 'bperm-chip-label', label));
      const x = el('button', 'bperm-chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', t('builder.perm.remove', { name: label }));
      x.addEventListener('click', onRemove);
      c.append(x);
      return c;
    }

    for (const spec of specs) {
      const card = el('div', 'bperm-card');
      card.dataset.list = spec.list;
      if (spec.title !== '') {
        const ch = el('div', 'bperm-card-head');
        ch.append(icon(spec.icon, 'bicon bperm-icon'));
        const txt = el('div', 'bperm-card-text');
        txt.append(el('strong', '', spec.title ?? t(`builder.perm.${spec.list}`)));
        const hint = spec.hint ?? t(`builder.perm.${spec.list}_hint`);
        if (hint) txt.append(el('span', '', hint));
        ch.append(txt);
        card.append(ch);
      }
      const row = el('div', 'bperm-row');
      card.append(row);
      rows[spec.list] = { row, spec, card };
      root.append(card);
    }

    function refresh() {
      for (const { row, spec, card } of Object.values(rows)) {
        row.replaceChildren();
        const items = get(spec.list);
        for (const item of items) {
          const remove = () => {
            set(spec.list, get(spec.list).filter((x) => x !== item));
            changed();
            if (state?.list === spec.list) renderPicker();
          };
          if (spec.kind === 'permission') row.append(chip(t(`builder.permission.${item}`), 'key', undefined, remove));
          else if (spec.kind === 'role' && pseudoRoles[item.id]) row.append(chip(t(pseudoRoles[item.id]), 'shield', undefined, remove));
          else if (spec.kind === 'role') row.append(chip(item.id === 'everyone' ? '@everyone' : `@${item.name || item.id}`, 'users', item.id === 'everyone' ? undefined : (item.color || ''), remove));
          else row.append(chip(item.name || item.id, CHANNEL_ICON[item.type] || 'hash', undefined, remove));
        }
        const single = spec.multiple === false && items.length > 0;
        const add = el('button', 'bperm-add');
        add.type = 'button';
        add.append(el('span', 'bperm-add-plus', single ? '⇄' : '+'), document.createTextNode(t(single ? 'builder.pick.change' : spec.add)));
        add.setAttribute('aria-expanded', String(state?.list === spec.list));
        add.addEventListener('click', () => {
          if (state?.list === spec.list) closePicker();
          else openPicker(spec.list);
        });
        row.append(add);
        if (!items.length) row.append(el('span', 'bperm-empty', spec.empty ?? t(`builder.perm.${spec.list}_empty`)));
        card.classList.toggle('is-active', state?.list === spec.list);
      }
      opts.onRefresh?.();
    }

    function closePicker() {
      setState(null);
      root.querySelectorAll('.bpick').forEach((x) => x.remove());
      refresh();
    }

    function openPicker(list) {
      const spec = rows[list].spec;
      setState({ list, step: spec.kind === 'permission' ? 'items' : 'guilds', guild: null, search: '', idMode: false });
      refresh();
      renderPicker();
    }

    function renderPicker() {
      root.querySelectorAll('.bpick').forEach((x) => x.remove());
      if (!state) return;
      const { spec, card } = rows[state.list];
      const box = el('div', 'bpick');
      box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); closePicker(); }
      });

      const h = el('div', 'bpick-head');
      const badgeIcon = el('span', 'bpick-badge');
      badgeIcon.append(icon(spec.icon));
      const ht = el('div', 'bpick-title');
      ht.append(el('strong', '', spec.popTitle || spec.title || t(`builder.perm.${state.list}`)));
      const subline = el('span', 'bpick-subline');
      if (spec.kind === 'permission') subline.textContent = t('builder.perm.required_permissions_pick');
      else if (state.step === 'guilds') subline.textContent = t('builder.pick.choose_server');
      else {
        subline.append(document.createTextNode(`${t('builder.pick.in')} `), el('strong', '', state.guild.name), document.createTextNode(' '));
        const change = el('button', 'bpick-link', t('builder.pick.change_server'));
        change.type = 'button';
        change.addEventListener('click', () => { state.step = 'guilds'; state.guild = null; state.search = ''; renderPicker(); });
        subline.append(change);
      }
      ht.append(subline);
      const close = el('button', 'icon-btn icon-btn-plain', '×');
      close.type = 'button';
      close.setAttribute('aria-label', t('builder.close'));
      close.addEventListener('click', closePicker);
      h.append(badgeIcon, ht, close);
      box.append(h);

      const sw = el('label', 'bpick-search');
      sw.append(icon('search'));
      const search = el('input');
      search.type = 'search';
      search.value = state.search;
      search.placeholder = t(spec.kind === 'permission' ? 'builder.pick.search_permissions'
        : state.step === 'guilds' ? 'builder.pick.search_servers'
          : spec.kind === 'role' ? 'builder.pick.search_roles' : 'builder.pick.search_channels');
      sw.append(search);
      box.append(sw);

      const listEl = el('div', 'bpick-list');
      box.append(listEl);

      const foot = el('div', 'bpick-foot');
      const count = el('span', 'bpick-count');
      const updateCount = () => {
        const n = get(state.list).length;
        count.textContent = n ? t('builder.pick.selected', { count: n }) : t('builder.pick.none');
      };
      updateCount();
      foot.append(count);
      if (state.idMode) {
        const idInput = el('input', 'mono bpick-id');
        idInput.placeholder = t(spec.kind === 'role' ? 'builder.pick.role_id' : 'builder.pick.channel_id');
        idInput.inputMode = 'numeric';
        const ok = el('button', 'btn btn-sm bpick-done', t('builder.perm.add'));
        ok.type = 'button';
        const submit = () => {
          const id = idInput.value.trim();
          if (!SNOWFLAKE.test(id)) { idInput.setCustomValidity(t('builder.pick.id_invalid')); idInput.reportValidity(); return; }
          const entry = { id, guild: state.guild?.id || '', name: id };
          if (spec.multiple === false) set(state.list, [entry]);
          else if (!get(state.list).some((x) => x.id === id)) set(state.list, [...get(state.list), entry]);
          state.idMode = false;
          changed();
          if (spec.multiple === false) closePicker(); else renderPicker();
        };
        idInput.addEventListener('input', () => idInput.setCustomValidity(''));
        idInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
        ok.addEventListener('click', submit);
        const cancel = el('button', 'btn btn-sm', '×');
        cancel.type = 'button';
        cancel.setAttribute('aria-label', t('action.cancel'));
        cancel.addEventListener('click', () => { state.idMode = false; renderPicker(); });
        foot.append(idInput, ok, cancel);
        setTimeout(() => idInput.focus(), 0);
      } else {
        if (spec.kind !== 'permission') {
          const byId = el('button', 'btn btn-sm', t('builder.pick.add_id'));
          byId.type = 'button';
          byId.addEventListener('click', () => { state.idMode = true; renderPicker(); });
          foot.append(byId);
        }
        if (get(state.list).length) {
          const clear = el('button', 'btn btn-sm', t('builder.pick.clear'));
          clear.type = 'button';
          clear.addEventListener('click', () => { set(state.list, []); changed(); renderPicker(); });
          foot.append(clear);
        }
        const done = el('button', 'btn btn-sm bpick-done', t('builder.pick.done'));
        done.type = 'button';
        done.addEventListener('click', closePicker);
        foot.append(done);
      }
      box.append(foot);
      card.append(box);
      requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));

      const fill = () => {
        state.search = search.value.trim().toLowerCase();
        fillList(listEl, spec, updateCount);
      };
      search.addEventListener('input', fill);
      fill();
      if (!state.idMode) setTimeout(() => search.focus({ preventScroll: true }), 0);
    }

    function checkRow(label, checked, onToggle, o = {}) {
      const row = el('label', 'bpick-row');
      const cb = el('input', 'bpick-check');
      // Always a square checkbox, also for one choice (the picker closes on pick).
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.addEventListener('change', () => { onToggle(cb.checked); row.classList.toggle('is-checked', cb.checked); });
      row.classList.toggle('is-checked', checked);
      row.append(cb);
      if (o.dot !== undefined) {
        const dot = el('span', 'bpick-dot');
        if (o.dot) dot.style.background = o.dot;
        row.append(dot);
      } else if (o.icon) row.append(icon(o.icon, 'bicon bpick-row-icon'));
      const text = el('span', 'bpick-row-text');
      text.append(el('strong', '', label));
      if (o.hint) text.append(el('span', '', o.hint));
      row.append(text);
      if (o.tag) row.append(el('span', 'bpick-tag', o.tag));
      if (o.special) row.classList.add('bpick-row-special');
      return row;
    }

    const status = (listEl, key) => listEl.replaceChildren(el('p', 'bpick-status', t(key)));

    async function fillList(listEl, spec, updateCount) {
      const q = state.search;
      const match = (s) => !q || String(s).toLowerCase().includes(q);
      const token = (listEl.dataset.token = String(Math.random()));
      const list = state.list;

      if (spec.kind === 'permission') {
        listEl.replaceChildren();
        for (const group of opts.permissionGroups || []) {
          const items = group.permissions.filter((k) => match(t(`builder.permission.${k}`)) || match(t(`builder.permission.${k}_hint`)));
          if (!items.length) continue;
          listEl.append(el('div', 'bpick-label', t(`builder.permgroup.${group.group}`)));
          for (const k of items) {
            listEl.append(checkRow(t(`builder.permission.${k}`), get(list).includes(k), (on) => {
              set(list, on ? [...new Set([...get(list), k])] : get(list).filter((x) => x !== k));
              changed();
              updateCount();
            }, { hint: t(`builder.permission.${k}_hint`) }));
          }
        }
        if (!listEl.childElementCount) status(listEl, 'builder.pick.empty');
        return;
      }

      if (state.step === 'guilds') {
        status(listEl, 'builder.pick.loading');
        let guilds;
        try { guilds = await source.guilds(); } catch { if (listEl.dataset.token === token) status(listEl, 'builder.pick.load_failed'); return; }
        if (listEl.dataset.token !== token) return;
        // One server only: straight to its roles or channels.
        if (guilds.length === 1 && !q && !state.backed) {
          state.step = 'items'; state.guild = guilds[0]; state.backed = true;
          renderPicker();
          return;
        }
        listEl.replaceChildren(el('div', 'bpick-label', t('builder.pick.servers')));
        for (const g of guilds.filter((x) => match(x.name))) {
          const b = el('button', 'bpick-guild');
          b.type = 'button';
          if (g.iconUrl) {
            const img = el('img', 'avatar');
            img.src = g.iconUrl;
            img.alt = '';
            b.append(img);
          } else b.append(el('span', 'avatar avatar-fallback', (g.name || '?').slice(0, 1).toUpperCase()));
          b.append(el('strong', '', g.name), icon('chevron', 'bicon bpick-chevron'));
          b.addEventListener('click', () => { state.step = 'items'; state.guild = g; state.search = ''; renderPicker(); });
          listEl.append(b);
        }
        if (listEl.childElementCount === 1) listEl.append(el('p', 'bpick-status', t('builder.pick.empty')));
        return;
      }

      const g = state.guild;
      status(listEl, 'builder.pick.loading');
      let items;
      try { items = await source.items(g.id, spec.kind === 'role' ? 'roles' : 'channels'); } catch { if (listEl.dataset.token === token) status(listEl, 'builder.pick.load_failed'); return; }
      if (listEl.dataset.token !== token) return;
      listEl.replaceChildren();
      const has = (id) => get(list).some((x) => x.id === id);
      const single = spec.multiple === false;
      const toggle = (entry) => (on) => {
        if (single) {
          set(list, on ? [entry] : []);
          changed();
          closePicker();
          return;
        }
        set(list, on ? [...get(list).filter((x) => x.id !== entry.id), entry] : get(list).filter((x) => x.id !== entry.id));
        changed();
        updateCount();
      };

      if (spec.kind === 'role') {
        if (list === 'allowed_roles' && !opts.noEveryone && match('@everyone')) {
          listEl.append(checkRow('@everyone', has('everyone'), toggle({ id: 'everyone' }), { icon: 'users', hint: t('builder.pick.everyone_hint'), special: true }));
        }
        for (const [id, label] of Object.entries(pseudoRoles)) {
          if (match(t(label))) listEl.append(checkRow(t(label), has(id), toggle({ id }), { icon: 'shield', hint: t(`${label}_hint`), special: true }));
        }
        listEl.append(el('div', 'bpick-label', t('builder.pick.roles_in', { server: g.name })));
        for (const r of items.filter((x) => match(x.name))) {
          listEl.append(checkRow(r.name, has(r.id), toggle({ id: r.id, guild: g.id, name: r.name, color: r.color || null }), { dot: r.color || '' }));
        }
      } else {
        listEl.append(el('div', 'bpick-label', t('builder.pick.channels_in', { server: g.name })));
        const allowedType = (c) => !spec.channelTypes || !spec.channelTypes.length || spec.channelTypes.includes(c.type);
        // Display order: channels without a category, then each category with its channels.
        const top = items.filter((c) => !c.parentId && c.type !== 'category');
        const ordered = [...top];
        for (const cat of items.filter((c) => c.type === 'category')) ordered.push(cat, ...items.filter((c) => c.parentId === cat.id));
        for (const c of ordered.filter((x) => match(x.name))) {
          if (!allowedType(c)) {
            if (c.type === 'category' && ordered.some((x) => x.parentId === c.id && allowedType(x))) listEl.append(el('div', 'bpick-label', c.name));
            continue;
          }
          const row = checkRow(c.name, has(c.id), toggle({ id: c.id, guild: g.id, name: c.name, type: c.type }), { icon: CHANNEL_ICON[c.type] || 'hash', tag: t(`builder.chan.${c.type}`) });
          if (c.parentId) row.classList.add('bpick-row-child');
          listEl.append(row);
        }
      }
      if (listEl.childElementCount <= 1) listEl.append(el('p', 'bpick-status', t('builder.pick.empty')));
    }

    refresh();
    if (state) renderPicker();
    return { root, refresh, close: closePicker };
  }

  /** The permissions block; value holds the four lists (and hide_without_permission). */
  function block(opts) {
    const value = opts.value;
    for (const s of BLOCK_LISTS) value[s.list] = Array.isArray(value[s.list]) ? value[s.list] : [];
    const lists = opts.lists ? BLOCK_LISTS.filter((s) => opts.lists.includes(s.list)) : BLOCK_LISTS;
    const t = opts.t;

    const root = el('section', 'bperm');
    if (opts.title !== '') {
      const head = el('div', 'bperm-head');
      head.append(el('h3', '', opts.title || t('builder.cfg.permissions')));
      root.append(head);
    }
    const sub = el('div', 'bperm-sub');
    const badge = el('span', 'bperm-badge');
    sub.append(el('span', '', opts.who || t('builder.perm.who')));
    if (opts.badge !== false) sub.append(badge);
    root.append(sub);

    const p = picker({
      t, source: opts.source, permissionGroups: opts.permissionGroups, pseudoRoles: opts.pseudoRoles, keep: opts.keep, className: 'bperm-lists', noEveryone: opts.noEveryone,
      specs: lists.map((s) => ({ ...s, ...(opts.texts?.[s.list] || {}) })),
      get: (list) => value[list],
      set: (list, entries) => { value[list] = entries; },
      onChange: () => opts.onChange(value),
      onRefresh: () => {
        const open = (value.allowed_roles.some((r) => r.id === 'everyone') || !lists.some((s) => s.list === 'allowed_roles'))
          && !value.banned_roles.length && !value.required_permissions.length && !value.banned_channels.length;
        badge.textContent = t(open ? 'builder.perm.open' : 'builder.perm.restricted');
        badge.classList.toggle('is-open', open);
      },
    });
    root.append(p.root);

    if (opts.hide) {
      const hide = el('label', 'bperm-card bperm-toggle');
      hide.append(icon('eyeOff', 'bicon bperm-icon'));
      const ht = el('span', 'bperm-card-text');
      ht.append(el('strong', '', t('builder.perm.hide')), el('span', '', t('builder.perm.hide_hint')));
      const toggle = el('input', 'toggle');
      toggle.type = 'checkbox';
      toggle.checked = Boolean(value.hide_without_permission);
      toggle.addEventListener('change', () => { value.hide_without_permission = toggle.checked; opts.onChange(value); });
      hide.append(ht, toggle);
      root.append(hide);
    }
    p.refresh();
    return root;
  }

  /** A single role or channel field (one or many). */
  function field(opts) {
    let entries = Array.isArray(opts.value) ? opts.value : [];
    const kind = opts.kind;
    const p = picker({
      t: opts.t, source: opts.source, className: 'bperm bperm-field',
      specs: [{
        list: 'value', kind, icon: kind === 'role' ? 'users' : 'hash', multiple: opts.multiple,
        title: '', popTitle: opts.title, empty: opts.empty ?? opts.t(kind === 'role' ? 'builder.pick.no_role' : 'builder.pick.no_channel'),
        add: kind === 'role' ? (opts.multiple ? 'builder.perm.add_role' : 'builder.pick.pick_role') : (opts.multiple ? 'builder.perm.add_channel' : 'builder.pick.pick_channel'),
        channelTypes: opts.channelTypes,
      }],
      get: () => entries,
      set: (_list, v) => { entries = v; },
      onChange: () => opts.onChange(entries),
    });
    return p.root;
  }

  window.BotHubPermissions = { block, field, BLOCK_LISTS, CHANNEL_ICON };
})();
