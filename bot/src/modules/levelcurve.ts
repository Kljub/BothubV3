// Leveling → level curve: the total XP a member needs to reach a level.
// "linear" is the classic curve (base, then step more per level); "custom"
// is a formula of `level` the admin writes, e.g. 5 * level ^ 2 + 50 * level.
// The formula is parsed here (no eval): numbers, level (or L), + - * / % ^,
// brackets and floor, ceil, round, sqrt, abs, log, min, max, pow.

export interface CurveConfig {
  baseXp?: number;
  stepXp?: number;
  maxLevel?: number;
  curve?: string; // linear, custom
  curveFormula?: string;
}

type Node = { n: number } | { v: true } | { op: string; a: Node; b: Node } | { neg: Node } | { fn: string; args: Node[] };

const FUNCS: Record<string, { min: number; max: number; run: (...x: number[]) => number }> = {
  floor: { min: 1, max: 1, run: Math.floor },
  ceil: { min: 1, max: 1, run: Math.ceil },
  round: { min: 1, max: 1, run: Math.round },
  sqrt: { min: 1, max: 1, run: Math.sqrt },
  abs: { min: 1, max: 1, run: Math.abs },
  log: { min: 1, max: 1, run: Math.log },
  min: { min: 2, max: 8, run: Math.min },
  max: { min: 2, max: 8, run: Math.max },
  pow: { min: 2, max: 2, run: Math.pow },
};

/** Parses a formula; throws an Error with a short reason when it is not valid. */
export function parseFormula(src: string): Node {
  if (src.length > 200) throw new Error('too long');
  const tokens = src.match(/\d+(?:\.\d+)?|[A-Za-z_]+|[-+*/%^(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (want?: string) => {
    const t = tokens[i++];
    if (want !== undefined && t !== want) throw new Error(`expected "${want}"`);
    if (t === undefined) throw new Error('unexpected end');
    return t;
  };
  const primary = (): Node => {
    const t = take();
    if (/^\d/.test(t)) return { n: Number(t) };
    if (t === '(') {
      const e = sum();
      take(')');
      return e;
    }
    if (t === '-') return { neg: power() };
    if (t === '+') return power();
    const name = t.toLowerCase();
    if (name === 'level' || name === 'l') return { v: true };
    const fn = FUNCS[name];
    if (!fn) throw new Error(`unknown name "${t}"`);
    take('(');
    const args = [sum()];
    while (peek() === ',') {
      take(',');
      args.push(sum());
    }
    take(')');
    if (args.length < fn.min || args.length > fn.max) throw new Error(`wrong number of values for ${name}`);
    return { fn: name, args };
  };
  // ^ binds tighter and to the right: 2 ^ 3 ^ 2 = 2 ^ 9.
  const power = (): Node => {
    const a = primary();
    if (peek() === '^') {
      take();
      return { op: '^', a, b: power() };
    }
    return a;
  };
  const product = (): Node => {
    let a = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') a = { op: take(), a, b: power() };
    return a;
  };
  const sum = (): Node => {
    let a = product();
    while (peek() === '+' || peek() === '-') a = { op: take(), a, b: product() };
    return a;
  };
  if (!tokens.length) throw new Error('empty');
  const tree = sum();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return tree;
}

export function evaluate(node: Node, level: number): number {
  if ('n' in node) return node.n;
  if ('v' in node) return level;
  if ('neg' in node) return -evaluate(node.neg, level);
  if ('fn' in node) return FUNCS[node.fn]!.run(...node.args.map((a) => evaluate(a, level)));
  const a = evaluate(node.a, level);
  const b = evaluate(node.b, level);
  switch (node.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    default: return Math.pow(a, b);
  }
}

/** The classic curve: level 1 costs base, each next level step more. */
export function linearXp(level: number, base: number, step: number): number {
  return level <= 0 ? 0 : level * base + (step * level * (level - 1)) / 2;
}

const parsed = new Map<string, Node | null>();

function formulaOf(src: string): Node | null {
  if (!parsed.has(src)) {
    let tree: Node | null = null;
    try {
      tree = parseFormula(src);
    } catch {
      tree = null;
    }
    if (parsed.size > 100) parsed.clear();
    parsed.set(src, tree);
  }
  return parsed.get(src)!;
}

/**
 * Total XP for a level with the configured curve. A custom formula that is
 * invalid, not finite or not rising falls back to the linear curve.
 */
export function xpForLevel(level: number, cfg: CurveConfig): number {
  if (level <= 0) return 0;
  const lin = linearXp(level, cfg.baseXp ?? 100, cfg.stepXp ?? 50);
  if (cfg.curve !== 'custom' || !cfg.curveFormula?.trim()) return lin;
  const tree = formulaOf(cfg.curveFormula.trim());
  if (!tree) return lin;
  const v = evaluate(tree, level);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : lin;
}

/** The level for a total XP. */
export function levelFor(xp: number, cfg: CurveConfig): number {
  let level = 0;
  const max = cfg.maxLevel ?? 0;
  let prev = 0;
  while (level < 100_000 && (max <= 0 || level < max)) {
    const need = xpForLevel(level + 1, cfg);
    // A curve that does not rise ends here (no endless levels for free).
    if (need > xp || need <= prev) break;
    prev = need;
    level++;
  }
  return level;
}

/** Why a formula is not usable, or null (for the settings warning). */
export function formulaProblem(src: string): string | null {
  let tree: Node;
  try {
    tree = parseFormula(src.trim());
  } catch (err) {
    return (err as Error).message;
  }
  let prev = 0;
  for (let l = 1; l <= 50; l++) {
    const v = evaluate(tree, l);
    if (!Number.isFinite(v) || v <= prev) return `the XP must rise with every level (level ${l} gives ${Number.isFinite(v) ? Math.floor(v) : v})`;
    prev = v;
  }
  return null;
}
