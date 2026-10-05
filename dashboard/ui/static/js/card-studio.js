// Card Designer: previews of the card list and the Card Studio editor.
// Drawing uses the shared renderer (/cards/render.mjs), the same code the bot
// draws its PNGs with. Saving goes through the API proxy
// (/api/v1/bots/{bot}/cards/{card}).
(() => {
  let renderer = null;
  let fontsReady = null;

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.key || 'error.api.unreachable');
    return data;
  }

  async function load() {
    renderer ??= await import('/cards/render.mjs');
    fontsReady ??= Promise.all(renderer.FONTS.flatMap((f) => Object.entries(f.weights).map(([w, style]) => {
      const face = new FontFace(f.family, `url(/cards/fonts/${f.file}-${style}.ttf)`, { weight: w });
      document.fonts.add(face);
      return face.load().catch(() => null);
    })));
    await fontsReady;
    return renderer;
  }

  // Pictures for the preview (the page only loads its own files, data: and the Discord CDN).
  const images = new Map();
  function loadImage(url) {
    if (!images.has(url)) {
      images.set(url, new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }));
    }
    return images.get(url);
  }

  const PREVIEWS = {
    tom: { 'user.avatar': 'https://cdn.discordapp.com/embed/avatars/1.png', 'second.avatar': 'https://cdn.discordapp.com/embed/avatars/3.png' },
    long: { user: 'Maximilian Sonnenschein', 'user.name': 'maximilian.sonnenschein', 'user.display': 'Maximilian Sonnenschein', 'user.avatar': 'https://cdn.discordapp.com/embed/avatars/4.png', 'member.ordinal': '12,345th', members: '12345' },
  };
  const varsFor = (r, key) => ({ ...r.SAMPLE_VARS, ...PREVIEWS.tom, ...(PREVIEWS[key] || {}) });

  async function draw(canvas, design, vars) {
    const r = await load();
    const d = r.normalize(design);
    if (canvas.width !== d.width) canvas.width = d.width;
    if (canvas.height !== d.height) canvas.height = d.height;
    await r.drawCard(canvas.getContext('2d'), design, { vars: vars || varsFor(r, 'tom'), loadImage });
  }

  // ---------- card list ----------

  function initList(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    const bot = root.dataset.bot;
    for (const c of root.querySelectorAll('[data-card-preview]')) {
      try {
        draw(c, JSON.parse(c.dataset.design));
      } catch {
        // a broken design just stays empty
      }
    }
    const err = (key) => {
      const box = root.querySelector('#cards-error');
      if (box) box.innerHTML = `<div class="alert alert-error">${key}</div>`;
    };
    root.querySelector('[data-card-new]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      try {
        const { templates } = await (await fetch('/cards/templates.json')).json();
        const kind = f.kind.value;
        const card = await api('POST', `/api/v1/bots/${bot}/cards`, { name: f.name.value.trim(), kind, design: templates[kind] || templates.custom });
        location.href = `/bots/cards/${card.id}`;
      } catch (ex) {
        err(ex.message);
      }
    });
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-card-delete]');
      if (!del) return;
      if (!window.confirm(del.dataset.confirmText)) return;
      try {
        await api('DELETE', `/api/v1/bots/${bot}/cards/${del.dataset.cardDelete}`);
        del.closest('.card-tile')?.remove();
      } catch (ex) {
        err(ex.message);
      }
    });
  }

  // ---------- Card Studio ----------

  function initStudio(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    const texts = JSON.parse(root.dataset.texts || '{}');
    const t = (k) => texts[`cards.${k}`] ?? k;
    const bot = root.dataset.bot;
    const cardId = root.dataset.card;
    const canvas = root.querySelector('[data-cs-canvas]');
    const overlay = root.querySelector('[data-cs-overlay]');
    const layersEl = root.querySelector('[data-cs-layers]');
    const props = root.querySelector('[data-cs-props]');
    const status = root.querySelector('[data-cs-status]');
    let design = JSON.parse(root.dataset.design || '{}');
    let selected = null;
    let preview = 'tom';
    let dirty = false;
    let snap = true;
    const past = [];
    const future = [];
    let r = null;

    const layerById = (id) => design.layers.find((l) => l.id === id);
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const commit = () => {
      past.push(JSON.stringify(design));
      if (past.length > 80) past.shift();
      future.length = 0;
      dirty = true;
      status.textContent = t('unsaved');
    };
    // The state before a change goes on the undo stack once per change.
    let pending = null;
    const begin = () => {
      pending ??= JSON.stringify(design);
    };
    const end = () => {
      if (pending !== null && pending !== JSON.stringify(design)) {
        past.push(pending);
        if (past.length > 80) past.shift();
        future.length = 0;
        dirty = true;
        status.textContent = t('unsaved');
      }
      pending = null;
    };

    let drawing = false;
    let again = false;
    async function redraw() {
      if (drawing) {
        again = true;
        return;
      }
      drawing = true;
      do {
        again = false;
        await draw(canvas, design, varsFor(r, preview));
      } while (again);
      drawing = false;
      placeBox();
    }

    const scale = () => canvas.clientWidth / canvas.width || 1;

    function placeBox() {
      overlay.innerHTML = '';
      const l = selected && layerById(selected);
      if (!l) return;
      const s = scale();
      const box = document.createElement('div');
      box.className = 'cs-box';
      Object.assign(box.style, { left: `${l.x * s}px`, top: `${l.y * s}px`, width: `${l.w * s}px`, height: `${l.h * s}px` });
      const label = document.createElement('span');
      label.className = 'cs-box-label';
      label.textContent = l.name || l.type;
      box.append(label);
      for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const k = document.createElement('i');
        k.className = `cs-handle cs-${h}`;
        k.dataset.handle = h;
        box.append(k);
      }
      overlay.append(box);
    }

    // ----- layers list -----
    function renderLayers() {
      layersEl.innerHTML = '';
      [...design.layers].reverse().forEach((l) => {
        const li = document.createElement('li');
        li.className = `cs-layer${l.id === selected ? ' is-selected' : ''}${l.visible === false ? ' is-hidden' : ''}`;
        li.dataset.id = l.id;
        li.innerHTML = '<span class="cs-layer-type"></span><span class="cs-layer-name"></span>';
        li.querySelector('.cs-layer-type').textContent = t(`layer.${l.type}`).slice(0, 1);
        li.querySelector('.cs-layer-name').textContent = l.name || l.type;
        const actions = document.createElement('span');
        actions.className = 'cs-layer-actions';
        for (const [act, label] of [['eye', l.visible === false ? '◌' : '◉'], ['up', '↑'], ['down', '↓'], ['dup', '⧉'], ['del', '✕']]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.act = act;
          b.textContent = label;
          b.title = t(`act.${act}`);
          actions.append(b);
        }
        li.append(actions);
        layersEl.append(li);
      });
      const bg = document.createElement('li');
      bg.className = `cs-layer cs-layer-bg${selected === null ? ' is-selected' : ''}`;
      bg.dataset.id = '';
      bg.innerHTML = '<span class="cs-layer-type">▣</span><span class="cs-layer-name"></span>';
      bg.querySelector('.cs-layer-name').textContent = t('background');
      layersEl.append(bg);
    }

    layersEl.addEventListener('click', (e) => {
      const li = e.target.closest('.cs-layer');
      if (!li) return;
      const id = li.dataset.id || null;
      const act = e.target.closest('[data-act]')?.dataset.act;
      const i = design.layers.findIndex((l) => l.id === id);
      if (act && i >= 0) {
        begin();
        if (act === 'eye') design.layers[i].visible = design.layers[i].visible === false;
        if (act === 'up' && i < design.layers.length - 1) design.layers.splice(i, 2, design.layers[i + 1], design.layers[i]);
        if (act === 'down' && i > 0) design.layers.splice(i - 1, 2, design.layers[i], design.layers[i - 1]);
        if (act === 'dup') {
          const copy = { ...clone(design.layers[i]), id: newId(), name: `${design.layers[i].name || design.layers[i].type} 2`, x: design.layers[i].x + 20, y: design.layers[i].y + 20 };
          design.layers.splice(i + 1, 0, copy);
          selected = copy.id;
        }
        if (act === 'del') {
          design.layers.splice(i, 1);
          selected = null;
        }
        end();
      } else selected = id;
      refresh();
    });

    const newId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

    const DEFAULTS = {
      text: { text: t('new_text'), font: 'Poppins', weight: 700, size: 48, color: '#ffffff', align: 'center', w: 500, h: 70, shrink: true },
      avatar: { shape: 'circle', w: 160, h: 160, borderWidth: 4, borderColor: '#ffffff', source: 'user' },
      image: { url: '', fit: 'cover', w: 300, h: 200, radius: 12 },
      shape: { shape: 'rect', fill: '#5865f2', w: 300, h: 120, radius: 16 },
      badge: { text: 'NEW', fill: '#eb459e', color: '#ffffff', font: 'Poppins', weight: 700, w: 160, h: 44 },
      bar: { value: '{level.progress}', fill: '#a78bfa', track: 'rgba(255,255,255,0.15)', w: 500, h: 30 },
      grid: { text: '{leaderboard}', header: false, stripes: true, color: '#ffffff', font: 'Poppins', weight: 600, w: 600, h: 180 },
    };
    root.querySelector('[data-cs-add]').addEventListener('click', (e) => {
      const type = e.target.closest('[data-add]')?.dataset.add;
      if (!type) return;
      begin();
      const d = DEFAULTS[type];
      const l = { id: newId(), type, name: t(`layer.${type}`), ...clone(d), x: Math.round((design.width - d.w) / 2), y: Math.round((design.height - d.h) / 2) };
      design.layers.push(l);
      selected = l.id;
      end();
      refresh();
    });

    // ----- properties -----
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    function group(title) {
      const g = el('section', 'cs-group');
      g.append(el('h4', '', title));
      props.append(g);
      return g;
    }
    // A field bound to obj[key]; kind: text, area, number, color, select, bool, range.
    function field(parent, obj, key, label, kind, opts = {}) {
      const wrap = el('label', `cs-field cs-field-${kind}`);
      wrap.append(el('span', '', label));
      let input;
      if (kind === 'area') input = el('textarea');
      else if (kind === 'select') {
        input = el('select');
        for (const o of opts.options) {
          const [v, lbl] = Array.isArray(o) ? o : [o, o];
          const op = el('option', '', lbl);
          op.value = v;
          input.append(op);
        }
      } else {
        input = el('input');
        input.type = kind === 'bool' ? 'checkbox' : kind === 'range' ? 'range' : kind === 'number' ? 'number' : 'text';
        if (kind === 'range') Object.assign(input, { min: opts.min ?? 0, max: opts.max ?? 1, step: opts.step ?? 0.05 });
        if (kind === 'number') Object.assign(input, { min: opts.min ?? -9999, max: opts.max ?? 9999, step: opts.step ?? 1 });
      }
      const cur = obj[key] ?? opts.fallback ?? '';
      if (kind === 'bool') input.checked = cur === true || (cur === '' && opts.fallback === true);
      else input.value = String(cur);
      if (kind === 'color') {
        const pick = el('input');
        pick.type = 'color';
        pick.value = /^#[0-9a-f]{6}$/i.test(String(cur)) ? cur : '#ffffff';
        pick.addEventListener('input', () => {
          begin();
          input.value = pick.value;
          obj[key] = pick.value;
          redraw();
        });
        pick.addEventListener('change', end);
        wrap.append(pick);
      }
      const read = () => (kind === 'bool' ? input.checked : kind === 'number' || kind === 'range' ? Number(input.value) : input.value);
      input.addEventListener('input', () => {
        begin();
        obj[key] = read();
        if (opts.onInput) opts.onInput();
        redraw();
      });
      input.addEventListener('change', () => {
        end();
        if (opts.rerender) refresh();
      });
      wrap.append(input);
      parent.append(wrap);
      return input;
    }

    function varChips(parent, onPick) {
      const box = el('div', 'cs-vars');
      for (const k of Object.keys(r.SAMPLE_VARS)) {
        const b = el('button', 'cs-var', `{${k}}`);
        b.type = 'button';
        b.addEventListener('click', () => onPick(`{${k}}`));
        box.append(b);
      }
      parent.append(box);
    }

    function renderProps() {
      props.innerHTML = '';
      const l = selected && layerById(selected);
      if (!l) {
        const bg = design.background || (design.background = {});
        const g = group(t('background'));
        field(g, bg, 'type', t('bg.type'), 'select', { options: [['color', t('bg.color')], ['gradient', t('bg.gradient')], ['image', t('bg.image')]], fallback: 'color', rerender: true });
        field(g, bg, 'color', t('colour'), 'color', { fallback: '#23272a' });
        if (bg.type === 'gradient') {
          field(g, bg, 'color2', t('colour2'), 'color', { fallback: '#5865f2' });
          field(g, bg, 'angle', t('angle'), 'number', { min: 0, max: 360, fallback: 135 });
        }
        if (bg.type === 'image') {
          field(g, bg, 'image', t('image_url'), 'text');
          g.append(el('p', 'hint', t('image_hint')));
        }
        field(g, bg, 'dim', t('dim'), 'range', { min: 0, max: 0.9, fallback: 0 });
        field(g, bg, 'radius', t('corner'), 'number', { min: 0, max: 200, fallback: 0 });
        props.append(el('p', 'hint', t('pick_layer')));
        return;
      }
      const g = group(t(`layer.${l.type}`));
      field(g, l, 'name', t('name'), 'text', { onInput: renderLayers });
      if (l.type === 'text' || l.type === 'badge' || l.type === 'grid') {
        const area = field(g, l, 'text', l.type === 'grid' ? t('rows') : t('says'), l.type === 'text' || l.type === 'grid' ? 'area' : 'text');
        if (l.type === 'grid') g.append(el('p', 'hint', t('grid_hint')));
        varChips(g, (v) => {
          begin();
          const at = area.selectionStart ?? area.value.length;
          area.value = area.value.slice(0, at) + v + area.value.slice(area.selectionEnd ?? at);
          l.text = area.value;
          end();
          redraw();
        });
      }
      if (l.type === 'image') {
        field(g, l, 'url', t('image_url'), 'text');
        g.append(el('p', 'hint', t('image_hint')));
        field(g, l, 'fit', t('fit'), 'select', { options: [['cover', t('fit.cover')], ['contain', t('fit.contain')]] });
        field(g, l, 'radius', t('corner'), 'number', { min: 0, max: 1000 });
      }
      if (l.type === 'avatar') {
        field(g, l, 'source', t('whose'), 'select', { options: [['user', t('whose.user')], ['second', t('whose.second')]] });
        field(g, l, 'shape', t('shape'), 'select', { options: [['circle', t('shape.circle')], ['rounded', t('shape.rounded')], ['square', t('shape.square')]] });
        field(g, l, 'borderWidth', t('border'), 'number', { min: 0, max: 50 });
        field(g, l, 'borderColor', t('border_colour'), 'color', { fallback: '#ffffff' });
      }
      if (l.type === 'text' || l.type === 'badge' || l.type === 'grid') {
        const f = group(t('font'));
        field(f, l, 'font', t('font'), 'select', { options: r.FONTS.map((x) => x.family), fallback: 'Poppins', rerender: true });
        const weights = Object.keys((r.FONTS.find((x) => x.family === (l.font || 'Poppins')) || r.FONTS[0]).weights);
        field(f, l, 'weight', t('weight'), 'select', { options: weights.map((w) => [w, t(`weight.${w}`)]), fallback: weights.at(-1) });
        field(f, l, 'size', t('size'), 'number', { min: 6, max: 400, fallback: 48 });
        if (l.type === 'text') {
          field(f, l, 'align', t('align'), 'select', { options: [['left', t('align.left')], ['center', t('align.center')], ['right', t('align.right')]], fallback: 'center' });
          field(f, l, 'letterSpacing', t('spacing'), 'number', { min: -20, max: 50, fallback: 0 });
          field(f, l, 'shrink', t('shrink'), 'bool', { fallback: true });
          field(f, l, 'wrap', t('wrap'), 'bool');
          field(f, l, 'shadow', t('shadow'), 'bool');
          field(f, l, 'fillType', t('fill'), 'select', { options: [['color', t('bg.color')], ['gradient', t('bg.gradient')]], rerender: true });
          field(f, l, 'color', t('colour'), 'color', { fallback: '#ffffff' });
          if (l.fillType === 'gradient') field(f, l, 'color2', t('colour2'), 'color', { fallback: '#a78bfa' });
        } else if (l.type === 'badge') {
          field(f, l, 'color', t('text_colour'), 'color', { fallback: '#ffffff' });
          field(f, l, 'fill', t('colour'), 'color', { fallback: '#5865f2' });
        } else {
          field(f, l, 'color', t('colour'), 'color', { fallback: '#ffffff' });
          field(f, l, 'header', t('grid_header'), 'bool');
          field(f, l, 'headColor', t('grid_head_colour'), 'color', { fallback: '#a78bfa' });
          field(f, l, 'stripes', t('grid_stripes'), 'bool', { fallback: true });
        }
      }
      if (l.type === 'shape' || l.type === 'bar') {
        const s = group(t('fill'));
        if (l.type === 'shape') field(s, l, 'shape', t('shape'), 'select', { options: [['rect', t('shape.rect')], ['circle', t('shape.circle')], ['star', t('shape.star')]] });
        if (l.type === 'bar') {
          field(s, l, 'value', t('bar_value'), 'text');
          s.append(el('p', 'hint', t('bar_hint')));
          field(s, l, 'track', t('track'), 'color', { fallback: '#4e5058' });
        }
        field(s, l, 'fillType', t('fill'), 'select', { options: [['color', t('bg.color')], ['gradient', t('bg.gradient')], ...(l.type === 'shape' ? [['none', t('fill.none')]] : [])], rerender: true });
        field(s, l, 'fill', t('colour'), 'color', { fallback: '#5865f2' });
        if (l.fillType === 'gradient') field(s, l, 'fill2', t('colour2'), 'color', { fallback: '#eb459e' });
        field(s, l, 'radius', t('corner'), 'number', { min: 0, max: 1000 });
        if (l.type === 'shape') {
          field(s, l, 'strokeWidth', t('border'), 'number', { min: 0, max: 50 });
          field(s, l, 'stroke', t('border_colour'), 'color', { fallback: '#ffffff' });
        }
      }
      const p = group(t('position'));
      for (const k of ['x', 'y', 'w', 'h']) field(p, l, k, t(`pos.${k}`), 'number', { onInput: placeBox });
      field(p, l, 'rotation', t('rotation'), 'number', { min: -360, max: 360, fallback: 0 });
      field(p, l, 'opacity', t('opacity'), 'range', { min: 0, max: 1, fallback: 1 });
      const c = el('div', 'cs-center');
      for (const [k, label] of [['x', t('centre_across')], ['y', t('centre_down')]]) {
        const b = el('button', 'btn btn-sm', label);
        b.type = 'button';
        b.addEventListener('click', () => {
          begin();
          if (k === 'x') l.x = Math.round((design.width - l.w) / 2);
          else l.y = Math.round((design.height - l.h) / 2);
          end();
          refresh();
        });
        c.append(b);
      }
      p.append(c);
    }

    function refresh() {
      renderLayers();
      renderProps();
      redraw();
    }

    // ----- drag & resize on the card -----
    let drag = null;
    function hit(px, py) {
      for (let i = design.layers.length - 1; i >= 0; i--) {
        const l = design.layers[i];
        if (l.visible !== false && px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h) return l;
      }
      return null;
    }
    overlay.addEventListener('pointerdown', (e) => {
      const s = scale();
      const rect = overlay.getBoundingClientRect();
      const px = (e.clientX - rect.left) / s;
      const py = (e.clientY - rect.top) / s;
      const handle = e.target.dataset?.handle;
      let l = handle ? layerById(selected) : hit(px, py);
      if (!l) {
        selected = null;
        refresh();
        return;
      }
      if (l.id !== selected) {
        selected = l.id;
        renderLayers();
        renderProps();
        placeBox();
      }
      begin();
      drag = { id: l.id, handle, px, py, start: { x: l.x, y: l.y, w: l.w, h: l.h } };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const l = layerById(drag.id);
      if (!l) return;
      const s = scale();
      const rect = overlay.getBoundingClientRect();
      const dx = (e.clientX - rect.left) / s - drag.px;
      const dy = (e.clientY - rect.top) / s - drag.py;
      const b = drag.start;
      if (!drag.handle) {
        l.x = Math.round(b.x + dx);
        l.y = Math.round(b.y + dy);
        if (snap) {
          const cx = (design.width - l.w) / 2;
          const cy = (design.height - l.h) / 2;
          if (Math.abs(l.x - cx) < 8) l.x = Math.round(cx);
          if (Math.abs(l.y - cy) < 8) l.y = Math.round(cy);
        }
      } else {
        const h = drag.handle;
        if (h.includes('e')) l.w = Math.max(10, Math.round(b.w + dx));
        if (h.includes('s')) l.h = Math.max(10, Math.round(b.h + dy));
        if (h.includes('w')) {
          l.w = Math.max(10, Math.round(b.w - dx));
          l.x = Math.round(b.x + b.w - l.w);
        }
        if (h.includes('n')) {
          l.h = Math.max(10, Math.round(b.h - dy));
          l.y = Math.round(b.y + b.h - l.h);
        }
        if (e.shiftKey && l.type === 'avatar') l.h = l.w;
      }
      placeBox();
      redraw();
    });
    const stop = () => {
      if (!drag) return;
      drag = null;
      end();
      renderProps();
    };
    overlay.addEventListener('pointerup', stop);
    overlay.addEventListener('pointercancel', stop);

    // ----- keys -----
    document.addEventListener('keydown', (e) => {
      if (!root.isConnected) return;
      const typing = e.target.closest('input, textarea, select');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
        return;
      }
      const l = selected && layerById(selected);
      if (!l || typing) return;
      const step = e.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        begin();
        l.x += moves[e.key][0];
        l.y += moves[e.key][1];
        end();
        renderProps();
        redraw();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        begin();
        design.layers = design.layers.filter((x) => x.id !== l.id);
        selected = null;
        end();
        refresh();
      }
    });

    function undo() {
      if (!past.length) return;
      future.push(JSON.stringify(design));
      design = JSON.parse(past.pop());
      if (selected && !layerById(selected)) selected = null;
      dirty = true;
      refresh();
    }
    function redo() {
      if (!future.length) return;
      past.push(JSON.stringify(design));
      design = JSON.parse(future.pop());
      dirty = true;
      refresh();
    }
    root.querySelector('[data-cs-undo]').addEventListener('click', undo);
    root.querySelector('[data-cs-redo]').addEventListener('click', redo);

    // ----- top bar -----
    const nameInput = root.querySelector('[data-cs-name]');
    const kindSelect = root.querySelector('[data-cs-kind]');
    nameInput.addEventListener('input', () => {
      dirty = true;
      status.textContent = t('unsaved');
    });
    kindSelect.addEventListener('change', () => {
      dirty = true;
      status.textContent = t('unsaved');
    });
    const sizeSelect = root.querySelector('[data-cs-size]');
    const sizeKey = `${design.width}x${design.height}`;
    if (![...sizeSelect.options].some((o) => o.value === sizeKey)) {
      const o = el('option', '', `${design.width} × ${design.height}`);
      o.value = sizeKey;
      sizeSelect.prepend(o);
    }
    sizeSelect.value = sizeKey;
    sizeSelect.addEventListener('change', () => {
      const [w, h] = sizeSelect.value.split('x').map(Number);
      begin();
      const fx = w / design.width;
      const fy = h / design.height;
      for (const l of design.layers) {
        l.x = Math.round(l.x * fx);
        l.y = Math.round(l.y * fy);
        l.w = Math.round(l.w * fx);
        l.h = Math.round(l.h * fy);
      }
      design.width = w;
      design.height = h;
      end();
      refresh();
    });
    root.querySelector('[data-cs-preview]').addEventListener('change', (e) => {
      preview = e.target.value;
      redraw();
    });
    root.querySelector('[data-cs-template]').addEventListener('click', async () => {
      if (!window.confirm(t('template_confirm'))) return;
      const { templates } = await (await fetch('/cards/templates.json')).json();
      begin();
      design = clone(templates[kindSelect.value] || templates.custom);
      selected = null;
      end();
      refresh();
    });

    async function save() {
      status.textContent = t('saving');
      try {
        await api('PUT', `/api/v1/bots/${bot}/cards/${cardId}`, { name: nameInput.value.trim(), kind: kindSelect.value, design });
        dirty = false;
        status.textContent = t('saved');
      } catch (ex) {
        status.textContent = `${t('save_failed')} (${ex.message})`;
      }
    }
    root.querySelector('[data-cs-save]').addEventListener('click', save);
    window.addEventListener('beforeunload', (e) => {
      if (dirty && root.isConnected) e.preventDefault();
    });
    new ResizeObserver(() => placeBox()).observe(canvas);

    load().then((rr) => {
      r = rr;
      design = { ...rr.normalize(design), layers: rr.normalize(design).layers };
      refresh();
    });
  }

  function init() {
    for (const root of document.querySelectorAll('[data-cards]')) initList(root);
    for (const root of document.querySelectorAll('[data-card-studio]')) initStudio(root);
  }
  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('htmx:afterSettle', init);
})();
