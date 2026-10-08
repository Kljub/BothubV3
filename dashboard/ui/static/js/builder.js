// BotHub node editor (command builder; later timed and custom events).
// Data comes from JSON islands in the page; everything else happens here.
// Flow edges decide the order. Data passes through variables: a node that
// produces a value names it in config.variable, other nodes reference it by
// that name (e.g. Delete Message -> message = "Var1").
// Conditions: a query node fans out to separate state nodes (Else + states).
(() => {
  'use strict';

  const island = (id) => {
    try {
      return JSON.parse(document.getElementById(id)?.textContent || 'null');
    } catch {
      return null;
    }
  };
  const defsList = island('builder-nodes') || [];
  const defs = Object.fromEntries(defsList.map((d) => [d.type, d]));
  const TEXT = island('builder-texts') || {};
  const meta = island('builder-meta') || {};
  // Open role/channel/permission popover of the permissions block (permissions.js), kept across re-renders.
  const pickerKeep = { state: null };
  const t = (key, params = {}) => String(TEXT[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m));
  // Custom events reuse the editor: no options, no modal forms, event wording.
  const isEvent = meta.kind === 'event';
  const tk = (key) => (isEvent && `${key}_event` in TEXT ? `${key}_event` : key);
  const EVENT_CATS = island('builder-events') || [];
  const EVENT_INFO = {};
  for (const c of EVENT_CATS) for (const e of c.events) EVENT_INFO[e.key] = { cat: c, vars: e.vars || [], intent: e.intent };
  const EVENT_HIDDEN = new Set(['action.send_form', 'condition.subcommand']);
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  const root = document.getElementById('builder');
  const canvas = root.querySelector('[data-canvas]');
  const world = root.querySelector('[data-world]');
  const edgesSvg = root.querySelector('[data-edges]');
  const panelBody = root.querySelector('[data-panel-body]');
  const inspector = root.querySelector('[data-inspector]');
  const simBox = root.querySelector('[data-sim]');
  const statusEl = root.querySelector('[data-status]');
  const zoomEl = root.querySelector('[data-zoom]');

  const SIZE = { normal: { w: 270, h: 70 }, compact: { w: 110, h: 64 }, wide: { w: 480, h: 84 }, button: { w: 200, h: 84 }, option: { w: 220, h: 64 } };
  const TABS = isEvent ? ['action', 'condition'] : ['option', 'action', 'condition'];
  // Built-in placeholders shown under "Available variables" (reference design).
  const PLACEHOLDERS = ['user', 'user.id', 'user.mention', 'user.avatar', 'server', 'server.id', 'channel', 'members', 'local.var', 'global.var'];

  // Option states (select menu branches) are regular boxes, other states small.
  const isOptionState = (node) => isState(node) && parentOf(node)?.type === 'condition.option';
  const isOption = (node) => defs[node?.type]?.category === 'option';
  const size = (node) => {
    const def = defs[node.type];
    if (def?.wide) return SIZE.wide;
    if (node.type === 'component.button') return SIZE.button;
    if (isState(node)) return SIZE.option;
    return def?.compact ? SIZE.compact : SIZE.normal;
  };
  const isCondition = (node) => defs[node?.type]?.category === 'condition' && !defs[node.type].compact;
  const isState = (node) => node && (node.type === 'condition.state' || node.type === 'condition.else');

  // ---------- graph state ----------

  function starterGraph() {
    const trig = isEvent
      ? { id: 'trigger', type: 'trigger.event', typeVersion: 1, config: { event_name: meta.name || '' }, position: { x: 120, y: 120 } }
      : { id: 'trigger', type: 'trigger.slash', typeVersion: 1, config: { command_name: meta.name || '', description: meta.description || '' }, position: { x: 120, y: 120 } };
    return {
      schemaVersion: 1,
      nodes: [
        trig,
        { id: 'error', type: 'utility.error_handler', typeVersion: 1, config: { variable: 'error' }, position: { x: 440, y: 120 } },
      ],
      edges: [],
    };
  }

  let graph = island('builder-graph') || starterGraph();
  if (!graph.nodes.some((n) => n.type === 'utility.error_handler')) {
    const trig = graph.nodes.find((n) => defs[n.type]?.category === 'trigger');
    graph.nodes.push({ id: 'error', type: 'utility.error_handler', typeVersion: 1, config: { variable: 'error' },
      position: { x: (trig?.position?.x ?? 120) + 320, y: trig?.position?.y ?? 120 } });
  }
  graph.nodes.forEach((n) => { n.config = n.config || {}; n.position = n.position || { x: 0, y: 0 }; });
  const OLD_OPS = { '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };
  graph.nodes.forEach((n) => { if (n.type === 'condition.state' && OLD_OPS[n.config.operator]) n.config.operator = OLD_OPS[n.config.operator]; });
  // Options used to be flow blocks; now they plug into the trigger.
  graph.edges = graph.edges.filter((e) => !(graph.nodes.find((n) => n.id === e.from.node)?.type || '').startsWith('option.') || e.from.port === 'option');
  const trigger = () => graph.nodes.find((n) => defs[n.type]?.category === 'trigger');
  if (!isEvent && trigger() && !trigger().config.command_name) trigger().config.command_name = meta.name || '';
  if (isEvent && trigger() && !trigger().config.event_name) trigger().config.event_name = meta.name || '';

  const view = { x: 40, y: 40, zoom: 1 };
  let selected = null; // { kind: 'node'|'edge', id }
  let dirty = false;
  let saving = false;
  let lastField = null; // last focused text field, target for variable chips

  const history = [JSON.stringify(graph)];
  let historyAt = 0;

  // Pick up where you left off: per browser and command, the view, the
  // selected block and unsaved changes are kept, so a reload or a closed tab
  // loses nothing. Written shortly after each change.
  const RESUME_KEY = `bothub.builder.resume.${meta.saveUrl}`;
  const readResume = () => { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch { return null; } };
  let resumeTimer = null;
  let pendingDraft = null; // offered back, not decided yet: kept as it is
  function keepResume() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      const snap = JSON.stringify(graph);
      const data = { view: { ...view }, selected, at: Date.now(), base: savedSnapshot };
      if (snap !== savedSnapshot) data.graph = snap;
      else if (pendingDraft) Object.assign(data, { graph: pendingDraft.graph, at: pendingDraft.at, base: pendingDraft.base });
      try { localStorage.setItem(RESUME_KEY, JSON.stringify(data)); } catch { /* storage blocked */ }
    }, 400);
  }

  function commit() {
    const snap = JSON.stringify(graph);
    if (snap === history[historyAt]) return;
    history.splice(historyAt + 1);
    history.push(snap);
    if (history.length > 100) history.shift();
    historyAt = history.length - 1;
    setDirty(true);
    updateUndo();
    scheduleProblems();
  }

  function restore(at) {
    historyAt = at;
    graph = JSON.parse(history[at]);
    if (selected && !exists(selected)) selected = null;
    // Undoing back to the saved state is not an unsaved change.
    setDirty(history[at] !== savedSnapshot);
    render();
    updateUndo();
  }

  function updateUndo() {
    root.querySelector('[data-action="undo"]').disabled = historyAt === 0;
    root.querySelector('[data-action="redo"]').disabled = historyAt >= history.length - 1;
  }

  const nodeById = (id) => graph.nodes.find((n) => n.id === id);
  const edgeId = (e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`;
  const exists = (sel) => (sel.kind === 'node' ? Boolean(nodeById(sel.id)) : graph.edges.some((e) => edgeId(e) === sel.id));
  // The condition a state node hangs on.
  const parentOf = (node) => nodeById(graph.edges.find((e) => e.to.node === node.id && e.from.port === 'branches')?.from.node);
  const statesOf = (cond) => graph.edges.filter((e) => e.from.node === cond.id && e.from.port === 'branches').map((e) => nodeById(e.to.node)).filter(Boolean);

  function newId(type) {
    const base = type.split('.').pop().replace(/[^a-z0-9]/g, '');
    let i = 1;
    while (nodeById(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  function newVariable() {
    const used = new Set(graph.nodes.map((n) => n.config.variable).filter(Boolean));
    let i = 1;
    while (used.has(`Var${i}`)) i++;
    return `Var${i}`;
  }

  function createNode(type, x, y) {
    const def = defs[type];
    const config = {};
    for (const [key, schema] of Object.entries(def.config?.properties || {})) {
      if (schema.default !== undefined) config[key] = structuredClone(schema.default);
    }
    if (def.config?.properties?.variable) config.variable = newVariable();
    if (isEvent) {
      for (const [key, schema] of Object.entries(def.config?.properties || {})) {
        if (schema['x-widget'] === 'destination' && config[key] === 'reply') config[key] = 'command_channel';
      }
    }
    const node = { id: newId(type), type, typeVersion: def.version, config, position: { x: Math.round(x), y: Math.round(y) } };
    graph.nodes.push(node);
    return node;
  }

  function addNode(type, x, y) {
    const def = defs[type];
    if (!def || def.locked || def.palette === false) return;
    const from = pendingNext && nodeById(pendingNext.node);
    let node;
    if (from) {
      const p = portPoint(from, 'out', pendingNext.port);
      const w = defs[type].wide ? SIZE.wide.w : SIZE.normal.w;
      node = createNode(type, p.x - w / 2, p.y + 70);
      graph.edges = graph.edges.filter((e) => !(e.from.node === from.id && e.from.port === pendingNext.port));
      graph.edges.push({ from: { node: from.id, port: pendingNext.port }, to: { node: node.id, port: 'in' } });
      pendingNext = null;
    } else if (defs[type].category === 'option' && trigger()) {
      const trig = trigger();
      const others = graph.edges.filter((e) => e.to.node === trig.id && e.to.port === 'options').map((e) => nodeById(e.from.node)).filter(Boolean);
      const nx = others.length ? Math.max(...others.map((o) => o.position.x + size(o).w)) + 20 : trig.position.x;
      node = createNode(type, nx, trig.position.y - SIZE.normal.h - 60);
      if (!node.config.name) node.config.name = uniqueOptionName(type.split('.').pop());
      graph.edges.push({ from: { node: node.id, port: 'option' }, to: { node: trig.id, port: 'options' } });
    } else {
      node = createNode(type, x, y);
    }
    // A condition always comes with its Else state.
    if (isCondition(node)) addState(node, 'condition.else');
    selected = { kind: 'node', id: node.id };
    commit();
    render();
    if (from) { renderPanel(); focusNode(node); }
  }

  function uniqueOptionName(base) {
    const used = new Set(graph.nodes.filter(isOption).map((n) => n.config.name));
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    return name;
  }

  // addState puts a new state under the condition, right of its siblings.
  function addState(cond, type = 'condition.state') {
    const siblings = statesOf(cond);
    const state = createNode(type, 0, cond.position.y + size(cond).h + 70);
    graph.edges.push({ from: { node: cond.id, port: 'branches' }, to: { node: state.id, port: 'in' } });
    const w = size(state).w;
    state.position.x = siblings.length ? Math.max(...siblings.map((s) => s.position.x + size(s).w)) + 16 : cond.position.x + (size(cond).w - w) / 2;
    if (cond.type === 'condition.option' && type === 'condition.state') state.config.value = t('builder.option_n', { n: siblings.filter((x) => x.type === 'condition.state').length + 1 });
    layoutOptions(cond);
    return state;
  }

  // Menu branches: options left to right, "Otherwise" last, centred under the question.
  function layoutOptions(cond) {
    const states = statesOf(cond).sort((a, b) => (a.type === 'condition.else') - (b.type === 'condition.else') || a.position.x - b.position.x);
    const total = states.reduce((n, st) => n + size(st).w, 0) + 16 * (states.length - 1);
    let x = cond.position.x + size(cond).w / 2 - total / 2;
    for (const st of states) {
      st.position = { x: Math.round(x), y: cond.position.y + size(cond).h + 90 };
      x += size(st).w + 16;
    }
  }

  // ---------- buttons and menus (blocks under a message block) ----------

  const componentsOf = (msg) => graph.edges.filter((e) => e.from.node === msg.id && e.from.port === 'components').map((e) => nodeById(e.to.node)).filter(Boolean);
  const optionConditionOf = (menu) => nodeById(graph.edges.find((e) => e.from.node === menu.id && e.from.port === 'next' && nodeById(e.to.node)?.type === 'condition.option')?.to.node);
  const menuOf = (cond) => nodeById(graph.edges.find((e) => e.to.node === cond.id && nodeById(e.from.node)?.type === 'component.select_menu')?.from.node);

  // attachedTo: blocks that belong to a node and move or go with it
  // (condition states, a message's buttons and menus, a menu's question).
  function attachedTo(node, out = new Set()) {
    const add = (n) => { if (n && !out.has(n)) { out.add(n); attachedTo(n, out); } };
    if (isCondition(node)) statesOf(node).forEach(add);
    if (defs[node.type]?.outputs?.some((p) => p.name === 'components')) componentsOf(node).forEach(add);
    if (node.type === 'component.select_menu') add(optionConditionOf(node));
    return out;
  }

  function nextComponentX(msg) {
    const comps = componentsOf(msg);
    return comps.length ? Math.max(...comps.map((c) => c.position.x + Math.max(size(c).w, ...[...attachedTo(c)].map((a) => a.position.x - c.position.x + size(a).w)))) + 40 : msg.position.x - 60;
  }

  function addButton(msg) {
    const n = componentsOf(msg).filter((c) => c.type === 'component.button').length + 1;
    const b = createNode('component.button', nextComponentX(msg), msg.position.y + size(msg).h + 110);
    b.config.label = t('builder.button_n', { n });
    graph.edges.push({ from: { node: msg.id, port: 'components' }, to: { node: b.id, port: 'in' } });
    selected = { kind: 'node', id: b.id };
    commit();
    render();
  }

  function addMenu(msg) {
    const x = nextComponentX(msg);
    const menu = createNode('component.select_menu', x, msg.position.y + size(msg).h + 110);
    graph.edges.push({ from: { node: msg.id, port: 'components' }, to: { node: menu.id, port: 'in' } });
    const cond = createNode('condition.option', x, menu.position.y + SIZE.normal.h + 70);
    graph.edges.push({ from: { node: menu.id, port: 'next' }, to: { node: cond.id, port: 'in' } });
    addState(cond, 'condition.else');
    addState(cond);
    selected = { kind: 'node', id: menu.id };
    commit();
    render();
  }

  function addOption(menu) {
    let cond = optionConditionOf(menu);
    if (!cond) {
      cond = createNode('condition.option', menu.position.x, menu.position.y + SIZE.normal.h + 70);
      graph.edges = graph.edges.filter((e) => !(e.from.node === menu.id && e.from.port === 'next'));
      graph.edges.push({ from: { node: menu.id, port: 'next' }, to: { node: cond.id, port: 'in' } });
      addState(cond, 'condition.else');
    }
    const st = addState(cond);
    selected = { kind: 'node', id: st.id };
    commit();
    render();
  }

  function removeSelected() {
    if (!selected) return;
    if (selected.kind === 'node') {
      const node = nodeById(selected.id);
      if (!node || defs[node.type]?.locked) return;
      // Removing a condition removes its states; the Else state stays with its condition.
      if (node.type === 'condition.else' && parentOf(node)) return;
      if (node.type === 'condition.option' && menuOf(node)) return; // belongs to its menu
      const gone = new Set([node.id, ...[...attachedTo(node)].map((n) => n.id)]);
      graph.nodes = graph.nodes.filter((n) => !gone.has(n.id));
      graph.edges = graph.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node));
    } else {
      graph.edges = graph.edges.filter((e) => edgeId(e) !== selected.id);
    }
    selected = null;
    commit();
    render();
  }

  // ---------- geometry ----------

  // outputsOf: the definition's outputs; with success/error paths the flow
  // output "next" becomes "success" and "error".
  function outputsOf(node) {
    const outs = defs[node.type]?.outputs || [];
    if (!node.paths) return outs;
    return outs.flatMap((p) => (p.name === 'next'
      ? [{ name: 'success', type: 'flow', labelKey: 'builder.port.success' }, { name: 'error', type: 'flow', labelKey: 'builder.port.error' }]
      : [p]));
  }
  const canHavePaths = (node) => !defs[node.type]?.locked && !defs[node.type]?.compact && defs[node.type]?.category !== 'component'
    && node.type !== 'condition.option' && (defs[node.type]?.outputs || []).some((p) => p.name === 'next');
  const nodeTitle = (node) => {
    const def = defs[node.type] || {};
    return def.compact ? stateLabel(node).join(' ') : (node.label || t(def.labelKey || node.type));
  };

  function portPoint(node, side, portName) {
    const s = size(node);
    const { x, y } = node.position;
    if (side === 'in') return { x: x + s.w / 2, y };
    const outs = outputsOf(node);
    const i = Math.max(0, outs.findIndex((p) => p.name === portName));
    return { x: x + (s.w * (i + 1)) / (outs.length + 1), y: y + s.h };
  }

  const toScreen = (p) => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y });
  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
  }

  function curve(a, b) {
    const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
    return `M${a.x} ${a.y} C${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }

  // Condition -> state: right-angled bracket (reference design).
  function elbow(a, b) {
    const midY = a.y + Math.max(16, (b.y - a.y) / 2);
    return `M${a.x} ${a.y} V${midY} H${b.x} V${b.y}`;
  }

  function branchLabel(cond, state) {
    const kind = defs[cond.type]?.conditionKind || 'match';
    const isElse = state.type === 'condition.else';
    if (kind === 'option') return isElse ? t('builder.state.anything_else') : state.config.value || '–';
    if (kind === 'compare' && statesOf(cond).filter((x) => x.type === 'condition.state').length === 1) return t(isElse ? 'builder.edge.false' : 'builder.edge.true');
    if (isElse) return t('builder.edge.else');
    if (kind === 'chance') return `${state.config.percent ?? 0}%`;
    return state.config.value || t('builder.state.empty');
  }

  // ---------- rendering ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    computeReach();
    world.replaceChildren();
    for (const node of graph.nodes) world.append(renderNode(node));
    applyView();
    renderInspector();
    decorateRun();
    if (activePanel === 'variables') renderPanel();
  }

  // Label of a state node: depends on its condition's kind.
  function stateLabel(node) {
    const kind = defs[parentOf(node)?.type]?.conditionKind || 'match';
    if (kind === 'option') return node.type === 'condition.else' ? [t('builder.state.otherwise'), t('builder.state.anything_else')] : [t('builder.state.option'), node.config.value || '–'];
    if (node.type === 'condition.else') return [t('builder.node.condition_else.label'), t('builder.node.condition_else.label')];
    const c = node.config;
    if (kind === 'chance') return [t('builder.state.chance'), `${c.percent ?? 0}%`];
    if (kind === 'compare') {
      const subject = parentOf(node)?.config.subject || '?';
      return [`${subject} ${t(`builder.op.${c.operator || 'eq'}`)}`, c.value || t('builder.state.empty')];
    }
    return [t('builder.state.match'), c.value || '–'];
  }

  function nodeSubtitle(node, def) {
    if (def.category === 'option') return node.config.name ? `{option_${node.config.name}}` : t('builder.cat.option');
    if (node.type === 'trigger.event') return EVENT_INFO[node.config.event] ? t(`builder.event.${node.config.event}`) : t('builder.event.pick');
    if (node.type === 'action.send_message') return t(tk(`builder.msg.target_short.${node.config.target || 'reply'}`));
    // A Note block shows the start of its text.
    if (node.type === 'action.note' && String(node.config.note || '').trim()) {
      const first = String(node.config.note).trim().split('\n')[0];
      return first.length > 48 ? `${first.slice(0, 47)}…` : first;
    }
    if (def.conditionKind === 'compare' && node.config.subject) return t('builder.checks', { value: node.config.subject });
    if (def.category === 'condition' || def.category === 'trigger' || def.category === 'utility') {
      return def.category === 'condition' ? t(def.descriptionKey || '') : t('builder.cat.' + def.category);
    }
    return node.config.variable ? `${t('builder.cat.' + def.category)} · ${node.config.variable}` : t('builder.cat.' + def.category);
  }

  // Reachable blocks (from the trigger and the error handler); others never run.
  let reachable = new Set();
  function computeReach() {
    reachable = new Set();
    const stack = graph.nodes.filter((n) => defs[n.type]?.locked).map((n) => n.id);
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      graph.edges.filter((e) => e.from.node === id).forEach((e) => stack.push(e.to.node));
    }
    for (const e of graph.edges) if (e.to.port === 'options' && reachable.has(e.to.node)) reachable.add(e.from.node);
  }

  function pill(label, title, cls, fn) {
    const b = el('button', `bnode-pill ${cls}`);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(el('span', 'bnode-pill-plus', '+'), document.createTextNode(label));
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    return b;
  }

  // Helper texts and Note blocks: colour and icon per style.
  const NOTE_STYLES = { note: '📝', info: 'ℹ️', tip: '💡', warning: '⚠️', danger: '⛔', success: '✅' };
  const noteStyle = (v) => (NOTE_STYLES[v] ? v : 'note');
  const HEX = /^#[0-9a-f]{6}$/i;
  // Own colour and icon of helper text / Note block (over the preset style).
  function noteLook(elem, color, iconText, style) {
    if (HEX.test(color || '')) elem.style.setProperty('--note', color);
    return iconText || NOTE_STYLES[noteStyle(style)];
  }

  function renderNode(node) {
    const def = defs[node.type] || { category: 'action', labelKey: node.type, outputs: [], inputs: [] };
    const optionState = isState(node);
    const cls = [`bnode`, `bnode-${def.category}`];
    if (def.color) cls.push(`bnode-color-${def.color}`);
    if (def.wide) cls.push('bnode-wide');
    if (node.type === 'component.button') cls.push('bnode-button');
    if (node.type === 'action.note') cls.push('bnode-notecard', `bnote-${noteStyle(node.config.style)}`);
    if (optionState) cls.push('bnode-optstate', node.type === 'condition.else' ? 'bnode-else' : 'bnode-state');
    else if (def.compact) cls.push('bnode-compact', node.type === 'condition.else' ? 'bnode-else' : 'bnode-state');
    const box = el('div', cls.join(' '));
    box.dataset.node = node.id;
    if (node.type === 'action.note') noteLook(box, node.config.color, '', node.config.style);
    if (selected?.kind === 'node' && selected.id === node.id) box.classList.add('is-selected');
    box.style.left = `${node.position.x}px`;
    box.style.top = `${node.position.y}px`;

    if (node.type === 'component.button') {
      // Discord-style button preview
      const c = node.config;
      const prev = el('span', `bnode-btnpreview is-${c.style || 'primary'}`);
      if (c.emoji) {
        const m = /^<(a?):(\w{2,32}):(\d{15,21})>$/.exec(String(c.emoji).trim());
        if (m) {
          const img = el('img', 'bnode-emoji');
          img.src = `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'webp'}?size=32`;
          img.alt = `:${m[2]}:`;
          img.referrerPolicy = 'no-referrer';
          prev.append(img);
        } else prev.append(el('span', '', c.emoji));
      }
      if (node.label || c.label || !c.emoji) prev.append(el('span', '', node.label || c.label || t('builder.node.component_button.label')));
      const cap = el('span', 'bnode-btncap');
      cap.append(icon('pointer'), document.createTextNode(t('builder.node.component_button.label')));
      box.append(prev, cap);
    } else {
      box.append(el('span', 'bnode-icon', optionState ? (node.type === 'condition.else' ? '?' : isOptionState(node) ? '☰' : '?') : (node.type === 'action.note' ? node.config.icon || NOTE_STYLES[noteStyle(node.config.style)] : def.icon || '•')));
      const text = el('span', 'bnode-text');
      if (def.compact) {
        const [small, big] = stateLabel(node);
        text.append(el('span', '', small), el('strong', '', big));
      } else {
        text.append(el('strong', '', node.label || t(def.labelKey)));
        if (def.wide) text.append(el('span', '', t(def.descriptionKey || '')), el('small', '', nodeSubtitle(node, def)));
        else text.append(el('span', '', nodeSubtitle(node, def)));
      }
      box.append(text);
    }
    if (node.type === 'action.send_message') {
      const edit = el('button', 'bnode-edit');
      edit.type = 'button';
      edit.append(icon('edit'), document.createTextNode(t('builder.msg.edit')));
      edit.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      edit.addEventListener('click', (ev) => { ev.stopPropagation(); selected = { kind: 'node', id: node.id }; render(); openMessageBuilder(node); });
      box.append(edit);
    }
    if (def.locked) {
      const lock = el('span', 'bnode-lock', '🔒');
      lock.title = t('builder.locked');
      box.append(lock);
    }
    if (isCondition(node) && node.type !== 'condition.option') {
      box.append(pill(t('builder.add_branch'), t('builder.add_branch_title'), 'is-left', () => {
        const state = addState(node);
        selected = { kind: 'node', id: state.id };
        commit();
        render();
      }));
    }
    // Buttons and menus of a message; options of a menu.
    if ((def.outputs || []).some((p) => p.name === 'components')) {
      box.append(pill(t('builder.add_button'), t('builder.add_button_title'), 'is-left', () => addButton(node)),
        pill(t('builder.add_menu'), t('builder.add_menu_title'), 'is-right', () => addMenu(node)));
    }
    if (node.type === 'component.select_menu') box.append(pill(t('builder.add_option'), t('builder.add_option_title'), 'is-left', () => addOption(node)));

    // Badges: never runs / something missing
    // Only on the first block of a loose chain; its blocks below are loose too.
    if (!def.locked && !reachable.has(node.id) && !graph.edges.some((e) => e.to.node === node.id)) box.append(el('span', 'bnode-badge-warn', t('builder.not_connected')));
    if (!def.compact && !def.locked && nodeProblems(node).length) {
      const bad = el('span', 'bnode-badge-err', '!');
      bad.title = t('builder.has_problems');
      box.append(bad);
    }

    if ((def.inputs || []).length) {
      const port = el('span', 'bport bport-in');
      port.dataset.port = 'in';
      box.append(port);
    }
    if (node.note) {
      const style = noteStyle(node.noteStyle);
      const note = el('div', `bnode-note bnote-${style}${node.noteMin ? ' bnote-min' : ''}`);
      const ic = el('button', 'bnote-icon', noteLook(note, node.noteColor, node.noteIcon, style));
      ic.type = 'button';
      ic.title = node.noteMin ? node.note : t('builder.opt.note_minimise');
      // The icon folds the text away (and back); the text stays as tooltip.
      ic.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      ic.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (node.noteMin) delete node.noteMin;
        else node.noteMin = true;
        refreshNode(node);
        commit();
      });
      note.append(ic);
      if (!node.noteMin) note.append(el('span', '', node.note));
      box.append(note);
    }

    outputsOf(node).forEach((p, i, all) => {
      const left = `${(100 * (i + 1)) / (all.length + 1)}%`;
      const port = el('span', `bport bport-out bport-${p.name}`);
      port.dataset.port = p.name;
      port.title = t(p.labelKey);
      port.style.left = left;
      box.append(port);
      // Quick add: "+" under a free flow output.
      const free = !graph.edges.some((e) => e.from.node === node.id && e.from.port === p.name);
      if (free && p.type === 'flow' && !['branches', 'components'].includes(p.name) && !(node.type === 'component.select_menu' && p.name === 'next')) {
        const plus = el('button', 'bnode-next', '+');
        plus.type = 'button';
        plus.title = t('builder.add_next');
        plus.setAttribute('aria-label', t('builder.add_next'));
        plus.style.left = left;
        plus.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        plus.addEventListener('click', (ev) => { ev.stopPropagation(); startAddNext(node, p.name); });
        box.append(plus);
      }
    });
    return box;
  }

  // Quick add: the next palette pick is placed under the port and wired to it.
  let pendingNext = null;
  function startAddNext(node, port) {
    pendingNext = { node: node.id, port };
    activePanel = 'nodes';
    if (activeTab === 'option') activeTab = 'action';
    root.querySelectorAll('[data-panel]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.panel === 'nodes')));
    renderPanel();
    panelBody.querySelector('.bpanel-search')?.focus();
  }

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    canvas.style.backgroundSize = `${20 * view.zoom}px ${20 * view.zoom}px`;
    zoomEl.textContent = `${Math.round(view.zoom * 100)}%`;
    renderEdges();
    keepResume();
  }

  function renderEdges(temp) {
    const r = canvas.getBoundingClientRect();
    edgesSvg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    edgesSvg.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    const dels = [];
    for (const e of graph.edges) {
      const from = nodeById(e.from.node);
      const to = nodeById(e.to.node);
      if (!from || !to) continue;
      const a = toScreen(portPoint(from, 'out', e.from.port));
      const b = toScreen(portPoint(to, 'in'));
      const attached = e.from.port === 'branches' || e.from.port === 'components';
      const d = attached ? elbow(a, b) : curve(a, b);
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      const sel = selected?.kind === 'edge' && selected.id === edgeId(e);
      path.setAttribute('class', `bedge${attached ? ' bedge-branch' : ''}${e.from.port === 'components' ? ' bedge-components' : ''}${e.to.port === 'options' ? ' bedge-option' : ''}${sel ? ' is-selected' : ''}`);
      edgesSvg.append(path);
      if (e.from.port === 'branches') {
        // Label on the branch: TRUE / FALSE, OPTION 1 / ANYTHING ELSE, 10% / ELSE
        const txt = branchLabel(from, to).toUpperCase().slice(0, 24);
        const w = txt.length * 6.4 * view.zoom + 16;
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', `bedge-label${to.type === 'condition.else' ? ' is-else' : ''}`);
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', String(b.x - w / 2));
        rect.setAttribute('y', String(b.y - 30 * view.zoom));
        rect.setAttribute('width', String(w));
        rect.setAttribute('height', String(16 * view.zoom));
        rect.setAttribute('rx', String(8 * view.zoom));
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', String(b.x));
        label.setAttribute('y', String(b.y - 19 * view.zoom));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('font-size', String(9.5 * view.zoom));
        label.textContent = txt;
        g.append(rect, label);
        edgesSvg.append(g);
      }
      if (!attached) { // states and components stay attached to their block
        const hit = document.createElementNS(ns, 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('class', 'bedge-hit');
        hit.dataset.edge = edgeId(e);
        edgesSvg.append(hit);
      }
      if (!attached) {
        // Remove button (drawn last, above the hit area) in the middle of the wire.
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'bedge-del');
        g.dataset.edgeDel = edgeId(e);
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', String(mid.x));
        c.setAttribute('cy', String(mid.y));
        c.setAttribute('r', String(Math.max(5, 7 * view.zoom)));
        const x1 = document.createElementNS(ns, 'path');
        const r = Math.max(2, 2.6 * view.zoom);
        x1.setAttribute('d', `M${mid.x - r} ${mid.y - r} L${mid.x + r} ${mid.y + r} M${mid.x + r} ${mid.y - r} L${mid.x - r} ${mid.y + r}`);
        const title = document.createElementNS(ns, 'title');
        title.textContent = t('builder.edge.remove');
        g.append(title, c, x1);
        dels.push(g);
      }
    }
    edgesSvg.append(...dels); // above every line
    if (temp) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', curve(temp.a, temp.b));
      path.setAttribute('class', 'bedge bedge-temp');
      edgesSvg.append(path);
    }
  }

  // ---------- inspector (properties, right side) ----------

  let inspectorNode = null;
  let refreshMissing = () => {};

  // Problems of one node, shown in the "things missing" banner.
  function nodeProblems(node) {
    const def = defs[node.type] || {};
    const out = [];
    const props = def.config?.properties || {};
    for (const key of def.config?.required || []) {
      const v = node.config[key];
      if (v === undefined || v === '' || (props[key]?.pattern && !new RegExp(props[key].pattern).test(v))) out.push({ key, text: t(props[key]?.['x-widget'] === 'checks' ? 'builder.check.pick_subject' : props[key]?.['x-labelKey'] || key) });
    }
    for (const [key, schema] of Object.entries(props)) {
      if (!isShown(node, schema)) continue;
      if (schema['x-hintKey'] === 'builder.cfg.ref_hint' && !node.config[key]) out.push({ key, text: t(schema['x-ref'] === 'message' ? 'builder.ref.missing' : schema['x-labelKey']) });
      if (schema['x-widget'] === 'form' && window.BotHubForm?.problems(node.config[key], t).length) out.push({ key, text: t(schema['x-labelKey']) });
      if (schema['x-widget'] === 'message' && !messageFilled(node)) out.push({ key, text: t('builder.msg.message_content') });
    }
    if (node.type === 'component.button' && node.config.style === 'link' && !node.config.url) out.push({ key: 'url', text: t('builder.cfg.button_url') });
    return out;
  }

  // Every variable the graph offers, for chips and the </> menus.
  function graphVariables(except) {
    const names = isEvent
      ? [...(EVENT_INFO[trigger()?.config.event]?.vars || []), '{local.var}', '{global.var}']
      : PLACEHOLDERS.map((p) => `{${p}}`);
    for (const n of graph.nodes) {
      if (n === except) continue;
      if (n.config.variable) names.push(n.config.variable);
      if (isOption(n) && n.config.name) names.push(`{option_${n.config.name}}`);
      if (n.type === 'action.send_form' && n.config.form_name) {
        for (const f of n.config.form?.fields || []) names.push(...window.BotHubForm.variablesOf(n.config.form_name, f));
      }
    }
    return names;
  }

  // isShown: the field's x-showIf / x-kinds conditions hold.
  function isShown(node, schema) {
    const show = schema['x-showIf'];
    if (show && !Object.entries(show).every(([k, vals]) => vals.includes(node.config[k] ?? defs[node.type]?.config?.properties?.[k]?.default))) return false;
    if (schema['x-kinds']) {
      const kind = isState(node) ? defs[parentOf(node)?.type]?.conditionKind || 'match' : null;
      if (!schema['x-kinds'].includes(kind)) return false;
    }
    return true;
  }

  let toastTimer = null;
  function copyText(text, message) {
    navigator.clipboard?.writeText(text).catch(() => {});
    toast(message || t('builder.copied', { name: text }));
  }
  function toast(message) {
    let toast = root.querySelector('.btoast');
    if (!toast) {
      toast = el('div', 'btoast');
      toast.setAttribute('role', 'status');
      root.append(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-shown'), 1400);
  }

  function refreshNode(node) {
    world.querySelector(`[data-node="${node.id}"]`)?.replaceWith(renderNode(node));
    renderEdges();
  }

  function duplicateNode(node) {
    const copy = structuredClone(node);
    copy.id = newId(node.type);
    copy.position = { x: node.position.x + 40, y: node.position.y + 40 };
    if (copy.config.variable) copy.config.variable = newVariable();
    if (copy.config.form_name) copy.config.form_name = `${copy.config.form_name}-2`.slice(0, 32);
    graph.nodes.push(copy);
    selected = { kind: 'node', id: copy.id };
    commit();
    render();
  }

  function renderInspector() {
    const node = selected?.kind === 'node' ? nodeById(selected.id) : null;
    inspector.hidden = !node;
    if (inspectorNode !== node?.id) pickerKeep.state = null;
    inspectorNode = node?.id;
    if (!node) return;
    const def = defs[node.type] || {};
    const scroll = inspector.scrollTop;
    inspector.replaceChildren();

    const top = el('div', 'binspector-top');
    top.append(el('strong', '', t('builder.block_settings')));
    const close = el('button', 'binspector-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('builder.close'));
    close.addEventListener('click', () => { selected = null; render(); });
    top.append(close);
    inspector.append(top);

    const body = el('div', 'binspector-body');
    const hero = el('div', `bhero bnode-${def.category || 'action'}${def.color ? ` bnode-color-${def.color}` : ''}`);
    hero.append(el('span', 'bnode-icon', def.icon || '•'));
    const heroText = el('div', 'bhero-text');
    heroText.append(el('strong', '', def.compact ? stateLabel(node).join(' ') : t(def.labelKey)), el('span', '', t(def.descriptionKey || '')));
    hero.append(heroText);
    body.append(hero);

    const bannerSlot = el('div', 'bmissing-slot');
    refreshMissing = () => {
      bannerSlot.replaceChildren();
      const missing = nodeProblems(node);
      if (!missing.length) return;
      const banner = el('div', 'bmissing');
      banner.append(icon('alert'), el('strong', '', missing.length === 1 ? t('builder.missing_one') : t('builder.missing_many', { count: missing.length })));
      for (const m of missing) {
        const b = el('button', 'bmissing-chip');
        b.type = 'button';
        b.append(document.createTextNode(m.text), el('span', '', ' ↓'));
        b.addEventListener('click', () => {
          const target = inspector.querySelector(`[data-field="${m.key}"]`);
          target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target?.querySelector('input, textarea, select, button')?.focus({ preventScroll: true });
        });
        banner.append(b);
      }
      bannerSlot.append(banner);
    };
    refreshMissing();
    body.append(bannerSlot);
    if (def.infoKey) {
      const info = el('div', 'binfo');
      info.append(icon('info'), el('span', '', t(def.infoKey)));
      body.append(info);
    }

    const form = el('div', 'form');
    const advanced = el('div', 'form');
    const required = new Set(def.config?.required || []);
    const kind = isState(node) ? defs[parentOf(node)?.type]?.conditionKind || 'match' : null;
    const widgets = [];
    for (const [key, schema] of Object.entries(def.config?.properties || {})) {
      if (schema['x-group'] || !isShown(node, schema)) continue;
      if (schema['x-widget'] === 'eventType') { form.append(eventTypeWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'timedEvent') { form.append(timedEventWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'webhook') { form.append(webhookWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'card') { form.append(cardWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'message') { form.append(messageWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'destination') { form.append(destinationWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'undo') { form.append(undoWidget(node, key, schema)); continue; }
      if (schema['x-widget'] === 'checks') { form.append(checksWidget(node, key, schema)); continue; }
      if (schema['x-ref'] === 'message' && !schema['x-advanced']) { form.append(messageRefField(node, key, schema)); continue; }
      if (TARGET_MODES[schema['x-ref']] && !schema['x-advanced']) { form.append(targetField(node, key, schema, required.has(key) || schema['x-hintKey'] === 'builder.cfg.ref_hint')); continue; }
      if (schema['x-widget'] === 'permissions') {
        widgets.push(permissionsWidget(node, key, schema));
        continue;
      }
      if (schema['x-widget'] === 'form') {
        form.append(formWidget(node, key, schema));
        continue;
      }
      (schema['x-advanced'] ? advanced : form).append(field(node, key, schema, required.has(key)));
    }
    body.append(form, ...widgets);
    const will = willDo(node);
    if (will) body.append(will);
    if (def.results?.length) body.append(resultsBox(node, def));
    if (advanced.childElementCount) {
      const det = el('details', 'badvanced');
      const sum = el('summary', '');
      sum.append(el('span', '', t('builder.advanced')), el('span', 'badvanced-opt', t('builder.optional')));
      det.append(sum, advanced);
      body.append(det);
    }

    if (isCondition(node)) {
      const add = el('button', 'btn btn-sm', t('builder.add_state'));
      add.type = 'button';
      add.addEventListener('click', () => { const s = addState(node); selected = { kind: 'node', id: s.id }; commit(); render(); });
      body.append(add);
    }

    if (!def.locked && !def.compact && def.category !== 'component') body.append(blockOptions(node, def));

    const removable = !def.locked && !(node.type === 'condition.else' && parentOf(node));
    if (removable) {
      const actions = el('div', 'bblock-actions');
      if (!def.compact) {
        const dup = el('button', 'btn bblock-dup');
        dup.type = 'button';
        dup.append(icon('copy'), document.createTextNode(t('builder.duplicate')));
        dup.addEventListener('click', () => duplicateNode(node));
        actions.append(dup);
      }
      const del = el('button', 'btn bblock-del');
      del.type = 'button';
      del.append(icon('trash'), document.createTextNode(t('builder.delete_block')));
      del.addEventListener('click', removeSelected);
      actions.append(del);
      body.append(actions);
    }

    // Available variables: click inserts into the last field, or copies.
    const vars = el('div', 'bvars');
    const varsHead = el('div', 'bvp-field');
    varsHead.append(el('div', 'bvars-title', t('builder.variables_title')));
    if (window.BotHubVarPicker) {
      const all = el('button', 'btn btn-sm');
      all.type = 'button';
      all.append(icon('search'), document.createTextNode(t('vars.browse')));
      all.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the field
      all.addEventListener('click', () => pickVariable((v) => insertVariable(v), 'insert', node));
      varsHead.append(all);
    }
    vars.append(varsHead);
    const chips = el('div', 'bvars-chips');
    for (const name of graphVariables(node)) {
      const chip = el('button', 'bvar-chip mono');
      chip.type = 'button';
      chip.title = t('builder.variable_insert', { name });
      chip.append(el('span', '', name), icon('clipboard', 'bicon bvar-clip'));
      chip.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the field
      chip.addEventListener('click', (ev) => {
        if (ev.target.closest('.bvar-clip')) copyText(name);
        else insertVariable(name);
      });
      chips.append(chip);
    }
    vars.append(chips);
    body.append(vars);
    const note = lastRunNote(node);
    if (note) body.append(note);
    inspector.append(body);
    inspector.scrollTop = scroll;
  }

  // Block options: label on the canvas, success/error paths, helper text.
  function blockOptions(node, def) {
    const wrap = el('section', 'bopts');
    wrap.append(el('h3', '', t('builder.block_options')));

    const card = (iconName, title, hint) => {
      const c = el('div', 'bopt');
      const h = el('div', 'bopt-head');
      h.append(icon(iconName, 'bicon bopt-icon'));
      const tx = el('div', 'bopt-text');
      tx.append(el('strong', '', title), el('span', '', hint));
      h.append(tx);
      c.append(h);
      return { c, h };
    };

    const label = card('tag', t('builder.opt.label'), t('builder.opt.label_hint'));
    const li = el('input', 'bopt-input');
    li.type = 'text';
    li.maxLength = 60;
    li.value = node.label || '';
    li.placeholder = t(def.labelKey);
    li.addEventListener('input', () => {
      if (li.value.trim()) node.label = li.value;
      else delete node.label;
      refreshNode(node);
      scheduleCommit();
    });
    label.c.append(li);
    wrap.append(label.c);

    if (canHavePaths(node)) {
      const paths = card('branch', t('builder.opt.paths'), t('builder.opt.paths_hint'));
      const sw = el('input', 'toggle');
      sw.type = 'checkbox';
      sw.checked = Boolean(node.paths);
      sw.setAttribute('aria-label', t('builder.opt.paths'));
      sw.addEventListener('change', () => {
        if (sw.checked) node.paths = true;
        else delete node.paths;
        // Switching unlinks the blocks after it.
        graph.edges = graph.edges.filter((e) => !(e.from.node === node.id && ['next', 'success', 'error'].includes(e.from.port)));
        refreshNode(node);
        commit();
      });
      paths.h.append(sw);
      wrap.append(paths.c);
    }

    const note = card('note', t('builder.opt.note'), t('builder.opt.note_hint'));
    const ns = el('input', 'toggle');
    ns.type = 'checkbox';
    ns.checked = node.note !== undefined;
    ns.setAttribute('aria-label', t('builder.opt.note'));
    note.h.append(ns);
    const area = el('textarea', 'bopt-input');
    area.rows = 3;
    area.maxLength = 500;
    area.placeholder = t('builder.opt.note_placeholder');
    area.value = node.note || '';
    area.hidden = !ns.checked;
    area.addEventListener('input', () => { node.note = area.value; refreshNode(node); scheduleCommit(); });
    ns.addEventListener('change', () => {
      if (ns.checked) { node.note = node.note || ''; area.hidden = false; area.focus(); }
      else { delete node.note; area.hidden = true; }
      refreshNode(node);
      commit();
    });
    // Look of the helper text: colour and icon.
    const looks = el('div', 'bnote-looks');
    looks.hidden = !ns.checked;
    for (const [style, ic] of Object.entries(NOTE_STYLES)) {
      const b = el('button', `bnote-look bnote-${style}`, ic);
      b.type = 'button';
      b.title = t(`builder.enum.note_style.${style}`);
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-pressed', String(noteStyle(node.noteStyle) === style));
      b.addEventListener('click', () => {
        if (style === 'note') delete node.noteStyle;
        else node.noteStyle = style;
        looks.querySelectorAll('.bnote-look').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        refreshNode(node);
        commit();
      });
      looks.append(b);
    }
    // Any colour and any emoji, and folded down to its icon.
    const own = el('div', 'bnote-own');
    const color = el('input', 'bnote-color');
    color.type = 'color';
    color.value = HEX.test(node.noteColor || '') ? node.noteColor : '#facc15';
    color.title = t('builder.opt.note_color');
    color.setAttribute('aria-label', color.title);
    color.addEventListener('input', () => { node.noteColor = color.value; refreshNode(node); scheduleCommit(); });
    const emo = el('button', 'btn btn-sm', node.noteIcon || t('builder.opt.note_icon'));
    emo.type = 'button';
    emo.addEventListener('click', () => openEmojiPicker(emo, (v) => {
      node.noteIcon = String(v).slice(0, 64);
      emo.textContent = node.noteIcon;
      refreshNode(node);
      commit();
    }));
    const reset = el('button', 'btn btn-sm', t('builder.opt.note_reset'));
    reset.type = 'button';
    reset.addEventListener('click', () => {
      delete node.noteColor;
      delete node.noteIcon;
      emo.textContent = t('builder.opt.note_icon');
      refreshNode(node);
      commit();
    });
    const minRow = el('label', 'bnote-minrow');
    const min = el('input');
    min.type = 'checkbox';
    min.checked = !!node.noteMin;
    min.addEventListener('change', () => {
      if (min.checked) node.noteMin = true;
      else delete node.noteMin;
      refreshNode(node);
      commit();
    });
    minRow.append(min, document.createTextNode(` ${t('builder.opt.note_minimise')}`));
    own.append(color, emo, reset);
    own.hidden = !ns.checked;
    minRow.hidden = !ns.checked;
    ns.addEventListener('change', () => { looks.hidden = !ns.checked; own.hidden = !ns.checked; minRow.hidden = !ns.checked; });
    note.c.append(area, looks, own, minRow);
    wrap.append(note.c);
    return wrap;
  }

  // Form block: summary card; the form itself is edited in BotHubForm.
  function formWidget(node, key, schema) {
    if (!node.config[key]) node.config[key] = structuredClone(schema.default);
    const form = node.config[key];
    const wrap = el('div', 'bformcard-wrap');
    wrap.dataset.field = key;
    wrap.append(el('h3', 'bsection-title', t(schema['x-labelKey'])));
    const card = el('div', 'bformcard');
    const txt = el('div', 'bformcard-text');
    const count = form.fields?.length || 0;
    txt.append(el('strong', '', form.title || t('builder.form.form_title')), el('span', '', t(count === 1 ? 'builder.form.fields_one' : 'builder.form.fields_many', { count })));
    const nameOk = /^[a-z0-9-]{1,32}$/.test(node.config.form_name || '');
    const edit = el('button', 'btn bformcard-edit');
    edit.type = 'button';
    edit.disabled = !nameOk;
    edit.append(icon('edit'), document.createTextNode(t('builder.form.edit')));
    edit.addEventListener('click', () => {
      window.BotHubForm.open({
        node: { config: node.config },
        t, el, icon,
        formName: () => node.config.form_name,
        variables: () => graphVariables(node),
        pickVariable: (onPick) => pickVariable(onPick, 'insert', node),
        bot: { name: meta.botName || '', avatar: meta.botAvatar || '' },
        copy: copyText,
        onChange: () => { refreshNode(node); refreshMissing(); scheduleCommit(); },
        onClose: () => { commit(); renderInspector(); },
      });
    });
    card.append(txt, edit);
    wrap.append(card);
    if (!nameOk) wrap.append(el('p', 'bfield-hint', t('builder.form.name_first')));

    const will = el('div', 'bwilldo');
    will.append(el('div', 'bwilldo-title', t('builder.form.will_do')));
    const line = el('div', 'bwilldo-text');
    line.append(document.createTextNode(`${t('builder.form.opens')} `), el('strong', '', form.title || t('builder.form.form_title')),
      document.createTextNode(` ${t('builder.form.with')} `), el('strong', '', t(count === 1 ? 'builder.form.fields_one' : 'builder.form.fields_many', { count })), document.createTextNode('.'));
    will.append(line);
    wrap.append(will);
    return wrap;
  }

  // ---------- message block: what, where, undo ----------

  function messageComponents(node) {
    return componentsOf(node).map((c) => (c.type === 'component.button'
      ? { kind: 'button', id: c.id, label: c.label || c.config.label, style: c.config.style, emoji: c.config.emoji, url: c.config.url, disabled: c.config.disabled }
      : { kind: 'menu', id: c.id, placeholder: c.config.placeholder, min: c.config.min_values, max: c.config.max_values,
        options: statesOf(optionConditionOf(c) || { id: '' }).filter((st) => st.type === 'condition.state').map((st) => ({ label: st.config.value, description: st.config.option_description, emoji: st.config.option_emoji })) }));
  }
  const messageFilled = (node) => window.BotHubMessage?.hasBody(node.config.message) || componentsOf(node).length > 0;

  // "Edit a message" of a message this command sent: the block that sent it
  // (its variable is in edit_message, e.g. {Var1}), or null.
  function originalMessageNode(node) {
    if (node.config.target !== 'edit') return null;
    const m = /^\{?([A-Za-z][A-Za-z0-9_]{0,31})\}?$/.exec(String(node.config.edit_message || '').trim());
    if (!m) return null;
    const src = graph.nodes.find((n) => n !== node && n.config?.variable === m[1] && n.config.message && typeof n.config.message === 'object');
    return src && messageFilled(src) ? src : null;
  }

  function openMessageBuilder(node) {
    // An edit starts from the original message instead of an empty one.
    const original = originalMessageNode(node);
    if (original && !messageFilled(node)) {
      node.config.message = structuredClone(original.config.message);
      toast(t('builder.msg.from_original'));
    }
    if (!node.config.message) node.config.message = structuredClone(defs[node.type].config.properties.message.default);
    window.BotHubMessage.open({
      message: node.config.message,
      t, el, icon,
      variables: () => graphVariables(node),
      pickVariable: (onPick) => pickVariable(onPick, 'insert', node),
      components: () => messageComponents(node),
      bot: { name: meta.botName || '', avatar: meta.botAvatar || '' },
      templatesUrl: meta.templatesUrl,
      csrf,
      copy: copyText,
      toast,
      onChange: () => { refreshNode(node); refreshMissing(); scheduleCommit(); },
      onClose: () => { commit(); render(); },
    });
  }

  function badge(textKey, ok) {
    const b = el('span', `bstate-badge${ok ? ' is-ok' : ''}`, t(textKey));
    return b;
  }

  function messageWidget(node, key, schema) {
    if (!node.config[key]) node.config[key] = structuredClone(schema.default);
    const msg = node.config[key];
    const wrap = el('div', 'bwidget');
    wrap.dataset.field = key;
    const filled = messageFilled(node);
    const h = el('h3', 'bsection-title');
    h.append(document.createTextNode(t(schema['x-labelKey'])), badge(filled ? 'builder.msg.ready_badge' : 'builder.msg.empty_badge', filled));
    wrap.append(h);

    const seg = el('div', 'bseg');
    for (const mode of ['normal', 'v2']) {
      const b = el('button', 'bseg-item');
      b.type = 'button';
      b.setAttribute('aria-pressed', String((msg.mode || 'normal') === mode));
      b.append(icon(mode === 'normal' ? 'message' : 'layers'), document.createTextNode(t(`builder.msg.mode.${mode}`)));
      b.addEventListener('click', () => { msg.mode = mode; refreshNode(node); commit(); renderInspector(); });
      seg.append(b);
    }
    wrap.append(seg);

    const card = el('div', `bmsgcard${filled ? ' is-filled' : ''}`);
    if (!filled) {
      const ic = el('span', 'bmsgcard-icon');
      ic.append(icon('message'));
      card.append(ic, el('strong', '', t('builder.msg.empty_title')), el('span', '', t('builder.msg.empty_hint')));
    } else {
      const sum = window.BotHubMessage.summary(msg);
      card.append(el('div', 'bmsgcard-text', sum || t('builder.ref.message_block')));
      const bits = [];
      if (msg.mode === 'v2') bits.push(t('builder.msg.summary_components', { count: (msg.components || []).length }));
      else if ((msg.embeds || []).length) bits.push(t(msg.embeds.length === 1 ? 'builder.msg.summary_embeds_one' : 'builder.msg.summary_embeds_many', { count: msg.embeds.length }));
      const comps = componentsOf(node).length;
      if (comps) bits.push(t('builder.msg.summary_attached', { count: comps }));
      if (bits.length) card.append(el('span', '', bits.join(' · ')));
    }
    const btn = el('button', 'btn bmsgcard-btn');
    btn.type = 'button';
    btn.append(icon('edit'), document.createTextNode(t(filled ? 'builder.msg.edit' : 'builder.msg.write')));
    btn.addEventListener('click', () => openMessageBuilder(node));
    card.append(btn);
    wrap.append(card);
    const original = originalMessageNode(node);
    if (original && filled) {
      // Start over from the message that is edited.
      const again = el('button', 'btn btn-sm');
      again.type = 'button';
      again.append(icon('copy'), document.createTextNode(t('builder.msg.use_original')));
      again.addEventListener('click', () => {
        if (!window.confirm(t('builder.msg.use_original_confirm'))) return;
        node.config.message = structuredClone(original.config.message);
        refreshNode(node);
        commit();
        renderInspector();
      });
      wrap.append(again);
    } else if (original) {
      wrap.append(el('p', 'bfield-hint', t('builder.msg.original_hint')));
    }
    if (!filled) {
      const err = el('p', 'berror');
      err.append(icon('alert'), document.createTextNode(t('builder.msg.error_empty')));
      wrap.append(err);
    }
    for (const prob of window.BotHubMessage.problems(msg, t)) {
      const err = el('p', 'berror');
      err.append(icon('alert'), document.createTextNode(prob));
      wrap.append(err);
    }
    return wrap;
  }

  const TARGET_TABS = { reply: isEvent ? ['command_channel', 'reply_message'] : ['reply', 'reply_message', 'command_channel'], channel: ['channel'], dm: ['dm'], edit: ['edit'] };
  const TAB_ICON = { reply: 'reply', channel: 'hash', dm: 'mail', edit: 'edit' };
  function destinationWidget(node, key, schema) {
    const target = node.config[key] || schema.default;
    const tab = Object.keys(TARGET_TABS).find((k) => TARGET_TABS[k].includes(target)) || 'reply';
    const wrap = el('div', 'bwidget');
    wrap.dataset.field = key;
    wrap.append(el('h3', 'bsection-title', t(schema['x-labelKey'])));
    const set = (v) => {
      if (v === schema.default) delete node.config[key];
      else node.config[key] = v;
      refreshNode(node);
      commit();
      renderInspector();
    };
    const tabs = el('div', 'btabs4');
    for (const k of Object.keys(TARGET_TABS)) {
      const b = el('button', 'btabs4-item');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === tab));
      b.append(icon(TAB_ICON[k]), document.createTextNode(t(`builder.msg.tab.${k}`)));
      b.addEventListener('click', () => { if (k !== tab) set(TARGET_TABS[k][0]); });
      tabs.append(b);
    }
    wrap.append(tabs);
    const props = defs[node.type].config.properties;
    const groupFields = (v) => Object.entries(props).filter(([, sc]) => sc['x-group'] === 'destination' && (sc['x-showIf']?.[key] || []).includes(v));
    for (const v of TARGET_TABS[tab]) {
      const on = v === target;
      const card = el('div', `bradio${on ? ' is-on' : ''}`);
      const head = el('button', 'bradio-head');
      head.type = 'button';
      head.setAttribute('aria-pressed', String(on));
      head.append(el('span', 'bradio-dot'));
      const tx = el('span', 'bradio-text');
      tx.append(el('strong', '', t(tk(`builder.msg.target.${v}`))), el('span', '', t(tk(`builder.msg.target.${v}_hint`))));
      head.append(tx);
      head.addEventListener('click', () => { if (!on) set(v); });
      card.append(head);
      if (on) {
        for (const [fk, fs] of groupFields(v)) {
          const f = fs['x-ref'] === 'message' ? messageRefField(node, fk, fs) : field(node, fk, fs, false);
          f.classList.add('bradio-body');
          card.append(f);
        }
      }
      wrap.append(card);
    }
    return wrap;
  }

  function undoWidget(node, key, schema) {
    const wrap = el('div', 'bwidget');
    wrap.dataset.field = key;
    wrap.append(el('h3', 'bsection-title', t(schema['x-labelKey'])));
    const card = el('div', 'bopt');
    const h = el('div', 'bopt-head');
    h.append(icon('rotate', 'bicon bopt-icon'));
    const tx = el('div', 'bopt-text');
    tx.append(el('strong', '', t(schema['x-undoTitleKey'] || 'builder.msg.undo_toggle')), el('span', '', t(schema['x-undoHintKey'] || 'builder.msg.undo_hint')));
    const sw = el('input', 'toggle');
    sw.type = 'checkbox';
    sw.checked = Boolean(node.config[key]);
    sw.setAttribute('aria-label', t(schema['x-undoTitleKey'] || 'builder.msg.undo_toggle'));
    h.append(tx, sw);
    card.append(h);
    const inp = el('input', 'bopt-input mono');
    inp.type = 'text';
    inp.maxLength = 20;
    inp.placeholder = '30s';
    inp.value = node.config[key] || '';
    inp.hidden = !sw.checked;
    const hint = el('span', 'bfield-hint', t('builder.msg.undo_after_hint'));
    hint.hidden = !sw.checked;
    inp.addEventListener('input', () => {
      const v = inp.value.trim();
      inp.classList.toggle('is-invalid', Boolean(v) && !/^[0-9]+[smhd]$/.test(v));
      if (/^[0-9]+[smhd]$/.test(v)) { node.config[key] = v; scheduleCommit(); updateWill(); }
    });
    sw.addEventListener('change', () => {
      if (sw.checked) { node.config[key] = inp.value.trim() || '30s'; inp.value = node.config[key]; }
      else delete node.config[key];
      inp.hidden = hint.hidden = !sw.checked;
      commit();
      updateWill();
      if (sw.checked) inp.focus();
    });
    card.append(inp, hint);
    wrap.append(card);
    const updateWill = () => { const w = willDo(node); inspector.querySelector('.bwilldo')?.replaceWith(w || ''); };
    return wrap;
  }

  // ---------- If / Else: what is checked, the checks, add a check ----------

  const OP_GROUPS = [['same', ['eq', 'ne']], ['numbers', ['gt', 'gte', 'lt', 'lte']], ['time', ['before', 'after']],
    ['text', ['contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with']], ['collections', ['in', 'not_in']]];
  const SOURCE_ICON = { variable: 'layers', option: 'list', other: 'code' };

  function checksWidget(node, key, schema) {
    const props = defs[node.type].config.properties;
    const source = node.config.source || props.source.default;
    const subject = node.config[key] || '';
    const wrap = el('div', 'bwidget');
    wrap.dataset.field = key;
    const setSubject = (v, re = true) => {
      if (v) node.config[key] = v;
      else delete node.config[key];
      refreshNode(node);
      statesOf(node).forEach(refreshNode);
      renderEdges();
      refreshMissing();
      if (re) { commit(); renderInspector(); } else scheduleCommit();
    };

    wrap.append(el('h3', 'bsection-title', t('builder.check.what')), el('p', 'bfield-hint', t('builder.check.what_hint')));
    for (const src of isEvent ? ['variable', 'other'] : ['variable', 'option', 'other']) {
      const on = src === source;
      const card = el('div', `bradio${on ? ' is-on' : ''}`);
      const head = el('button', 'bradio-head');
      head.type = 'button';
      head.setAttribute('aria-pressed', String(on));
      head.append(el('span', 'bradio-dot'), icon(SOURCE_ICON[src], 'bicon bradio-icon'));
      const tx = el('span', 'bradio-text');
      tx.append(el('strong', '', t(`builder.check.source.${src}`)), el('span', '', t(`builder.check.source.${src}_hint`)));
      head.append(tx);
      head.addEventListener('click', () => {
        if (on) return;
        if (src === props.source.default) delete node.config.source;
        else node.config.source = src;
        setSubject('');
      });
      card.append(head);
      if (on) {
        const body = el('div', 'bradio-body bchips');
        const chip = (value, label) => {
          const b = el('button', `bchip${value === subject ? ' is-on' : ''}`, label);
          b.type = 'button';
          b.addEventListener('click', () => setSubject(value === subject ? '' : value));
          body.append(b);
        };
        if (src === 'option') {
          const opts = graph.nodes.filter((n) => isOption(n) && n.config.name);
          if (!opts.length) body.append(el('p', 'bfield-hint', t('builder.check.no_options')));
          for (const o of opts) chip(`{option_${o.config.name}}`, o.config.name);
        } else if (src === 'variable') {
          const vars = graph.nodes.filter((n) => n !== node && n.config.variable).map((n) => n.config.variable);
          if (!vars.length) body.append(el('p', 'bfield-hint', t('builder.check.no_variables')));
          for (const v of vars) chip(v, v);
        } else {
          const l = el('label', 'bfield');
          const i = el('input', 'mono');
          i.type = 'text';
          i.maxLength = 200;
          i.placeholder = '{user}';
          i.value = subject;
          i.addEventListener('focus', () => { lastField = i; });
          i.addEventListener('input', () => setSubject(i.value, false));
          l.append(el('span', 'bfield-label', t('builder.check.value')), i);
          body.classList.remove('bchips');
          body.append(l);
        }
        card.append(body);
      }
      wrap.append(card);
    }

    // Your checks: the branches on the canvas
    wrap.append(el('h3', 'bsection-title', t('builder.check.yours')), el('p', 'bfield-hint', t('builder.check.yours_hint')));
    const list = el('div', 'bchecks');
    const states = statesOf(node).sort((a, b) => (b.type === 'condition.else') - (a.type === 'condition.else'));
    for (const st of states) {
      const row = el('button', 'bcheck');
      row.type = 'button';
      const tx = el('span', 'bcheck-text');
      if (st.type === 'condition.else') tx.append(richText('builder.check.otherwise'));
      else {
        tx.append(el('strong', '', `${t('builder.check.if')} `), el('code', 'bcheck-code', subject || '?'),
          document.createTextNode(` ${t(`builder.op.${st.config.operator || 'eq'}`)} `), el('code', 'bcheck-code', st.config.value || t('builder.state.empty')));
      }
      row.append(tx, icon('chevron', 'bicon bcheck-go'));
      row.addEventListener('click', () => { selected = { kind: 'node', id: st.id }; focusNode(st); render(); });
      list.append(row);
    }
    wrap.append(list);

    // Add another check: operator chips + value
    const add = el('div', 'baddcheck');
    add.append(el('strong', '', t('builder.check.add')));
    const valueWrap = el('label', 'bfield');
    const vi = el('input', 'mono');
    vi.type = 'text';
    vi.maxLength = 200;
    vi.addEventListener('focus', () => { lastField = vi; });
    valueWrap.append(el('span', 'bfield-label', t('builder.check.compare_to')), vi, el('span', 'bfield-hint', t('builder.check.compare_hint')));
    for (const [g, ops] of OP_GROUPS) {
      add.append(el('div', 'bopgroup', t(`builder.opgroup.${g}`)));
      const row = el('div', 'bchips');
      for (const op of ops) {
        const b = el('button', 'bchip', t(`builder.opchip.${op}`));
        b.type = 'button';
        b.addEventListener('click', () => {
          const st = addState(node);
          st.config.operator = op;
          if (vi.value.trim()) st.config.value = vi.value.trim();
          commit();
          render();
        });
        row.append(b);
      }
      add.append(row);
    }
    add.append(valueWrap);
    wrap.append(add);
    return wrap;
  }

  // ---------- targets: member, channel, category, role(s) ----------
  // Value: {user.id} / {channel.id} (who or where it ran), {option_x}, an ID
  // picked from the server, or any ID, variable or placeholder.

  const TARGET_MODES = { member: ['invoker', 'option', 'custom'], channel: ['current', 'option', 'server', 'custom'], category: ['server', 'custom'],
    role: ['option', 'server', 'custom'], roles: ['server', 'custom'] };
  if (isEvent) for (const k of Object.keys(TARGET_MODES)) TARGET_MODES[k] = TARGET_MODES[k].filter((m) => m !== 'option');
  const TARGET_OPTION = { member: 'option.user', channel: 'option.channel', role: 'option.role' };
  const targetModes = new Map();
  const targetNames = new Map(); // id -> name of things picked from a server

  function targetMode(kind, value, memo) {
    const modes = TARGET_MODES[kind];
    if (kind === 'member' && /^\{user(\.id)?\}$/.test(value)) return 'invoker';
    if (kind === 'channel' && /^\{channel(\.id)?\}$/.test(value)) return 'current';
    if (/^\{option_[a-z0-9_-]+\}$/.test(value) && modes.includes('option')) return 'option';
    const remembered = targetModes.get(memo);
    if (remembered && modes.includes(remembered)) return remembered;
    if (kind === 'roles') return value && !value.split(',').every((x) => /^\d{17,20}$/.test(x.trim())) ? 'custom' : 'server';
    if (/^\d{17,20}$/.test(value) && modes.includes('server')) return 'server';
    return value ? 'custom' : modes.includes('server') ? 'server' : 'custom';
  }

  function targetField(node, key, schema, isRequired) {
    const kind = schema['x-ref'];
    const value = String(node.config[key] ?? '');
    const memo = `${node.id}.${key}`;
    const mode = targetMode(kind, value, memo);
    const wrap = el('div', 'bfield btarget');
    wrap.dataset.field = key;
    const title = el('span', 'bfield-label', t(schema['x-labelKey']));
    if (isRequired) {
      const needed = el('span', 'bneeded', t('builder.needed'));
      needed.hidden = Boolean(value);
      title.append(el('span', 'bfield-required', ' *'), needed);
    }
    wrap.append(title);
    const set = (v, rerender = true) => {
      if (v) node.config[key] = v;
      else delete node.config[key];
      refreshNode(node);
      refreshMissing();
      scheduleCommit();
      if (rerender) wrap.replaceWith(targetField(node, key, schema, isRequired));
    };
    const modes = el('div', 'btarget-modes');
    for (const m of TARGET_MODES[kind]) {
      const b = el('button', 'bchip', t(tk(`builder.target.${m}`)));
      b.type = 'button';
      b.classList.toggle('is-on', m === mode);
      b.setAttribute('aria-pressed', String(m === mode));
      b.addEventListener('click', () => {
        if (m === mode) return;
        targetModes.set(memo, m);
        set(m === 'invoker' ? '{user.id}' : m === 'current' ? '{channel.id}' : '');
      });
      modes.append(b);
    }
    wrap.append(modes);

    if (mode === 'option') {
      const chips = el('div', 'bchips');
      const opts = graph.nodes.filter((n) => n.type === TARGET_OPTION[kind] && n.config.name);
      if (!opts.length) chips.append(el('span', 'bfield-hint', t('builder.target.no_options')));
      for (const o of opts) {
        const v = `{option_${o.config.name}}`;
        const b = el('button', `bchip${v === value ? ' is-on' : ''}`, o.config.name);
        b.type = 'button';
        b.addEventListener('click', () => set(v));
        chips.append(b);
      }
      wrap.append(chips);
    } else if (mode === 'server') {
      const row = el('div', 'btarget-row');
      if (kind === 'roles') {
        const ids = value.split(',').map((x) => x.trim()).filter(Boolean);
        for (const id of ids) {
          const chip = el('span', 'bperm-chip');
          chip.append(el('span', 'bperm-chip-label', `@${targetNames.get(id) || id}`));
          const x = el('button', 'bperm-chip-x', '×');
          x.type = 'button';
          x.setAttribute('aria-label', t('builder.perm.remove', { name: targetNames.get(id) || id }));
          x.addEventListener('click', () => set(ids.filter((i) => i !== id).join(',')));
          chip.append(x);
          row.append(chip);
        }
      } else if (value) {
        row.append(el('span', 'bfield-hint', t('builder.target.picked', { name: targetNames.get(value) || value })));
      }
      const pick = el('button', 'bperm-add');
      pick.type = 'button';
      pick.append(el('span', 'bperm-add-plus', '+'), document.createTextNode(t(kind === 'roles' ? 'builder.target.add_roles' : 'builder.target.pick')));
      pick.addEventListener('click', () => openServerPicker(wrap, kind, (item) => {
        targetNames.set(item.id, item.name);
        if (kind === 'roles') {
          const ids = value.split(',').map((x) => x.trim()).filter(Boolean);
          if (!ids.includes(item.id)) ids.push(item.id);
          set(ids.join(','));
        } else set(item.id);
      }));
      row.append(pick);
      wrap.append(row);
    } else if (mode === 'custom') {
      const i = el('input', 'mono');
      i.type = 'text';
      i.maxLength = schema.maxLength || 200;
      i.value = value;
      i.placeholder = kind === 'roles' ? '123…, 456…' : '{user.id}';
      i.addEventListener('focus', () => { lastField = i; });
      i.addEventListener('input', () => set(i.value.trim(), false));
      wrap.append(i, el('span', 'bfield-hint', t(schema['x-hintKey'] === 'builder.cfg.ref_optional_hint' ? 'builder.cfg.ref_optional_hint' : 'builder.target.custom_hint')));
    }
    return wrap;
  }

  // Server picker: servers of the bot, then that server's roles or channels.
  function openServerPicker(wrap, kind, onPick) {
    wrap.querySelectorAll('.bpick').forEach((x) => x.remove());
    const state = { guild: null, search: '' };
    const box = el('div', 'bpick btarget-pick');
    box.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); box.remove(); } });
    wrap.append(box);
    const render = async () => {
      box.replaceChildren();
      const head = el('div', 'bpick-head');
      const title = el('div', 'bpick-title');
      title.append(el('strong', '', t('builder.target.pick')));
      if (state.guild) {
        const sub = el('span', 'bpick-subline');
        const change = el('button', 'bpick-link', t('builder.pick.change_server'));
        change.type = 'button';
        change.addEventListener('click', () => { state.guild = null; state.search = ''; render(); });
        sub.append(el('strong', '', state.guild.name), document.createTextNode(' '), change);
        title.append(sub);
      }
      const close = el('button', 'icon-btn icon-btn-plain', '×');
      close.type = 'button';
      close.setAttribute('aria-label', t('builder.close'));
      close.addEventListener('click', () => box.remove());
      head.append(title, close);
      const sw = el('label', 'bpick-search');
      sw.append(icon('search'));
      const input = el('input');
      input.type = 'search';
      input.value = state.search;
      input.placeholder = t(state.guild ? (kind === 'role' || kind === 'roles' ? 'builder.pick.search_roles' : 'builder.pick.search_channels') : 'builder.pick.search_servers');
      sw.append(input);
      const list = el('div', 'bpick-list');
      box.append(head, sw, list);
      const fill = async () => {
        const q = input.value.trim().toLowerCase();
        state.search = q;
        list.replaceChildren(el('p', 'bpick-status', t('builder.pick.loading')));
        try {
          if (!state.guild) {
            const guilds = (await load(guildsUrl())).filter((g) => !q || g.name.toLowerCase().includes(q));
            list.replaceChildren();
            for (const g of guilds) {
              const b = el('button', 'bpick-guild');
              b.type = 'button';
              b.append(el('span', 'avatar avatar-fallback', (g.name || '?').slice(0, 1).toUpperCase()), el('strong', '', g.name), icon('chevron', 'bicon bpick-chevron'));
              b.addEventListener('click', () => { state.guild = g; state.search = ''; render(); });
              list.append(b);
            }
          } else {
            const roleKind = kind === 'role' || kind === 'roles';
            let items = await load(guildPart(state.guild.id, roleKind ? 'roles' : 'channels'));
            if (kind === 'category') items = items.filter((c) => c.type === 'category');
            else if (kind === 'channel') items = items.filter((c) => c.type !== 'category');
            items = items.filter((x) => !q || x.name.toLowerCase().includes(q));
            list.replaceChildren();
            for (const it of items) {
              const b = el('button', 'bpick-guild');
              b.type = 'button';
              if (roleKind) {
                const dot = el('span', 'bpick-dot');
                if (it.color) dot.style.background = it.color;
                b.append(dot, el('strong', '', `@${it.name}`));
              } else b.append(icon(CHANNEL_ICON[it.type] || 'hash', 'bicon bpick-row-icon'), el('strong', '', it.name), el('span', 'bpick-tag', t(`builder.chan.${it.type}`)));
              b.addEventListener('click', () => { onPick({ id: it.id, name: it.name }); if (kind !== 'roles') box.remove(); });
              list.append(b);
            }
          }
          if (!list.childElementCount) list.append(el('p', 'bpick-status', t('builder.pick.empty')));
        } catch {
          list.replaceChildren(el('p', 'bpick-status', t('builder.pick.load_failed')));
        }
      };
      input.addEventListener('input', fill);
      fill();
      setTimeout(() => input.focus({ preventScroll: true }), 0);
      requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    };
    render();
  }

  // Results a block leaves for the blocks after it, as copy chips.
  function resultsBox(node, def) {
    const box = el('div', 'bresults');
    box.append(el('div', 'bwilldo-title', t('builder.results.title')), el('span', 'bfield-hint', t('builder.results.hint')));
    const base = node.config.variable;
    if (!base) {
      box.append(el('span', 'bfield-hint', t('builder.results.need_variable')));
      return box;
    }
    for (const r of def.results) {
      const row = el('div', 'bresult');
      row.append(copyChip(`{${base}${r.suffix}}`), el('span', 'bresult-label', t(r.labelKey)));
      box.append(row);
    }
    return box;
  }

  // A variable chip that copies its name.
  function copyChip(name) {
    const chip = el('button', 'bvar-chip mono');
    chip.type = 'button';
    chip.title = t('builder.copy', { name });
    chip.append(el('span', '', name), icon('clipboard', 'bicon bvar-clip'));
    chip.addEventListener('mousedown', (ev) => ev.preventDefault());
    chip.addEventListener('click', () => copyText(name));
    return chip;
  }

  // ---------- event type (custom events) ----------

  // The picked event as a card; clicking it opens the picker.
  function eventCard(key, onPick) {
    const info = EVENT_INFO[key];
    const card = el('button', `bevent-card${info ? '' : ' is-empty'}`);
    card.type = 'button';
    const tx = el('span', 'bevent-text');
    tx.append(el('strong', '', info ? t(`builder.event.${key}`) : t('builder.event.pick')),
      el('span', '', info ? t(`builder.eventcat.${info.cat.key}`) : t('builder.cfg.event_type_hint')));
    card.append(el('span', 'bevent-icon', info ? info.cat.icon : '📡'), tx, el('span', 'bevent-change', t(info ? 'builder.event.change' : 'builder.event.pick')));
    card.addEventListener('click', () => openEventPicker(key, onPick));
    return card;
  }

  function eventTypeWidget(node, key, schema) {
    const wrap = el('div', 'bwidget');
    wrap.dataset.field = key;
    wrap.append(el('h3', 'bsection-title', t(schema['x-labelKey'])), el('p', 'bfield-hint', t(schema['x-hintKey'])));
    wrap.append(eventCard(node.config[key], (k) => {
      node.config[key] = k;
      refreshNode(node);
      refreshMissing();
      commit();
      renderInspector();
    }));
    const info = EVENT_INFO[node.config[key]];
    // The intent this event needs is off in the Developer Portal: it would never fire.
    if (info && intentOff(info.intent)) wrap.append(el('div', 'bevent-intent-warn', `⚠ ${t(`builder.event.intent_off.${info.intent}`)}`));
    if (info?.vars.length) {
      const box = el('div', 'bresults');
      box.append(el('div', 'bwilldo-title', t('builder.event.vars_title')), el('span', 'bfield-hint', t('builder.event.vars_hint')));
      const chips = el('div', 'bevent-vars');
      chips.append(...info.vars.map(copyChip));
      box.append(chips);
      wrap.append(box);
    }
    return wrap;
  }

  // Custom events of type "timed": which timed event (schedule) starts them.
  function timedEventWidget(node, key, schema) {
    const label = el('label', 'bfield');
    label.dataset.field = key;
    const title = el('span', 'bfield-label', t(schema['x-labelKey']));
    title.append(el('span', 'bfield-required', ' *'));
    label.append(title);
    const input = el('select');
    const none = el('option', '', t('builder.cfg.timed_event_pick'));
    none.value = '';
    input.append(none);
    input.addEventListener('change', () => {
      node.config[key] = input.value;
      refreshNode(node);
      refreshMissing();
      commit();
    });
    label.append(input, el('span', 'bfield-hint', t(schema['x-hintKey'])));
    load(meta.timedEventsUrl).then((items) => {
      for (const te of items) {
        const o = el('option', '', te.name);
        o.value = String(te.id);
        if (String(te.id) === String(node.config[key] ?? '')) o.selected = true;
        input.append(o);
      }
    }).catch(() => label.append(el('span', 'bfield-hint', t('builder.pick.load_failed'))));
    return label;
  }

  // Make Image Card: one of the bot's cards (Card Designer).
  function cardWidget(node, key, schema) {
    const label = el('label', 'bfield');
    label.dataset.field = key;
    label.append(el('span', 'bfield-label', t(schema['x-labelKey'])));
    const input = el('select');
    const none = el('option', '', t('builder.card.pick'));
    none.value = '';
    input.append(none);
    input.addEventListener('change', () => {
      if (input.value) node.config[key] = input.value;
      else delete node.config[key];
      refreshNode(node);
      refreshMissing();
      commit();
    });
    label.append(input, el('span', 'bfield-hint', t(schema['x-hintKey'])));
    load(meta.cardsUrl).then((items) => {
      for (const c of items) {
        const o = el('option', '', `${c.name} (#${c.id})`);
        o.value = String(c.id);
        if (String(c.id) === String(node.config[key] ?? '')) o.selected = true;
        input.append(o);
      }
      if (!items.length) label.append(el('span', 'bfield-hint', t('builder.card.none')));
    }).catch(() => label.append(el('span', 'bfield-hint', t('builder.pick.load_failed'))));
    return label;
  }

  // Custom events of type "webhook": which webhook starts them ("" = every one).
  function webhookWidget(node, key, schema) {
    const label = el('label', 'bfield');
    label.dataset.field = key;
    label.append(el('span', 'bfield-label', t(schema['x-labelKey'])));
    const input = el('select');
    const any = el('option', '', t('builder.webhook.any'));
    any.value = '';
    input.append(any);
    input.addEventListener('change', () => {
      if (input.value) node.config[key] = input.value;
      else delete node.config[key];
      refreshNode(node);
      refreshMissing();
      commit();
    });
    label.append(input, el('span', 'bfield-hint', t(schema['x-hintKey'])));
    load(meta.webhooksUrl).then((items) => {
      for (const h of items) {
        const o = el('option', '', h.name);
        o.value = h.eventId;
        if (h.eventId === node.config[key]) o.selected = true;
        input.append(o);
      }
      if (!items.length) label.append(el('span', 'bfield-hint', t('builder.webhook.none')));
    }).catch(() => label.append(el('span', 'bfield-hint', t('builder.pick.load_failed'))));
    return label;
  }

  // Popup: search and categories on top, the events below.
  // A privileged intent an event needs is off in the Developer Portal (meta.intents from the bot's last start).
  function intentOff(intent) {
    return !!intent && !!meta.intents && meta.intents[intent] === false;
  }

  function openEventPicker(current, onPick) {
    const state = { cat: '', search: '' };
    const overlay = el('div', 'bform');
    const dialog = el('div', 'bsetup bevent-picker');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('builder.event.picker_title'));
    overlay.append(dialog);
    root.append(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') close(); });
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
    const head = el('div', 'bsetup-head');
    const hi = el('span', 'bsetup-icon', '📡');
    const ht = el('div', '');
    ht.append(el('strong', '', t('builder.event.picker_title')), el('span', 'bfield-hint', t('builder.event.picker_hint')));
    const x = el('button', 'bform-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('builder.close'));
    x.addEventListener('click', close);
    head.append(hi, ht, x);
    const sw = el('label', 'bpick-search');
    sw.append(icon('search'));
    const input = el('input');
    input.type = 'search';
    input.placeholder = t('builder.event.search');
    sw.append(input);
    // Categories in a sidebar on the left, search and events on the right.
    const cats = el('nav', 'bevent-side');
    cats.setAttribute('aria-label', t('builder.event.categories'));
    const list = el('div', 'bevent-list');
    const main = el('div', 'bevent-main');
    main.append(sw, list);
    const body = el('div', 'bsetup-body bevent-body');
    body.append(cats, main);
    dialog.append(head, body);
    const catItem = (key, icon, label, count) => {
      const b = el('button', 'bevent-cat');
      b.type = 'button';
      b.classList.toggle('is-on', state.cat === key);
      b.setAttribute('aria-pressed', String(state.cat === key));
      b.append(el('span', 'bevent-cat-icon', icon), el('span', 'bevent-cat-label', label), el('span', 'bevent-cat-count', String(count)));
      b.addEventListener('click', () => { state.cat = key; fill(); list.scrollTop = 0; });
      return b;
    };
    const fill = () => {
      const total = EVENT_CATS.reduce((n, c) => n + c.events.length, 0);
      cats.replaceChildren(catItem('', '✨', t('builder.event.all'), total), ...EVENT_CATS.map((c) => catItem(c.key, c.icon, t(`builder.eventcat.${c.key}`), c.events.length)));
      list.replaceChildren();
      const q = state.search;
      for (const c of EVENT_CATS) {
        if (state.cat && c.key !== state.cat) continue;
        // Every word has to match, in any order ("message delete").
        const items = c.events.filter((e) => {
          const hay = `${t(`builder.event.${e.key}`)} ${e.key.replace(/_/g, ' ')} ${t(`builder.eventcat.${c.key}`)}`.toLowerCase();
          return q.split(/\s+/).every((w) => hay.includes(w));
        });
        if (!items.length) continue;
        list.append(el('div', 'bevent-group', `${c.icon} ${t(`builder.eventcat.${c.key}`)}`));
        for (const e of items) {
          const b = el('button', `bevent-item${e.key === current ? ' is-on' : ''}${e.soon ? ' is-soon' : ''}`);
          b.type = 'button';
          b.append(el('span', '', t(`builder.event.${e.key}`)));
          if (e.soon) b.append(el('span', 'bevent-soon', t('builder.event.soon')));
          if (intentOff(e.intent)) {
            const w = el('span', 'bevent-intent', `⚠ ${t('builder.event.intent_off_short')}`);
            w.title = t(`builder.event.intent_off.${e.intent}`);
            b.append(w);
          }
          b.append(el('span', 'bevent-key mono', e.key));
          // Types the bot does not emit yet stay visible but cannot be picked.
          if (e.soon) { b.disabled = true; b.title = t('builder.event.soon_hint'); } else b.addEventListener('click', () => { close(); onPick(e.key); });
          list.append(b);
        }
      }
      if (!list.childElementCount) list.append(el('p', 'bpick-status', t('builder.pick.empty')));
    };
    input.addEventListener('input', () => { state.search = input.value.trim().toLowerCase(); fill(); });
    fill();
    list.querySelector('.is-on')?.scrollIntoView({ block: 'center' });
    setTimeout(() => input.focus(), 0);
  }

  // "What this block will do" for blocks that describe themselves.
  function richText(str, params = {}) {
    const frag = document.createDocumentFragment();
    t(str, params).split('**').forEach((part, i) => frag.append(i % 2 ? el('strong', '', part) : document.createTextNode(part)));
    return frag;
  }
  function willDo(node) {
    let content = null;
    if (node.type === 'action.send_message') {
      content = document.createDocumentFragment();
      content.append(richText(tk(`builder.msg.willdo.${node.config.target || 'reply'}`)));
      if (node.config.delete_after) content.append(richText('builder.msg.willdo.undo', { time: node.config.delete_after }));
    } else if (node.type === 'action.delete_message') {
      content = richText(String(node.config.message || '').includes('/') ? 'builder.ref.willdo.delete_id' : 'builder.ref.willdo.delete_block');
    }
    if (!content) return null;
    const will = el('div', 'bwilldo');
    const line = el('div', 'bwilldo-text');
    line.append(content);
    will.append(el('div', 'bwilldo-title', t('builder.form.will_do')), line);
    return will;
  }

  // ---------- "which message": a message a block sent, or by ID ----------
  // Value: the block's variable (e.g. Var1), or "<channel>/<message id>".

  const refModes = new Map();
  function ancestorsOf(node) {
    const out = new Set();
    const stack = [node.id];
    while (stack.length) {
      const id = stack.pop();
      for (const e of graph.edges) {
        if (e.to.node === id && !out.has(e.from.node)) { out.add(e.from.node); stack.push(e.from.node); }
      }
    }
    return out;
  }

  function messageRefField(node, key, schema) {
    const value = String(node.config[key] || '');
    const modeKey = `${node.id}.${key}`;
    const mode = value.includes('/') ? 'id' : value ? 'block' : refModes.get(modeKey) || 'block';
    const wrap = el('div', 'bwidget');
    wrap.dataset.field = key;
    const h = el('h3', 'bsection-title', schema['x-group'] ? t(schema['x-labelKey']) : t('builder.ref.which'));
    wrap.append(h);
    const set = (v) => {
      if (v) node.config[key] = v;
      else delete node.config[key];
      refreshNode(node);
      refreshMissing();
      scheduleCommit();
    };
    const radio = (m, titleKey, hintKey) => {
      const on = m === mode;
      const card = el('div', `bradio${on ? ' is-on' : ''}`);
      const head = el('button', 'bradio-head');
      head.type = 'button';
      head.setAttribute('aria-pressed', String(on));
      head.append(el('span', 'bradio-dot'));
      const tx = el('span', 'bradio-text');
      tx.append(el('strong', '', t(titleKey)), el('span', '', t(hintKey)));
      head.append(tx);
      head.addEventListener('click', () => {
        if (on) return;
        refModes.set(modeKey, m);
        set('');
        commit();
        renderInspector();
      });
      card.append(head);
      wrap.append(card);
      return { card, head, on };
    };

    const a = radio('block', 'builder.ref.block', 'builder.ref.block_hint');
    if (a.on) {
      const senders = graph.nodes.filter((n) => n !== node && defs[n.type]?.produces === 'message');
      const picked = senders.find((n) => n.config.variable && n.config.variable === value);
      if (!picked) a.head.append(el('span', 'bneeded', t('builder.ref.pick')));
      const list = el('div', 'bradio-body brefs');
      if (!senders.length) list.append(el('p', 'bfield-hint', t('builder.ref.no_blocks')));
      const above = ancestorsOf(node);
      for (const n of senders) {
        const item = el('button', `bref${n === picked ? ' is-picked' : ''}`);
        item.type = 'button';
        const ic = el('span', 'bref-icon');
        ic.append(icon('message'));
        const tx = el('span', 'bref-text');
        let sub = t('builder.ref.message_block');
        if (n.type === 'action.send_message') sub = messageFilled(n) ? (window.BotHubMessage.summary(n.config.message) || t('builder.ref.message_block')) : t('builder.ref.empty_message');
        tx.append(el('strong', '', nodeTitle(n)), el('span', '', sub));
        if (!above.has(n.id)) tx.append(el('em', 'bref-warn', t('builder.ref.not_above')));
        item.append(ic, tx);
        item.addEventListener('click', () => {
          if (!n.config.variable) { n.config.variable = newVariable(); refreshNode(n); }
          set(n.config.variable);
          commit();
          renderInspector();
        });
        list.append(item);
      }
      a.card.append(list);
    }
    const b = radio('id', 'builder.ref.id', 'builder.ref.id_hint');
    if (b.on) {
      const [ch, id] = value.includes('/') ? [value.slice(0, value.lastIndexOf('/')), value.slice(value.lastIndexOf('/') + 1)] : ['', ''];
      const body = el('div', 'bradio-body form');
      const mk = (labelKey, hintKey, v, ph) => {
        const l = el('label', 'bfield');
        l.append(el('span', 'bfield-label', t(labelKey)));
        const i = el('input', 'mono');
        i.type = 'text';
        i.maxLength = 100;
        i.placeholder = ph;
        i.value = v;
        i.addEventListener('focus', () => { lastField = i; });
        l.append(i, el('span', 'bfield-hint', t(hintKey)));
        body.append(l);
        return i;
      };
      const ci = mk('builder.ref.channel', 'builder.ref.channel_hint', ch, '{channel}');
      const mi = mk('builder.ref.message_id', 'builder.ref.message_id_hint', id, '123456789012345678');
      const upd = () => set(ci.value.trim() || mi.value.trim() ? `${ci.value.trim() || '{channel}'}/${mi.value.trim()}` : '');
      ci.addEventListener('input', upd);
      mi.addEventListener('input', upd);
      b.card.append(body);
    }
    return wrap;
  }

  function insertVariable(name) {
    const input = lastField && document.contains(lastField) ? lastField : null;
    if (!input) {
      navigator.clipboard?.writeText(name).catch(() => {});
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + name + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + name.length, start + name.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function field(node, key, schema, isRequired) {
    const isBool = schema.type === 'boolean';
    const label = el('label', isBool ? 'toggle-row' : 'bfield');
    label.dataset.field = key;
    const name = t(schema['x-labelKey'] || key);
    const value = node.config[key];
    let needed = null;
    const update = (v) => {
      if (v === '' || v === undefined) delete node.config[key];
      else node.config[key] = v;
      refreshNode(node);
      if (needed) needed.hidden = v !== '' && v !== undefined;
      refreshMissing();
      if (node.type === 'action.send_form' && key === 'form_name') {
        const formSchema = defs[node.type].config.properties.form;
        inspector.querySelector('[data-field="form"]')?.replaceWith(formWidget(node, 'form', formSchema));
      } else if (schema['x-showIf'] === undefined && Object.values(defs[node.type]?.config?.properties || {}).some((p) => p['x-showIf']?.[key])) renderInspector();
      scheduleCommit();
    };
    const title = el('span', 'bfield-label', name);
    if (isRequired) {
      needed = el('span', 'bneeded', t('builder.needed'));
      needed.hidden = value !== undefined && value !== '';
      title.append(el('span', 'bfield-required', ' *'), needed);
    }
    let input;
    if (isBool) {
      const text = el('span', 'bfield');
      text.append(title);
      if (schema['x-hintKey']) text.append(el('span', 'bfield-hint', t(schema['x-hintKey'])));
      label.append(text);
      input = el('input', 'toggle');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.addEventListener('change', () => update(input.checked));
      label.append(input);
      return label;
    }
    label.append(title);
    if (schema.enum) {
      input = el('select');
      for (const opt of schema.enum) {
        const o = el('option', '', schema['x-enumKey'] ? t(`${schema['x-enumKey']}.${opt}`) : opt);
        o.value = opt;
        if (opt === (value ?? schema.default)) o.selected = true;
        input.append(o);
      }
      input.addEventListener('change', () => update(input.value));
    } else if (schema['x-multiline']) {
      input = el('textarea');
      input.rows = 4;
      input.value = value ?? '';
      input.addEventListener('input', () => update(input.value));
    } else {
      input = el('input');
      input.type = 'text';
      if (schema.maxLength) input.maxLength = schema.maxLength;
      input.value = value ?? '';
      // Number fields also take a variable ({option_amount}); the bot resolves it at run time.
      const asNumber = (v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
      if (schema.type === 'number') input.inputMode = 'decimal';
      input.addEventListener('input', () => update(schema.type === 'number' ? asNumber(input.value) : input.value));
    }
    if (schema['x-placeholder']) input.placeholder = schema['x-placeholder'];
    if (key === 'variable' || schema['x-mono']) input.classList.add('mono');
    if (input.tagName !== 'SELECT') input.addEventListener('focus', () => { lastField = input; });
    if (schema['x-widget'] === 'emoji') {
      // Buttons and menu options: pick a standard emoji or one of the server's.
      const row = el('div', 'bemoji-field');
      const pickBtn = el('button', 'btn btn-sm bemoji-btn');
      pickBtn.type = 'button';
      pickBtn.title = t('builder.emoji.pick');
      pickBtn.setAttribute('aria-label', t('builder.emoji.pick'));
      pickBtn.append(icon('smile'));
      pickBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        openEmojiPicker(row, (v) => { input.value = v; update(v); });
      });
      row.append(input, pickBtn);
      label.append(row);
    } else if (key === 'var_name' && window.BotHubVarPicker) {
      // Variable blocks: pick a Data Storage variable ({var.key}) or one of this command.
      const row = el('div', 'bvp-field');
      const pickBtn = el('button', 'btn btn-sm');
      pickBtn.type = 'button';
      pickBtn.append(icon('list'), document.createTextNode(t('vars.choose')));
      pickBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        pickVariable((v) => { input.value = v; update(v); }, 'name', node);
      });
      row.append(input, pickBtn);
      label.append(row);
    } else {
      label.append(input);
    }
    if (schema['x-hintKey']) label.append(el('span', 'bfield-hint', t(schema['x-hintKey'])));
    return label;
  }

  // Variable popup (var-picker.js); falls back to nothing when not loaded.
  const VAR_CATALOG = island('builder-variables') || { categories: [] };
  function pickVariable(onPick, mode = 'insert', node = null) {
    window.BotHubVarPicker?.open({
      t, el, icon, mode, onPick,
      catalog: VAR_CATALOG,
      graphVars: () => graphVariables(node).filter((v) => mode !== 'insert' || !VAR_CATALOG.categories.some((c) => c.items.some((i) => i.token === v))),
      dataVarsUrl: meta.dataVarsUrl,
    });
  }

  // ---------- permissions widget (slash trigger) ----------
  // Allowed roles, banned roles, required permissions, banned channels and
  // the "hide" switch. Roles and channels are picked per server: first the
  // servers the bot is in, then that server's roles or channels.

  const ICONS = window.BotHubIcons || {};
  const CHANNEL_ICON = { category: 'folder', text: 'hash', voice: 'volume', stage: 'volume', announcement: 'megaphone', forum: 'forum' };

  function icon(name, cls = 'bicon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  // Cached lookups through the dashboard's API proxy.
  const cache = new Map();
  function load(url) {
    if (!cache.has(url)) {
      cache.set(url, fetch(url, { credentials: 'same-origin' }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }).then((d) => d.items || []).catch((err) => { cache.delete(url); throw err; }));
    }
    return cache.get(url);
  }
  const guildsUrl = () => meta.guildsUrl;
  const guildPart = (gid, part) => `${meta.guildsUrl}/${encodeURIComponent(gid)}/${part}`;

  // Pseudo roles resolved by the bot from the moderation module settings.
  const PSEUDO_ROLES = { 'moderation:moderator': 'builder.pick.moderators', 'moderation:admin': 'builder.pick.mod_admins' };

  // The permissions block lives in permissions.js (also used by the module settings pages).
  function permissionsWidget(node, key, schema) {
    if (!node.config[key]) node.config[key] = structuredClone(schema.default);
    return window.BotHubPermissions.block({
      value: node.config[key], t, hide: true, keep: pickerKeep,
      permissionGroups: schema['x-permissionGroups'], pseudoRoles: PSEUDO_ROLES,
      source: { guilds: () => load(guildsUrl()), items: (gid, part) => load(guildPart(gid, part)) },
      onChange: () => scheduleCommit(),
    });
  }

  let commitTimer = null;
  function scheduleCommit() {
    setDirty(true);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 400);
  }

  // ---------- panels (left rail) ----------

  let activePanel = 'nodes';
  let activeTab = TABS[0];
  let search = '';

  function renderPanel() {
    panelBody.replaceChildren();
    if (activePanel === 'nodes') return renderPalette();
    if (activePanel === 'variables') return renderVariables();
    if (activePanel === 'errors') {
      if (runs === null) loadRuns();
      return renderRuns();
    }
    panelBody.append(el('h3', 'bpanel-title', t('builder.rail.' + activePanel)), el('p', 'muted', t('builder.panel.soon')));
  }

  function renderPalette() {
    const pending = pendingNext && nodeById(pendingNext.node);
    if (pending) {
      const note = el('div', 'bpending');
      note.append(el('span', '', t('builder.pick_next', { node: nodeTitle(pending) })));
      const cancel = el('button', 'btn btn-sm', t('builder.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => { pendingNext = null; renderPanel(); });
      note.append(cancel);
      panelBody.append(note);
    }
    const input = el('input', 'sidebar-search bpanel-search');
    input.type = 'search';
    input.placeholder = t('builder.search_nodes_slash');
    input.value = search;
    const list = el('div', 'bpalette');
    input.addEventListener('input', () => { search = input.value.trim().toLowerCase(); renderPaletteList(list); });
    const tabs = el('div', 'btabs');
    for (const tab of TABS) {
      const b = el('button', 'btab', t('builder.tab.' + tab));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(tab === activeTab));
      b.addEventListener('click', () => { activeTab = tab; renderPanel(); });
      tabs.append(b);
    }
    panelBody.append(input, tabs, list);
    renderPaletteList(list);
  }

  // Favourite blocks: a per-browser convenience, so localStorage is fine.
  const FAV_KEY = 'bothub.builder.favourites';
  function favourites() {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
  }
  function saveFavourites(set) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch { /* storage blocked */ }
  }

  function renderPaletteList(list) {
    list.replaceChildren();
    const favs = favourites();
    const matches = defsList.filter((d) => !d.locked && d.palette !== false && !(isEvent && (d.category === 'option' || EVENT_HIDDEN.has(d.type))) && (search
      ? (t(d.labelKey) + ' ' + t(d.descriptionKey || '')).toLowerCase().includes(search)
      : d.category === activeTab)).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    const groups = new Map();
    const favItems = search ? [] : defsList.filter((d) => favs.has(d.type) && d.category === activeTab);
    if (favItems.length) groups.set('__fav', favItems);
    for (const d of matches) {
      const g = d.group || 'general';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    }
    for (const [g, items] of groups) {
      list.append(el('div', 'bpalette-group', g === '__fav' ? t('builder.favourites') : t('builder.group.' + g)));
      for (const d of items) {
        const item = el('button', `bpalette-item bnode-${d.category}${d.color ? ` bnode-color-${d.color}` : ''}`);
        item.type = 'button';
        item.draggable = true;
        item.append(el('span', 'bpalette-grip', '⠿'), el('span', 'bnode-icon', d.icon || '•'));
        const text = el('span', 'bnode-text');
        text.append(el('strong', '', t(d.labelKey)), el('span', '', t(d.descriptionKey || '')));
        const star = el('span', `bpalette-star${favs.has(d.type) ? ' is-on' : ''}`, '★');
        star.setAttribute('role', 'button');
        star.tabIndex = 0;
        star.title = t(favs.has(d.type) ? 'builder.unfavourite' : 'builder.favourite');
        star.setAttribute('aria-label', star.title);
        const toggleFav = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const f = favourites();
          if (f.has(d.type)) f.delete(d.type); else f.add(d.type);
          saveFavourites(f);
          renderPaletteList(list);
        };
        star.addEventListener('click', toggleFav);
        star.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggleFav(ev); });
        item.append(text, star);
        item.addEventListener('click', () => {
          const r = canvas.getBoundingClientRect();
          const c = toWorld(r.left + r.width / 2, r.top + r.height / 3);
          addNode(d.type, c.x - SIZE.normal.w / 2 + (Math.random() * 40 - 20), c.y + (Math.random() * 40 - 20));
        });
        item.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/bothub-node', d.type));
        list.append(item);
      }
    }
  }

  function renderVariables() {
    panelBody.append(el('h3', 'bpanel-title', t('builder.rail.variables')), el('p', 'hint', t('builder.variables.hint')));
    const vars = graph.nodes.filter((n) => n.config.variable);
    if (!vars.length) {
      panelBody.append(el('p', 'muted', t('builder.variables.empty')));
      return;
    }
    const list = el('div', 'bpalette');
    for (const n of vars) {
      const def = defs[n.type] || {};
      const item = el('button', `bpalette-item bnode-${def.category}`);
      item.type = 'button';
      item.append(el('span', 'bnode-icon', def.icon || '•'));
      const text = el('span', 'bnode-text');
      text.append(el('strong', 'mono', n.config.variable), el('span', '', t(def.labelKey)));
      item.append(text);
      item.addEventListener('click', () => { selected = { kind: 'node', id: n.id }; focusNode(n); render(); });
      list.append(item);
    }
    panelBody.append(list);
  }

  root.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => {
    activePanel = b.dataset.panel;
    root.querySelectorAll('[data-panel]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderPanel();
  }));

  // ---------- canvas interaction ----------

  let drag = null;

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.builder-zoom, .builder-sim')) return;
    const port = ev.target.closest('.bport-out');
    const nodeEl = ev.target.closest('.bnode');
    const edgeEl = ev.target.closest('[data-edge]');
    const delEl = ev.target.closest('[data-edge-del]');
    canvas.focus({ preventScroll: true });
    if (delEl) {
      graph.edges = graph.edges.filter((e) => edgeId(e) !== delEl.dataset.edgeDel);
      if (selected?.kind === 'edge') selected = null;
      commit();
      render();
      return;
    }
    if (port && !['branches', 'components'].includes(port.dataset.port)) {
      drag = { kind: 'wire', from: nodeById(port.closest('.bnode').dataset.node), port: port.dataset.port };
    } else if (nodeEl) {
      const node = nodeById(nodeEl.dataset.node);
      const w = toWorld(ev.clientX, ev.clientY);
      // Dragging a condition moves its states along.
      const group = [node, ...attachedTo(node)].map((n) => ({ n, dx: w.x - n.position.x, dy: w.y - n.position.y }));
      drag = { kind: 'node', group, moved: false };
      if (selected?.id !== node.id) { selected = { kind: 'node', id: node.id }; render(); }
    } else if (edgeEl) {
      selected = { kind: 'edge', id: edgeEl.dataset.edge };
      render();
      return;
    } else {
      drag = { kind: 'pan', sx: ev.clientX - view.x, sy: ev.clientY - view.y, moved: false, x0: ev.clientX, y0: ev.clientY };
    }
    canvas.setPointerCapture(ev.pointerId);
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      view.x = ev.clientX - drag.sx;
      view.y = ev.clientY - drag.sy;
      if (Math.abs(ev.clientX - drag.x0) + Math.abs(ev.clientY - drag.y0) > 3) drag.moved = true;
      applyView();
    } else if (drag.kind === 'node') {
      const w = toWorld(ev.clientX, ev.clientY);
      for (const g of drag.group) {
        g.n.position = { x: Math.round(w.x - g.dx), y: Math.round(w.y - g.dy) };
        const box = world.querySelector(`[data-node="${g.n.id}"]`);
        box.style.left = `${g.n.position.x}px`;
        box.style.top = `${g.n.position.y}px`;
      }
      drag.moved = true;
      renderEdges();
    } else if (drag.kind === 'wire') {
      const r = canvas.getBoundingClientRect();
      renderEdges({ a: toScreen(portPoint(drag.from, 'out', drag.port)), b: { x: ev.clientX - r.left, y: ev.clientY - r.top } });
    }
  });

  canvas.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'node' && d.moved) commit();
    if (d.kind === 'pan' && !d.moved && selected) { selected = null; render(); }
    if (d.kind === 'wire') {
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bnode');
      const to = target && nodeById(target.dataset.node);
      // Option wires end on the trigger; flow wires never end on a state,
      // a component, a menu's question, the trigger or an option.
      const optionWire = d.port === 'option';
      const ok = to && to !== d.from && (optionWire
        ? (defs[to.type]?.inputs || []).some((p) => p.name === 'options')
        : !isState(to) && defs[to.type]?.category !== 'component' && to.type !== 'condition.option' && (defs[to.type]?.inputs || []).some((p) => p.type === 'flow'));
      if (ok) {
        graph.edges = graph.edges.filter((e) => !(e.from.node === d.from.id && e.from.port === d.port));
        graph.edges.push({ from: { node: d.from.id, port: d.port }, to: { node: to.id, port: optionWire ? 'options' : 'in' } });
        commit();
      }
      renderEdges();
    }
  });

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  function zoomAt(clientX, clientY, factor) {
    const r = canvas.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const z = Math.min(2, Math.max(0.3, view.zoom * factor));
    view.x = px - ((px - view.x) * z) / view.zoom;
    view.y = py - ((py - view.y) * z) / view.zoom;
    view.zoom = z;
    applyView();
  }

  function fit() {
    if (!graph.nodes.length) return;
    const r = canvas.getBoundingClientRect();
    const minX = Math.min(...graph.nodes.map((n) => n.position.x)) - 60;
    const minY = Math.min(...graph.nodes.map((n) => n.position.y)) - 60;
    const maxX = Math.max(...graph.nodes.map((n) => n.position.x + size(n).w)) + 60;
    const maxY = Math.max(...graph.nodes.map((n) => n.position.y + size(n).h)) + 60;
    view.zoom = Math.min(1.2, Math.max(0.3, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    view.x = (r.width - (maxX - minX) * view.zoom) / 2 - minX * view.zoom;
    view.y = (r.height - (maxY - minY) * view.zoom) / 2 - minY * view.zoom;
    applyView();
  }

  function focusNode(node) {
    const r = canvas.getBoundingClientRect();
    view.x = r.width / 2 - (node.position.x + size(node).w / 2) * view.zoom;
    view.y = r.height / 3 - node.position.y * view.zoom;
    applyView();
  }

  canvas.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('text/bothub-node')) ev.preventDefault(); });
  canvas.addEventListener('drop', (ev) => {
    const type = ev.dataTransfer.getData('text/bothub-node');
    if (!type) return;
    ev.preventDefault();
    const w = toWorld(ev.clientX, ev.clientY);
    addNode(type, w.x - SIZE.normal.w / 2, w.y - SIZE.normal.h / 2);
  });

  // ---------- emoji picker (buttons, menu options) ----------
  const EMOJI_SETS = [
    ['smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😔 😢 😭 😤 😡 🤯 😳 🥺 😱 🤔 🤫 🙄 😴 🤤 😷 🤒 🤠 🤡 👻 💀 👽 🤖 💩 😺'],
    ['people', '👋 🤚 ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 👏 🙌 👐 🤝 🙏 ✍️ 💪 🧠 👀 👁️ 👅 👄 👶 🧑 👨 👩 🧓 👮 🕵️ 💂 🥷 👷 🤴 👸 🧙 🧚 🧛 🧜'],
    ['nature', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🦈 🐬 🐳 🌲 🌴 🌵 🌷 🌹 🌻 🍀 🍁 🍄 🌍 🌙 ⭐ 🌟 ☀️ ⛅ 🌈 ❄️ 🔥 💧 🌊'],
    ['food', '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🌽 🥕 🍞 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🍣 🍜 🍩 🍪 🎂 🍰 🍫 🍬 🍭 🍿 ☕ 🍵 🥤 🍺 🍷 🍹'],
    ['activities', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 ⛳ 🎣 🎿 🏂 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🧩'],
    ['travel', '🚗 🚕 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🏍️ 🚲 🛴 🚂 ✈️ 🚀 🛸 🚁 ⛵ 🚢 ⚓ 🗺️ 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🏖️ 🏝️ 🏔️ 🌋 🏠 🏢 🏥 🏦 🏫 ⛪ 🕌 ⛩️ 🌃 🌆 🌉'],
    ['objects', '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 🎥 📺 📻 ⏰ ⏳ 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 ⚒️ 🛠️ ⚙️ 🔩 🧲 🔫 💣 🔪 🛡️ 🔮 🧿 💈 🔭 🔬 💊 💉 🧬 🧹 🧺 🎁 🎈 🎉 🎊 ✉️ 📦 📝 📌 📎 🔒 🔓 🔑 🗝️ 📢 📣 🔔 🔕 📅 📊 📈 📉'],
    ['symbols', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ☮️ ✝️ ☪️ 🕉️ ☯️ ♈ ♉ ♊ ⛎ 🆔 ⚛️ ☢️ ☣️ ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❕ ❗ 〰️ ⚠️ 🚫 ⛔ 🔞 💯 🔅 🔆 🔱 ⚜️ 🔰 ♻️ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🔤 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ 🔀 🔁 🔂 ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ 🔄 🔃 🎵 🎶 💲 ©️ ®️ ™️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔶 🔷 🔸 🔹 🔺 🔻'],
    ['flags', '🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈 🏴‍☠️ 🇩🇪 🇦🇹 🇨🇭 🇬🇧 🇺🇸 🇫🇷 🇮🇹 🇪🇸 🇳🇱 🇵🇱 🇹🇷 🇺🇦 🇷🇺 🇯🇵 🇰🇷 🇨🇳 🇧🇷 🇨🇦 🇦🇺 🇪🇺'],
  ];

  function openEmojiPicker(anchor, onPick) {
    root.querySelector('.bemoji-pop')?.remove();
    const pop = el('div', 'bemoji-pop');
    pop.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); pop.remove(); } });
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (ev) => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) close(); };
    document.addEventListener('pointerdown', outside, true);
    const tabs = el('div', 'bemoji-tabs');
    const body = el('div', 'bemoji-body');
    const pick = (v) => { onPick(v); close(); };
    const showStandard = () => {
      body.replaceChildren();
      for (const [cat, list] of EMOJI_SETS) {
        body.append(el('div', 'bemoji-cat', t(`builder.emoji.cat.${cat}`)));
        const grid = el('div', 'bemoji-grid');
        for (const e of list.split(' ')) {
          const btn = el('button', 'bemoji-item', e);
          btn.type = 'button';
          btn.addEventListener('click', () => pick(e));
          grid.append(btn);
        }
        body.append(grid);
      }
    };
    const showServer = async () => {
      body.replaceChildren(el('p', 'bpick-status', t('builder.pick.loading')));
      let guilds;
      try {
        guilds = await load(guildsUrl());
      } catch {
        body.replaceChildren(el('p', 'bpick-status', t('builder.pick.load_failed')));
        return;
      }
      if (!guilds.length) {
        body.replaceChildren(el('p', 'bpick-status', t('builder.emoji.no_servers')));
        return;
      }
      const sel = el('select', 'bemoji-guild');
      for (const g of guilds) {
        const o = el('option', '', g.name);
        o.value = g.id;
        sel.append(o);
      }
      const grid = el('div', 'bemoji-grid');
      const fill = async () => {
        grid.replaceChildren(el('p', 'bpick-status', t('builder.pick.loading')));
        let items;
        try {
          items = await load(guildPart(sel.value, 'emojis'));
        } catch {
          grid.replaceChildren(el('p', 'bpick-status', t('builder.pick.load_failed')));
          return;
        }
        grid.replaceChildren();
        if (!items.length) grid.append(el('p', 'bpick-status', t('builder.emoji.none')));
        for (const e of items) {
          const btn = el('button', 'bemoji-item');
          btn.type = 'button';
          btn.title = `:${e.name}:`;
          const img = el('img');
          img.src = e.url;
          img.alt = e.name;
          img.loading = 'lazy';
          btn.append(img);
          btn.addEventListener('click', () => pick(e.text));
          grid.append(btn);
        }
      };
      sel.addEventListener('change', fill);
      body.replaceChildren(sel, grid);
      fill();
    };
    for (const [key, show] of [['standard', showStandard], ['server', showServer]]) {
      const tb = el('button', 'bemoji-tab', t(`builder.emoji.tab.${key}`));
      tb.type = 'button';
      tb.addEventListener('click', () => {
        tabs.querySelectorAll('.bemoji-tab').forEach((x) => x.classList.toggle('is-active', x === tb));
        show();
      });
      tabs.append(tb);
    }
    const clear = el('button', 'bemoji-tab bemoji-clear', t('builder.emoji.clear'));
    clear.type = 'button';
    clear.addEventListener('click', () => pick(''));
    tabs.append(clear);
    pop.append(tabs, body);
    anchor.append(pop);
    tabs.querySelector('.bemoji-tab').classList.add('is-active');
    showStandard();
  }

  // ---------- copy and paste blocks (Ctrl+C / Ctrl+V) ----------
  // The selected block with everything attached to it (states, buttons,
  // menu options) is copied. It is kept in this browser, so it pastes into
  // other commands and bots too; with "Copy blocks to the clipboard" on, it
  // also goes to the system clipboard as JSON (paste it anywhere, or into
  // BotHub on another computer).
  const CLIP_KEY = 'bothub.builder.clip';
  const SYS_KEY = 'bothub.builder.systemClipboard';
  const systemClipboard = () => { try { return localStorage.getItem(SYS_KEY) === '1'; } catch { return false; } };
  let lastPointer = null;
  canvas.addEventListener('pointermove', (ev) => { lastPointer = toWorld(ev.clientX, ev.clientY); });

  function copyBlocks() {
    let node = selected?.kind === 'node' ? nodeById(selected.id) : null;
    if (!node) return null;
    // A state or menu option is copied with the block it belongs to.
    if (isState(node) && parentOf(node)) node = parentOf(node);
    if (node.type === 'condition.option' && menuOf(node)) node = menuOf(node);
    if (defs[node.type]?.locked) return null;
    const nodes = [node, ...attachedTo(node)];
    const ids = new Set(nodes.map((n) => n.id));
    return {
      bothub: 'blocks',
      version: 1,
      nodes: structuredClone(nodes),
      edges: structuredClone(graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node))),
    };
  }

  function readBlocks(text) {
    try {
      const data = JSON.parse(text);
      return data?.bothub === 'blocks' && Array.isArray(data.nodes) && Array.isArray(data.edges) ? data : null;
    } catch {
      return null;
    }
  }

  function pasteBlocks(data) {
    const nodes = data.nodes.filter((n) => n && typeof n.type === 'string' && defs[n.type] && !defs[n.type].locked && n.position);
    if (!nodes.length) {
      toast(t('builder.clip.nothing'));
      return;
    }
    const left = Math.min(...nodes.map((n) => n.position.x));
    const top = Math.min(...nodes.map((n) => n.position.y));
    const at = lastPointer ?? { x: left + 40, y: top + 40 };
    const ids = new Map();
    const used = new Set(graph.nodes.map((n) => n.config?.variable).filter(Boolean));
    for (const n of nodes) {
      const copy = structuredClone(n);
      copy.id = newId(n.type);
      copy.typeVersion = defs[n.type].version;
      copy.config ??= {};
      copy.position = { x: Math.round(at.x + n.position.x - left), y: Math.round(at.y + n.position.y - top) };
      if (copy.config.variable && used.has(copy.config.variable)) copy.config.variable = newVariable();
      if (copy.config.variable) used.add(copy.config.variable);
      ids.set(n.id, copy.id);
      graph.nodes.push(copy);
    }
    for (const e of data.edges) {
      if (!ids.has(e?.from?.node) || !ids.has(e?.to?.node)) continue;
      graph.edges.push({ from: { node: ids.get(e.from.node), port: e.from.port }, to: { node: ids.get(e.to.node), port: e.to.port } });
    }
    // Pasted command options join this command's trigger, under a free name.
    const trig = trigger();
    for (const id of ids.values()) {
      const node = nodeById(id);
      if (defs[node.type].category !== 'option' || !trig) continue;
      const base = node.config.name || node.type.split('.').pop();
      node.config.name = ''; // not counted as taken by itself
      node.config.name = uniqueOptionName(base);
      graph.edges.push({ from: { node: id, port: 'option' }, to: { node: trig.id, port: 'options' } });
    }
    selected = { kind: 'node', id: ids.get(nodes[0].id) };
    commit();
    render();
    toast(nodes.length < data.nodes.length ? t('builder.clip.partly', { count: nodes.length }) : t('builder.clip.pasted', { count: nodes.length }));
  }

  const editing = (ev) => document.querySelector('.bform, .bmsg, .bsetup, .btop-pop') || ev.target.closest?.('input, textarea, select, [contenteditable="true"]');
  document.addEventListener('copy', (ev) => {
    if (editing(ev) || window.getSelection()?.toString()) return;
    const data = copyBlocks();
    if (!data) return;
    const text = JSON.stringify(data);
    try { localStorage.setItem(CLIP_KEY, text); } catch { /* storage blocked: system clipboard only */ }
    if (systemClipboard()) {
      ev.clipboardData.setData('text/plain', text);
      ev.preventDefault();
    }
    toast(t('builder.clip.copied', { count: data.nodes.length }));
  });
  document.addEventListener('paste', (ev) => {
    if (editing(ev)) return;
    let data = systemClipboard() ? readBlocks(ev.clipboardData?.getData('text/plain') || '') : null;
    if (!data) {
      try { data = readBlocks(localStorage.getItem(CLIP_KEY) || ''); } catch { data = null; }
    }
    if (!data) return;
    ev.preventDefault();
    pasteBlocks(data);
  });

  document.addEventListener('keydown', (ev) => {
    if (document.querySelector('.bform')) return; // form builder open
    const typing = ev.target.closest('input, textarea, select');
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    if (mod && k === 's') { ev.preventDefault(); save(); return; }
    if (mod && ev.shiftKey && k === 'f') { ev.preventDefault(); openSearch(); return; }
    if (!typing && ev.key === '/' && !mod) {
      ev.preventDefault();
      if (activePanel !== 'nodes') root.querySelector('[data-panel="nodes"]').click();
      panelBody.querySelector('.bpanel-search')?.focus();
      return;
    }
    if (typing) return;
    if (mod && k === 'z' && !ev.shiftKey) { ev.preventDefault(); if (historyAt > 0) restore(historyAt - 1); }
    else if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) { ev.preventDefault(); if (historyAt < history.length - 1) restore(historyAt + 1); }
    // Only on the canvas: Backspace on a button of a popup (emoji picker, settings) must not delete the block.
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && (ev.target === document.body || canvas.contains(ev.target)) && !ev.target.closest('.bemoji-pop, .bsearch')) removeSelected();
    else if (ev.key === 'Escape' && selected) { selected = null; render(); }
  });

  // ---------- canvas search (Ctrl+Shift+F): labels, types and notes ----------

  function openSearch() {
    let box = root.querySelector('.bsearch');
    if (box) { box.querySelector('input').focus(); return; }
    box = el('div', 'bsearch');
    const wrap = el('label', 'bpick-search');
    wrap.append(icon('search'));
    const input = el('input');
    input.type = 'search';
    input.placeholder = t('builder.search.placeholder');
    wrap.append(input);
    const list = el('div', 'bsearch-list');
    box.append(wrap, list);
    canvas.append(box);
    const closeSearch = () => box.remove();
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      list.replaceChildren();
      if (!q) return;
      const hits = graph.nodes.filter((n) => [nodeTitle(n), t(defs[n.type]?.labelKey || ''), n.note || '', n.config.variable || '']
        .some((x) => String(x).toLowerCase().includes(q))).slice(0, 12);
      if (!hits.length) list.append(el('p', 'bpick-status', t('builder.search.empty')));
      for (const n of hits) {
        const b = el('button', 'bsearch-item');
        b.type = 'button';
        b.append(el('strong', '', nodeTitle(n)));
        if (n.note) b.append(el('span', '', n.note));
        b.addEventListener('click', () => { selected = { kind: 'node', id: n.id }; focusNode(n); render(); closeSearch(); });
        list.append(b);
      }
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') closeSearch();
      if (ev.key === 'Enter') list.querySelector('.bsearch-item')?.click();
    });
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    input.focus();
  }

  // ---------- validation (is the logic complete?) ----------

  function validate() {
    const problems = [];
    const add = (text, node) => problems.push({ text, node: node?.id });
    const triggers = graph.nodes.filter((n) => defs[n.type]?.category === 'trigger');
    if (triggers.length !== 1) add(t('builder.test.no_trigger'));
    computeReach();
    const reach = reachable;
    const optionNames = new Set();
    for (const n of graph.nodes.filter(isOption)) {
      if (n.config.name && optionNames.has(n.config.name)) add(t('builder.test.option_name_taken', { name: n.config.name }), n);
      optionNames.add(n.config.name);
    }
    const unreachable = graph.nodes.filter((n) => !reach.has(n.id));
    if (unreachable.length) add(t('builder.test.unreachable', { count: unreachable.length }), unreachable[0]);
    const vars = new Map();
    for (const n of graph.nodes) {
      const v = n.config.variable;
      if (!v) continue;
      if (vars.has(v)) add(t('builder.test.duplicate_var', { name: v }), n);
      vars.set(v, n);
    }
    for (const n of graph.nodes) {
      const def = defs[n.type];
      if (!def) continue;
      const label = nodeTitle(n);
      if (isCondition(n) && statesOf(n).filter((s) => s.type === 'condition.else').length !== 1) add(t('builder.test.no_else', { node: label }), n);
      if (isState(n) && !parentOf(n)) add(t('builder.test.orphan_state'), n);
      for (const [key, schema] of Object.entries(def.config?.properties || {})) {
        if (schema['x-widget'] === 'permissions' && n.config[key] && !(n.config[key].allowed_roles || []).length) add(t('builder.test.nobody_allowed', { node: label }), n);
        if (schema['x-widget'] === 'form' && window.BotHubForm?.problems(n.config[key], t).length) add(t('builder.test.form_incomplete', { node: label }), n);
      }
      if (n.type === 'action.send_form' && n.config.form_name
        && graph.nodes.some((o) => o !== n && o.type === 'action.send_form' && o.config.form_name === n.config.form_name)) {
        add(t('builder.test.form_name_taken', { node: label, name: n.config.form_name }), n);
      }
      for (const key of def.config?.required || []) {
        if (n.config[key] === undefined || n.config[key] === '') add(t('builder.test.required', { node: label, field: t(def.config.properties[key]['x-labelKey']) }), n);
      }
      if (n.type === 'action.send_message' && !messageFilled(n)) add(t('builder.test.message_empty', { node: label }), n);
      if (defs[n.type]?.outputs?.some((p) => p.name === 'components')) {
        const comps = componentsOf(n);
        const rows = Math.ceil(comps.filter((c) => c.type === 'component.button').length / 5) + comps.filter((c) => c.type === 'component.select_menu').length;
        if (rows > 5) add(t('builder.test.too_many_rows', { node: label }), n);
      }
      if (n.type === 'component.button' && n.config.style === 'link' && !n.config.url) add(t('builder.test.button_url', { node: label }), n);
      if (n.type === 'component.select_menu' && !statesOf(optionConditionOf(n) || { id: '' }).some((st) => st.type === 'condition.state')) add(t('builder.test.menu_options', { node: label }), n);
      for (const [key, schema] of Object.entries(def.config?.properties || {})) {
        if (!isShown(n, schema)) continue;
        const v = n.config[key];
        const hint = schema['x-hintKey'];
        if (hint === 'builder.cfg.ref_hint' || hint === 'builder.cfg.ref_optional_hint') {
          if (!v && hint === 'builder.cfg.ref_optional_hint') continue;
          if (!v) add(t('builder.test.missing', { node: label, field: t(schema['x-labelKey']) }), n);
          else if (/^[A-Za-z][A-Za-z0-9_]*$/.test(v) && !vars.has(v)) add(t('builder.test.unknown_var', { node: label, name: v }), n);
        }
      }
    }
    return problems;
  }

  // ---------- save, autosave ----------

  function setDirty(v) {
    dirty = v;
    keepResume();
    if (!saving) setStatus(v ? 'unsaved' : 'saved');
  }

  function setStatus(state) {
    statusEl.textContent = t('builder.' + (state === 'failed' ? 'save_failed' : state));
    statusEl.dataset.state = state;
    root.querySelector('.autosave').dataset.state = state;
  }

  async function save() {
    if (saving) return false;
    clearTimeout(commitTimer);
    commit();
    saving = true;
    setStatus('saving');
    const name = (isEvent ? trigger()?.config.event_name : trigger()?.config.command_name) || meta.name;
    try {
      const res = await fetch(meta.saveUrl, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ name, description: trigger()?.config.description || '', enabled: meta.enabled, graph }),
      });
      saving = false;
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setStatus('failed');
        showSim([{ status: 'error', text: t(data?.error?.key || 'builder.save_failed') }], false);
        return false;
      }
      meta.name = name;
      savedSnapshot = JSON.stringify(graph);
      meta.updatedAt = new Date().toISOString();
      updateLastSaved();
      const title = root.querySelector('[data-command-name]');
      if (title) title.textContent = isEvent ? name : `/${name}`;
      dirty = false;
      setStatus('saved');
      return true;
    } catch {
      saving = false;
      setStatus('failed');
      return false;
    }
  }

  // Autosave every minute when something changed and the logic is complete.
  const AUTOSAVE_MS = 60000;
  const ring = root.querySelector('.autosave-ring');
  let nextAutosave = Date.now() + AUTOSAVE_MS;
  setInterval(async () => {
    const left = Math.max(0, nextAutosave - Date.now());
    ring.setAttribute('stroke-dashoffset', String((left / AUTOSAVE_MS) * 100));
    if (left > 0) return;
    nextAutosave = Date.now() + AUTOSAVE_MS;
    if (dirty && validate().length === 0) await save();
  }, 1000);

  window.addEventListener('beforeunload', (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });

  // ---------- test (simulation by the BotCore; mock for now) ----------

  function showSim(lines, running) {
    simBox.hidden = false;
    simBox.replaceChildren();
    const head = el('div', 'bsim-head');
    head.append(el('strong', '', t('builder.test.title')));
    const close = el('button', 'icon-btn icon-btn-plain', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('builder.close'));
    close.addEventListener('click', () => { simBox.hidden = true; clearHighlights(); });
    head.append(close);
    simBox.append(head);
    const list = el('ol', 'bsim-list');
    for (const l of lines) list.append(el('li', `bsim-${l.status}`, l.text));
    simBox.append(list);
    if (running) simBox.append(el('p', 'muted', t('builder.test.running')));
  }

  function clearHighlights() {
    world.querySelectorAll('.bnode').forEach((n) => n.classList.remove('sim-active', 'sim-ok', 'sim-error'));
  }

  let testing = false;
  async function test() {
    if (testing) return;
    const problems = validate();
    if (problems.length) {
      showSim(problems.map((p) => ({ status: 'error', text: p.text })), false);
      return;
    }
    testing = true;
    showSim([], true);
    let steps;
    try {
      const res = await fetch(meta.simulateUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ graph }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.key || 'builder.test.failed');
      steps = data.steps || [];
    } catch (err) {
      testing = false;
      showSim([{ status: 'error', text: t(err.message) }], false);
      return;
    }
    // Step by step: highlight each node and log its result.
    clearHighlights();
    const lines = [];
    for (const step of steps) {
      const box = world.querySelector(`[data-node="${step.node}"]`);
      box?.classList.add('sim-active');
      const node = nodeById(step.node);
      const def = node && defs[node.type];
      const label = def ? (def.compact ? stateLabel(node).join(' ') : t(def.labelKey)) : step.node;
      lines.push({ status: step.status, text: `${label}: ${t(step.key, step.params || {})}` });
      showSim(lines, true);
      await new Promise((r) => setTimeout(r, 650));
      box?.classList.remove('sim-active');
      box?.classList.add(step.status === 'error' ? 'sim-error' : 'sim-ok');
    }
    const failed = steps.some((s) => s.status === 'error');
    lines.push({ status: failed ? 'error' : 'ok', text: t(failed ? 'builder.test.result_error' : 'builder.test.ok') });
    showSim(lines, false);
    testing = false;
  }

  // ---------- playbacks (runs the bot recorded) ----------
  // The ⚠ rail panel lists the last runs of this command; opening one plays
  // it on the canvas block by block (step, speed), follows up to 4
  // variables, shows the reason and fix of a failed block, and the block's
  // settings with the values of that run under its settings.

  let runs = null;
  let openRun = null;
  let lastRun = null;
  let playAt = -1;
  let playTimer = null;
  let playSpeed = 1;
  const follow = [];
  const RUN_SPEEDS = [0.5, 1, 2, 4];

  async function getJSON(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.key || 'builder.runs.failed');
    return data;
  }

  async function loadRuns() {
    if (!meta.runsUrl) return;
    try {
      runs = (await getJSON(meta.runsUrl)).items || [];
    } catch {
      runs = [];
    }
    // The newest run fills "Last run values" under the block settings.
    if (runs.length && lastRun?.id !== runs[0].id) {
      lastRun = await getJSON(`${meta.runUrl}/${runs[0].id}`).catch(() => null);
      if (!openRun) renderInspector();
    }
    if (activePanel === 'errors') renderPanel();
  }

  async function openPlayback(id) {
    stopPlay();
    try {
      openRun = await getJSON(`${meta.runUrl}/${id}`);
    } catch (err) {
      toast(t(err.message));
      return;
    }
    playAt = -1;
    activePanel = 'errors';
    root.querySelectorAll('[data-panel]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.panel === 'errors')));
    renderPanel();
    render();
    const failed = openRun.error_node && nodeById(openRun.error_node);
    if (failed) focusNode(failed);
  }

  function closePlayback() {
    stopPlay();
    openRun = null;
    playAt = -1;
    renderPanel();
    render();
  }

  function runSteps() {
    return openRun?.steps || [];
  }

  // Variables after step i (-1 = at the start).
  function varsAt(i) {
    const v = { ...(openRun?.start_vars || {}) };
    const steps = runSteps();
    for (let k = 0; k <= i && k < steps.length; k++) Object.assign(v, steps[k].vars || {});
    return v;
  }

  function stepLabel(step) {
    const node = nodeById(step.node);
    const def = defs[step.type] || (node && defs[node.type]);
    if (node?.label) return node.label;
    if (def) return def.compact && node ? stateLabel(node).join(' ') : t(def.labelKey);
    return step.type || step.node;
  }

  function runHint(run) {
    const h = run?.error_hint;
    if (!h) return { text: run?.error_text || '', fix: '' };
    const local = (meta.runErrors || {})[h.key];
    const fill = (s) => String(s).replace(/\{([a-z]+)\}/g, (m, n) => (h.params && n in h.params ? h.params[n] : m));
    return local ? { text: fill(local.text), fix: fill(local.fix) } : { text: h.text, fix: h.fix };
  }

  function runWhen(run) {
    const d = new Date(run.time);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function stepTo(i) {
    const steps = runSteps();
    playAt = Math.max(-1, Math.min(steps.length - 1, i));
    decorateRun();
    renderPlaybackState();
    if (playAt >= 0) renderInspector();
  }

  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    root.querySelector('[data-run-play]')?.replaceChildren(document.createTextNode('▶'));
  }

  function togglePlay() {
    if (playTimer) return stopPlay();
    const steps = runSteps();
    if (!steps.length) return;
    if (playAt >= steps.length - 1) stepTo(-1);
    root.querySelector('[data-run-play]')?.replaceChildren(document.createTextNode('⏸'));
    playTimer = setInterval(() => {
      if (playAt >= runSteps().length - 1) return stopPlay();
      stepTo(playAt + 1);
    }, 700 / playSpeed);
  }

  // Canvas: blocks passed so far green/red, the current one yellow, the failed one with a tag.
  function decorateRun() {
    world.querySelectorAll('.bnode').forEach((n) => n.classList.remove('sim-active', 'sim-ok', 'sim-error', 'run-failed'));
    world.querySelectorAll('.brun-tag').forEach((n) => n.remove());
    if (!openRun) return;
    const steps = runSteps();
    const box = (id) => world.querySelector(`[data-node="${CSS.escape(id)}"]`);
    for (let k = 0; k <= playAt; k++) box(steps[k].node)?.classList.add(steps[k].status === 'error' ? 'sim-error' : 'sim-ok');
    if (playAt >= 0) box(steps[playAt].node)?.classList.add('sim-active');
    const showFail = playAt < 0 || playAt >= steps.length - 1;
    if (showFail && !openRun.ok && openRun.error_node) {
      const b = box(openRun.error_node);
      if (b) {
        b.classList.add('run-failed');
        b.append(el('span', `brun-tag${openRun.fixed ? ' brun-tag-fixed' : ''}`, openRun.fixed ? `✓ ${t('builder.runs.fixed')}` : t('builder.runs.failed_tag')));
      }
    }
  }

  // Updates the step list, the counter and the followed variables without rebuilding the panel.
  function renderPlaybackState() {
    const steps = runSteps();
    panelBody.querySelectorAll('[data-step]').forEach((li) => li.classList.toggle('brun-step-current', Number(li.dataset.step) === playAt));
    panelBody.querySelector('[data-step]')?.parentElement?.querySelector('.brun-step-current')?.scrollIntoView({ block: 'nearest' });
    const counter = panelBody.querySelector('[data-run-counter]');
    if (counter) counter.textContent = t('builder.runs.step_of', { n: String(playAt + 1), total: String(steps.length) });
    const fol = panelBody.querySelector('[data-run-follow]');
    if (fol) renderFollow(fol);
  }

  function renderFollow(box) {
    box.replaceChildren();
    const v = varsAt(playAt);
    for (const name of follow) {
      const chip = el('span', 'brun-follow-chip');
      chip.append(el('span', 'mono', name), el('strong', 'mono', name in v ? (v[name] === '' ? '""' : v[name]) : '—'));
      const x = el('button', 'icon-btn icon-btn-plain', '×');
      x.type = 'button';
      x.setAttribute('aria-label', t('builder.close'));
      x.addEventListener('click', () => { follow.splice(follow.indexOf(name), 1); renderFollow(box); });
      chip.append(x);
      box.append(chip);
    }
    if (follow.length < 4) {
      const pick = el('select', 'brun-follow-pick');
      pick.setAttribute('aria-label', t('builder.runs.follow'));
      pick.append(new Option(`+ ${t('builder.runs.follow')}`, ''));
      const names = Object.keys(varsAt(runSteps().length - 1)).filter((n) => !follow.includes(n)).sort();
      for (const n of names) pick.append(new Option(n, n));
      pick.addEventListener('change', () => {
        if (pick.value) follow.push(pick.value);
        renderFollow(box);
      });
      box.append(pick);
    }
  }

  function renderRuns() {
    panelBody.append(el('h3', 'bpanel-title', t('builder.rail.errors')));
    if (openRun) return renderPlayback();
    const head = el('div', 'brun-head');
    head.append(el('p', 'muted', t('builder.runs.hint')));
    const refresh = el('button', 'btn btn-sm', t('builder.runs.refresh'));
    refresh.type = 'button';
    refresh.addEventListener('click', () => { runs = null; renderPanel(); loadRuns(); });
    head.append(refresh);
    panelBody.append(head);
    if (runs === null) {
      panelBody.append(el('p', 'muted', t('builder.runs.loading')));
      return;
    }
    if (!runs.length) {
      panelBody.append(el('p', 'muted', t('builder.runs.empty')));
      return;
    }
    const list = el('ul', 'brun-list');
    for (const r of runs) {
      const item = el('li', `brun-item${r.ok ? '' : ' brun-item-error'}`);
      const b = el('button', 'brun-open');
      b.type = 'button';
      b.append(el('span', 'brun-icon', r.ok ? '✓' : '✗'));
      const txt = el('span', 'brun-text');
      txt.append(el('strong', '', runWhen(r)), el('span', 'muted', [r.user_name, t(`errors.source.${r.source || ''}`)].filter(Boolean).join(' · ')));
      if (!r.ok) txt.append(el('span', 'brun-reason', runHint(r).text || t('errors.unknown')));
      b.append(txt);
      if (r.fixed) b.append(el('span', 'brun-badge brun-badge-ok', t('builder.runs.fixed')));
      if (r.muted) b.append(el('span', 'brun-badge', '🔕'));
      b.addEventListener('click', () => openPlayback(r.id));
      item.append(b);
      list.append(item);
    }
    panelBody.append(list);
  }

  function renderPlayback() {
    const r = openRun;
    const back = el('button', 'btn btn-sm brun-back', `← ${t('builder.runs.all')}`);
    back.type = 'button';
    back.addEventListener('click', closePlayback);
    panelBody.append(back);
    const info = el('div', 'brun-info');
    info.append(el('strong', '', `${r.ok ? '✓' : '✗'} ${runWhen(r)}`));
    info.append(el('span', 'muted', [r.user_name && `👤 ${r.user_name}`, r.guild_name && `🏠 ${r.guild_name}`, r.channel_name && `#${r.channel_name}`, t(`errors.source.${r.source || ''}`)].filter(Boolean).join(' · ')));
    panelBody.append(info);

    if (!r.ok) {
      const h = runHint(r);
      const box = el('div', 'brun-error');
      const node = r.error_node && nodeById(r.error_node);
      box.append(el('strong', '', node ? t('builder.runs.block_failed', { block: stepLabel({ node: node.id, type: node.type }) }) : t('errors.unknown')));
      if (h.text) box.append(el('p', '', h.text));
      if (h.fix) box.append(el('p', 'brun-fix', `🔧 ${h.fix}`));
      if (r.error_text && r.error_text !== h.text) box.append(el('p', 'hint mono', r.error_text));
      if (r.fixed) box.append(el('p', 'brun-fixed', `✓ ${t('builder.runs.fixed_hint')}`));
      if (node) {
        const show = el('button', 'btn btn-sm', t('builder.runs.show_block'));
        show.type = 'button';
        show.addEventListener('click', () => { selected = { kind: 'node', id: node.id }; focusNode(node); render(); });
        box.append(show);
      }
      panelBody.append(box);
    }
    for (const w of r.warnings || []) {
      const node = nodeById(w.node);
      panelBody.append(el('p', 'brun-warning', `⚠ ${node ? stepLabel({ node: node.id, type: node.type }) + ': ' : ''}${w.text}`));
    }

    const controls = el('div', 'brun-controls');
    const btn = (label, title, fn, attr) => {
      const b = el('button', 'builder-icon-btn', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      if (attr) b.setAttribute(attr, '');
      b.addEventListener('click', fn);
      controls.append(b);
    };
    btn('⏮', t('builder.runs.start'), () => { stopPlay(); stepTo(-1); });
    btn('◀', t('builder.runs.prev'), () => { stopPlay(); stepTo(playAt - 1); });
    btn('▶', t('builder.runs.play'), togglePlay, 'data-run-play');
    btn('▶|', t('builder.runs.next'), () => { stopPlay(); stepTo(playAt + 1); });
    btn('⏭', t('builder.runs.end'), () => { stopPlay(); stepTo(runSteps().length - 1); });
    const speed = el('select', 'brun-speed');
    speed.setAttribute('aria-label', t('builder.runs.speed'));
    for (const s of RUN_SPEEDS) speed.append(new Option(`${s}×`, String(s), s === playSpeed, s === playSpeed));
    speed.addEventListener('change', () => {
      playSpeed = Number(speed.value) || 1;
      if (playTimer) { stopPlay(); togglePlay(); }
    });
    controls.append(speed);
    panelBody.append(controls);
    const counter = el('span', 'muted brun-counter', '');
    counter.setAttribute('data-run-counter', '');
    panelBody.append(counter);

    panelBody.append(el('h4', 'brun-sub', t('builder.runs.follow_title')));
    const fol = el('div', 'brun-follow');
    fol.setAttribute('data-run-follow', '');
    panelBody.append(fol);

    panelBody.append(el('h4', 'brun-sub', t('builder.runs.steps')));
    const list = el('ol', 'brun-steps');
    runSteps().forEach((s, i) => {
      const li = el('li', `brun-step brun-step-${s.status}`);
      li.dataset.step = String(i);
      const line = el('button', 'brun-step-btn');
      line.type = 'button';
      line.append(el('span', '', `${s.status === 'error' ? '✗' : '✓'} ${stepLabel(s)}`));
      if (typeof s.t === 'number') line.append(el('span', 'muted mono', `${s.t} ms`));
      line.addEventListener('click', () => { stopPlay(); stepTo(i); });
      li.append(line);
      if (s.log) li.append(el('div', 'brun-log mono', `📝 ${s.log}`));
      if (s.message && s.status === 'error') li.append(el('div', 'brun-msg', s.message));
      list.append(li);
    });
    panelBody.append(list);
    renderPlaybackState();
  }

  // "Last run values": the settings of the selected block as the run had them.
  function lastRunNote(node) {
    const run = openRun || lastRun;
    if (!run) return null;
    const steps = run.steps || [];
    let step = null;
    const upto = openRun && playAt >= 0 ? playAt : steps.length - 1;
    for (let k = upto; k >= 0; k--) if (steps[k]?.node === node.id) { step = steps[k]; break; }
    if (!step || (!step.values && !step.vars && !step.log)) return null;
    const box = el('div', `brun-note${step.status === 'error' ? ' brun-note-error' : ''}`);
    box.append(el('strong', '', `${t('builder.runs.last_values')} · ${runWhen(run)}`));
    const add = (k, v) => {
      const row = el('div', 'brun-note-row');
      row.append(el('span', 'muted', k), el('span', 'mono', v === '' ? '""' : v));
      box.append(row);
    };
    for (const [k, v] of Object.entries(step.values || {})) add(k, v);
    for (const [k, v] of Object.entries(step.vars || {})) add(`{${k}}`, v);
    if (step.log) add('📝', step.log);
    if (step.status === 'error' && step.message) add('✗', step.message);
    return box;
  }

  // ---------- top bar ----------

  let savedSnapshot = JSON.stringify(graph);

  function closeTopPops() { root.querySelectorAll('.btop-pop').forEach((p) => p.remove()); }
  function topPop(anchor, cls = '') {
    closeTopPops();
    const pop = el('div', `btop-pop ${cls}`);
    pop.setAttribute('role', 'dialog');
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    if (r.left > window.innerWidth / 2) pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    else pop.style.left = `${Math.max(8, r.left)}px`;
    pop.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    pop.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { closeTopPops(); anchor.focus(); } });
    root.append(pop);
    return pop;
  }
  document.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('.btop-pop, [data-top]')) closeTopPops(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && root.querySelector('.btop-pop')) { ev.stopPropagation(); closeTopPops(); } }, true);

  // Last saved: relative time, refreshed every 30 seconds.
  const lastSavedEl = root.querySelector('[data-last-saved]');
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' });
  function updateLastSaved() {
    if (!lastSavedEl) return;
    const at = meta.updatedAt ? new Date(meta.updatedAt) : null;
    if (!at || Number.isNaN(at.getTime())) { lastSavedEl.textContent = ''; return; }
    const secs = Math.round((at.getTime() - Date.now()) / 1000);
    const abs = Math.abs(secs);
    const rel = abs < 45 ? rtf.format(0, 'second') : abs < 3600 ? rtf.format(Math.round(secs / 60), 'minute')
      : abs < 86400 ? rtf.format(Math.round(secs / 3600), 'hour') : rtf.format(Math.round(secs / 86400), 'day');
    lastSavedEl.textContent = t('builder.last_saved', { when: rel });
    lastSavedEl.title = at.toLocaleString();
  }
  setInterval(updateLastSaved, 30000);

  // Problems: count in the button, list in a popover; a row jumps to its block.
  const problemsBtn = root.querySelector('[data-action="problems"]');
  let problemsTimer = null;
  function scheduleProblems() {
    clearTimeout(problemsTimer);
    problemsTimer = setTimeout(updateProblems, 300);
  }
  function updateProblems() {
    const n = validate().length;
    problemsBtn.dataset.count = String(n);
    problemsBtn.querySelector('[data-problems-count]').textContent = n ? String(n) : '✓';
    problemsBtn.classList.toggle('has-problems', n > 0);
  }
  // A node with a problem blinks its outline a few times (problems list).
  function blinkNodes(ids) {
    for (const id of new Set(ids.filter(Boolean))) {
      const box = world.querySelector(`[data-node="${id}"]`);
      if (!box) continue;
      box.classList.remove('bnode-blink');
      void box.offsetWidth; // restart the animation
      box.classList.add('bnode-blink');
      clearTimeout(box.blinkTimer);
      box.blinkTimer = setTimeout(() => box.classList.remove('bnode-blink'), 1900); // 3 × 0.6 s
    }
  }

  function openProblems(anchor) {
    const pop = topPop(anchor, 'btop-problems');
    const list = validate();
    blinkNodes(list.map((p) => p.node));
    pop.append(el('strong', '', t('builder.problems.title')), el('p', 'bfield-hint', t('builder.problems.hint')));
    if (!list.length) pop.append(el('p', 'bproblems-ok', t('builder.problems.none')));
    for (const p of list) {
      const row = el('button', 'bproblem');
      row.type = 'button';
      row.append(icon('alert'), el('span', '', p.text));
      row.disabled = !p.node;
      row.addEventListener('click', () => {
        const node = nodeById(p.node);
        if (!node) return;
        closeTopPops();
        selected = { kind: 'node', id: node.id };
        focusNode(node);
        render();
        blinkNodes([node.id]);
      });
      pop.append(row);
    }
  }

  function replaceGraph(next) {
    graph = next;
    graph.nodes.forEach((n) => { n.config = n.config || {}; n.position = n.position || { x: 0, y: 0 }; });
    selected = null;
    commit();
    render();
    fit();
  }

  function openImport(anchor) {
    const pop = topPop(anchor, 'btop-import');
    pop.append(el('strong', '', t(tk('builder.import.title'))), el('p', 'bfield-hint', t(tk('builder.import.hint'))));
    const area = el('textarea', 'mono');
    area.rows = 8;
    area.placeholder = '{ "schemaVersion": 1, "nodes": [], "edges": [] }';
    const err = el('p', 'bmsg-error');
    const go = el('button', 'btn btn-sm bform-primary', t('builder.import.apply'));
    go.type = 'button';
    go.addEventListener('click', () => {
      let data;
      try { data = JSON.parse(area.value); } catch { err.textContent = t('builder.import.invalid'); return; }
      const g = data?.graph || data;
      const ok = g && g.schemaVersion === 1 && Array.isArray(g.nodes) && Array.isArray(g.edges) && g.nodes.length <= 500
        && g.nodes.every((n) => n && typeof n.id === 'string' && defs[n.type]) && g.nodes.filter((n) => defs[n.type].category === 'trigger').length === 1;
      if (!ok) { err.textContent = t('builder.import.invalid'); return; }
      // Unique node IDs and edges between existing nodes and known ports.
      const ids = new Set(g.nodes.map((n) => n.id));
      const hasPort = (node, dir, port) => {
        const def = defs[node.type];
        if (dir === 'out') return outputsOf(node).some((p) => p.name === port) || (def.category === 'option' && port === 'option');
        return (def.inputs || []).some((p) => p.name === port);
      };
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const edgesOk = g.edges.length <= 2000 && g.edges.every((e) => e && e.from && e.to
        && byId.has(e.from.node) && byId.has(e.to.node) && hasPort(byId.get(e.from.node), 'out', e.from.port) && hasPort(byId.get(e.to.node), 'in', e.to.port));
      if (ids.size !== g.nodes.length || !edgesOk) { err.textContent = t('builder.import.broken'); return; }
      // The command keeps its own name and description (an event its name).
      const trig = g.nodes.find((n) => defs[n.type].category === 'trigger');
      if (trig.type !== trigger()?.type) { err.textContent = t(isEvent ? 'builder.import.not_event' : 'builder.import.not_command'); return; }
      trig.config = isEvent
        ? { ...(trig.config || {}), event_name: trigger()?.config.event_name }
        : { ...(trig.config || {}), command_name: trigger()?.config.command_name, description: trigger()?.config.description };
      if (!g.nodes.some((n) => n.type === 'utility.error_handler')) g.nodes.push({ id: 'error', type: 'utility.error_handler', typeVersion: 1, config: { variable: 'error' }, position: { x: (trig.position?.x ?? 120) + 320, y: trig.position?.y ?? 120 } });
      closeTopPops();
      replaceGraph(structuredClone(g));
      toast(t(tk('builder.import.done')));
    });
    pop.append(area, err, go);
    setTimeout(() => area.focus(), 0);
  }

  function openSettings(anchor) {
    const pop = topPop(anchor, 'btop-settings');
    pop.append(el('strong', '', t('builder.settings.title')));
    const row = el('label', 'bopt');
    const h = el('div', 'bopt-head');
    const tx = el('div', 'bopt-text');
    tx.append(el('strong', '', t('builder.settings.enabled')), el('span', '', t('builder.settings.enabled_hint')));
    const sw = el('input', 'toggle');
    sw.type = 'checkbox';
    sw.checked = Boolean(meta.enabled);
    sw.addEventListener('change', () => { meta.enabled = sw.checked; setDirty(true); });
    h.append(tx, sw);
    row.append(h);
    const share = el('button', 'btn btn-sm');
    share.type = 'button';
    share.append(icon('copy'), document.createTextNode(t('builder.settings.share')));
    share.addEventListener('click', () => copyText(JSON.stringify(graph), t('builder.settings.shared')));
    // Copy blocks to the system clipboard (a per-browser choice).
    const clipRow = el('label', 'bopt');
    const ch = el('div', 'bopt-head');
    const ct = el('div', 'bopt-text');
    ct.append(el('strong', '', t('builder.settings.clipboard')), el('span', '', t('builder.settings.clipboard_hint')));
    const cs = el('input', 'toggle');
    cs.type = 'checkbox';
    cs.checked = systemClipboard();
    cs.addEventListener('change', () => { try { localStorage.setItem(SYS_KEY, cs.checked ? '1' : '0'); } catch { /* storage blocked */ } });
    ch.append(ct, cs);
    clipRow.append(ch);
    pop.append(row, clipRow, el('p', 'bfield-hint', t('builder.settings.share_hint')), share);
  }

  async function openHistory(anchor) {
    const pop = topPop(anchor, 'btop-history');
    pop.append(el('strong', '', t('builder.history.title')), el('p', 'bfield-hint', t('builder.history.hint')));
    const list = el('div', 'bhistory');
    list.append(el('p', 'bpick-status', t('builder.pick.loading')));
    pop.append(list);
    let items;
    try {
      const res = await fetch(meta.versionsUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      items = (await res.json()).items || [];
    } catch {
      list.replaceChildren(el('p', 'bpick-status', t('builder.history.failed')));
      return;
    }
    list.replaceChildren();
    if (!items.length) list.append(el('p', 'bpick-status', t('builder.history.empty')));
    items.forEach((v, i) => {
      const row = el('div', 'bhistory-row');
      const tx = el('span', 'bhistory-text');
      tx.append(el('strong', '', new Date(v.savedAt).toLocaleString()), el('span', '', t(i === 0 ? 'builder.history.current' : 'builder.history.blocks', { count: v.nodes })));
      const load = el('button', 'btn btn-sm', t('builder.history.load'));
      load.type = 'button';
      load.disabled = i === 0 && !dirty;
      load.addEventListener('click', async () => {
        try {
          const res = await fetch(`${meta.versionsUrl}/${v.id}`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error();
          const data = await res.json();
          closeTopPops();
          replaceGraph(data.graph);
          toast(t('builder.history.loaded'));
        } catch {
          toast(t('builder.history.failed'));
        }
      });
      row.append(tx, load);
      list.append(row);
    });
  }

  function openDiscard(anchor) {
    const pop = topPop(anchor, 'btop-discard');
    pop.append(el('strong', '', t('builder.discard.title')), el('p', 'bfield-hint', t('builder.discard.hint')));
    const go = el('button', 'btn btn-sm btn-danger', t('builder.discard.confirm'));
    go.type = 'button';
    go.disabled = !dirty;
    go.addEventListener('click', () => {
      closeTopPops();
      graph = JSON.parse(savedSnapshot);
      history.splice(0, history.length, savedSnapshot);
      historyAt = 0;
      selected = null;
      render();
      updateUndo();
      setDirty(false);
      updateProblems();
    });
    const cancel = el('button', 'btn btn-sm', t('builder.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', closeTopPops);
    const actions = el('div', 'bpop-actions');
    actions.append(cancel, go);
    pop.append(actions);
  }

  // ---------- buttons ----------

  root.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    if (a === 'undo' && historyAt > 0) restore(historyAt - 1);
    if (a === 'redo' && historyAt < history.length - 1) restore(historyAt + 1);
    if (a === 'save') save();
    if (a === 'test') test();
    const btn = ev.target.closest('[data-action]');
    if (a === 'problems') openProblems(btn);
    if (a === 'import') openImport(btn);
    if (a === 'settings') openSettings(btn);
    if (a === 'history') openHistory(btn);
    if (a === 'discard') openDiscard(btn);
    if (a === 'zoom-in' || a === 'zoom-out') {
      const r = canvas.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, a === 'zoom-in' ? 1.2 : 1 / 1.2);
    }
    if (a === 'fit') fit();
  });

  root.querySelector('[data-builder-back]').addEventListener('click', (ev) => {
    if (dirty && !window.confirm(t('builder.leave_unsaved'))) ev.preventDefault();
    else dirty = false;
  });

  // Redraw edges whenever the canvas changes size (inspector opens, window resizes).
  new ResizeObserver(() => renderEdges()).observe(canvas);

  renderPanel();
  render();
  updateUndo();
  setStatus('saved');
  updateLastSaved();
  updateProblems();
  resumeWork();
  // Opened from the Errors page (?run=…): play that run; else load the runs for "Last run values".
  if (meta.openRun) openPlayback(meta.openRun);
  loadRuns();

  function resumeWork() {
    const r = readResume();
    if (!r) return;
    if (r.view && Number.isFinite(r.view.zoom)) {
      Object.assign(view, { x: Number(r.view.x) || 0, y: Number(r.view.y) || 0, zoom: Math.min(2, Math.max(0.3, r.view.zoom)) });
      applyView();
    }
    if (r.selected && exists(r.selected)) {
      selected = r.selected;
      render();
    }
    if (!r.graph || r.graph === savedSnapshot) return;
    // Unsaved changes of an earlier visit: offer them back.
    pendingDraft = r;
    const bar = el('div', 'bresume');
    bar.setAttribute('role', 'status');
    const text = el('span', '', t(r.base === savedSnapshot ? 'builder.resume.found' : 'builder.resume.found_changed', { time: new Date(r.at).toLocaleString() }));
    const take = el('button', 'btn btn-primary btn-sm', t('builder.resume.restore'));
    take.type = 'button';
    take.addEventListener('click', () => {
      bar.remove();
      pendingDraft = null;
      try {
        graph = JSON.parse(r.graph);
      } catch {
        return;
      }
      graph.nodes.forEach((n) => { n.config = n.config || {}; n.position = n.position || { x: 0, y: 0 }; });
      if (selected && !exists(selected)) selected = null;
      commit();
      render();
      updateProblems();
      toast(t('builder.resume.restored'));
    });
    const drop = el('button', 'btn btn-sm', t('builder.resume.discard'));
    drop.type = 'button';
    drop.addEventListener('click', () => { bar.remove(); pendingDraft = null; keepResume(); });
    bar.append(text, take, drop);
    root.append(bar);
  }

  // ---------- setup dialog for a new event ----------
  function openEventSetup() {
    const trig = trigger();
    if (!trig) return;
    const c = trig.config;
    const state = { name: c.event_name || '', event: c.event || '' };
    const overlay = el('div', 'bform');
    const dialog = el('div', 'bsetup');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('builder.event.setup_title'));
    overlay.append(dialog);
    root.append(overlay);
    const done = () => { overlay.remove(); window.history.replaceState(null, '', location.pathname); };
    overlay.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') done(); });
    const render = () => {
      dialog.replaceChildren();
      const head = el('div', 'bsetup-head');
      const hi = el('span', 'bsetup-icon', '📡');
      const ht = el('div', '');
      ht.append(el('strong', '', t('builder.event.setup_title')), el('span', 'bfield-hint', t('builder.event.setup_hint')));
      const x = el('button', 'bform-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', t('builder.close'));
      x.addEventListener('click', done);
      head.append(hi, ht, x);
      const bodyEl = el('div', 'bsetup-body form');
      bodyEl.append(el('div', 'bfield-label', t('builder.cfg.event_type')), eventCard(state.event, (k) => { state.event = k; render(); }));
      const nameLab = el('label', 'bfield');
      const nameIn = el('input');
      nameIn.maxLength = 100;
      nameIn.value = state.name;
      nameIn.placeholder = t('builder.event.name_placeholder');
      nameIn.addEventListener('input', () => { state.name = nameIn.value; });
      nameLab.append(el('span', 'bfield-label', t('builder.cfg.event_name')), nameIn, el('span', 'bfield-hint', t('builder.cfg.event_name_hint')));
      bodyEl.append(nameLab);
      const info = el('div', 'binfo');
      info.append(icon('info'), el('span', '', t('builder.event.setup_later')));
      const err = el('p', 'berror');
      err.hidden = true;
      bodyEl.append(info, err);
      const foot = el('div', 'bsetup-foot');
      const skip = el('button', 'btn', t('builder.setup.skip'));
      skip.type = 'button';
      skip.addEventListener('click', done);
      const start = el('button', 'btn bform-primary', `${t('builder.setup.start')} →`);
      start.type = 'button';
      start.addEventListener('click', () => {
        const fail = (key) => { err.hidden = false; err.replaceChildren(icon('alert'), document.createTextNode(t(key))); };
        if (!state.event) return fail('builder.event.type_needed');
        if (!state.name.trim()) return fail('builder.event.name_needed');
        c.event = state.event;
        c.event_name = state.name.trim();
        done();
        commit();
        selected = { kind: 'node', id: trig.id };
        refreshNode(trig);
        renderInspector();
        save();
      });
      foot.append(skip, start);
      dialog.append(head, bodyEl, foot);
      if (state.event) setTimeout(() => nameIn.focus(), 0);
    };
    render();
  }

  // ---------- setup dialog for a new command ----------
  function openSetup() {
    if (isEvent) return openEventSetup();
    const trig = trigger();
    if (!trig) return;
    const c = trig.config;
    const state = { type: c.command_type || 'slash', name: c.command_type && c.command_type !== 'slash' ? c.menu_name || '' : c.command_name || '', description: c.description || '', contexts: c.contexts || 'guild' };
    const overlay = el('div', 'bform');
    const dialog = el('div', 'bsetup');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('builder.setup.title'));
    overlay.append(dialog);
    root.append(overlay);
    const done = () => { overlay.remove(); window.history.replaceState(null, '', location.pathname); };
    overlay.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') done(); });
    const card = (group, value, titleKey, hintKey, iconName) => {
      const b = el('button', 'bsetup-card');
      b.type = 'button';
      b.dataset.group = group;
      b.setAttribute('aria-pressed', String(state[group] === value));
      const ic = el('span', 'bsetup-icon');
      ic.append(icon(iconName));
      const tx = el('span', 'bsetup-text');
      tx.append(el('strong', '', t(titleKey)), el('span', '', t(hintKey)));
      b.append(ic, tx);
      b.addEventListener('click', () => { state[group] = value; render(); });
      return b;
    };
    const render = () => {
      dialog.replaceChildren();
      const head = el('div', 'bsetup-head');
      const hi = el('span', 'bsetup-icon');
      hi.append(icon('edit'));
      const ht = el('div', '');
      ht.append(el('strong', '', t('builder.setup.title')), el('span', 'bfield-hint', t('builder.setup.hint')));
      const x = el('button', 'bform-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', t('builder.close'));
      x.addEventListener('click', done);
      head.append(hi, ht, x);
      dialog.append(head);
      const bodyEl = el('div', 'bsetup-body form');
      bodyEl.append(el('div', 'bfield-label', t('builder.setup.type')));
      const types = el('div', 'bsetup-cards is-three');
      types.append(card('type', 'slash', 'builder.setup.slash', 'builder.setup.slash_hint', 'code'), card('type', 'user', 'builder.setup.user', 'builder.setup.user_hint', 'user'),
        card('type', 'message', 'builder.setup.message', 'builder.setup.message_hint', 'message'));
      bodyEl.append(types);
      const nameLab = el('label', 'bfield');
      nameLab.append(el('span', 'bfield-label', t('builder.setup.trigger')));
      const nameRow = el('div', 'bsetup-name');
      if (state.type === 'slash') nameRow.append(el('span', 'mono', '/'));
      const nameIn = el('input', state.type === 'slash' ? 'mono' : '');
      nameIn.maxLength = state.type === 'slash' ? 98 : 32;
      nameIn.value = state.name;
      nameIn.placeholder = state.type === 'slash' ? 'ping' : 'Show profile';
      nameIn.addEventListener('input', () => { state.name = nameIn.value; });
      nameRow.append(nameIn);
      nameLab.append(nameRow, el('span', 'bfield-hint', t(state.type === 'slash' ? 'builder.setup.trigger_hint' : 'builder.setup.menu_hint')));
      bodyEl.append(nameLab);
      let descIn = null;
      if (state.type === 'slash') {
        const dl = el('label', 'bfield');
        descIn = el('input');
        descIn.maxLength = 100;
        descIn.value = state.description;
        descIn.placeholder = 'Replies with pong';
        descIn.addEventListener('input', () => { state.description = descIn.value; });
        dl.append(el('span', 'bfield-label', t('builder.setup.description')), descIn, el('span', 'bfield-hint', t('builder.setup.description_hint')));
        bodyEl.append(dl);
      }
      bodyEl.append(el('div', 'bfield-label', t('builder.setup.where')));
      const where = el('div', 'bsetup-cards');
      where.append(card('contexts', 'guild', 'builder.setup.guild', 'builder.setup.guild_hint', 'server'), card('contexts', 'guild_dm', 'builder.setup.guild_dm', 'builder.setup.guild_dm_hint', 'mail'));
      bodyEl.append(where);
      const info = el('div', 'binfo');
      info.append(icon('info'), el('span', '', t('builder.setup.later')));
      bodyEl.append(info);
      const err = el('p', 'berror');
      err.hidden = true;
      bodyEl.append(err);
      dialog.append(bodyEl);
      const foot = el('div', 'bsetup-foot');
      const skip = el('button', 'btn', t('builder.setup.skip'));
      skip.type = 'button';
      skip.addEventListener('click', done);
      const start = el('button', 'btn bform-primary', `${t('builder.setup.start')} →`);
      start.type = 'button';
      start.addEventListener('click', () => {
        const name = state.name.trim();
        const fail = (key) => { err.hidden = false; err.replaceChildren(icon('alert'), document.createTextNode(t(key))); };
        if (state.type === 'slash') {
          if (!/^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$/.test(name)) return fail('builder.setup.name_invalid');
          if (!state.description.trim()) return fail('builder.setup.description_needed');
          c.command_name = name;
          c.description = state.description.trim();
          delete c.menu_name;
        } else {
          if (!name) return fail('builder.setup.name_invalid');
          c.menu_name = name;
          c.command_name = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || c.command_name;
        }
        if (state.type === 'slash') delete c.command_type; else c.command_type = state.type;
        if (state.contexts === 'guild') delete c.contexts; else c.contexts = state.contexts;
        done();
        commit();
        renderAll();
        save();
      });
      foot.append(skip, start);
      dialog.append(foot);
      setTimeout(() => nameIn.focus(), 0);
    };
    const renderAll = () => { selected = { kind: 'node', id: trig.id }; refreshNode(trig); renderInspector(); };
    render();
  }
  if (new URLSearchParams(location.search).get('setup') === '1') openSetup();
  // Short address: /bots/builder/ (the dashboard remembers the open command for a reload).
  if (/\/builder\/\d+\/?$/.test(location.pathname)) window.history.replaceState(window.history.state, '', location.pathname.replace(/\/\d+\/?$/, '/'));
})();
