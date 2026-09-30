// Blocks that need no Discord: variables, text, math, wait, loops, HTTP,
// notes, logs.

import { randomUUID, randomInt } from 'node:crypto';
import { request, parseHeaders } from './http.js';
import { GraphError, StopLoop, type Handler, type Run } from './interpreter.js';
import type { GraphNode } from './types.js';
import { parseDuration } from './util.js';
import type { DataContext, DataStore } from '../core/datastore.js';

export type Scope = 'run' | 'user' | 'server' | 'global';

/** Stored variables (table variables). The run scope stays in memory. */
export interface VarStore {
  get(scope: Exclude<Scope, 'run'>, scopeId: string, name: string): string | undefined;
  set(scope: Exclude<Scope, 'run'>, scopeId: string, name: string, value: string): void;
  delete(scope: Exclude<Scope, 'run'>, scopeId: string, name: string): void;
}

export interface CoreDeps {
  vars: VarStore;
  /** Error Log block: writes to the bot log in the dashboard. */
  logError(run: Run, text: string): void;
  /** Longest pause of a Wait block that keeps the run in memory. */
  maxPauseMs?: number;
  /** Reset Cooldown block: clears the cooldown of a command of this bot. */
  resetCooldown?(command: string, scopeKey: string): void;
  /** API Request block; tests replace it. */
  http?: typeof request;
  /** Data Storage variables ({var.<key>}); absent in tests without a database. */
  data?: DataStore;
}

/** Where a Data Storage value belongs: server, member and channel of the run. */
export function dataContext(run: Run): DataContext {
  return { guildId: run.vars.get('server.id') ?? '', userId: run.vars.get('user.id') ?? '', channelId: run.vars.get('channel.id') ?? '' };
}

/** "var.coins" -> "coins" for Data Storage variables, else undefined. */
function dataKey(deps: CoreDeps, name: string): string | undefined {
  return deps.data && name.startsWith('var.') ? name.slice(4) : undefined;
}

/** scope_id rules of the variables table. */
export function scopeId(run: Run, scope: Exclude<Scope, 'run'>): string {
  const guild = run.vars.get('server.id') ?? '';
  if (scope === 'global') return '';
  if (scope === 'server') return guild;
  return `${guild}:${run.vars.get('user.id') ?? ''}`;
}

/**
 * {local.NAME}: run variable, else user, else server scope.
 * {global.NAME}: global scope.
 */
export function lookupVariable(deps: CoreDeps, name: string, run: Run): string | undefined {
  const key = dataKey(deps, name);
  if (key !== undefined) return deps.data!.get(key, dataContext(run));
  if (name.startsWith('local.')) {
    const n = name.slice(6);
    return deps.vars.get('user', scopeId(run, 'user'), n) ?? deps.vars.get('server', scopeId(run, 'server'), n);
  }
  if (name.startsWith('global.')) return deps.vars.get('global', '', name.slice(7));
  return helperValue(name);
}

/**
 * Helper placeholders (shared/variables.json, category "time" and "helpers"):
 * {time.now}, {time.unix}, {time.in:2h}, {time.in_unix:30m}, {random:1-100}.
 * Unknown names give undefined, so the placeholder stays as written.
 */
export function helperValue(name: string, nowMs = Date.now()): string | undefined {
  const now = Math.floor(nowMs / 1000);
  if (name === 'time.now') return `<t:${now}:f>`;
  if (name === 'time.unix') return String(now);
  const ahead = /^time\.in(_unix)?:(\w+)$/.exec(name);
  if (ahead) {
    let ms: number;
    try {
      ms = parseDuration(ahead[2]!);
    } catch {
      return undefined;
    }
    const at = now + Math.floor(ms / 1000);
    return ahead[1] ? String(at) : `<t:${at}:f>`;
  }
  const random = /^random:(\d{1,9})-(\d{1,9})$/.exec(name);
  if (random) {
    const lo = Number(random[1]);
    const hi = Number(random[2]);
    if (hi < lo) return undefined;
    return String(randomInt(lo, hi + 1));
  }
  return undefined;
}

function varName(run: Run, node: GraphNode): string {
  const name = run.str(node, 'var_name').trim();
  if (!name || name.length > 64) throw new GraphError('error.run.bad_variable_name', { value: name });
  return name;
}

function scopeOf(run: Run, node: GraphNode): Scope {
  const s = String(run.raw(node, 'scope') ?? 'run');
  return s === 'user' || s === 'server' || s === 'global' ? s : 'run';
}

function readVar(deps: CoreDeps, run: Run, scope: Scope, name: string): string {
  const key = dataKey(deps, name);
  if (key !== undefined) return deps.data!.get(key, dataContext(run)) ?? '';
  if (scope === 'run') return run.vars.get(`local.${name}`) ?? '';
  return deps.vars.get(scope, scopeId(run, scope), name) ?? '';
}

