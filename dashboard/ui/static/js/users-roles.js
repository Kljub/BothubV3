// Users & Roles (admin): search, role filter, sort and pages of the two
// tables run here; the server renders all rows. Buttons with
// data-ur-toggle="#id" show or hide a form (new user, new role, edit row).
(() => {
  const state = new WeakMap(); // table -> { page }

  const rowsOf = (table) => [...table.tBodies[0].rows].filter((r) => r.hasAttribute('data-ur-row'));
  const followOf = (row) => (row.nextElementSibling && row.nextElementSibling.hasAttribute('data-ur-follow') ? row.nextElementSibling : null);

  function render(root, name) {
    const table = root.querySelector(`[data-ur-table="${name}"]`);
    if (!table) return;
    const query = (root.querySelector(`[data-ur-search="${name}"]`)?.value ?? '').trim().toLowerCase();
    const role = root.querySelector(`[data-ur-role-filter="${name}"]`)?.value ?? '';
    const sort = root.querySelector(`[data-ur-sort="${name}"]`)?.value ?? '';
    const body = table.tBodies[0];
    const rows = rowsOf(table);
    if (sort) {
      const key = (r) => (sort === 'name' ? r.dataset.name.toLowerCase() : sort === 'users' ? -Number(r.dataset.users) : Number(r.dataset.pos));
      rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      for (const r of rows) {
        const f = followOf(r);
        body.append(r);
        if (f) body.append(f);
      }
    }
    const shown = rows.filter((r) => (!query || (r.dataset.filterText ?? '').toLowerCase().includes(query)) && (!role || r.dataset.role === role));
    const size = Number(table.dataset.urPageSize) || shown.length || 1;
    const pages = Math.max(1, Math.ceil(shown.length / size));
    const st = state.get(table) ?? { page: 1 };
    st.page = Math.min(st.page, pages);
    state.set(table, st);
    const from = (st.page - 1) * size;
    for (const r of rows) {
      const i = shown.indexOf(r);
      const visible = i >= from && i < from + size;
      r.hidden = !visible;
      const f = followOf(r);
      if (f && !visible) f.hidden = true;
    }
    const pager = root.querySelector(`[data-ur-pager="${name}"]`);
    if (!pager) return;
    const info = document.createElement('span');
    info.textContent = (pager.dataset.text ?? '{from}–{to} / {total}')
      .replace('{from}', String(shown.length ? from + 1 : 0))
      .replace('{to}', String(Math.min(from + size, shown.length)))
      .replace('{total}', String(shown.length));
    const nav = document.createElement('nav');
    nav.className = 'pagination';
    if (pages > 1) {
      const btn = (label, page, disabled, current) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'page-btn';
        b.textContent = label;
        b.disabled = disabled;
        if (current) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', () => {
          st.page = page;
          render(root, name);
        });
        return b;
      };
      nav.append(btn('‹', st.page - 1, st.page === 1, false));
      for (let p = 1; p <= pages; p++) nav.append(btn(String(p), p, false, p === st.page));
      nav.append(btn('›', st.page + 1, st.page === pages, false));
    }
    pager.replaceChildren(info, nav);
  }

  function init(scope) {
    const root = scope.matches?.('[data-users-roles]') ? scope : scope.querySelector?.('[data-users-roles]');
    if (!root) return;
    for (const name of ['users', 'roles']) render(root, name);
  }

  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-ur-search]');
    if (!el) return;
    const root = el.closest('[data-users-roles]');
    const table = root.querySelector(`[data-ur-table="${el.dataset.urSearch}"]`);
    if (table) state.set(table, { page: 1 });
    render(root, el.dataset.urSearch);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-ur-role-filter], [data-ur-sort]');
    if (!el) return;
    const name = el.dataset.urRoleFilter ?? el.dataset.urSort;
    const root = el.closest('[data-users-roles]');
    const table = root.querySelector(`[data-ur-table="${name}"]`);
    if (table) state.set(table, { page: 1 });
    render(root, name);
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ur-toggle]');
    if (!btn) return;
    const target = document.querySelector(btn.dataset.urToggle);
    if (!target) return;
    target.hidden = !target.hidden;
    if (!target.hidden) target.querySelector('input:not([type=hidden]), select')?.focus();
  });
  document.addEventListener('DOMContentLoaded', () => init(document));
  document.addEventListener('htmx:afterSettle', () => init(document));
})();
