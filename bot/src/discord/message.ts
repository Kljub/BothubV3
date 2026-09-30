// Message payloads from the message builder format (builder-message.js,
// toDiscord). Buttons and select menus are blocks on the canvas, plugged into
// the message block's "components" port. Every field is passed on; only
// empty ones are left out.

import type { Run } from '../graph/interpreter.js';
import type { GraphNode } from '../graph/types.js';

interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: string;
  author?: { name?: string; url?: string; icon_url?: string };
  fields?: { name?: string; value?: string; inline?: boolean }[];
  image_url?: string;
  thumbnail_url?: string;
  footer?: { text?: string; icon_url?: string };
  timestamp?: boolean;
}

interface BuilderMessage {
  mode?: 'normal' | 'v2';
  content?: string;
  embeds?: Embed[];
  accent?: string;
  components?: { type: 'text' | 'separator' | 'media'; content?: string; divider?: boolean; spacing?: string; urls?: string[] }[];
}

const STYLE: Record<string, number> = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

/** Removes undefined, empty strings and empty arrays (Discord rejects some). */
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}

function hexToInt(hex: string | undefined): number | undefined {
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined;
}

/** Discord payload for a message block. customId(node) names interactive components. */
export function buildMessage(run: Run, node: GraphNode, customId: (component: GraphNode) => string): Record<string, unknown> {
  const msg = (run.raw(node, 'message') ?? {}) as BuilderMessage;
  const r = (s: string | undefined) => (s ? run.render(s) : undefined);
  const rows = componentRows(run, node, customId);

  if (msg.mode === 'v2') {
    const inner = (msg.components ?? []).map((c) => {
      if (c.type === 'text') return { type: 10, content: r(c.content) ?? '' };
      if (c.type === 'separator') return { type: 14, divider: c.divider !== false, spacing: c.spacing === 'large' ? 2 : 1 };
      return { type: 12, items: (c.urls ?? []).map((url) => ({ media: { url: run.render(url) } })) };
    });
    return { flags: 32768, components: [clean({ type: 17, accent_color: hexToInt(msg.accent), components: [...inner, ...rows] })] };
  }

  return clean({
    content: r(msg.content),
    embeds: (msg.embeds ?? []).map((e) =>
      clean({
        title: r(e.title),
        url: r(e.url),
        description: r(e.description),
        color: hexToInt(e.color),
        author: e.author?.name ? clean({ name: run.render(e.author.name), url: r(e.author.url), icon_url: r(e.author.icon_url) }) : undefined,
        fields: (e.fields ?? []).filter((f) => f.name && f.value).map((f) => ({ name: run.render(f.name!), value: run.render(f.value!), inline: Boolean(f.inline) })),
        image: e.image_url ? { url: run.render(e.image_url) } : undefined,
        thumbnail: e.thumbnail_url ? { url: run.render(e.thumbnail_url) } : undefined,
        footer: e.footer?.text ? clean({ text: run.render(e.footer.text), icon_url: r(e.footer.icon_url) }) : undefined,
        timestamp: e.timestamp ? new Date().toISOString() : undefined,
      }),
    ),
    components: rows,
  });
}

/** Action rows: up to 5 buttons per row, one select menu per row. */
function componentRows(run: Run, node: GraphNode, customId: (component: GraphNode) => string): Record<string, unknown>[] {
  const parts = run.targets(node.id, 'components').sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
  const rows: Record<string, unknown>[] = [];
  const buttons = parts.filter((p) => p.type === 'component.button' && !p.disabled);
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(i, i + 5).map((b) => {
        const style = String(run.raw(b, 'style') ?? 'primary');
        return clean({
          type: 2,
          style: STYLE[style] ?? 1,
          label: run.str(b, 'label'),
          emoji: run.str(b, 'emoji') ? { name: run.str(b, 'emoji') } : undefined,
          url: style === 'link' ? run.str(b, 'url') : undefined,
          custom_id: style === 'link' ? undefined : customId(b),
          disabled: run.bool(b, 'disabled') || undefined,
        });
      }),
    });
  }
  for (const m of parts.filter((p) => p.type === 'component.select_menu' && !p.disabled)) {
    // The options are the states of the Select Menu Option block after it.
    const question = run.targets(m.id, 'next').find((n) => n.type === 'condition.option');
    const states = question ? run.targets(question.id, 'branches').filter((s) => s.type === 'condition.state') : [];
    rows.push({
      type: 1,
      components: [
        clean({
          type: 3,
          custom_id: customId(m),
          placeholder: run.str(m, 'placeholder'),
          min_values: Number(run.raw(m, 'min_values') ?? 1),
          max_values: Math.min(Number(run.raw(m, 'max_values') ?? 1), Math.max(states.length, 1)),
          disabled: run.bool(m, 'disabled') || undefined,
          options: states.slice(0, 25).map((s) =>
            clean({
              label: run.str(s, 'value').slice(0, 100) || '–',
              value: run.str(s, 'value').slice(0, 100) || s.id,
              description: run.str(s, 'option_description').slice(0, 100),
              emoji: run.str(s, 'option_emoji') ? { name: run.str(s, 'option_emoji') } : undefined,
            }),
          ),
        }),
      ],
    });
  }
  return rows;
}

/** Content check before sending: Discord refuses a message without a body. */
export function hasBody(payload: Record<string, unknown>): boolean {
  return Boolean(payload.content) || (Array.isArray(payload.embeds) && payload.embeds.length > 0) || (Array.isArray(payload.components) && payload.components.length > 0);
}