function writeVar(deps: CoreDeps, run: Run, scope: Scope, name: string, value: string): void {
  const key = dataKey(deps, name);
  if (key !== undefined) return deps.data!.set(key, dataContext(run), value);
  if (value.length > 500) throw new GraphError('error.run.value_too_long', { max: 500 });
  if (scope === 'run') {
    run.vars.set(`local.${name}`, value);
    run.vars.set(name, value);
  } else {
    deps.vars.set(scope, scopeId(run, scope), name, value);
  }
}

function manipulate(run: Run, node: GraphNode): string {
  const input = run.str(node, 'input');
  const find = run.str(node, 'find');
  const op = String(run.raw(node, 'operation') ?? 'uppercase');
  const n = (key: string) => Number(run.str(node, key) || 0);
  switch (op) {
    case 'uppercase':
      return input.toUpperCase();
    case 'lowercase':
      return input.toLowerCase();
    case 'capitalize':
      return input.charAt(0).toUpperCase() + input.slice(1);
    case 'title_case':
      return input.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    case 'trim':
      return input.trim();
    case 'trim_start':
      return input.trimStart();
    case 'trim_end':
      return input.trimEnd();
    case 'replace':
      return input.replace(find, run.str(node, 'replace_with'));
    case 'replace_all':
      return input.split(find).join(run.str(node, 'replace_with'));
    case 'regex_replace':
      try {
        return input.replace(new RegExp(find, 'g'), run.str(node, 'replace_with'));
      } catch {
        throw new GraphError('error.run.bad_regex', { value: find });
      }
    case 'concat':
      return input + run.str(node, 'other');
    case 'pad_start':
      return input.padStart(Math.min(n('pad_length'), 2000), run.str(node, 'pad_with') || ' ');
    case 'pad_end':
      return input.padEnd(Math.min(n('pad_length'), 2000), run.str(node, 'pad_with') || ' ');
    case 'repeat':
      return input.repeat(Math.max(0, Math.min(n('times'), 100)));
    case 'reverse':
      return [...input].reverse().join('');
    case 'slugify':
      return input.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    case 'slice':
      return input.slice(n('start'), run.str(node, 'end') === '' ? undefined : n('end'));
    case 'substring':
      return input.substring(n('start'), run.str(node, 'end') === '' ? undefined : n('end'));
    case 'char_at':
      return input.charAt(n('start'));
    case 'split':
      return JSON.stringify(input.split(run.str(node, 'separator')));
    case 'match':
      try {
        return (input.match(new RegExp(find)) ?? [''])[0] ?? '';
      } catch {
        throw new GraphError('error.run.bad_regex', { value: find });
      }
    case 'length':
      return String([...input].length);
    case 'includes':
      return String(input.includes(find));
    case 'starts_with':
      return String(input.startsWith(find));
    case 'ends_with':
      return String(input.endsWith(find));
    case 'index_of':
      return String(input.indexOf(find));
    case 'last_index_of':
      return String(input.lastIndexOf(find));
    case 'search':
      return String(input.toLowerCase().indexOf(find.toLowerCase()));
    case 'url_encode':
      return encodeURIComponent(input);
    case 'url_decode':
      try {
        return decodeURIComponent(input);
      } catch {
        return input;
      }
    case 'base64_encode':
      return Buffer.from(input, 'utf8').toString('base64');
    case 'base64_decode':
      return Buffer.from(input, 'base64').toString('utf8');
    case 'json_stringify':
      return JSON.stringify(input);
    case 'sanitize':
      return input.replace(/[\\*_~`|>@#]/g, (c) => `\\${c}`);
    case 'unsanitize':
      return input.replace(/\\([\\*_~`|>@#])/g, '$1');
    default:
      throw new GraphError('error.run.unsupported_operation', { value: op });
  }
}

/** Items of a loop list: a JSON array, else one item per line or comma. */
export function loopItems(text: string): string[] {
  const t = text.trim();
  if (t === '') return [];
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr)) return arr.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    } catch {
      // not JSON: split below
    }
  }
  return (t.includes('\n') ? t.split(/\r?\n/) : t.split(',')).map((v) => v.trim()).filter((v) => v !== '');
}

/** command_cooldowns.scope_key, same rule as the slash trigger. */
function cooldownScope(run: Run, scope: string, user: string): string {
  const guild = run.vars.get('server.id') ?? '';
  if (scope === 'global') return '';
  if (scope === 'server') return `g:${guild}`;
  return `g:${guild}:u:${user}`;
}

/** Stores a JSON value as {Var.json}, {Var.json.a}, {Var.json.a.0}, … (depth 5, 200 keys). */
function setJson(run: Run, node: GraphNode, prefix: string, value: unknown, depth = 0, budget = { left: 200 }): void {
  if (budget.left-- <= 0) return;
  run.setResult(node, prefix, typeof value === 'string' ? value : JSON.stringify(value));
  if (depth >= 5 || value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) setJson(run, node, `${prefix}.${k}`, v, depth + 1, budget);
}

const MATH: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => {
    if (b === 0) throw new GraphError('error.run.division_by_zero');
    return a / b;
  },
  modulo: (a, b) => {
    if (b === 0) throw new GraphError('error.run.division_by_zero');
    return a % b;
  },
  power: (a, b) => a ** b,
  set: (_a, b) => b,
};

