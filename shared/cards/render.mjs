// Card renderer of the Card Designer. One file for both sides: the dashboard
// (Card Studio preview, browser canvas) and the bot (the PNG it posts,
// @napi-rs/canvas) draw with the same code, so the preview is the card.
//
// A design: { width, height, background, layers: [layer, …] } (see
// shared/cards/templates.json). Layers are drawn in order (first = bottom).
// Text fields may hold placeholders like {user.name}; fill() replaces them.

export const FONTS = [
  { family: 'Poppins', file: 'Poppins', weights: { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' } },
  { family: 'Bebas Neue', file: 'BebasNeue', weights: { 400: 'Regular' } },
  { family: 'Righteous', file: 'Righteous', weights: { 400: 'Regular' } },
  { family: 'Bangers', file: 'Bangers', weights: { 400: 'Regular' } },
  { family: 'Lobster', file: 'Lobster', weights: { 400: 'Regular' } },
  { family: 'Pacifico', file: 'Pacifico', weights: { 400: 'Regular' } },
  { family: 'Press Start 2P', file: 'PressStart2P', weights: { 400: 'Regular' } },
  { family: 'Space Mono', file: 'SpaceMono', weights: { 400: 'Regular', 700: 'Bold' } },
  { family: 'VT323', file: 'VT323', weights: { 400: 'Regular' } },
];

export const LAYER_TYPES = ['text', 'avatar', 'image', 'shape', 'badge', 'bar', 'grid'];
export const LIMITS = { minSize: 100, maxSize: 2048, maxLayers: 40, maxText: 300 };

/** The weight a font really has nearest to the wanted one. */
export function fontWeight(family, weight) {
  const f = FONTS.find((x) => x.family === family) ?? FONTS[0];
  const ws = Object.keys(f.weights).map(Number);
  return ws.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), ws[0]);
}

export function fontFamily(family) {
  return (FONTS.find((x) => x.family === family) ?? FONTS[0]).family;
}

/** {name} placeholders (also {name|short} and {name|commas}); unknown ones stay. */
export function fill(text, vars) {
  return String(text ?? '').replace(/\{([A-Za-z0-9_.]+)(\|(short|commas))?\}/g, (all, name, _p, fmt) => {
    if (!(name in vars)) return all;
    const v = String(vars[name]);
    const n = Number(v);
    if (fmt && v.trim() !== '' && Number.isFinite(n)) {
      if (fmt === 'commas') return Math.round(n).toLocaleString('en-US');
      const abs = Math.abs(n);
      const s = abs >= 1e9 ? [1e9, 'b'] : abs >= 1e6 ? [1e6, 'm'] : abs >= 1e3 ? [1e3, 'k'] : null;
      return s ? `${(n / s[0]).toFixed(1).replace(/\.0$/, '')}${s[1]}` : String(Math.round(n));
    }
    return v;
  });
}

const num = (v, min, max, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb;
};
const color = (v, fb) => (typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/.test(v.trim()) ? v.trim() : fb);

/** A design made safe: sizes in range, known layer types, at most 40 layers. */
export function normalize(design) {
  const d = design && typeof design === 'object' ? design : {};
  const width = Math.round(num(d.width, LIMITS.minSize, LIMITS.maxSize, 1024));
  const height = Math.round(num(d.height, LIMITS.minSize, LIMITS.maxSize, 500));
  const bg = d.background && typeof d.background === 'object' ? d.background : {};
  const layers = (Array.isArray(d.layers) ? d.layers : []).filter((l) => l && LAYER_TYPES.includes(l.type)).slice(0, LIMITS.maxLayers);
  return {
    width,
    height,
    background: {
      type: ['color', 'gradient', 'image'].includes(bg.type) ? bg.type : 'color',
      color: color(bg.color, '#23272a'),
      color2: color(bg.color2, '#5865f2'),
      angle: num(bg.angle, 0, 360, 135),
      image: typeof bg.image === 'string' ? bg.image.slice(0, 500) : '',
      dim: num(bg.dim, 0, 1, 0),
      radius: num(bg.radius, 0, 200, 0),
    },
    layers: layers.map((l, i) => ({
      ...l,
      id: typeof l.id === 'string' && l.id ? l.id.slice(0, 20) : `l${i}`,
      name: typeof l.name === 'string' ? l.name.slice(0, 40) : l.type,
      x: num(l.x, -width, width * 2, 0),
      y: num(l.y, -height, height * 2, 0),
      w: num(l.w, 1, width * 2, 100),
      h: num(l.h, 1, height * 2, 100),
      opacity: num(l.opacity, 0, 1, 1),
      visible: l.visible !== false,
    })),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shapePath(ctx, kind, x, y, w, h, r) {
  if (kind === 'circle') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
  } else if (kind === 'star') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rad = i % 2 ? 0.45 : 1;
      ctx.lineTo(cx + Math.cos(a) * (w / 2) * rad, cy + Math.sin(a) * (h / 2) * rad);
    }
    ctx.closePath();
  } else roundRect(ctx, x, y, w, h, r);
}

