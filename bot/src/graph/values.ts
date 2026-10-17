// Value helpers of the object, list, maths and type blocks. Every value is
// text between blocks; objects and lists travel as JSON.

import { GraphError } from './interpreter.js';

export type ValueType = 'empty' | 'boolean' | 'number' | 'list' | 'object' | 'text';

/** What a text holds: empty, true/false, a number, a JSON list or object, or plain text. */
export function valueType(text: string): ValueType {
  const t = text.trim();
  if (t === '') return 'empty';
  if (t === 'true' || t === 'false') return 'boolean';
  if (Number.isFinite(Number(t))) return 'number';
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t);
      if (Array.isArray(v)) return 'list';
      if (v && typeof v === 'object') return 'object';
    } catch {
      // plain text with a bracket
    }
  }
  return 'text';
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A typed value from text: "auto" makes numbers, true/false and JSON of what looks like it. */
export function typedValue(text: string, type: string): Json {
  switch (type) {
    case 'text':
      return text;
    case 'number': {
      const n = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(n)) throw new GraphError('error.run.not_a_number', { field: 'value', value: text });
      return n;
    }
    case 'boolean':
      return /^(true|yes|1|on)$/i.test(text.trim());
    case 'json':
      try {
        return JSON.parse(text) as Json;
      } catch {
        throw new GraphError('error.run.bad_json', { value: text.slice(0, 100) });
      }
    default: {
      const kind = valueType(text);
      if (kind === 'number') return Number(text.trim());
      if (kind === 'boolean') return text.trim() === 'true';
      if (kind === 'list' || kind === 'object') return JSON.parse(text.trim()) as Json;
      return text;
    }
  }
}

/**
 * An object from text: JSON, or one "key: value" / "key = value" per line.
 * Empty text is an empty object.
 */
export function parseObject(text: string, lines = true): Record<string, Json> {
  const t = text.trim();
  if (t === '') return {};
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, Json>;
    } catch {
      // fall through to the error
    }
    throw new GraphError('error.run.bad_json', { value: t.slice(0, 100) });
  }
  if (!lines) throw new GraphError('error.run.bad_json', { value: t.slice(0, 100) });
  const out: Record<string, Json> = {};
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^\s*([^:=]+?)\s*[:=]\s*(.*)$/.exec(line);
    if (!m) throw new GraphError('error.run.bad_json', { value: line.slice(0, 100) });
    setPath(out, m[1]!, typedValue(m[2]!.trim(), 'auto'));
  }
  return out;
}

/** "a.b.0.c" to its parts. */
function pathParts(path: string): string[] {
  const parts = path.split('.').map((p) => p.trim());
  if (!path.trim() || parts.some((p) => p === '')) throw new GraphError('error.run.missing_value', { field: 'key' });
  if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) throw new GraphError('error.run.bad_json', { value: path });
  return parts;
}

function child(v: unknown, key: string): unknown {
  if (Array.isArray(v)) return /^\d+$/.test(key) ? v[Number(key)] : undefined;
  if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, key)) return (v as Record<string, unknown>)[key];
  return undefined;
}

export function getPath(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const p of pathParts(path)) {
    v = child(v, p);
    if (v === undefined) return undefined;
  }
  return v;
}

/** Sets a value; missing objects on the way are made. */
export function setPath(obj: Record<string, Json>, path: string, value: Json): void {
  const parts = pathParts(path);
  let v: Record<string, Json> | Json[] = obj;
  for (const p of parts.slice(0, -1)) {
    let next = child(v, p);
    if (!next || typeof next !== 'object') {
      next = {};
      if (Array.isArray(v)) {
        if (!/^\d+$/.test(p)) throw new GraphError('error.run.bad_json', { value: path });
        v[Number(p)] = next as Json;
      } else v[p] = next as Json;
    }
    v = next as Record<string, Json> | Json[];
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(v)) {
    if (!/^\d+$/.test(last) || Number(last) > 10_000) throw new GraphError('error.run.bad_json', { value: path });
    v[Number(last)] = value;
  } else v[last] = value;
}

/** Removes a value; false when there was none. */
export function removePath(obj: Record<string, Json>, path: string): boolean {
  const parts = pathParts(path);
  const parent = parts.length > 1 ? getPath(obj, parts.slice(0, -1).join('.')) : obj;
  const last = parts[parts.length - 1]!;
  if (Array.isArray(parent)) {
    if (!/^\d+$/.test(last) || Number(last) >= parent.length) return false;
    parent.splice(Number(last), 1);
    return true;
  }
  if (parent && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, last)) {
    delete (parent as Record<string, unknown>)[last];
    return true;
  }
  return false;
}

/** A value as block text: strings as they are, everything else as JSON. */
export function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** List items of a value: a JSON list, else one per line or comma; empty text is an empty list. */
export function listOf(text: string): string[] {
  const t = text.trim();
  if (t === '') return [];
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr)) return arr.map((v) => asText(v));
    } catch {
      // not JSON
    }
  }
  return (t.includes('\n') ? t.split(/\r?\n/) : t.split(',')).map((v) => v.trim()).filter((v) => v !== '');
}

// ---------- maths ----------

const FUNCS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log10,
  ln: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/**
 * A maths expression: numbers, + - * / % ^, brackets, the functions
 * above and pi / e. No variables: placeholders are filled before.
 */
export function calculate(text: string): number {
  const src = text.trim();
  const fail = () => new GraphError('error.run.bad_expression', { value: text.slice(0, 200) });
  const tokens = src.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[a-z]+|\*\*|[-+*/%^(),]|\S/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take();
      const r = unary();
      if ((op === '/' || op === '%') && r === 0) throw new GraphError('error.run.division_by_zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const unary = (): number => {
    if (peek() === '-') {
      take();
      return -unary();
    }
    if (peek() === '+') {
      take();
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (peek() === '^' || peek() === '**') {
      take();
      return base ** unary();
    }
    return base;
  };
  const atom = (): number => {
    const t = take();
    if (t === undefined) throw fail();
    if (t === '(') {
      const v = expr();
      if (take() !== ')') throw fail();
      return v;
    }
    if (/^[\d.]/.test(t)) return Number(t);
    const name = t.toLowerCase();
    if (CONSTS[name] !== undefined) return CONSTS[name]!;
    const fn = FUNCS[name];
    if (!fn || take() !== '(') throw fail();
    const args = [expr()];
    while (peek() === ',') {
      take();
      args.push(expr());
    }
    if (take() !== ')') throw fail();
    return fn(...args);
  };
  if (!tokens.length || tokens.length > 500) throw fail();
  const v = expr();
  if (i !== tokens.length || !Number.isFinite(v)) throw fail();
  return v;
}

/** A number with at most `decimals` places, without trailing zeros. */
export function roundTo(n: number, decimals: number | null): string {
  if (decimals === null) return String(Number(n.toPrecision(15)));
  return String(Number(n.toFixed(Math.max(0, Math.min(10, decimals)))));
}
