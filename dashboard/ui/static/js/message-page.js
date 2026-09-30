// Message Builder module page: opens the message editor (builder-message.js)
// for a new or a saved message. Saving goes through the API proxy; the list
// reloads itself on the event bothub:templates-changed.
(() => {
  'use strict';
  if (window.BotHubMessagePage) return;
  window.BotHubMessagePage = true;

  const island = (id) => {
    try {
      return JSON.parse(document.getElementById(id)?.textContent || 'null');
    } catch {
      return null;
    }
  };
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const icon = (name, cls = 'bicon') => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = window.BotHubIcons?.[name] || '';
    return svg;
  };
  const PLACEHOLDERS = ['server', 'server.id', 'server.members', 'members', 'channel', 'channel.id', 'bot.name', 'bot.id', 'bot.servers'];

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

  const tr = (key) => (island('msgb-texts') || {})[key] ?? key;

  function changed() {
    document.body.dispatchEvent(new CustomEvent('bothub:templates-changed', { bubbles: true }));
  }

  function openEditor(root, message, onDone) {
    const texts = island('msgb-texts') || {};
    const t = (key, params = {}) => String(texts[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m));
    let dirty = false;
    window.BotHubMessage.open({
      message, t, el, icon,
      variables: () => PLACEHOLDERS.map((p) => `{${p}}`),
      pickVariable: window.BotHubVarPicker ? (onPick) => window.BotHubVarPicker.open({
        t, el, icon, onPick,
        catalog: island('msgb-variables') || { categories: [] },
        graphVars: () => [],
        dataVarsUrl: root.dataset.dataVarsUrl,
      }) : undefined,
      components: () => [],
      bot: { name: root.dataset.botName || '', avatar: root.dataset.botAvatar || '' },
      templatesUrl: root.dataset.templatesUrl,
      csrf,
      copy: (text) => navigator.clipboard?.writeText(text),
      toast: (msg) => { const box = document.getElementById('msgb-error'); if (box) box.textContent = msg; },
      onChange: () => { dirty = true; },
      onClose: () => onDone(dirty),
    });
  }

  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-msgb-new], [data-msgb-edit]');
    if (!btn || !window.BotHubMessage) return;
    const root = btn.closest('[data-msgb]');
    const error = document.getElementById('msgb-error');
    if (error) error.textContent = '';
    try {
      if (btn.hasAttribute('data-msgb-new')) {
        const message = { mode: 'normal', content: '', embeds: [] };
        openEditor(root, message, () => {
          if (!window.BotHubMessage.hasBody(message)) return;
          // Name it: the dialog posts the message kept in its hidden field.
          const dialog = document.getElementById('msgb-name-dialog');
          dialog.querySelector('[name="message"]').value = JSON.stringify(message);
          dialog.showModal();
          dialog.querySelector('[name="name"]').focus();
        });
        return;
      }
      const url = `${root.dataset.templatesUrl}/${btn.dataset.msgbEdit}`;
      const tpl = await api('GET', url);
      openEditor(root, tpl.message, async (dirty) => {
        if (!dirty) return;
        try {
          await api('PUT', url, { message: tpl.message });
          changed();
        } catch (err) {
          if (error) error.textContent = tr(err.message);
        }
      });
    } catch (err) {
      if (error) error.textContent = tr(err.message);
    }
  });
})();
