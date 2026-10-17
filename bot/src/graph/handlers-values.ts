// Blocks without Discord for values: objects, dates, maths, value types and
// the variable blocks that read, change or clear stored values.

import { GraphError, type Handler, type Run } from './interpreter.js';
import type { GraphNode } from './types.js';
import { readVar, scopeOf, setJson, targetUser, varName, writeVar, type CoreDeps } from './handlers-core.js';
import { asText, calculate, getPath, listOf, parseObject, removePath, roundTo, setPath, typedValue, valueType } from './values.js';
import { dateParts, dayName, dayOfYear, formatDate, isoWeek, langOf, monthName, parseDateTime, signedDuration, timeAgo, zonedTime, zoneOf } from './dates.js';

/** Stores an object as {Var} (JSON) and its keys as {Var.key}. */
function setObject(run: Run, node: GraphNode, obj: unknown): void {
  const json = JSON.stringify(obj);
  if (json.length > 4000) throw new GraphError('error.run.value_too_long', { max: 4000 });
  setJson(run, node, '', obj);
}

function objectOf(run: Run, node: GraphNode): Record<string, ReturnType<typeof typedValue>> {
  return parseObject(run.str(node, 'object'), false);
}

/** The date of a block's "date" field (now when empty). */
function dateOf(run: Run, node: GraphNode, key = 'date'): number {
  const text = run.str(node, key).trim();
  return text ? parseDateTime(text, run.str(node, 'timezone')) : Date.now();
}

