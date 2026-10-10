// BotHub message builder: popup editor of the "Send or Edit a Message" block.
// Edits node.config.message in place: text and embeds (normal message) or
// text, separators and media (Components V2). Buttons and menus are blocks on
// the canvas; the preview shows them read-only.
(() => {
  'use strict';

  const MAX_CONTENT = 2000;
  const MAX_EMBEDS = 10;
  const MAX_FIELDS = 25;
  const MAX_EMBED_TOTAL = 6000;
  const MAX_V2 = 40;
  const DEFAULT_COLOR = '#5865f2';
  const EMOJIS = ['😀', '😂', '😊', '😍', '😎', '🤔', '😢', '😡', '👍', '👎', '👏', '🙏', '🎉', '🎁', '🔥', '⭐', '✅', '❌', '⚠️', '❗', '❓', '💬', '📢', '📌',
    '🔒', '🔓', '🔔', '💡', '⏰', '📅', '🏆', '🥇', '💰', '💎', '🎮', '🎵', '❤️', '💙', '💚', '💛', '💜', '🖤', '➡️', '⬅️', '⬆️', '⬇️', '🔗', '👋'];

  // ---------- helpers usable without the popup ----------

  const text = (v) => String(v ?? '');
  const embedChars = (e) => text(e.title).length + text(e.description).length + text(e.author?.name).length + text(e.footer?.text).length
    + (e.fields || []).reduce((n, f) => n + text(f.name).length + text(f.value).length, 0);
  const embedEmpty = (e) => !text(e.title).trim() && !text(e.description).trim() && !(e.fields || []).length
    && !text(e.image_url).trim() && !text(e.thumbnail_url).trim() && !text(e.author?.name).trim() && !text(e.footer?.text).trim();

  function hasBody(msg) {
    if (!msg) return false;
    if (msg.mode === 'v2') return (msg.components || []).some((c) => (c.type === 'text' && text(c.content).trim()) || (c.type === 'media' && (c.urls || []).length));
    return Boolean(text(msg.content).trim()) || (msg.embeds || []).some((e) => !embedEmpty(e));
  }

  function problems(msg, t) {
    const out = [];
    if (!msg) return out;
    if (msg.mode !== 'v2') {
      (msg.embeds || []).forEach((e, i) => { if (embedEmpty(e)) out.push(t('builder.mb.embed_empty', { n: i + 1 })); });
      if ((msg.embeds || []).reduce((n, e) => n + embedChars(e), 0) > MAX_EMBED_TOTAL) out.push(t('builder.mb.limit_total'));
    }
    return out;
  }

  function summary(msg) {
    if (!msg) return '';
    const parts = msg.mode === 'v2' ? (msg.components || []).filter((c) => c.type === 'text').map((c) => c.content) : [msg.content, ...(msg.embeds || []).map((e) => e.title || e.description)];
    return text(parts.find((p) => text(p).trim())).split('\n')[0].slice(0, 90);
  }

  const hexToInt = (hex) => (/^#[0-9a-f]{6}$/i.test(hex || '') ? parseInt(hex.slice(1), 16) : undefined);
  const intToHex = (n) => (Number.isInteger(n) ? `#${n.toString(16).padStart(6, '0')}` : undefined);
  const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === '' || v === undefined || (Array.isArray(v) && !v.length) ? undefined : v)));

  // toDiscord converts the block's message (plus its buttons and menus) to
  // Discord message JSON.
  // Button / option emoji as Discord JSON: server emojis (<:name:id>) by ID.
  function emojiJson(v) {
    const s = String(v || '').trim();
    if (!s) return undefined;
    const m = /^<(a?):(\w{2,32}):(\d{15,21})>$/.exec(s);
    return m ? clean({ id: m[3], name: m[2], animated: m[1] ? true : undefined }) : { name: s };
  }

  function toDiscord(msg, comps = []) {
    const rows = [];
    const buttons = comps.filter((c) => c.kind === 'button');
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push({ type: 1, components: buttons.slice(i, i + 5).map((b) => clean({
        // Emoji-only buttons have no label (Discord shows none either).
        type: 2, style: { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 }[b.style] || 1, label: b.label || undefined,
        emoji: emojiJson(b.emoji), url: b.style === 'link' ? b.url : undefined,
        custom_id: b.style === 'link' ? undefined : b.id, disabled: b.disabled || undefined,
      })) });
    }
    for (const m of comps.filter((c) => c.kind === 'menu')) {
      rows.push({ type: 1, components: [clean({ type: 3, custom_id: m.id, placeholder: m.placeholder, min_values: m.min, max_values: m.max,
        options: (m.options || []).map((o) => clean({ label: o.label, value: o.value || o.label, description: o.description, emoji: emojiJson(o.emoji) })) })] });
    }
    if (msg.mode === 'v2') {
      const inner = (msg.components || []).map((c) => {
        if (c.type === 'text') return { type: 10, content: c.content || '' };
        if (c.type === 'separator') return { type: 14, divider: c.divider !== false, spacing: c.spacing === 'large' ? 2 : 1 };
        return { type: 12, items: (c.urls || []).map((url) => ({ media: { url } })) };
      });
      return { flags: 32768, components: [clean({ type: 17, accent_color: hexToInt(msg.accent), components: [...inner, ...rows] })] };
    }
    return clean({
      content: msg.content,
      embeds: (msg.embeds || []).map((e) => clean({
        title: e.title, url: e.url, description: e.description, color: hexToInt(e.color),
        author: e.author?.name ? { name: e.author.name, url: e.author.url, icon_url: e.author.icon_url } : undefined,
        fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
        image: e.image_url ? { url: e.image_url } : undefined, thumbnail: e.thumbnail_url ? { url: e.thumbnail_url } : undefined,
        footer: e.footer?.text ? { text: e.footer.text, icon_url: e.footer.icon_url } : undefined,
        timestamp: e.timestamp ? new Date().toISOString() : undefined,
      })),
      components: rows,
    });
  }

  // fromDiscord reads Discord message JSON. Buttons and menus are ignored:
  // they are blocks on the canvas.
  function fromDiscord(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('invalid');
    const str = (v, max) => text(v).slice(0, max);
    if ((json.flags & 32768) || (json.components || []).some((c) => [10, 12, 14, 17].includes(c.type))) {
      const out = { mode: 'v2', components: [] };
      const walk = (list) => {
        for (const c of list || []) {
          if (c.type === 17) {
            if (Number.isInteger(c.accent_color)) out.accent = intToHex(c.accent_color);
            walk(c.components);
          } else if (c.type === 10) out.components.push({ type: 'text', content: str(c.content, 4000) });
          else if (c.type === 14) out.components.push({ type: 'separator', divider: c.divider !== false, spacing: c.spacing === 2 ? 'large' : 'small' });
          else if (c.type === 12) out.components.push({ type: 'media', urls: (c.items || []).map((i) => str(i.media?.url, 2000)).filter(Boolean).slice(0, 10) });
          else if (c.type === 9) walk(c.components);
        }
      };
      walk(json.components);
      out.components = out.components.slice(0, MAX_V2);
      return out;
    }
    if (json.content === undefined && json.embeds === undefined) throw new Error('invalid');
    return {
      mode: 'normal',
      content: str(json.content, MAX_CONTENT),
      embeds: (json.embeds || []).slice(0, MAX_EMBEDS).map((e) => clean({
        color: intToHex(e.color), title: str(e.title, 256), url: str(e.url, 2000), description: str(e.description, 4096),
        author: e.author ? clean({ name: str(e.author.name, 256), url: str(e.author.url, 2000), icon_url: str(e.author.icon_url, 2000) }) : undefined,
        fields: (e.fields || []).slice(0, MAX_FIELDS).map((f) => ({ name: str(f.name, 256), value: str(f.value, 1024), inline: Boolean(f.inline) })),
        image_url: str(e.image?.url, 2000), thumbnail_url: str(e.thumbnail?.url, 2000),
        footer: e.footer ? clean({ text: str(e.footer.text, 2048), icon_url: str(e.footer.icon_url, 2000) }) : undefined,
        timestamp: Boolean(e.timestamp) || undefined,
      })),
    };
  }

  // ---------- Discord markdown (subset) as DOM, no innerHTML ----------

  const INLINE = /(\*\*([\s\S]+?)\*\*)|(__([\s\S]+?)__)|(\*([^*\n]+?)\*)|(_([^_\n]+?)_)|(~~([\s\S]+?)~~)|(\|\|([\s\S]+?)\|\|)|(`([^`\n]+?)`)|(\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\))|(<(@&|@!?|#)(\d{17,20})>)|(\{[a-zA-Z0-9_.]+\})|(https?:\/\/[^\s<]+)/g;

  function inline(str, el) {
    const frag = document.createDocumentFragment();
    // A new RegExp per call: recursion must not share lastIndex.
    const re = new RegExp(INLINE.source, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(str))) {
      if (m.index > last) frag.append(str.slice(last, m.index));
      if (m[1]) { const b = el('strong'); b.append(inline(m[2], el)); frag.append(b); }
      else if (m[3]) { const u = el('u'); u.append(inline(m[4], el)); frag.append(u); }
      else if (m[5] || m[7]) { const i = el('em'); i.append(inline(m[6] || m[8], el)); frag.append(i); }
      else if (m[9]) { const s = el('s'); s.append(inline(m[10], el)); frag.append(s); }
      else if (m[11]) { frag.append(el('span', 'dmsg-spoiler', m[12])); }
      else if (m[13]) { frag.append(el('code', 'dmsg-code', m[14])); }
      else if (m[15]) { frag.append(el('span', 'dmsg-link', m[16])); }
      else if (m[18]) { frag.append(el('span', 'dmsg-mention', m[19] === '#' ? `#channel` : m[19] === '@&' ? '@role' : '@user')); }
      else if (m[21]) { frag.append(el('span', 'dmsg-var', m[21])); }
      else if (m[22]) { frag.append(el('span', 'dmsg-link', m[22])); }
      last = re.lastIndex;
    }
    if (last < str.length) frag.append(str.slice(last));
    return frag;
  }

  function markdown(src, el) {
    const root = el('div', 'dmsg-md');
    const parts = text(src).split(/```(?:[a-z0-9]*\n)?([\s\S]*?)```/i);
    parts.forEach((part, i) => {
      if (i % 2 === 1) { root.append(el('pre', 'dmsg-pre', part)); return; }
      const lines = part.split('\n');
      lines.forEach((line, li) => {
        const h = /^(#{1,3}) (.*)$/.exec(line);
        const q = /^> (.*)$/.exec(line);
        if (h) {
          const hd = el('div', `dmsg-h${h[1].length}`);
          hd.append(inline(h[2], el));
          root.append(hd);
        } else if (q) {
          const bq = el('div', 'dmsg-quote');
          bq.append(inline(q[1], el));
          root.append(bq);
        } else {
          root.append(inline(line, el));
          if (li < lines.length - 1) root.append(el('br'));
        }
      });
    });
    return root;
  }

  // ---------- popup ----------

  function open(ctx) {
    const { t, el, icon, onChange } = ctx;
    const msg = ctx.message;
    msg.mode = msg.mode || 'normal';
    msg.embeds = msg.embeds || [];
    msg.components = msg.components || [];
    const openEmbeds = new Set(msg.embeds.length ? [0] : []);
    const changed = () => { onChange(); updateHead(); renderPreview(); };

    const overlay = el('div', 'bform bmsg');
    const dialog = el('div', 'bmsg-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('builder.mb.title'));

    // ---- header ----
    const head = el('header', 'bmsg-head');
    const hIcon = el('span', 'bmsg-icon');
    hIcon.append(icon('message'));
    const hText = el('div', 'bmsg-titles');
    const pills = el('div', 'bmsg-pills');
    const charPill = el('span', 'bmsg-pill');
    const embedPill = el('span', 'bmsg-pill');
    pills.append(charPill, embedPill);
    hText.append(el('strong', '', t('builder.mb.title')), pills);
    const tools = el('div', 'bmsg-tools');
    const tool = (name, label, fn) => {
      const b = el('button', 'btn btn-sm bmsg-tool');
      b.type = 'button';
      b.append(icon(name), document.createTextNode(label));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(b); });
      tools.append(b);
      return b;
    };
    tool('grid', t('builder.mb.templates'), (b) => openTemplates(b));
    tool('save', t('builder.mb.save_template'), (b) => openSave(b));
    tool('clipboard', t('builder.mb.paste_json'), (b) => openPaste(b));
    const copyBtn = tool('copy', t('builder.mb.copy_json'), () => {
      ctx.copy(JSON.stringify(toDiscord(msg, ctx.components()), null, 2), t('builder.mb.copied_json'));
    });
    const x = el('button', 'bform-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('builder.close'));
    x.addEventListener('click', close);
    head.append(hIcon, hText, tools, x);

    // ---- body ----
    const body = el('div', 'bmsg-body');
    const left = el('section', 'bmsg-left');
    const preview = el('section', 'bmsg-preview');
    body.append(left, preview);
    dialog.append(head, body);
    overlay.append(dialog);
    document.body.append(overlay);

    const closePops = () => dialog.querySelectorAll('.bmsg-pop, .bform-varmenu').forEach((p) => p.remove());
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
    dialog.addEventListener('click', closePops);
    overlay.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        if (dialog.querySelector('.bmsg-pop, .bform-varmenu')) closePops();
        else close();
      }
    });
    const prevFocus = document.activeElement;
    function close() {
      overlay.remove();
      ctx.onClose?.();
      prevFocus?.focus?.();
    }

    function updateHead() {
      const n = text(msg.content).length;
      charPill.textContent = t('builder.mb.chars', { count: n.toLocaleString() });
      charPill.classList.toggle('is-over', n > MAX_CONTENT);
      embedPill.textContent = t('builder.mb.embeds_count', { count: msg.embeds.length });
      embedPill.hidden = msg.mode === 'v2';
      charPill.hidden = msg.mode === 'v2';
      copyBtn.disabled = !hasBody(msg);
    }

    // ---- small builders ----
    function input(value, max, onInput, opts = {}) {
      const wrap = el('div', 'bform-input');
      const i = el(opts.multiline ? 'textarea' : 'input');
      if (!opts.multiline) i.type = opts.type || 'text';
      if (opts.rows) i.rows = opts.rows;
      if (max) i.maxLength = max;
      if (opts.placeholder) i.placeholder = opts.placeholder;
      if (opts.mono) i.classList.add('mono');
      i.value = value ?? '';
      i.addEventListener('input', () => onInput(i.value));
      wrap.append(i);
      if (opts.vars) wrap.append(varButton(i, max));
      return { wrap, input: i };
    }

    function insertAt(i, str, max) {
      const s = i.selectionStart ?? i.value.length;
      const e = i.selectionEnd ?? i.value.length;
      i.value = (i.value.slice(0, s) + str + i.value.slice(e)).slice(0, max || undefined);
      i.dispatchEvent(new Event('input'));
      i.focus();
      i.setSelectionRange(s + str.length, s + str.length);
    }

    function varButton(i, max) {
      const b = el('button', 'bform-code');
      b.type = 'button';
      b.title = t('builder.insert_variable');
      b.setAttribute('aria-label', t('builder.insert_variable'));
      b.append(icon('code'));
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePops();
        if (ctx.pickVariable) return ctx.pickVariable((name) => insertAt(i, name, max));
        const menu = el('div', 'bform-varmenu');
        for (const name of ctx.variables()) {
          const item = el('button', 'mono', name);
          item.type = 'button';
          item.addEventListener('click', () => { insertAt(i, name, max); menu.remove(); });
          menu.append(item);
        }
        b.parentElement.append(menu);
      });
      return b;
    }

    function labeled(labelText, control, hint, counter) {
      const f = el('div', 'bform-field');
      const top = el('div', 'bform-label');
      top.append(el('span', 'bform-label-text', labelText));
      if (counter) top.append(counter);
      f.append(top);
      if (hint) f.append(el('p', 'bform-hint', hint));
      f.append(control);
      return f;
    }

    function toolBtn(name, label, disabled, fn) {
      const b = el('button', 'bform-tool');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = disabled;
      b.append(icon(name));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      return b;
    }

    // ---- left: editor ----
    function renderLeft() {
      left.replaceChildren();
      if (msg.mode === 'v2') renderV2();
      else renderNormal();
    }

    function renderNormal() {
      // Message text
      const card = el('div', 'bmsg-card');
      const count = el('span', 'bform-count');
      const setCount = () => { count.textContent = `${text(msg.content).length}/${MAX_CONTENT}`; };
      setCount();
      const top = el('div', 'bform-label');
      top.append(el('span', 'bform-label-text', t('builder.mb.text')), count);
      const area = input(msg.content, MAX_CONTENT, (v) => { msg.content = v; setCount(); changed(); }, { multiline: true, rows: 5 });
      area.wrap.classList.add('bmsg-textarea');
      const icons = el('div', 'bmsg-textarea-tools');
      const vb = varButton(area.input, MAX_CONTENT);
      vb.classList.remove('bform-code');
      vb.classList.add('bmsg-mini');
      vb.replaceChildren(icon('clipboard'));
      const eb = el('button', 'bmsg-mini');
      eb.type = 'button';
      eb.title = t('builder.mb.emoji');
      eb.setAttribute('aria-label', t('builder.mb.emoji'));
      eb.append(icon('smile'));
      eb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePops();
        // The emoji picker of the dashboard (bot, server and standard emojis); picks add up.
        if (window.BotHubEmojiPicker) {
          window.BotHubEmojiPicker.open(icons, { t, botId: ctx.botId, bot: ctx.bot, multi: true, clear: false, onPick: (e) => insertAt(area.input, e, MAX_CONTENT) });
          return;
        }
        const pop = el('div', 'bmsg-pop bmsg-emojis');
        for (const e of EMOJIS) {
          const b = el('button', '', e);
          b.type = 'button';
          b.addEventListener('click', () => { insertAt(area.input, e, MAX_CONTENT); pop.remove(); });
          pop.append(b);
        }
        icons.append(pop);
      });
      icons.append(vb, eb);
      area.wrap.append(icons);
      card.append(top, area.wrap);
      left.append(card);

      // Embeds
      const eh = el('div', 'bmsg-section');
      const et = el('div', 'bmsg-section-title');
      et.append(el('strong', '', t('builder.mb.embeds')), el('span', 'bmsg-pill', t('builder.mb.of10', { count: msg.embeds.length })));
      const add = el('button', 'btn btn-sm bmsg-add');
      add.type = 'button';
      add.disabled = msg.embeds.length >= MAX_EMBEDS;
      add.append(el('span', 'bmsg-plus', '+'), document.createTextNode(t('builder.mb.add_embed')));
      add.addEventListener('click', () => {
        msg.embeds.push({ color: DEFAULT_COLOR, title: '', description: '' });
        openEmbeds.add(msg.embeds.length - 1);
        changed();
        renderLeft();
      });
      eh.append(et, add);
      left.append(eh);
      if (!msg.embeds.length) {
        const empty = el('div', 'bmsg-empty');
        const ic = el('span', 'bmsg-empty-icon');
        ic.append(icon('square'));
        const tx = el('div', '');
        tx.append(el('strong', '', t('builder.mb.no_embeds')), el('span', '', t('builder.mb.no_embeds_hint')));
        empty.append(ic, tx);
        left.append(empty);
      }
      msg.embeds.forEach((e, i) => left.append(embedEditor(e, i)));
    }

    function embedEditor(e, i) {
      const det = el('details', 'bmsg-embed');
      det.open = openEmbeds.has(i);
      det.addEventListener('toggle', () => { if (det.open) openEmbeds.add(i); else openEmbeds.delete(i); });
      const sum = el('summary', 'bmsg-embed-head');
      const sw = el('span', 'bmsg-swatch');
      sw.style.background = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#1e1f22';
      const st = el('span', 'bmsg-embed-title');
      st.append(el('strong', '', t('builder.mb.embed_n', { n: i + 1 })), el('span', '', e.title || e.description || ''));
      const tb = el('span', 'bform-item-tools');
      const move = (to) => {
        msg.embeds.splice(to, 0, msg.embeds.splice(i, 1)[0]);
        openEmbeds.clear();
        openEmbeds.add(to);
        changed();
        renderLeft();
      };
      tb.append(
        toolBtn('up', t('builder.form.move_up'), i === 0, () => move(i - 1)),
        toolBtn('down', t('builder.form.move_down'), i === msg.embeds.length - 1, () => move(i + 1)),
        toolBtn('copy', t('builder.mb.duplicate'), msg.embeds.length >= MAX_EMBEDS, () => { msg.embeds.splice(i + 1, 0, structuredClone(e)); changed(); renderLeft(); }),
        toolBtn('trash', t('builder.mb.delete'), false, () => { msg.embeds.splice(i, 1); openEmbeds.clear(); changed(); renderLeft(); }),
      );
      sum.append(sw, st, tb);
      det.append(sum);

      const bodyEl = el('div', 'bmsg-embed-body');
      const set = (path, v) => {
        const keys = path.split('.');
        let o = e;
        for (const k of keys.slice(0, -1)) o = o[k] = o[k] || {};
        const k = keys.at(-1);
        if (v === '' || v === false) delete o[k];
        else o[k] = v;
        if (keys.length > 1 && !Object.keys(e[keys[0]]).length) delete e[keys[0]];
        st.lastChild.textContent = e.title || e.description || '';
        changed();
      };
      const row = (...nodes) => { const r = el('div', 'bform-grid'); r.append(...nodes); return r; };

      // Color
      const colorWrap = el('div', 'bmsg-color');
      const ci = el('input');
      ci.type = 'color';
      const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
      ci.value = isHex(e.color) ? e.color : DEFAULT_COLOR;
      // A hex code or a variable that holds one ({weather.color}).
      const ct = input(e.color || '', 64, (v) => {
        const s = v.trim();
        if (isHex(s)) { ci.value = s; sw.style.background = s; set('color', s); }
        else if (!s) { sw.style.background = '#1e1f22'; set('color', ''); }
        else if (/^\{[A-Za-z0-9_.:-]{1,100}\}$/.test(s)) { sw.style.background = '#1e1f22'; set('color', s); }
      }, { mono: true, placeholder: DEFAULT_COLOR, vars: true });
      ci.addEventListener('input', () => { ct.input.value = ci.value; sw.style.background = ci.value; set('color', ci.value); });
      colorWrap.append(ci, ct.wrap);
      bodyEl.append(labeled(t('builder.mb.color'), colorWrap));

      bodyEl.append(el('div', 'bmsg-sub', t('builder.mb.author')), row(
        labeled(t('builder.mb.author_name'), input(e.author?.name, 256, (v) => set('author.name', v), { vars: true }).wrap),
        labeled(t('builder.mb.author_icon'), input(e.author?.icon_url, 2000, (v) => set('author.icon_url', v), { mono: true, vars: true }).wrap),
      ), labeled(t('builder.mb.author_url'), input(e.author?.url, 2000, (v) => set('author.url', v), { mono: true, vars: true }).wrap));

      bodyEl.append(row(
        labeled(t('builder.mb.title_field'), input(e.title, 256, (v) => set('title', v), { vars: true }).wrap),
        labeled(t('builder.mb.title_url'), input(e.url, 2000, (v) => set('url', v), { mono: true, vars: true }).wrap),
      ));
      bodyEl.append(labeled(t('builder.mb.description'), input(e.description, 4096, (v) => set('description', v), { multiline: true, rows: 4, vars: true }).wrap));

      // Fields
      const fh = el('div', 'bmsg-sub');
      fh.append(document.createTextNode(t('builder.mb.fields')), el('span', 'bmsg-pill', `${(e.fields || []).length}/${MAX_FIELDS}`));
      bodyEl.append(fh);
      const fl = el('div', 'bmsg-fields');
      const renderFields = () => {
        fl.replaceChildren();
        (e.fields || []).forEach((f, fi) => {
          const r = el('div', 'bmsg-field');
          const inl = el('label', 'bmsg-inline');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = Boolean(f.inline);
          cb.addEventListener('change', () => { f.inline = cb.checked; changed(); });
          inl.append(cb, document.createTextNode(t('builder.mb.inline')));
          r.append(
            input(f.name, 256, (v) => { f.name = v; changed(); }, { placeholder: t('builder.mb.field_name'), vars: true }).wrap,
            input(f.value, 1024, (v) => { f.value = v; changed(); }, { placeholder: t('builder.mb.field_value'), multiline: true, rows: 2, vars: true }).wrap,
            inl,
            toolBtn('trash', t('builder.mb.remove_field'), false, () => { e.fields.splice(fi, 1); if (!e.fields.length) delete e.fields; changed(); renderFields(); }),
          );
          fl.append(r);
        });
        const af = el('button', 'btn btn-sm', `+ ${t('builder.mb.add_field')}`);
        af.type = 'button';
        af.disabled = (e.fields || []).length >= MAX_FIELDS;
        af.addEventListener('click', () => { e.fields = e.fields || []; e.fields.push({ name: '', value: '', inline: false }); changed(); renderFields(); });
        fl.append(af);
      };
      renderFields();
      bodyEl.append(fl);

      bodyEl.append(el('div', 'bmsg-sub', t('builder.mb.images')), row(
        labeled(t('builder.mb.image'), input(e.image_url, 2000, (v) => set('image_url', v), { mono: true, vars: true }).wrap),
        labeled(t('builder.mb.thumbnail'), input(e.thumbnail_url, 2000, (v) => set('thumbnail_url', v), { mono: true, vars: true }).wrap),
      ));
      bodyEl.append(el('div', 'bmsg-sub', t('builder.mb.footer')), row(
        labeled(t('builder.mb.footer_text'), input(e.footer?.text, 2048, (v) => set('footer.text', v), { vars: true }).wrap),
        labeled(t('builder.mb.footer_icon'), input(e.footer?.icon_url, 2000, (v) => set('footer.icon_url', v), { mono: true, vars: true }).wrap),
      ));
      const ts = el('label', 'bmsg-inline');
      const tcb = el('input');
      tcb.type = 'checkbox';
      tcb.checked = Boolean(e.timestamp);
      tcb.addEventListener('change', () => set('timestamp', tcb.checked));
      ts.append(tcb, document.createTextNode(t('builder.mb.timestamp')));
      bodyEl.append(ts);
      det.append(bodyEl);
      return det;
    }

    function renderV2() {
      // Accent color of the container
      const card = el('div', 'bmsg-card');
      const colorWrap = el('div', 'bmsg-color');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = Boolean(msg.accent);
      const ci = el('input');
      ci.type = 'color';
      ci.value = msg.accent || DEFAULT_COLOR;
      ci.disabled = !msg.accent;
      on.addEventListener('change', () => {
        if (on.checked) msg.accent = ci.value;
        else delete msg.accent;
        ci.disabled = !on.checked;
        changed();
      });
      ci.addEventListener('input', () => { msg.accent = ci.value; changed(); });
      const lab = el('label', 'bmsg-inline');
      lab.append(on, document.createTextNode(t('builder.mb.accent')));
      colorWrap.append(lab, ci);
      card.append(colorWrap);
      left.append(card);

      const eh = el('div', 'bmsg-section');
      const et = el('div', 'bmsg-section-title');
      et.append(el('strong', '', t('builder.mb.v2_components')), el('span', 'bmsg-pill', `${msg.components.length}/${MAX_V2}`));
      const adds = el('div', 'bmsg-adds');
      for (const [type, key] of [['text', 'builder.mb.add_text'], ['separator', 'builder.mb.add_separator'], ['media', 'builder.mb.add_media']]) {
        const b = el('button', 'btn btn-sm bmsg-add');
        b.type = 'button';
        b.disabled = msg.components.length >= MAX_V2;
        b.append(el('span', 'bmsg-plus', '+'), document.createTextNode(t(key)));
        b.addEventListener('click', () => {
          msg.components.push(type === 'text' ? { type, content: '' } : type === 'separator' ? { type, divider: true, spacing: 'small' } : { type, urls: [] });
          changed();
          renderLeft();
        });
        adds.append(b);
      }
      eh.append(et, adds);
      left.append(eh);
      if (!msg.components.length) {
        const empty = el('div', 'bmsg-empty');
        const ic = el('span', 'bmsg-empty-icon');
        ic.append(icon('square'));
        const tx = el('div', '');
        tx.append(el('strong', '', t('builder.mb.no_components')), el('span', '', t('builder.mb.no_components_hint')));
        empty.append(ic, tx);
        left.append(empty);
      }
      msg.components.forEach((c, i) => {
        const box = el('div', 'bmsg-embed bmsg-comp');
        const hd = el('div', 'bmsg-embed-head');
        const tb = el('span', 'bform-item-tools');
        const move = (to) => { msg.components.splice(to, 0, msg.components.splice(i, 1)[0]); changed(); renderLeft(); };
        tb.append(
          toolBtn('up', t('builder.form.move_up'), i === 0, () => move(i - 1)),
          toolBtn('down', t('builder.form.move_down'), i === msg.components.length - 1, () => move(i + 1)),
          toolBtn('trash', t('builder.mb.remove'), false, () => { msg.components.splice(i, 1); changed(); renderLeft(); }),
        );
        const ht = el('span', 'bmsg-embed-title');
        ht.append(el('strong', '', t(`builder.mb.comp.${c.type}`)));
        hd.append(ht, tb);
        box.append(hd);
        const bd = el('div', 'bmsg-embed-body');
        if (c.type === 'text') {
          bd.append(input(c.content, 4000, (v) => { c.content = v; changed(); }, { multiline: true, rows: 4, vars: true }).wrap);
        } else if (c.type === 'separator') {
          const r = el('div', 'bmsg-color');
          const dl = el('label', 'bmsg-inline');
          const dcb = el('input');
          dcb.type = 'checkbox';
          dcb.checked = c.divider !== false;
          dcb.addEventListener('change', () => { c.divider = dcb.checked; changed(); });
          dl.append(dcb, document.createTextNode(t('builder.mb.divider')));
          const sel = el('select');
          for (const v of ['small', 'large']) {
            const o = el('option', '', t(`builder.mb.spacing_${v}`));
            o.value = v;
            o.selected = (c.spacing || 'small') === v;
            sel.append(o);
          }
          sel.addEventListener('change', () => { c.spacing = sel.value; changed(); });
          r.append(dl, labeled(t('builder.mb.spacing'), sel));
          bd.append(r);
        } else {
          bd.append(labeled(t('builder.mb.media_urls'), input((c.urls || []).join('\n'), 20000, (v) => {
            c.urls = v.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10);
            changed();
          }, { multiline: true, rows: 3, mono: true }).wrap));
        }
        box.append(bd);
        left.append(box);
      });
    }

    // ---- right: preview ----
    function renderPreview() {
      preview.replaceChildren();
      const card = el('div', 'dmsg');
      if (ctx.bot.avatar) {
        const img = el('img', 'dmsg-avatar');
        img.src = ctx.bot.avatar;
        img.alt = '';
        card.append(img);
      } else card.append(el('span', 'dmsg-avatar dmodal-avatar-fallback', (ctx.bot.name || 'B').slice(0, 1).toUpperCase()));
      const main = el('div', 'dmsg-main');
      const meta = el('div', 'dmsg-meta');
      const now = new Date();
      const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.append(el('strong', '', ctx.bot.name || 'Bot'), el('span', 'dmsg-app', t('builder.mb.app')), el('span', 'dmsg-time', t('builder.mb.today', { time })));
      main.append(meta);

      if (!hasBody(msg) && !ctx.components().length) {
        main.append(el('div', 'dmsg-placeholder', t('builder.mb.preview_empty')));
      } else if (msg.mode === 'v2') {
        const box = el('div', 'dmsg-container');
        if (msg.accent) box.style.borderLeftColor = msg.accent;
        else box.classList.add('no-accent');
        for (const c of msg.components) {
          if (c.type === 'text') box.append(markdown(c.content, el));
          else if (c.type === 'separator') box.append(el('div', `dmsg-sep${c.divider !== false ? ' has-line' : ''}${c.spacing === 'large' ? ' is-large' : ''}`));
          else {
            const g = el('div', `dmsg-gallery n${Math.min((c.urls || []).length, 4)}`);
            for (const url of (c.urls || []).slice(0, 10)) g.append(image(url));
            box.append(g);
          }
        }
        box.append(componentRows());
        main.append(box);
      } else {
        if (text(msg.content).trim()) main.append(markdown(msg.content, el));
        for (const e of msg.embeds) main.append(embedPreview(e, time));
        main.append(componentRows());
      }
      card.append(main);
      preview.append(card);
    }

    function image(url) {
      // Variables cannot be loaded; show a placeholder box instead.
      if (!/^https:\/\//.test(url) || /[{}]/.test(url)) {
        const ph = el('div', 'dmsg-img-ph');
        ph.append(icon('image'));
        return ph;
      }
      const img = el('img', 'dmsg-img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      return img;
    }

    // Server emojis show as their picture, like in Discord.
    function emojiEl(v) {
      const m = /^<(a?):(\w{2,32}):(\d{15,21})>$/.exec(String(v).trim());
      if (!m) return el('span', '', v);
      const img = el('img', 'dmsg-emoji');
      img.src = `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'webp'}?size=48`;
      img.alt = `:${m[2]}:`;
      img.referrerPolicy = 'no-referrer';
      return img;
    }

    function embedPreview(e, time) {
      const box = el('div', 'dmsg-embed');
      box.style.borderLeftColor = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#1e1f22';
      const inner = el('div', 'dmsg-embed-inner');
      const col = el('div', 'dmsg-embed-col');
      if (e.author?.name) {
        const a = el('div', 'dmsg-author');
        if (e.author.icon_url) { const im = image(e.author.icon_url); im.classList.add('dmsg-author-icon'); a.append(im); }
        a.append(el('span', '', e.author.name));
        col.append(a);
      }
      if (e.title) {
        const ti = el('div', `dmsg-embed-title${e.url ? ' is-link' : ''}`);
        ti.append(inline(e.title, el));
        col.append(ti);
      }
      if (e.description) col.append(markdown(e.description, el));
      if ((e.fields || []).length) {
        const grid = el('div', 'dmsg-fields');
        for (const f of e.fields) {
          const fd = el('div', `dmsg-field${f.inline ? ' is-inline' : ''}`);
          const fn = el('div', 'dmsg-field-name');
          fn.append(inline(f.name || '​', el));
          fd.append(fn, markdown(f.value || '', el));
          grid.append(fd);
        }
        col.append(grid);
      }
      if (e.image_url) { const im = image(e.image_url); im.classList.add('dmsg-embed-image'); col.append(im); }
      if (e.footer?.text || e.timestamp) {
        const ft = el('div', 'dmsg-footer');
        if (e.footer?.icon_url) { const im = image(e.footer.icon_url); im.classList.add('dmsg-footer-icon'); ft.append(im); }
        ft.append(el('span', '', [e.footer?.text, e.timestamp ? t('builder.mb.today', { time }) : ''].filter(Boolean).join(' • ')));
        col.append(ft);
      }
      inner.append(col);
      if (e.thumbnail_url) { const th = image(e.thumbnail_url); th.classList.add('dmsg-thumb'); inner.append(th); }
      box.append(inner);
      return box;
    }

    function componentRows() {
      const wrap = el('div', 'dmsg-rows');
      const comps = ctx.components();
      const buttons = comps.filter((c) => c.kind === 'button');
      for (let i = 0; i < buttons.length; i += 5) {
        const row = el('div', 'dmsg-row');
        for (const b of buttons.slice(i, i + 5)) {
          const btn = el('span', `dmsg-btn is-${b.style || 'primary'}${b.disabled ? ' is-disabled' : ''}`);
          if (b.emoji) btn.append(emojiEl(b.emoji));
          if (b.label || !b.emoji) btn.append(el('span', '', b.label || '…'));
          if (b.style === 'link') btn.append(icon('external'));
          row.append(btn);
        }
        wrap.append(row);
      }
      for (const m of comps.filter((c) => c.kind === 'menu')) {
        const sel = el('div', 'dmsg-select');
        sel.append(el('span', '', m.placeholder || t('builder.form.select_placeholder')), icon('chevronDown'));
        wrap.append(sel);
      }
      return wrap;
    }

    // ---- header popovers: templates, save, paste ----
    function popover(anchor, cls) {
      closePops();
      const pop = el('div', `bmsg-pop ${cls}`);
      pop.addEventListener('click', (ev) => ev.stopPropagation());
      anchor.parentElement.append(pop);
      const r = anchor.getBoundingClientRect();
      const pr = anchor.parentElement.getBoundingClientRect();
      pop.style.right = `${Math.max(0, pr.right - r.right)}px`;
      return pop;
    }

    async function api(method, url, body) {
      const res = await fetch(url, {
        method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ctx.csrf() },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.key || 'builder.mb.load_failed');
      }
      return res.status === 204 ? null : res.json();
    }

    async function openTemplates(anchor) {
      const pop = popover(anchor, 'bmsg-templates');
      pop.append(el('p', 'bpick-status', t('builder.pick.loading')));
      let items;
      try {
        items = (await api('GET', ctx.templatesUrl)).items || [];
      } catch (err) {
        pop.replaceChildren(el('p', 'bpick-status', t(err.message)));
        return;
      }
      pop.replaceChildren();
      if (!items.length) pop.append(el('p', 'bpick-status', t('builder.mb.no_templates')));
      for (const tpl of items) {
        const row = el('div', 'bmsg-tpl');
        row.append(el('span', 'bmsg-tpl-name', tpl.name));
        const use = el('button', 'btn btn-sm', t('builder.mb.apply'));
        use.type = 'button';
        use.addEventListener('click', () => {
          const m = structuredClone(tpl.message || {});
          for (const k of Object.keys(msg)) delete msg[k];
          Object.assign(msg, { mode: 'normal', content: '', embeds: [], components: [] }, m);
          openEmbeds.clear();
          if (msg.embeds.length) openEmbeds.add(0);
          closePops();
          changed();
          renderAll();
        });
        const del = toolBtn('trash', t('builder.mb.delete_template'), false, async () => {
          try { await api('DELETE', `${ctx.templatesUrl}/${tpl.id}`); row.remove(); } catch (err) { ctx.toast(t(err.message)); }
        });
        row.append(use, del);
        pop.append(row);
      }
    }

    function openSave(anchor) {
      const pop = popover(anchor, 'bmsg-save');
      const name = input('', 60, () => {}, { placeholder: t('builder.mb.template_name') });
      const save = el('button', 'btn btn-sm bform-primary', t('builder.mb.save'));
      save.type = 'button';
      const err = el('p', 'bmsg-error');
      const submit = async () => {
        const n = name.input.value.trim();
        if (!n) { name.input.focus(); return; }
        save.disabled = true;
        try {
          await api('POST', ctx.templatesUrl, { name: n, message: msg });
          closePops();
          ctx.toast(t('builder.mb.saved'));
        } catch (e) {
          err.textContent = t(e.message === 'builder.mb.load_failed' ? 'builder.mb.save_failed' : e.message);
          save.disabled = false;
        }
      };
      name.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
      save.addEventListener('click', submit);
      pop.append(name.wrap, save, err);
      setTimeout(() => name.input.focus(), 0);
    }

    function openPaste(anchor) {
      const pop = popover(anchor, 'bmsg-paste');
      pop.append(el('strong', '', t('builder.mb.paste_title')), el('p', 'bform-hint', t('builder.mb.paste_hint')));
      const area = el('textarea', 'mono');
      area.rows = 8;
      area.placeholder = '{ "content": "Hello", "embeds": [] }';
      const err = el('p', 'bmsg-error');
      const load = el('button', 'btn btn-sm bform-primary', t('builder.mb.paste_apply'));
      load.type = 'button';
      load.addEventListener('click', () => {
        let parsed;
        try {
          parsed = fromDiscord(JSON.parse(area.value));
        } catch {
          err.textContent = t('builder.mb.paste_invalid');
          return;
        }
        for (const k of Object.keys(msg)) delete msg[k];
        Object.assign(msg, { embeds: [], components: [] }, parsed);
        openEmbeds.clear();
        if (msg.embeds.length) openEmbeds.add(0);
        closePops();
        changed();
        renderAll();
      });
      pop.append(area, err, load);
      setTimeout(() => area.focus(), 0);
    }

    function renderAll() {
      renderLeft();
      updateHead();
      renderPreview();
    }
    renderAll();
    setTimeout(() => left.querySelector('textarea')?.focus(), 0);
  }

  window.BotHubMessage = { open, hasBody, problems, summary, toDiscord, fromDiscord };
})();
