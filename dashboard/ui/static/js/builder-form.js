// BotHub form builder: the full-screen editor of the "Send a Form" block.
// builder.js calls BotHubForm.open(); the form lives in node.config.form and
// is changed in place. Answers become variables {form_name.variable}.
(() => {
  'use strict';

  const MAX_FIELDS = 5;
  const MAX_OPTIONS = 25;
  const VAR_RE = /^[a-z][a-z0-9_]{0,31}$/;
  const TYPES = ['text', 'select', 'user', 'role', 'channel', 'mentionable', 'file'];
  const TYPE_ICON = { text: 'type', select: 'list', user: 'user', role: 'shield', channel: 'hash', mentionable: 'at', file: 'paperclip' };
  // Variables each field type gives after the form was sent.
  const SUFFIXES = {
    text: ['', '.length'],
    select: ['', '.count'],
    user: ['', '.id', '.mention'],
    role: ['', '.id', '.mention'],
    channel: ['', '.id', '.mention'],
    mentionable: ['', '.id', '.mention'],
    file: ['.url', '.name', '.size'],
  };
  const PICK_TYPES = new Set(['select', 'user', 'role', 'channel', 'mentionable', 'file']);

  const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32);

  function variablesOf(formName, f) {
    const base = `${formName || 'form'}.${f.variable || 'field'}`;
    return (SUFFIXES[f.type] || ['']).map((s) => `{${base}${s}}`);
  }

  // problems returns the reasons the form cannot be sent yet (empty = ready).
  function problems(form, t) {
    const out = [];
    if (!form || !String(form.title || '').trim()) out.push(t('builder.form.err.title'));
    const fields = form?.fields || [];
    if (!fields.length) out.push(t('builder.form.err.no_fields'));
    const seen = new Set();
    fields.forEach((f, i) => out.push(...fieldProblems(f, i, t, seen)));
    return out;
  }

  function fieldProblems(f, i, t, seen = new Set()) {
    const n = i + 1;
    const out = [];
    if (!String(f.label || '').trim()) out.push(t('builder.form.err.label', { n }));
    if (!VAR_RE.test(f.variable || '')) out.push(t('builder.form.err.variable', { n }));
    else if (seen.has(f.variable)) out.push(t('builder.form.err.variable_dup', { name: f.variable }));
    seen.add(f.variable);
    if (f.type === 'select') {
      const opts = f.options || [];
      if (!opts.length) out.push(t('builder.form.err.options', { n }));
      const values = opts.map((o) => o.value);
      if (opts.some((o) => !String(o.label || '').trim() || !String(o.value || '').trim()) || new Set(values).size !== values.length) {
        out.push(t('builder.form.err.option_value', { n }));
      }
    }
    if (f.type === 'text' && f.min_length != null && f.max_length != null && f.min_length > f.max_length) out.push(t('builder.form.err.length', { n }));
    if (PICK_TYPES.has(f.type) && f.min_values != null && f.max_values != null && f.min_values > f.max_values) out.push(t('builder.form.err.picks', { n }));
    return out;
  }

  function newField(type, taken) {
    let v = type === 'text' ? 'answer' : type;
    for (let i = 2; taken.has(v); i++) v = `${type === 'text' ? 'answer' : type}_${i}`;
    const f = { type, variable: v, label: '', required: false };
    if (type === 'text') f.style = 'short';
    if (type === 'select') f.options = [{ label: 'Option 1', value: 'option_1' }];
    return f;
  }

  function open(ctx) {
    const { node, t, el, icon, onChange } = ctx;
    const form = node.config.form;
    form.fields = form.fields || [];
    let current = 0;

    // Popup: dimmed backdrop, dialog in the middle.
    const overlay = el('div', 'bform');
    const dialog = el('div', 'bform-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('builder.form.title'));
    const changed = () => { onChange(); refresh(); };

    // ---- header ----
    const head = el('header', 'bform-head');
    const titleRow = el('div', 'bform-titlerow');
    const h = el('h2', '', t('builder.form.title'));
    const help = icon('help', 'bicon bform-help');
    help.setAttribute('aria-hidden', 'false');
    const helpWrap = el('span', 'bform-help-wrap');
    helpWrap.title = t('builder.form.help');
    helpWrap.append(help);
    titleRow.append(h, helpWrap, el('span', 'bform-sub', t('builder.form.subtitle')));
    const closeX = el('button', 'bform-x', '×');
    closeX.type = 'button';
    closeX.setAttribute('aria-label', t('builder.close'));
    closeX.addEventListener('click', close);
    titleRow.append(closeX);

    const titleLine = el('div', 'bform-titleline');
    const titleField = labeled(t('builder.form.form_title'), true, 45, () => form.title || '');
    const titleInput = textInput(form.title || '', 45, (v) => { form.title = v; changed(); });
    titleField.box.append(titleInput.wrap);
    titleLine.append(titleField.root);
    const pill = el('span', 'bform-pill');
    const addBtn = el('button', 'btn bform-primary');
    addBtn.type = 'button';
    addBtn.textContent = `+ ${t('builder.form.add_field')}`;
    const addMenu = el('div', 'bform-menu');
    addMenu.hidden = true;
    for (const type of TYPES) {
      const b = el('button', 'bform-menu-item');
      b.type = 'button';
      b.append(icon(TYPE_ICON[type]));
      const tx = el('span', '');
      tx.append(el('strong', '', t(`builder.form.type.${type}`)), el('small', '', t(`builder.form.type.${type}_hint`)));
      b.append(tx);
      b.addEventListener('click', () => {
        addMenu.hidden = true;
        form.fields.push(newField(type, new Set(form.fields.map((f) => f.variable))));
        current = form.fields.length - 1;
        changed();
        renderEditor();
      });
      addMenu.append(b);
    }
    addBtn.addEventListener('click', (ev) => { ev.stopPropagation(); addMenu.hidden = !addMenu.hidden; });
    const addWrap = el('div', 'bform-add');
    addWrap.append(pill, addBtn, addMenu);
    titleLine.append(addWrap);
    head.append(titleRow, titleLine);

    // ---- columns ----
    const cols = el('div', 'bform-cols');
    const left = el('section', 'bform-left');
    const list = el('div', 'bform-list');
    const leftHead = el('h3', 'bform-coltitle', t('builder.form.fields'));
    left.append(leftHead, list, el('p', 'bform-hint', t('builder.form.fields_help')));
    const mid = el('section', 'bform-mid');
    const right = el('section', 'bform-right');
    cols.append(left, mid, right);

    // ---- footer ----
    const foot = el('footer', 'bform-foot');
    const status = el('span', 'bform-status');
    const done = el('button', 'btn bform-primary', t('builder.form.done'));
    done.type = 'button';
    done.addEventListener('click', close);
    foot.append(status, done);

    dialog.append(head, cols, foot);
    overlay.append(dialog);
    document.body.append(overlay);
    // A click on the backdrop closes the popup (changes are already applied).
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
    overlay.addEventListener('click', () => { addMenu.hidden = true; overlay.querySelectorAll('.bform-varmenu').forEach((m) => m.remove()); });
    // Builder shortcuts (Delete, Ctrl+Z) must not reach the canvas while open.
    overlay.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') close();
    });
    const prevFocus = document.activeElement;

    function close() {
      overlay.remove();
      ctx.onClose?.();
      prevFocus?.focus?.();
    }

    // ---- small builders ----
    function labeled(text, required, max, value, hint, help2) {
      const r = el('div', 'bform-field');
      const top = el('div', 'bform-label');
      const lbl = el('span', 'bform-label-text', text);
      if (required) lbl.append(el('span', 'bform-req', ' *'));
      top.append(lbl);
      if (help2) {
        const hw = el('span', 'bform-help-wrap');
        hw.title = help2;
        hw.append(icon('help', 'bicon bform-help'));
        top.append(hw);
      }
      let counter = null;
      if (max) {
        counter = el('span', 'bform-count');
        top.append(counter);
      }
      r.append(top);
      if (hint) r.append(el('p', 'bform-hint', hint));
      const box = el('div', 'bform-box');
      r.append(box);
      const update = () => { if (counter) counter.textContent = `${String(value() || '').length}/${max}`; };
      update();
      return { root: r, box, update };
    }

    // textInput: input (or textarea) with the </> variable menu.
    function textInput(value, max, onInput, opts = {}) {
      const wrap = el('div', 'bform-input');
      const input = el(opts.multiline ? 'textarea' : 'input');
      if (!opts.multiline) input.type = opts.number ? 'number' : 'text';
      if (opts.number) { input.min = opts.min ?? 0; input.max = opts.max ?? 4000; }
      if (max && !opts.number) input.maxLength = max;
      if (opts.placeholder) input.placeholder = opts.placeholder;
      if (opts.mono) input.classList.add('mono');
      input.value = value ?? '';
      input.addEventListener('input', () => onInput(input.value));
      wrap.append(input);
      if (!opts.number && !opts.noVars) {
        const b = el('button', 'bform-code');
        b.type = 'button';
        b.title = t('builder.insert_variable');
        b.setAttribute('aria-label', t('builder.insert_variable'));
        b.append(icon('code'));
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          overlay.querySelectorAll('.bform-varmenu').forEach((m) => m.remove());
          if (ctx.pickVariable) {
            return ctx.pickVariable((name) => {
              const s = input.selectionStart ?? input.value.length;
              const e = input.selectionEnd ?? input.value.length;
              input.value = (input.value.slice(0, s) + name + input.value.slice(e)).slice(0, max || undefined);
              input.dispatchEvent(new Event('input'));
              input.focus();
            });
          }
          const menu = el('div', 'bform-varmenu');
          for (const name of ctx.variables()) {
            const item = el('button', 'mono', name);
            item.type = 'button';
            item.addEventListener('click', () => {
              const s = input.selectionStart ?? input.value.length;
              const e = input.selectionEnd ?? input.value.length;
              input.value = (input.value.slice(0, s) + name + input.value.slice(e)).slice(0, max || undefined);
              input.dispatchEvent(new Event('input'));
              menu.remove();
              input.focus();
            });
            menu.append(item);
          }
          wrap.append(menu);
        });
        wrap.append(b);
      }
      return { wrap, input };
    }

    function select(values, value, labelOf, onPick) {
      const s = el('select', 'bform-select');
      for (const v of values) {
        const o = el('option', '', labelOf(v));
        o.value = String(v);
        if (String(v) === String(value)) o.selected = true;
        s.append(o);
      }
      s.addEventListener('change', () => onPick(s.value));
      return s;
    }

    function chip(name) {
      const c = el('button', 'bform-chip mono');
      c.type = 'button';
      c.title = t('builder.copy', { name });
      c.append(el('span', '', name), icon('clipboard'));
      c.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctx.copy(name);
        c.classList.add('is-copied');
        setTimeout(() => c.classList.remove('is-copied'), 900);
      });
      return c;
    }

    // ---- left: field list ----
    function renderList() {
      list.replaceChildren();
      form.fields.forEach((f, i) => {
        const ok = fieldProblems(f, i, t).length === 0;
        const row = el('div', `bform-item${i === current ? ' is-current' : ''}`);
        row.tabIndex = 0;
        const stat = el('span', `bform-item-state ${ok ? 'is-ok' : 'is-bad'}`);
        stat.append(icon(ok ? 'checkCircle' : 'alert'));
        const typeIc = el('span', 'bform-item-type');
        typeIc.append(icon(TYPE_ICON[f.type]));
        const txt = el('span', 'bform-item-text');
        const sub = el('span', 'bform-item-sub');
        sub.append(document.createTextNode(`${t(`builder.form.type.${f.type}`)} `), el('span', 'mono bform-var', variablesOf(ctx.formName(), f)[0]));
        txt.append(el('strong', '', f.label || t('builder.form.field_n', { n: i + 1 })), sub);
        const tools = el('span', 'bform-item-tools');
        const tool = (name, label, disabled, fn) => {
          const b = el('button', 'bform-tool');
          b.type = 'button';
          b.title = label;
          b.setAttribute('aria-label', label);
          b.disabled = disabled;
          b.append(icon(name));
          b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
          return b;
        };
        tools.append(
          tool('up', t('builder.form.move_up'), i === 0, () => { form.fields.splice(i - 1, 0, form.fields.splice(i, 1)[0]); current = i - 1; changed(); renderEditor(); }),
          tool('down', t('builder.form.move_down'), i === form.fields.length - 1, () => { form.fields.splice(i + 1, 0, form.fields.splice(i, 1)[0]); current = i + 1; changed(); renderEditor(); }),
          tool('copy', t('builder.form.duplicate'), form.fields.length >= MAX_FIELDS, () => {
            const copy = structuredClone(f);
            const taken = new Set(form.fields.map((x) => x.variable));
            let v = `${f.variable}_2`;
            for (let k = 3; taken.has(v); k++) v = `${f.variable}_${k}`;
            copy.variable = v.slice(0, 32);
            form.fields.splice(i + 1, 0, copy);
            current = i + 1;
            changed();
            renderEditor();
          }),
          tool('trash', t('builder.form.delete'), false, () => {
            form.fields.splice(i, 1);
            current = Math.max(0, Math.min(current, form.fields.length - 1));
            changed();
            renderEditor();
          }),
        );
        row.append(stat, typeIc, txt, tools);
        const pick = () => { current = i; renderEditor(); };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
        list.append(row);
      });
    }

    // ---- middle: field editor ----
    function renderEditor() {
      mid.replaceChildren();
      const f = form.fields[current];
      renderList();
      if (!f) {
        mid.append(el('p', 'bform-hint', t('builder.form.fields_help')));
        refresh();
        return;
      }
      const head2 = el('div', 'bform-edhead');
      const title = el('div', 'bform-edtitle');
      const ti = el('span', 'bform-edicon');
      ti.append(icon(TYPE_ICON[f.type]));
      const tt = el('div', '');
      const strong = el('strong', '', t('builder.form.field_n', { n: current + 1 }));
      tt.append(strong, document.createTextNode(` - ${t(`builder.form.type.${f.type}`)}`));
      const mainVar = el('div', 'mono bform-var', variablesOf(ctx.formName(), f)[0]);
      const tw = el('div', '');
      tw.append(tt, mainVar);
      title.append(ti, tw);
      const badge = el('span', 'bform-badge');
      head2.append(title, badge);
      mid.append(head2);

      const setBadge = () => {
        const ok = fieldProblems(f, current, t).length === 0;
        badge.textContent = t(ok ? 'builder.form.ready' : 'builder.form.incomplete');
        badge.classList.toggle('is-ok', ok);
      };
      setBadge();
      const fieldChanged = () => { setBadge(); changed(); renderList(); };

      // Field type
      const typeF = labeled(t('builder.form.field_type'), false, 0, null, t(`builder.form.type.${f.type}_hint`), t('builder.form.help'));
      typeF.box.append(select(TYPES, f.type, (v) => t(`builder.form.type.${v}`), (v) => {
        const keep = { variable: f.variable, label: f.label, description: f.description, required: f.required };
        const fresh = newField(v, new Set());
        form.fields[current] = { ...fresh, ...Object.fromEntries(Object.entries(keep).filter(([, x]) => x !== undefined)) };
        changed();
        renderEditor();
      }));
      mid.append(typeF.root);

      // Variable name box with copy chips
      const vbox = el('div', 'bform-varbox');
      const varF = labeled(t('builder.form.variable'), true, 32, () => f.variable, t('builder.form.variable_hint'));
      const varIn = textInput(f.variable, 32, (v) => {
        f.variable = v.trim();
        varF.update();
        mainVar.textContent = variablesOf(ctx.formName(), f)[0];
        renderChips();
        fieldChanged();
      }, { mono: true, noVars: true });
      varF.box.append(varIn.wrap);
      const chipsWrap = el('div', 'bform-chips');
      const renderChips = () => chipsWrap.replaceChildren(...variablesOf(ctx.formName(), f).map(chip));
      renderChips();
      const varText = el('p', 'bform-hint');
      const setVarText = () => { varText.textContent = t(f.type === 'text' ? 'builder.form.var_text' : 'builder.form.var_other', { label: f.label || t('builder.form.field_n', { n: current + 1 }) }); };
      setVarText();
      vbox.append(varF.root, el('p', 'bform-hint', t('builder.form.variable_use')), chipsWrap, varText);
      mid.append(vbox);

      const grid = el('div', 'bform-grid');
      mid.append(grid);
      const add = (node2) => grid.append(node2);

      // Label (fills the variable name while the user did not change it)
      const labF = labeled(t('builder.form.label'), true, 45, () => f.label, t('builder.form.label_hint'));
      labF.box.append(textInput(f.label, 45, (v) => {
        const auto = !f.variable || f.variable === slug(f.label) || /^(answer|select|user|role|channel|mentionable|file)(_\d+)?$/.test(f.variable);
        f.label = v;
        if (auto && slug(v)) {
          const taken = new Set(form.fields.filter((x) => x !== f).map((x) => x.variable));
          let nv = slug(v);
          for (let k = 2; taken.has(nv); k++) nv = `${slug(v).slice(0, 29)}_${k}`;
          f.variable = nv;
          varIn.input.value = nv;
          varF.update();
          mainVar.textContent = variablesOf(ctx.formName(), f)[0];
          renderChips();
        }
        labF.update();
        setVarText();
        fieldChanged();
      }).wrap);
      add(labF.root);

      const descF = labeled(t('builder.form.description'), false, 100, () => f.description, t('builder.form.description_hint'));
      descF.box.append(textInput(f.description, 100, (v) => { if (v) f.description = v; else delete f.description; descF.update(); fieldChanged(); }).wrap);
      add(descF.root);

      const reqF = labeled(t('builder.form.required'), false, 0, null, t('builder.form.required_hint'));
      reqF.box.append(select(['false', 'true'], String(Boolean(f.required)), (v) => t(v === 'true' ? 'builder.form.yes' : 'builder.form.no'), (v) => { f.required = v === 'true'; fieldChanged(); }));
      add(reqF.root);

      const numField = (key, labelKey, min, max) => {
        const nf = labeled(t(labelKey), false, 0, null, t(`${labelKey}_hint`));
        nf.box.append(textInput(f[key] ?? '', 0, (v) => {
          if (v === '') delete f[key];
          else f[key] = Math.max(min, Math.min(max, Math.round(Number(v))));
          fieldChanged();
        }, { number: true, min, max }).wrap);
        add(nf.root);
      };

      if (f.type === 'text') {
        const styleF = labeled(t('builder.form.style'), false, 0, null, t('builder.form.style_hint'));
        styleF.box.append(select(['short', 'paragraph'], f.style || 'short', (v) => t(`builder.form.style_${v}`), (v) => { f.style = v; fieldChanged(); }));
        add(styleF.root);
      }
      if (f.type !== 'file') {
        const phF = labeled(t('builder.form.placeholder'), false, 100, () => f.placeholder, t('builder.form.placeholder_hint'));
        phF.box.append(textInput(f.placeholder, 100, (v) => { if (v) f.placeholder = v; else delete f.placeholder; phF.update(); fieldChanged(); }).wrap);
        add(phF.root);
      }
      if (f.type === 'text') {
        numField('min_length', 'builder.form.min_length', 0, 4000);
        numField('max_length', 'builder.form.max_length', 1, 4000);
        const defF = labeled(t('builder.form.default'), false, 4000, () => f.default, t('builder.form.default_hint'));
        defF.box.append(textInput(f.default, 4000, (v) => { if (v) f.default = v; else delete f.default; defF.update(); fieldChanged(); }).wrap);
        add(defF.root);
      } else {
        numField('min_values', 'builder.form.min_values', 0, f.type === 'file' ? 10 : 25);
        numField('max_values', 'builder.form.max_values', 1, f.type === 'file' ? 10 : 25);
      }

      if (f.type === 'select') {
        const optF = labeled(t('builder.form.options'), true, 0, null, t('builder.form.options_hint'));
        const optList = el('div', 'bform-options');
        const renderOptions = () => {
          optList.replaceChildren();
          (f.options || []).forEach((o, oi) => {
            const row = el('div', 'bform-option');
            const lab2 = textInput(o.label, 100, (v) => {
              const autoValue = !o.value || o.value === slug(o.label);
              o.label = v;
              if (autoValue) { o.value = slug(v); val.input.value = o.value; }
              fieldChanged();
            }, { placeholder: t('builder.form.option_label'), noVars: true });
            const val = textInput(o.value, 100, (v) => { o.value = v; fieldChanged(); }, { placeholder: t('builder.form.option_value'), mono: true, noVars: true });
            const desc = textInput(o.description, 100, (v) => { if (v) o.description = v; else delete o.description; fieldChanged(); }, { placeholder: t('builder.form.option_description'), noVars: true });
            const rm = el('button', 'bform-tool');
            rm.type = 'button';
            rm.title = t('builder.form.remove_option');
            rm.setAttribute('aria-label', t('builder.form.remove_option'));
            rm.append(icon('trash'));
            rm.addEventListener('click', () => { f.options.splice(oi, 1); fieldChanged(); renderOptions(); });
            row.append(lab2.wrap, val.wrap, desc.wrap, rm);
            optList.append(row);
          });
          const addOpt = el('button', 'btn btn-sm', `+ ${t('builder.form.add_option')}`);
          addOpt.type = 'button';
          addOpt.disabled = (f.options || []).length >= MAX_OPTIONS;
          addOpt.addEventListener('click', () => {
            f.options = f.options || [];
            const n = f.options.length + 1;
            f.options.push({ label: `Option ${n}`, value: `option_${n}` });
            fieldChanged();
            renderOptions();
          });
          optList.append(addOpt);
        };
        renderOptions();
        optF.box.append(optList);
        optF.root.classList.add('bform-wide');
        add(optF.root);
      }
      refresh();
    }

    // ---- right: preview and variables ----
    function renderRight() {
      right.replaceChildren();
      right.append(el('h3', 'bform-coltitle', t('builder.form.preview')), el('p', 'bform-hint', t('builder.form.preview_hint')));
      const modal = el('div', 'dmodal');
      const mh = el('div', 'dmodal-head');
      if (ctx.bot.avatar) {
        const img = el('img', 'dmodal-avatar');
        img.src = ctx.bot.avatar;
        img.alt = '';
        mh.append(img);
      } else mh.append(el('span', 'dmodal-avatar dmodal-avatar-fallback', (ctx.bot.name || 'B').slice(0, 1).toUpperCase()));
      mh.append(el('strong', '', form.title || t('builder.form.form_title')), el('span', 'dmodal-x', '×'));
      modal.append(mh);
      form.fields.forEach((f, i) => {
        const fb = el('div', `dmodal-field${i === current ? ' is-current' : ''}`);
        const lab3 = el('div', 'dmodal-label', (f.label || t('builder.form.field_n', { n: i + 1 })).toUpperCase());
        if (f.required) lab3.append(el('span', 'dmodal-req', ' *'));
        fb.append(lab3);
        if (f.description) fb.append(el('div', 'dmodal-desc', f.description));
        if (f.type === 'text') {
          const box = el('div', `dmodal-input${f.style === 'paragraph' ? ' is-paragraph' : ''}`, f.default || f.placeholder || '');
          if (!f.default) box.classList.add('is-placeholder');
          fb.append(box);
        } else if (f.type === 'file') {
          const up = el('div', 'dmodal-upload');
          up.append(icon('upload'), el('span', '', t('builder.form.upload_text')));
          fb.append(up);
        } else {
          const sel = el('div', 'dmodal-select');
          sel.append(el('span', '', f.placeholder || t('builder.form.select_placeholder')), icon('chevronDown'));
          fb.append(sel);
        }
        fb.addEventListener('click', () => { current = i; renderEditor(); });
        modal.append(fb);
      });
      const mf = el('div', 'dmodal-foot');
      mf.append(el('span', 'dmodal-cancel', t('builder.form.cancel')), el('span', 'dmodal-submit', t('builder.form.submit')));
      modal.append(mf);
      right.append(modal);

      right.append(el('h3', 'bform-coltitle bform-gap', t('builder.form.variables')), el('p', 'bform-hint', t('builder.form.variables_hint')));
      const vl = el('div', 'bform-varlist');
      form.fields.forEach((f, i) => {
        const g = el('div', 'bform-vargroup');
        const gh = el('div', 'bform-vargroup-head');
        gh.append(icon(TYPE_ICON[f.type]), el('strong', '', f.label || t('builder.form.field_n', { n: i + 1 })));
        const cw = el('div', 'bform-chips');
        cw.append(...variablesOf(ctx.formName(), f).map(chip));
        g.append(gh, cw);
        vl.append(g);
      });
      right.append(vl);
    }

    function refresh() {
      pill.textContent = t('builder.form.fields_pill', { count: form.fields.length });
      addBtn.disabled = form.fields.length >= MAX_FIELDS;
      titleField.update();
      const probs = problems(form, t);
      status.replaceChildren();
      status.classList.toggle('is-ok', !probs.length);
      status.append(icon(probs.length ? 'alert' : 'checkCircle'));
      status.append(el('span', '', probs.length
        ? t(probs.length === 1 ? 'builder.form.problems_one' : 'builder.form.problems_many', { count: probs.length, first: probs[0] })
        : t('builder.form.is_ready')));
      renderRight();
    }

    renderEditor();
    setTimeout(() => titleInput.input.focus(), 0);
  }

  window.BotHubForm = { open, problems, variablesOf };
})();
