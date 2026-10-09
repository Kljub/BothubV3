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

  // Pictures for the preview (the page only loads its own files, data: and the
  // Discord CDN). "asset:<id>" is an uploaded picture of the bot (Your pictures).
  const images = new Map();
  let assetBot = null;
  const assetUrl = async (id) => {
    const a = await api('GET', `/api/v1/bots/${assetBot}/card-images/${id}`);
    return `data:${a.mime};base64,${a.data}`;
  };
  function loadImage(url) {
    if (!images.has(url)) {
      images.set(url, (async () => {
        let src = url;
        const asset = /^asset:(\d+)$/.exec(url);
        if (asset) {
          try {
            src = await assetUrl(asset[1]);
          } catch {
            return null;
          }
        }
        const frames = await gifFrames(src);
        if (frames) return frames;
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
        });
      })());
    }
    return images.get(url);
  }

  // Animated GIFs: their frames ({ frames: [{ image, delay }] }, the shared
  // renderer picks one by time). Needs the browser's ImageDecoder; without
  // it (or for pictures of other sites) the first frame shows.
  let anyAnimated = false;
  async function gifFrames(src) {
    if (typeof ImageDecoder === 'undefined') return null;
    try {
      // Uploaded pictures arrive as data: URLs (no fetch: the page's CSP), others by fetch.
      let bytes;
      const m = /^data:image\/gif;base64,(.+)$/.exec(src);
      if (m) bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
      else if (/^data:/.test(src)) return null;
      else {
        const res = await fetch(src);
        const blob = res.ok ? await res.blob() : null;
        if (!blob || blob.type !== 'image/gif') return null;
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
      await dec.tracks.ready;
      const count = Math.min(dec.tracks.selectedTrack?.frameCount ?? 0, 100);
      if (count < 2) return null;
      const frames = [];
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        frames.push({ image: await createImageBitmap(image), delay: Math.max(20, (image.duration || 100000) / 1000) });
        image.close();
      }
      anyAnimated = true;
      return { frames };
    } catch {
      return null;
    }
  }

  const PREVIEWS = {
    kljub: { 'user.avatar': 'https://cdn.discordapp.com/embed/avatars/1.png', 'second.avatar': 'https://cdn.discordapp.com/embed/avatars/3.png' },
    long: { user: 'Maximilian Sonnenschein', 'user.name': 'maximilian.sonnenschein', 'user.display': 'Maximilian Sonnenschein', 'user.avatar': 'https://cdn.discordapp.com/embed/avatars/4.png', 'member.ordinal': '12,345th', members: '12345' },
  };
  const varsFor = (r, key) => ({ ...r.SAMPLE_VARS, ...PREVIEWS.kljub, ...(PREVIEWS[key] || {}) });

  async function draw(canvas, design, vars, time = 0) {
    const r = await load();
    const d = r.normalize(design);
    if (canvas.width !== d.width) canvas.width = d.width;
    if (canvas.height !== d.height) canvas.height = d.height;
    await r.drawCard(canvas.getContext('2d'), design, { vars: vars || varsFor(r, 'kljub'), loadImage, time });
  }

  // ---------- card list ----------

  function initList(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    const bot = root.dataset.bot;
    assetBot = bot;
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
        const card = await api('POST', `/api/v1/bots/${bot}/cards`, { name: f.name.value.trim() || f.dataset.defaultName, kind, design: templates[kind] || templates.custom });
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
    assetBot = bot;
    const cardId = root.dataset.card;
    const canvas = root.querySelector('[data-cs-canvas]');
    const overlay = root.querySelector('[data-cs-overlay]');
    const layersEl = root.querySelector('[data-cs-layers]');
    const props = root.querySelector('[data-cs-props]');
    const status = root.querySelector('[data-cs-status]');
    let design = JSON.parse(root.dataset.design || '{}');
    let selected = null;
    let preview = 'kljub';
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
        await draw(canvas, design, varsFor(r, preview), performance.now() - animStart);
      } while (again);
      drawing = false;
      placeBox();
      animate();
    }

    // Animated card: the preview plays (about 12 pictures a second).
    const animStart = performance.now();
    let animTimer = null;
    function animate() {
      clearTimeout(animTimer);
      if (!design.animated || !(anyAnimated || r.effectLoop(design) > 0) || !root.isConnected) return;
      animTimer = setTimeout(async () => {
        if (!drawing) {
          drawing = true;
          await draw(canvas, design, varsFor(r, preview), performance.now() - animStart);
          drawing = false;
        }
        animate();
      }, 80);
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
        li.draggable = true;
        li.innerHTML = '<span class="cs-layer-grip" aria-hidden="true">⠿</span><span class="cs-layer-type"></span><span class="cs-layer-name"></span>';
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

    // Drag & drop: a layer dropped above another is drawn over it (the list
    // shows the top layer first, design.layers holds the bottom first).
    let dragId = null;
    const clearDrop = () => layersEl.querySelectorAll('.drop-above, .drop-below').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    layersEl.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.cs-layer');
      if (!li?.dataset.id) return;
      dragId = li.dataset.id;
      li.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    layersEl.addEventListener('dragover', (e) => {
      const li = e.target.closest('.cs-layer');
      if (!dragId || !li || li.classList.contains('cs-layer-bg')) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      clearDrop();
      li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
    });
    layersEl.addEventListener('dragleave', (e) => {
      if (!layersEl.contains(e.relatedTarget)) clearDrop();
    });
    layersEl.addEventListener('drop', (e) => {
      const li = e.target.closest('.cs-layer');
      const above = li?.classList.contains('drop-above');
      clearDrop();
      if (!dragId || !li?.dataset.id || li.dataset.id === dragId) return;
      e.preventDefault();
      const from = design.layers.findIndex((l) => l.id === dragId);
      if (from < 0) return;
      begin();
      const [moved] = design.layers.splice(from, 1);
      const to = design.layers.findIndex((l) => l.id === li.dataset.id);
      // "Above" in the list = drawn later (higher index).
      design.layers.splice(above ? to + 1 : to, 0, moved);
      selected = moved.id;
      end();
      refresh();
    });
    layersEl.addEventListener('dragend', () => {
      dragId = null;
      clearDrop();
      layersEl.querySelectorAll('.is-dragging').forEach((x) => x.classList.remove('is-dragging'));
    });

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
      effect: { effect: 'snow', count: 40, scale: 1, speed: 1, w: design.width, h: design.height },
    };
    root.querySelector('[data-cs-add]').addEventListener('click', (e) => {
      const type = e.target.closest('[data-add]')?.dataset.add;
      if (!type) return;
      begin();
      const d = DEFAULTS[type];
      const l = { id: newId(), type, name: t(`layer.${type}`), ...clone(d), x: Math.round((design.width - d.w) / 2), y: Math.round((design.height - d.h) / 2) };
      if (type === 'effect') Object.assign(l, { w: design.width, h: design.height, x: 0, y: 0 });
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

    // Variables: a clipboard button on the field opens a searchable list
    // (name and sample value) instead of every chip taking room below it.
    function varPicker(input, onPick) {
      const wrap = input.parentElement;
      wrap.classList.add('cs-has-vars');
      const btn = el('button', 'cs-var-btn', '📋');
      btn.type = 'button';
      btn.title = t('vars');
      btn.setAttribute('aria-label', t('vars'));
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const open = wrap.querySelector('.cs-varpop');
        if (open) return open.remove();
        const pop = el('div', 'cs-varpop');
        const search = el('input', 'cs-varpop-search');
        search.placeholder = t('vars_search');
        const list = el('div', 'cs-varpop-list');
        const fill = () => {
          const q = search.value.trim().toLowerCase();
          list.innerHTML = '';
          for (const [k, sample] of Object.entries(r.SAMPLE_VARS)) {
            if (q && !k.toLowerCase().includes(q)) continue;
            const item = el('button', 'cs-varpop-item');
            item.type = 'button';
            item.append(el('code', '', `{${k}}`), el('span', '', String(sample).split('\n')[0].slice(0, 40)));
            item.addEventListener('click', () => {
              onPick(`{${k}}`);
              pop.remove();
              input.focus();
            });
            list.append(item);
          }
        };
        search.addEventListener('input', fill);
        search.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { pop.remove(); input.focus(); } });
        pop.append(search, list);
        wrap.append(pop);
        fill();
        search.focus();
        const outside = (ev) => {
          if (!pop.contains(ev.target) && ev.target !== btn) {
            pop.remove();
            document.removeEventListener('pointerdown', outside, true);
          }
        };
        document.addEventListener('pointerdown', outside, true);
      });
      wrap.append(btn);
    }

    // "Your pictures": uploads of the bot; a click puts one into obj[key] as asset:<id>.
    let pictureList = null;
    function pictures(parent, obj, key) {
      const box = el('div', 'cs-pictures');
      parent.append(el('span', 'cs-sub', t('pictures')), box);
      const fill = (items) => {
        box.innerHTML = '';
        for (const p of items) {
          const tile = el('button', `cs-pic${obj[key] === `asset:${p.id}` ? ' is-selected' : ''}`);
          tile.type = 'button';
          tile.title = p.name;
          const img = el('img');
          img.alt = '';
          loadImage(`asset:${p.id}`).then((i) => {
            if (i) img.src = i.src;
          });
          const del = el('span', 'cs-pic-del', '✕');
          del.title = t('picture_delete');
          tile.append(img, del);
          tile.addEventListener('click', async (e) => {
            if (e.target === del) {
              if (!window.confirm(t('picture_delete_confirm'))) return;
              await api('DELETE', `/api/v1/bots/${bot}/card-images/${p.id}`).catch(() => null);
              pictureList = null;
              renderProps();
              return;
            }
            begin();
            obj[key] = `asset:${p.id}`;
            end();
            refresh();
          });
          box.append(tile);
        }
        const up = el('label', 'cs-pic cs-pic-add', '+');
        up.title = t('picture_upload');
        const input = el('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/gif,image/webp';
        input.hidden = true;
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) return;
          if (file.size > 2 * 1024 * 1024) {
            status.textContent = t('picture_too_big');
            return;
          }
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const data = String(reader.result).split(',')[1];
              const pic = await api('POST', `/api/v1/bots/${bot}/card-images`, { name: file.name, data });
              pictureList = null;
              begin();
              obj[key] = `asset:${pic.id}`;
              end();
              refresh();
            } catch (ex) {
              status.textContent = `${t('picture_failed')} (${ex.message})`;
            }
          };
          reader.readAsDataURL(file);
        });
        up.append(input);
        box.append(up);
      };
      (pictureList ??= api('GET', `/api/v1/bots/${bot}/card-images`).then((r) => r.items || []).catch(() => [])).then(fill);
    }

    function renderProps() {
      props.innerHTML = '';
      const l = selected && layerById(selected);
      if (!l) {
        const bg = design.background || (design.background = {});
        const g = group(t('background'));
        field(g, design, 'animated', t('animated'), 'bool', { fallback: false });
        g.append(el('p', 'hint', t('animated_hint')));
        field(g, bg, 'type', t('bg.type'), 'select', { options: [['color', t('bg.color')], ['gradient', t('bg.gradient')], ['image', t('bg.image')]], fallback: 'color', rerender: true });
        field(g, bg, 'color', t('colour'), 'color', { fallback: '#23272a' });
        if (bg.type === 'gradient') {
          field(g, bg, 'color2', t('colour2'), 'color', { fallback: '#5865f2' });
          field(g, bg, 'angle', t('angle'), 'number', { min: 0, max: 360, fallback: 135 });
        }
        if (bg.type === 'image') {
          pictures(g, bg, 'image');
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
        varPicker(area, (v) => {
          begin();
          const at = area.selectionStart ?? area.value.length;
          area.value = area.value.slice(0, at) + v + area.value.slice(area.selectionEnd ?? at);
          l.text = area.value;
          end();
          redraw();
        });
      }
      if (l.type === 'image') {
        pictures(g, l, 'url');
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
      if (l.type === 'effect') {
        const e = group(t('effect'));
        field(e, l, 'effect', t('effect'), 'select', { options: r.EFFECTS.map((k) => [k, t(`effect.${k}`)]), fallback: 'snow' });
        field(e, l, 'count', t('effect_count'), 'number', { min: 1, max: 200, fallback: 40 });
        field(e, l, 'scale', t('effect_scale'), 'range', { min: 0.2, max: 5, fallback: 1 });
        field(e, l, 'speed', t('effect_speed'), 'number', { min: 1, max: 4, fallback: 1 });
        field(e, l, 'color', t('colour'), 'color', { fallback: '' });
        field(e, l, 'color2', t('colour2'), 'color', { fallback: '' });
        e.append(el('p', 'hint', t('effect_hint')));
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
    // Template gallery: categories, previews drawn when they scroll into view.
    let gallery = null;
    root.querySelector('[data-cs-template]').addEventListener('click', async () => {
      if (!gallery) {
        const data = await (await fetch('/cards/gallery.json')).json();
        gallery = el('dialog', 'cs-gallery');
        const head = el('header', 'cs-gallery-head');
        head.append(el('strong', '', t('gallery')));
        const close = el('button', 'icon-btn', '×');
        close.type = 'button';
        close.addEventListener('click', () => gallery.close());
        head.append(close);
        const chips = el('div', 'chips cs-gallery-cats');
        const grid = el('div', 'cs-gallery-grid');
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            const tpl = data.templates[Number(e.target.dataset.i)];
            draw(e.target, tpl.design, varsFor(r, preview));
          }
        }, { root: grid });
        const show = (cat) => {
          for (const b of chips.children) b.classList.toggle('is-active', b.dataset.cat === cat);
          for (const tile of grid.children) tile.hidden = cat !== 'all' && tile.dataset.cat !== cat;
        };
        for (const cat of ['all', ...data.categories]) {
          const b = el('button', 'chip', t(`gallery.${cat}`));
          b.type = 'button';
          b.dataset.cat = cat;
          b.addEventListener('click', () => show(cat));
          chips.append(b);
        }
        data.templates.forEach((tpl, i) => {
          const tile = el('button', 'cs-gallery-tile');
          tile.type = 'button';
          tile.dataset.cat = tpl.category;
          const c = el('canvas');
          c.dataset.i = String(i);
          tile.append(c, el('span', '', tpl.name));
          tile.addEventListener('click', () => {
            if (design.layers.length && !window.confirm(t('template_confirm'))) return;
            begin();
            design = clone(tpl.design);
            if ([...kindSelect.options].some((o) => o.value === tpl.kind)) kindSelect.value = tpl.kind;
            selected = null;
            end();
            gallery.close();
            refresh();
          });
          grid.append(tile);
          io.observe(c);
        });
        gallery.append(head, chips, grid);
        document.body.append(gallery);
        show('all');
      }
      gallery.showModal();
    });

    // Saves the card; true when it is stored. Changes are also saved on
    // their own 2 seconds after the last edit.
    let saving = null;
    async function save() {
      clearTimeout(autoTimer);
      autoTimer = null;
      if (saving) await saving;
      status.textContent = t('saving');
      const sent = JSON.stringify(design);
      saving = api('PUT', `/api/v1/bots/${bot}/cards/${cardId}`, { name: nameInput.value.trim(), kind: kindSelect.value, design: JSON.parse(sent) })
        .then(() => {
          if (JSON.stringify(design) === sent) dirty = false;
          status.textContent = dirty ? t('unsaved') : t('saved');
          return true;
        })
        .catch((ex) => {
          status.textContent = `${t('save_failed')} (${ex.message})`;
          return false;
        });
      const ok = await saving;
      saving = null;
      return ok;
    }
    let autoTimer = null;
    setInterval(() => {
      if (dirty && !saving && !autoTimer) autoTimer = setTimeout(() => { autoTimer = null; if (dirty) save(); }, 2000);
    }, 500);
    root.querySelector('[data-cs-save]').addEventListener('click', save);

    // "Send a test": pick a server and channel; the bot posts the saved card there.
    const testPanel = root.querySelector('[data-cs-test-panel]');
    root.querySelector('[data-cs-test]').addEventListener('click', async () => {
      testPanel.hidden = !testPanel.hidden;
      if (testPanel.hidden || testPanel.dataset.loaded) return;
      testPanel.dataset.loaded = '1';
      const gSel = testPanel.querySelector('[data-cs-test-guild]');
      const cSel = testPanel.querySelector('[data-cs-test-channel]');
      const loadChannels = async () => {
        cSel.innerHTML = '';
        if (!gSel.value) return;
        const res = await api('GET', `/api/v1/bots/${bot}/guilds/${gSel.value}/channels`).catch(() => ({ items: [] }));
        for (const c of res.items || []) {
          if (c.type !== 'text' && c.type !== 'announcement') continue;
          const o = el('option', '', `# ${c.name}`);
          o.value = c.id;
          cSel.append(o);
        }
      };
      try {
        const res = await api('GET', `/api/v1/bots/${bot}/guilds`);
        for (const g of res.items || []) {
          const o = el('option', '', g.name);
          o.value = g.id;
          gSel.append(o);
        }
        gSel.addEventListener('change', loadChannels);
        await loadChannels();
      } catch (ex) {
        testPanel.querySelector('[data-cs-test-status]').textContent = t('test_no_servers');
      }
    });
    root.querySelector('[data-cs-test-send]').addEventListener('click', async () => {
      const out = testPanel.querySelector('[data-cs-test-status]');
      const channelId = testPanel.querySelector('[data-cs-test-channel]').value;
      if (!channelId) return;
      // The bot draws the stored card: save first, and never send an old one.
      if (dirty && !(await save())) {
        out.textContent = `${t('test_failed')} (${t('save_failed')})`;
        return;
      }
      try {
        await api('POST', `/api/v1/bots/${bot}/cards/${cardId}/send`, { channelId });
        out.textContent = t('test_sent');
      } catch (ex) {
        out.textContent = `${t('test_failed')} (${ex.message})`;
      }
    });
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