function paint(ctx, l, x, y, w, h) {
  if (l.fillType === 'gradient') {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, color(l.fill, '#5865f2'));
    g.addColorStop(1, color(l.fill2, '#eb459e'));
    return g;
  }
  return color(l.fill, '#5865f2');
}

/** Cover or contain an image into a box. */
function drawImageFit(ctx, img, x, y, w, h, fit) {
  const iw = img.width || img.naturalWidth || 1;
  const ih = img.height || img.naturalHeight || 1;
  const s = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Text in a box: shrink to fit (one line) or wrap; returns nothing. */
function drawText(ctx, l, text, x, y, w, h) {
  const family = fontFamily(l.font);
  const weight = fontWeight(family, num(l.weight, 100, 900, 700));
  let size = num(l.size, 6, 400, 48);
  const spacing = num(l.letterSpacing, -20, 50, 0);
  const setFont = () => {
    ctx.font = `${weight} ${size}px "${family}"`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  };
  setFont();
  const align = ['left', 'center', 'right'].includes(l.align) ? l.align : 'center';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const ax = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;
  let lines = [text];
  if (l.wrap) {
    lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const t = line ? `${line} ${word}` : word;
        if (ctx.measureText(t).width > w && line) {
          lines.push(line);
          line = word;
        } else line = t;
      }
      lines.push(line);
    }
    while (l.shrink !== false && size > 8 && lines.length * size * 1.2 > h) {
      size -= 2;
      setFont();
    }
  } else if (l.shrink !== false) {
    while (size > 8 && ctx.measureText(text).width > w) {
      size -= 1;
      setFont();
    }
  }
  if (l.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.round(size / 6);
    ctx.shadowOffsetY = Math.round(size / 14);
  }
  if (l.fillType === 'gradient') {
    const g = ctx.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, color(l.color, '#ffffff'));
    g.addColorStop(1, color(l.color2, '#a78bfa'));
    ctx.fillStyle = g;
  } else ctx.fillStyle = color(l.color, '#ffffff');
  const lh = size * 1.2;
  const top = y + h / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((line, i) => ctx.fillText(line, ax, top + i * lh));
  ctx.shadowColor = 'transparent';
}

/**
 * Draws a design on a 2D context of design.width × design.height.
 * opts.vars: placeholder values; opts.loadImage(url) → image or null (each
 * side loads pictures its own way; failures leave the spot empty).
 */
