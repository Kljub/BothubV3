// Operators of the condition.state block. Same rules as the builder
// simulation (dashboard/cmd/mockapi, compare()).

import { valueType } from './values.js';

export function compare(a: string, op: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  const numeric = a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y);
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const inList = () => la.split(',').some((item) => item.trim() === lb);
  switch (op) {
    case '':
    case 'eq':
    case '==':
      return a === b;
    case 'ne':
    case '!=':
      return a !== b;
    case 'gt':
    case '>':
      return numeric && x > y;
    case 'lt':
    case '<':
      return numeric && x < y;
    case 'gte':
    case '>=':
      return numeric && x >= y;
    case 'lte':
    case '<=':
      return numeric && x <= y;
    case 'after':
      return numeric ? x > y : a > b;
    case 'before':
      return numeric ? x < y : a < b;
    case 'contains':
      return la.includes(lb);
    case 'not_contains':
      return !la.includes(lb);
    case 'starts_with':
      return la.startsWith(lb);
    case 'not_starts_with':
      return !la.startsWith(lb);
    case 'ends_with':
      return la.endsWith(lb);
    case 'not_ends_with':
      return !la.endsWith(lb);
    case 'in':
      return inList();
    case 'not_in':
      return !inList();
    // Value checks: the compare value is not used.
    case 'exists':
      return a.trim() !== '';
    case 'empty':
      return a.trim() === '';
    case 'is_number':
      return valueType(a) === 'number';
    case 'is_text':
      return valueType(a) === 'text';
    case 'is_boolean':
      return valueType(a) === 'boolean';
    case 'is_list':
      return valueType(a) === 'list';
    case 'is_object':
      return valueType(a) === 'object';
    default:
      return false;
  }
}