export function valueHandlers(deps: CoreDeps): [string, Handler][] {
  return [
    // ---------- objects ----------
    ['action.create_object', (node, run) => setObject(run, node, parseObject(run.str(node, 'properties')))],
    ['action.text_to_object', (node, run) => setObject(run, node, parseObject(run.str(node, 'input')))],
    [
      'action.object_add_property',
      (node, run) => {
        const obj = objectOf(run, node);
        setPath(obj, run.str(node, 'key'), typedValue(run.str(node, 'value'), String(run.raw(node, 'value_type') ?? 'auto')));
        setObject(run, node, obj);
      },
    ],
    [
      'action.object_remove_property',
      (node, run) => {
        const obj = objectOf(run, node);
        removePath(obj, run.str(node, 'key'));
        setObject(run, node, obj);
      },
    ],
    [
      'action.object_get_property',
      (node, run) => {
        const v = getPath(objectOf(run, node), run.str(node, 'key'));
        if (v !== null && typeof v === 'object') setJson(run, node, '', v);
        else run.setResult(node, '', asText(v));
        run.setResult(node, '.exists', v === undefined ? 'false' : 'true');
        run.setResult(node, '.type', v === undefined ? 'empty' : valueType(asText(v)));
      },
    ],
    [
      'action.object_info',
      (node, run) => {
        const obj = objectOf(run, node);
        const keys = Object.keys(obj);
        run.setResult(node, '', JSON.stringify(obj, null, 2).slice(0, 4000));
        run.setResult(node, '.keys', keys.join(', '));
        run.setResult(node, '.count', keys.length);
        run.setResult(node, '.values', keys.map((k) => asText(obj[k])).join(', ').slice(0, 4000));
        run.setResult(node, '.json', JSON.stringify(obj));
      },
    ],

    // ---------- dates ----------
    [
      'action.create_date',
      (node, run) => {
        const tz = run.str(node, 'timezone');
        const mode = String(run.raw(node, 'date_mode') ?? 'now');
        let ms: number;
        if (mode === 'text') ms = parseDateTime(run.str(node, 'date'), tz);
        else if (mode === 'parts') {
          const part = (key: string, min: number, max: number, fallback: number) => {
            const t = run.str(node, key).trim();
            if (t === '') return fallback;
            const n = Number(t);
            if (!Number.isInteger(n) || n < min || n > max) throw new GraphError('error.run.bad_date', { value: `${key}=${t}` });
            return n;
          };
          const now = dateParts(Date.now(), tz);
          const [y, mo, d] = [part('year', 1970, 9999, now.year), part('month', 1, 12, now.month), part('day', 1, 31, now.day)];
          if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) throw new GraphError('error.run.bad_date', { value: `${y}-${mo}-${d}` });
          ms = zonedTime(y, mo, d, part('hour', 0, 23, 0), part('minute', 0, 59, 0), part('second', 0, 59, 0), tz);
        } else ms = Date.now();
        ms += signedDuration(run.str(node, 'add'));
        const unix = Math.floor(ms / 1000);
        run.setResult(node, '', unix);
        run.setResult(node, '.unix', unix);
        run.setResult(node, '.iso', new Date(ms).toISOString());
        run.setResult(node, '.discord', `<t:${unix}:f>`);
        run.setResult(node, '.relative', `<t:${unix}:R>`);
      },
    ],
    [
      'action.format_date',
      (node, run) => {
        const ms = dateOf(run, node);
        run.setResult(node, '', formatDate(ms, String(run.raw(node, 'date_format') ?? 'date_time'), run.str(node, 'pattern'), run.str(node, 'timezone'), langOf(String(run.raw(node, 'language') ?? 'en'))));
      },
    ],
    [
      'action.date_info',
      (node, run) => {
        const ms = dateOf(run, node);
        const tz = run.str(node, 'timezone');
        const lang = langOf(String(run.raw(node, 'language') ?? 'en'));
        const p = dateParts(ms, tz);
        const unix = Math.floor(ms / 1000);
        run.setResult(node, '', `<t:${unix}:F>`);
        run.setResult(node, '.year', p.year);
        run.setResult(node, '.month', p.month);
        run.setResult(node, '.day', p.day);
        run.setResult(node, '.hour', p.hour);
        run.setResult(node, '.minute', p.minute);
        run.setResult(node, '.second', p.second);
        run.setResult(node, '.weekday', p.weekday);
        run.setResult(node, '.weekday_name', dayName(p.weekday, lang));
        run.setResult(node, '.month_name', monthName(p.month, lang));
        run.setResult(node, '.week', isoWeek(p));
        run.setResult(node, '.day_of_year', dayOfYear(p));
        run.setResult(node, '.days_in_month', new Date(Date.UTC(p.year, p.month, 0)).getUTCDate());
        run.setResult(node, '.weekend', p.weekday >= 6 ? 'true' : 'false');
        run.setResult(node, '.unix', unix);
        run.setResult(node, '.iso', new Date(ms).toISOString());
        run.setResult(node, '.timezone', zoneOf(tz));
      },
    ],
    [
      'action.time_ago',
      (node, run) => {
        const ms = dateOf(run, node);
        const now = dateOf(run, node, 'compare_to');
        const diff = Math.round((now - ms) / 1000);
        const abs = Math.abs(diff);
        run.setResult(node, '', timeAgo(ms, now, langOf(String(run.raw(node, 'language') ?? 'en'))));
        run.setResult(node, '.seconds', abs);
        run.setResult(node, '.minutes', Math.floor(abs / 60));
        run.setResult(node, '.hours', Math.floor(abs / 3600));
        run.setResult(node, '.days', Math.floor(abs / 86_400));
        run.setResult(node, '.future', diff < 0 ? 'true' : 'false');
        run.setResult(node, '.discord', `<t:${Math.floor(ms / 1000)}:R>`);
      },
    ],

    // ---------- maths and types ----------
    [
      'action.calculate',
      (node, run) => {
        const d = run.str(node, 'decimals').trim();
        run.setResult(node, '', roundTo(calculate(run.str(node, 'expression')), d === '' ? null : Number(d)));
      },
    ],
    [
      'action.value_type',
      (node, run) => {
        const v = run.str(node, 'value');
        run.setResult(node, '', valueType(v));
        run.setResult(node, '.length', valueType(v) === 'list' ? listOf(v).length : [...v].length);
      },
    ],

    // ---------- variables ----------
    [
      'action.get_variable',
      (node, run) => {
        const v = readVar(deps, run, scopeOf(run, node), varName(run, node), targetUser(run, node));
        if (valueType(v) === 'object' || valueType(v) === 'list') setJson(run, node, '', JSON.parse(v));
        else run.setResult(node, '', v);
        run.setResult(node, '.exists', v === '' ? 'false' : 'true');
      },
    ],
    [
      'action.control_variable',
      (node, run) => {
        const scope = scopeOf(run, node);
        const name = varName(run, node);
        const user = targetUser(run, node);
        const current = readVar(deps, run, scope, name, user);
        const value = run.str(node, 'value');
        const op = String(run.raw(node, 'list_operation') ?? 'append');
        let next: string;
        let list: string[] | null = null;
        switch (op) {
          case 'append':
            next = current + value;
            break;
          case 'prepend':
            next = value + current;
            break;
          case 'toggle':
            next = current.trim() === 'true' ? 'false' : 'true';
            break;
          case 'list_add':
            list = [...listOf(current), value];
            break;
          case 'list_add_unique':
            list = listOf(current);
            if (!list.includes(value)) list.push(value);
            break;
          case 'list_remove':
            list = listOf(current).filter((x) => x !== value);
            break;
          case 'list_remove_at': {
            list = listOf(current);
            const at = Math.trunc(run.num(node, 'value'));
            if (at >= 1 && at <= list.length) list.splice(at - 1, 1);
            break;
          }
          case 'list_clear':
            list = [];
            break;
          default:
            throw new GraphError('error.run.unsupported_operation', { value: op });
        }
        if (list) next = JSON.stringify(list);
        writeVar(deps, run, scope, name, next!, user);
        run.setResult(node, '', next!);
        run.setResult(node, '.count', list ? list.length : [...next!].length);
      },
    ],
    [
      'action.clear_data',
      (node, run) => {
        if (!deps.data) throw new GraphError('error.run.unsupported_block', { type: node.type });
        const key = run.str(node, 'data_key').trim().replace(/^\{?var\./, '').replace(/\}$/, '');
        if (!key) throw new GraphError('error.run.missing_value', { field: 'data_key' });
        const guild = run.bool(node, 'all_servers') ? null : (run.vars.get('server.id') ?? '');
        if (guild === '') throw new GraphError('error.run.needs_server');
        run.setResult(node, '', deps.data.clear(key, guild));
      },
    ],
  ];
}
