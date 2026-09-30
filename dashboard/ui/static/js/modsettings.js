// Module settings forms (templates/partials/module_settings.html): fields
// with data-show-if='{"field": ["value", …]}' are shown only while another
// field of the same form has one of the values. Checkboxes count as
// "true"/"false".
(function () {
  'use strict';

  function valueOf(form, name) {
    const el = form.elements[name];
    if (!el) return null;
    if (el.type === 'checkbox') return String(el.checked);
    return el.value;
  }

  function apply(root) {
    root.querySelectorAll('[data-show-if]').forEach((el) => {
      let cond;
      try { cond = JSON.parse(el.dataset.showIf); } catch { return; }
      const form = el.closest('form');
      if (!form) return;
      el.hidden = !Object.entries(cond).every(([name, values]) => {
        const v = valueOf(form, name);
        return v === null || values.includes(v);
      });
    });
  }

  document.addEventListener('change', (ev) => {
    const form = ev.target.closest && ev.target.closest('.modset-form');
    if (form) apply(form);
  });
  document.addEventListener('htmx:afterSwap', (ev) => apply(ev.target));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(document));
  else apply(document);
})();