export async function drawCard(ctx, design, opts = {}) {
  const d = normalize(design);
  const vars = opts.vars ?? {};
  const load = async (url) => {
    const u = fill(url, vars).trim();
    if (!/^https:\/\//.test(u) && !/^data:image\//.test(u) && !/^\//.test(u) && !/^asset:\d+$/.test(u)) return null;
    try {
      return (await opts.loadImage?.(u)) ?? null;
    } catch {
      return null;
    }
  };
  const W = d.width;
  const H = d.height;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  // Background
  ctx.save();
  roundRect(ctx, 0, 0, W, H, d.background.radius);
  ctx.clip();
  if (d.background.type === 'gradient') {
    const a = (d.background.angle * Math.PI) / 180;
    const dx = (Math.cos(a) * W) / 2;
    const dy = (Math.sin(a) * H) / 2;
    const g = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
    g.addColorStop(0, d.background.color);
    g.addColorStop(1, d.background.color2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = d.background.color;
    ctx.fillRect(0, 0, W, H);
    if (d.background.type === 'image' && d.background.image) {
      const img = await load(d.background.image);
      if (img) drawImageFit(ctx, img, 0, 0, W, H, 'cover');
    }
  }
  if (d.background.dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${d.background.dim})`;
    ctx.fillRect(0, 0, W, H);
  }
  // Layers
  for (const l of d.layers) {
    if (!l.visible) continue;
    const { x, y, w, h } = l;
    ctx.save();
    ctx.globalAlpha = l.opacity;
    if (l.rotation) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((num(l.rotation, -360, 360, 0) * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }
    if (l.type === 'text') {
      drawText(ctx, l, fill(l.text, vars).slice(0, LIMITS.maxText), x, y, w, h);
    } else if (l.type === 'shape') {
      shapePath(ctx, l.shape, x, y, w, h, num(l.radius, 0, 1000, 0));
      if (l.fillType !== 'none') {
        ctx.fillStyle = paint(ctx, l, x, y, w, h);
        ctx.fill();
      }
      const sw = num(l.strokeWidth, 0, 50, 0);
      if (sw > 0) {
        ctx.lineWidth = sw;
        ctx.strokeStyle = color(l.stroke, '#ffffff');
        ctx.stroke();
      }
    } else if (l.type === 'avatar' || l.type === 'image') {
      const url = l.type === 'avatar' ? (l.source === 'second' ? '{second.avatar}' : '{user.avatar}') : l.url;
      const radius = l.type === 'avatar' && l.shape !== 'square' && l.shape !== 'rounded' ? Math.min(w, h) / 2 : num(l.radius, 0, 1000, l.shape === 'rounded' ? 24 : 0);
      ctx.save();
      shapePath(ctx, l.type === 'avatar' && l.shape !== 'square' && l.shape !== 'rounded' ? 'circle' : 'rect', x, y, w, h, radius);
      ctx.clip();
      const img = await load(url);
      if (img) drawImageFit(ctx, img, x, y, w, h, l.fit === 'contain' ? 'contain' : 'cover');
      else {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, y, w, h);
        if (l.type === 'avatar') {
          ctx.fillStyle = '#ffffff';
          ctx.font = `700 ${Math.round(Math.min(w, h) * 0.45)}px "Poppins"`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(fill('{user.name}', vars).slice(0, 1).toUpperCase() || '?', x + w / 2, y + h / 2);
        }
      }
      ctx.restore();
      const bw = num(l.borderWidth, 0, 50, 0);
      if (bw > 0) {
        shapePath(ctx, l.type === 'avatar' && l.shape !== 'square' && l.shape !== 'rounded' ? 'circle' : 'rect', x, y, w, h, radius);
        ctx.lineWidth = bw;
        ctx.strokeStyle = color(l.borderColor, '#ffffff');
        ctx.stroke();
      }
    } else if (l.type === 'badge') {
      roundRect(ctx, x, y, w, h, h / 2);
      ctx.fillStyle = color(l.fill, '#5865f2');
      ctx.fill();
      drawText(ctx, { ...l, align: 'center', wrap: false, shrink: true, size: l.size ?? Math.round(h * 0.5), fillType: 'color' }, fill(l.text, vars).slice(0, 60), x + h / 3, y, w - (2 * h) / 3, h);
    } else if (l.type === 'grid') {
      // Rows from the text (one per line), cells split by " | " (e.g. a leaderboard variable).
      const rows = fill(l.text, vars).split('\n').map((r) => r.split(' | ')).filter((r) => r.join('').trim() !== '').slice(0, 25);
      if (rows.length) {
        const cols = Math.max(...rows.map((r) => r.length));
        const rh = h / rows.length;
        rows.forEach((row, i) => {
          if (l.stripes !== false && i % 2 === 1) {
            ctx.fillStyle = color(l.stripe, 'rgba(255,255,255,0.06)');
            ctx.fillRect(x, y + i * rh, w, rh);
          }
          row.forEach((cell, c) => {
            const head = l.header && i === 0;
            drawText(ctx, { ...l, weight: head ? 800 : l.weight ?? 500, size: l.size ?? Math.round(rh * 0.5), align: c === 0 ? 'left' : c === cols - 1 ? 'right' : 'center', wrap: false, color: head ? color(l.headColor, '#a78bfa') : l.color },
              cell.trim(), x + (c * w) / cols + 10, y + i * rh, w / cols - 20, rh);
          });
        });
      }
    } else if (l.type === 'bar') {
      const value = num(fill(l.value, vars), 0, 100, 0);
      const r = num(l.radius, 0, 1000, h / 2);
      roundRect(ctx, x, y, w, h, r);
      ctx.fillStyle = color(l.track, 'rgba(255,255,255,0.15)');
      ctx.fill();
      if (value > 0) {
        roundRect(ctx, x, y, Math.max(h, (w * value) / 100), h, r);
        ctx.fillStyle = paint(ctx, l, x, y, w, h);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Sample values for previews and test sends. */
export const SAMPLE_VARS = {
  user: 'Tom', 'user.name': 'tom', 'user.display': 'Tom', 'user.id': '200000000000000001', 'user.mention': '@Tom', 'user.avatar': '',
  server: 'My Server', 'server.id': '100000000000000001', members: '1204', 'member.number': '1204', 'member.ordinal': '1204th',
  'user.created.ago': '3 years ago', 'account.days': '1100', 'member.days': '0',
  'second.name': 'Anna', 'second.avatar': '', level: '12', xp: '3400', 'xp.next': '5000', 'level.progress': '68', rank: '4',
  boosts: '7', milestone: '1200',
  leaderboard: '#1 | Anna | 12,400\n#2 | Tom | 9,800\n#3 | Max | 7,150',
};
