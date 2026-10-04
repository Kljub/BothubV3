// Start tour: a guided walk through the dashboard. Everything is dimmed but
// the element of the step (spotlight); a tip explains it. Demo steps show
// the hidden stage #tour-demo (a module card, a command row, its
// permissions) where an animated cursor clicks the toggles, so the tour
// works without a bot. Steps and texts come from #tour-config (layout.html).
// The first visit starts it once (localStorage "bh-tour-done"); the topbar
// button [data-tour-start] starts it again. Positions are set through the
// CSSOM (el.style.left …): the page's CSP allows no inline style attributes.
(function () {
  'use strict';

  const PAD = 6;
  const DONE_KEY = 'bh-tour-done';
  let steps = [];
  let idx = 0;
  let ui = null;
  let demoRun = 0;

  const config = () => {
    try {
      return JSON.parse(document.getElementById('tour-config')?.textContent || '{}');
    } catch {
      return {};
    }
  };
  const label = (k) => config().labels?.[k] ?? k;
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const stage = () => document.getElementById('tour-demo');
  const demoEl = (name) => stage()?.querySelector(`[data-demo="${name}"]`);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function build() {
    if (ui) return;
    const backdrop = el('div', 'tour-backdrop');
    const spot = el('div', 'tour-spot');
    const tip = el('div', 'tour-tip');
    tip.setAttribute('role', 'dialog');
    tip.setAttribute('aria-live', 'polite');
    const arrow = el('div', 'tour-arrow');
    const title = el('h3', 'tour-title');
    const text = el('p', 'tour-text');
    const foot = el('div', 'tour-foot');
    const count = el('span', 'tour-count');
    const btns = el('span', 'tour-btns');
    const skip = el('button', 'btn btn-sm tour-skip');
    const back = el('button', 'btn btn-sm');
    const next = el('button', 'btn btn-sm btn-primary');
    for (const b of [skip, back, next]) b.type = 'button';
    btns.append(skip, back, next);
    foot.append(count, btns);
    tip.append(arrow, title, text, foot);
    const cursor = el('div', 'tour-cursor');
    cursor.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3l12 10-5.2.6 3 6.3-2.8 1.3-3-6.4L6 18.6z"/></svg>';
    document.body.append(backdrop, spot, tip, cursor);
    ui = { backdrop, spot, tip, arrow, title, text, count, skip, back, next, cursor };
    skip.addEventListener('click', () => end());
    back.addEventListener('click', () => show(idx - 1));
    next.addEventListener('click', () => (idx >= steps.length - 1 ? end() : show(idx + 1)));
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (!ui) return;
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') idx >= steps.length - 1 ? end() : show(idx + 1);
    else if (e.key === 'ArrowLeft' && idx > 0) show(idx - 1);
  }

  /** The element of a step, or null (centered step, or the element is not on this page). */
  function targetOf(step) {
    if (!step?.sel) return null;
    const t = document.querySelector(step.sel);
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return r.width || r.height ? t : null;
  }

  // ---------- demo: the cursor clicks on the stage ----------

  async function moveTo(target) {
    if (!target) return;
    const r = target.getBoundingClientRect();
    ui.cursor.style.left = `${r.left + r.width / 2 - 3}px`;
    ui.cursor.style.top = `${r.top + r.height / 2 - 2}px`;
    await sleep(700);
  }

  async function click() {
    ui.cursor.classList.add('tour-cursor-click');
    await sleep(350);
    ui.cursor.classList.remove('tour-cursor-click');
  }

  function setToggle(name, on) {
    const input = demoEl(name);
    if (input) input.checked = on;
    const card = demoEl('card');
    if (name === 'module' && card) card.classList.toggle('module-card-off', !on);
    if (name === 'command') {
      const count = demoEl('count');
      if (count) count.textContent = on ? label('demo_on') : label('demo_off');
    }
  }

  function setPerms(open) {
    const panel = demoEl('perms');
    if (panel) panel.hidden = !open;
    const saved = demoEl('saved');
    if (saved) saved.hidden = true;
    reposition();
  }

  async function runDemo(kind) {
    const run = ++demoRun;
    const alive = () => ui && run === demoRun;
    const box = stage().getBoundingClientRect();
    ui.cursor.classList.add('tour-cursor-jump');
    ui.cursor.style.left = `${box.left + box.width / 2}px`;
    ui.cursor.style.top = `${box.bottom - 20}px`;
    ui.cursor.hidden = false;
    void ui.cursor.offsetWidth;
    ui.cursor.classList.remove('tour-cursor-jump');
    while (alive()) {
      if (kind === 'module') {
        setPerms(false);
        setToggle('command', true);
        await moveTo(demoEl('module')); if (!alive()) return;
        await click(); setToggle('module', false); await sleep(900); if (!alive()) return;
        await click(); setToggle('module', true);
      } else if (kind === 'command') {
        setPerms(false);
        setToggle('module', true);
        await moveTo(demoEl('command')); if (!alive()) return;
        await click(); setToggle('command', false); await sleep(900); if (!alive()) return;
        await click(); setToggle('command', true);
      } else {
        setToggle('module', true);
        setToggle('command', true);
        setPerms(false);
        await moveTo(demoEl('gear')); if (!alive()) return;
        await click(); setPerms(true); await sleep(1100); if (!alive()) return;
        await moveTo(demoEl('save')); if (!alive()) return;
        await click();
        const saved = demoEl('saved');
        if (saved) saved.hidden = false;
        await sleep(1400); if (!alive()) return;
        setPerms(false);
      }
      await sleep(1600);
    }
  }

  function hideDemo() {
    demoRun++;
    const s = stage();
    if (s) s.hidden = true;
    if (ui) ui.cursor.hidden = true;
  }

  // ---------- steps ----------

  function show(i) {
    idx = Math.max(0, Math.min(i, steps.length - 1));
    const step = steps[idx];
    ui.title.textContent = step.title;
    ui.text.textContent = step.text;
    ui.count.textContent = label('step_of').replace('{n}', String(idx + 1)).replace('{m}', String(steps.length));
    ui.skip.textContent = label('skip');
    ui.back.textContent = label('back');
    ui.next.textContent = idx >= steps.length - 1 ? label('finish') : label('next');
    ui.back.hidden = idx === 0;
    ui.skip.hidden = idx >= steps.length - 1;
    if (step.demo && stage()) {
      stage().hidden = false;
      place(stage());
      runDemo(step.demo);
      ui.next.focus();
      return;
    }
    hideDemo();
    const target = targetOf(step);
    // A closed menu (bot switcher, user menu) shows its summary; that is enough.
    target?.scrollIntoView({ block: 'nearest' });
    place(target);
    ui.next.focus();
  }

  function place(target) {
    const { spot, tip, arrow, backdrop } = ui;
    if (!target) {
      spot.hidden = true;
      backdrop.classList.add('tour-backdrop-dark');
      tip.dataset.pos = 'center';
      arrow.hidden = true;
      tip.style.left = `${Math.max(12, (innerWidth - tip.offsetWidth) / 2)}px`;
      tip.style.top = `${Math.max(12, (innerHeight - tip.offsetHeight) / 2)}px`;
      return;
    }
    const r = target.getBoundingClientRect();
    backdrop.classList.remove('tour-backdrop-dark');
    spot.hidden = false;
    spot.style.left = `${r.left - PAD}px`;
    spot.style.top = `${r.top - PAD}px`;
    spot.style.width = `${r.width + PAD * 2}px`;
    spot.style.height = `${r.height + PAD * 2}px`;
    arrow.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 14;
    let pos;
    let left;
    let top;
    if (r.right + gap + tw <= innerWidth - 8) {
      pos = 'right';
      left = r.right + gap;
      top = Math.min(Math.max(8, r.top + r.height / 2 - th / 2), innerHeight - th - 8);
    } else if (r.bottom + gap + th <= innerHeight - 8) {
      pos = 'bottom';
      left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), innerWidth - tw - 8);
      top = r.bottom + gap;
    } else if (r.left - gap - tw >= 8) {
      pos = 'left';
      left = r.left - gap - tw;
      top = Math.min(Math.max(8, r.top + r.height / 2 - th / 2), innerHeight - th - 8);
    } else {
      pos = 'top';
      left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), innerWidth - tw - 8);
      top = Math.max(8, r.top - gap - th);
    }
    tip.dataset.pos = pos;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    if (pos === 'right' || pos === 'left') {
      arrow.style.top = `${Math.min(Math.max(10, r.top + r.height / 2 - top - 7), th - 24)}px`;
      arrow.style.left = '';
    } else {
      arrow.style.left = `${Math.min(Math.max(10, r.left + r.width / 2 - left - 7), tw - 24)}px`;
      arrow.style.top = '';
    }
  }

  function reposition() {
    if (!ui) return;
    const step = steps[idx];
    place(step?.demo && stage() ? stage() : targetOf(step));
  }

  function start() {
    steps = (config().steps || []).filter((s) => (s.demo ? Boolean(stage()) : !s.sel || targetOf(s)));
    if (!steps.length) return;
    build();
    show(0);
  }

  function end() {
    hideDemo();
    if (ui) {
      for (const k of ['backdrop', 'spot', 'tip', 'cursor']) ui[k].remove();
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
      document.removeEventListener('keydown', onKey);
      ui = null;
    }
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      // private mode: the tour may start again next time
    }
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-tour-start]')) {
      e.preventDefault();
      if (ui) end();
      start();
    }
  });

  // First visit: start once, after the page has its layout.
  function autostart() {
    let done = true;
    try {
      done = localStorage.getItem(DONE_KEY) === '1';
    } catch {
      done = true;
    }
    if (!done && document.querySelector('.shell')) setTimeout(start, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autostart);
  else autostart();

  window.BotHubTour = { start, end };
}());