export function coreHandlers(deps: CoreDeps): Map<string, Handler> {
  const maxPause = deps.maxPauseMs ?? 15 * 60_000;
  const http = deps.http ?? request;
  return new Map<string, Handler>([
    [
      'action.run_loop',
      async (node, run) => {
        const max = run.engine.limits.maxLoopIterations;
        const byList = run.raw(node, 'loop') === 'list';
        const items = byList ? loopItems(run.str(node, 'list')) : [];
        const count = byList ? items.length : Math.floor(run.num(node, 'count'));
        if (count < 0) throw new GraphError('error.run.not_a_number', { field: 'count', value: String(count) });
        if (count > max) throw new GraphError('error.run.too_many_loop_rounds', { max });
        for (let i = 0; i < count; i++) {
          run.setResult(node, '', byList ? items[i] : String(i + 1));
          run.setResult(node, '.count', i + 1);
          run.setResult(node, '.index', i);
          run.setResult(node, '.first', i === 0);
          run.setResult(node, '.last', i === count - 1);
          if ((await run.branch(node.id, 'each')) === 'stop') break;
        }
      },
    ],
    [
      'action.stop_loop',
      () => {
        throw new StopLoop();
      },
    ],
    [
      'action.base64',
      (node, run) => {
        const input = run.str(node, 'input');
        if (run.raw(node, 'direction') === 'decode') {
          const clean = input.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
          if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new GraphError('error.run.not_base64');
          run.setResult(node, '', Buffer.from(clean, 'base64').toString('utf8'));
        } else {
          run.setResult(node, '', Buffer.from(input, 'utf8').toString('base64'));
        }
      },
    ],
    [
      'action.api_request',
      async (node, run) => {
        const method = String(run.raw(node, 'method') ?? 'GET').toUpperCase();
        const body = method === 'GET' || method === 'DELETE' ? undefined : run.str(node, 'body') || undefined;
        const headers = parseHeaders(run.str(node, 'headers'));
        if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain';
        }
        const res = await http(method, run.str(node, 'url').trim(), headers, body);
        run.setResult(node, '.status', res.status);
        run.setResult(node, '.body', res.body);
        try {
          setJson(run, node, '.json', JSON.parse(res.body));
        } catch {
          run.setResult(node, '.json', '');
        }
      },
    ],
    [
      'action.reset_cooldown',
      (node, run) => {
        if (!deps.resetCooldown) throw new GraphError('error.run.unsupported_block', { type: node.type });
        const command = run.str(node, 'command').trim().replace(/^\//, '') || (run.vars.get('command.name') ?? '');
        const scope = String(run.raw(node, 'cooldown_scope') ?? 'user');
        deps.resetCooldown(command, cooldownScope(run, scope, run.str(node, 'user').trim()));
      },
    ],
    ['action.note', () => undefined],
    ['action.error_log', (node, run) => deps.logError(run, run.str(node, 'content'))],
    ['action.set_variable', (node, run) => writeVar(deps, run, scopeOf(run, node), varName(run, node), run.str(node, 'value'))],
    [
      'action.delete_variable',
      (node, run) => {
        const scope = scopeOf(run, node);
        const name = varName(run, node);
        const key = dataKey(deps, name);
        if (key !== undefined) return deps.data!.delete(key, dataContext(run));
        if (scope === 'run') {
          run.vars.delete(`local.${name}`);
          run.vars.delete(name);
        } else {
          deps.vars.delete(scope, scopeId(run, scope), name);
        }
      },
    ],
    [
      'action.run_equation',
      (node, run) => {
        const scope = scopeOf(run, node);
        const name = varName(run, node);
        const op = MATH[String(run.raw(node, 'math') ?? 'add')];
        if (!op) throw new GraphError('error.run.unsupported_operation');
        const current = Number(readVar(deps, run, scope, name) || 0);
        const operand = run.num(node, 'operand');
        if (!Number.isFinite(current)) throw new GraphError('error.run.not_a_number', { field: name });
        const result = op(current, operand);
        if (!Number.isFinite(result)) throw new GraphError('error.run.not_a_number', { field: name });
        writeVar(deps, run, scope, name, String(result));
      },
    ],
    [
      'action.set_unique_variable',
      (node, run) => {
        const kind = run.raw(node, 'unique_kind');
        const value = kind === 'number' ? String(randomInt(100000, 999999999)) : kind === 'short' ? randomUUID().slice(0, 8) : randomUUID();
        run.setResult(node, '', value);
      },
    ],
    ['action.manipulate_text', (node, run) => run.setResult(node, '', manipulate(run, node))],
    [
      'action.wait',
      async (node, run) => {
        if (run.raw(node, 'wait_mode') === 'later') throw new GraphError('error.run.unsupported_block', { type: 'action.wait (later)' });
        const ms = parseDuration(run.str(node, 'duration'));
        if (ms > maxPause) throw new GraphError('error.run.wait_too_long', { max: '15m' });
        await run.pause(ms);
      },
    ],
  ]);
}
