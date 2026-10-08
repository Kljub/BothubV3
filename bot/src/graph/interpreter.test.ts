import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Run, GraphError, definitions, type Engine, type Handler } from './interpreter.js';
import { coreHandlers, type VarStore } from './handlers-core.js';
import type { Graph, GraphNode, NodeDefinition } from './types.js';
import { compare } from './compare.js';
import { parseDuration, snowflake } from './util.js';

const defs = definitions([
  { type: 'trigger.slash', category: 'trigger' },
  { type: 'option.text', category: 'option' },
  { type: 'utility.error_handler', category: 'utility' },
  { type: 'condition.comparison', category: 'condition', conditionKind: 'compare' },
  { type: 'condition.chance', category: 'condition', conditionKind: 'chance' },
  { type: 'condition.role', category: 'condition', conditionKind: 'match' },
  { type: 'condition.state', category: 'condition', compact: true },
  { type: 'condition.else', category: 'condition', compact: true },
  { type: 'action.set_variable', category: 'action', config: { properties: { scope: { default: 'run' } } } },
  { type: 'action.run_equation', category: 'action' },
  { type: 'action.manipulate_text', category: 'action' },
  { type: 'action.wait', category: 'action' },
  { type: 'test.say', category: 'action' },
  { type: 'test.boom', category: 'action' },
] satisfies NodeDefinition[]);

const limits = { maxNodes: 500, maxEdges: 2000, maxSteps: 1000, maxLoopIterations: 100, maxRuntimeMs: 10_000, maxDiscordCallsPerRun: 50 };

function memoryStore(): VarStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (s, id, n) => data.get(`${s}|${id}|${n}`),
    set: (s, id, n, v) => void data.set(`${s}|${id}|${n}`, v),
    delete: (s, id, n) => void data.delete(`${s}|${id}|${n}`),
  };
}

function engine(said: string[], extra: [string, Handler][] = []): Engine {
  const store = memoryStore();
  const handlers = coreHandlers({ vars: store, logError: () => undefined });
  handlers.set('test.say', (node, run) => void said.push(run.str(node, 'text')));
  handlers.set('test.boom', () => {
    throw new GraphError('error.test.boom');
  });
  for (const [k, h] of extra) handlers.set(k, h);
  return {
    defs,
    handlers,
    limits,
    match: (_cond, state, run) => (run.vars.get('member.roles') ?? '').split(',').includes(run.str(state, 'value')),
  };
}

let seq = 0;
const n = (type: string, config: Record<string, unknown> = {}, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: `${type.split('.')[1]}_${++seq}`,
  type,
  typeVersion: 1,
  config,
  ...extra,
});
const edge = (a: GraphNode, port: string, b: GraphNode, toPort = 'in') => ({ from: { node: a.id, port }, to: { node: b.id, port: toPort } });
const graph = (nodes: GraphNode[], edges: Graph['edges']): Graph => ({ schemaVersion: 1, nodes, edges });

test('runs the flow in order and fills placeholders', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const a = n('test.say', { text: 'Hi {user}' });
  const b = n('test.say', { text: 'You said {option_word}' });
  const r = await new Run(graph([t, a, b], [edge(t, 'next', a), edge(a, 'next', b)]), engine(said), {}, { user: 'Kljub', option_word: 'hello' }).start();
  assert.equal(r.ok, true);
  assert.deepEqual(said, ['Hi Kljub', 'You said hello']);
});

test('unknown placeholders stay unchanged', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const a = n('test.say', { text: '{nope} and {user.id}' });
  await new Run(graph([t, a], [edge(t, 'next', a)]), engine(said), {}, { 'user.id': '1' }).start();
  assert.deepEqual(said, ['{nope} and 1']);
});

test('compare condition picks the first matching state, else Else', async () => {
  for (const [amount, expected] of [['150', 'big'], ['5', 'small'], ['abc', 'other']] as const) {
    const said: string[] = [];
    const t = n('trigger.slash');
    const c = n('condition.comparison', { source: 'option', subject: 'option_amount' });
    const s1 = n('condition.state', { operator: 'gt', value: '100' }, { position: { x: 0, y: 0 } });
    const s2 = n('condition.state', { operator: 'lte', value: '100' }, { position: { x: 100, y: 0 } });
    const el = n('condition.else', {}, { position: { x: 200, y: 0 } });
    const big = n('test.say', { text: 'big' });
    const small = n('test.say', { text: 'small' });
    const other = n('test.say', { text: 'other' });
    const g = graph([t, c, s1, s2, el, big, small, other], [
      edge(t, 'next', c), edge(c, 'branches', s1), edge(c, 'branches', s2), edge(c, 'branches', el),
      edge(s1, 'next', big), edge(s2, 'next', small), edge(el, 'next', other),
    ]);
    await new Run(g, engine(said), {}, { option_amount: amount }).start();
    assert.deepEqual(said, [expected], `amount ${amount}`);
  }
});

test('multi = all runs every matching state', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const c = n('condition.role', { multi: 'all' });
  const s1 = n('condition.state', { value: '1' }, { position: { x: 0, y: 0 } });
  const s2 = n('condition.state', { value: '2' }, { position: { x: 100, y: 0 } });
  const s3 = n('condition.state', { value: '3' }, { position: { x: 200, y: 0 } });
  const a = n('test.say', { text: 'one' });
  const b = n('test.say', { text: 'two' });
  const d = n('test.say', { text: 'three' });
  const g = graph([t, c, s1, s2, s3, a, b, d], [
    edge(t, 'next', c), edge(c, 'branches', s1), edge(c, 'branches', s2), edge(c, 'branches', s3),
    edge(s1, 'next', a), edge(s2, 'next', b), edge(s3, 'next', d),
  ]);
  await new Run(g, engine(said), {}, { 'member.roles': '1,3' }).start();
  assert.deepEqual(said, ['one', 'three']);
});

test('a failing block continues at the error handler with the error variable', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const boom = n('test.boom');
  const never = n('test.say', { text: 'never' });
  const eh = n('utility.error_handler', { variable: 'err' });
  const report = n('test.say', { text: 'failed: {err}' });
  const r = await new Run(graph([t, boom, never, eh, report], [edge(t, 'next', boom), edge(boom, 'next', never), edge(eh, 'next', report)]), engine(said)).start();
  assert.deepEqual(said, ['failed: error.test.boom']);
  assert.equal(r.ok, false);
  assert.equal(r.errorKey, 'error.test.boom');
});

test('success and error paths replace the error handler', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const boom = n('test.boom', { variable: 'x' }, { paths: true });
  const ok = n('test.say', { text: 'ok' });
  const bad = n('test.say', { text: 'bad {x.error}' });
  const eh = n('utility.error_handler');
  const handler = n('test.say', { text: 'handler' });
  const g = graph([t, boom, ok, bad, eh, handler], [edge(t, 'next', boom), edge(boom, 'success', ok), edge(boom, 'error', bad), edge(eh, 'next', handler)]);
  const r = await new Run(g, engine(said)).start();
  assert.deepEqual(said, ['bad error.test.boom']);
  assert.equal(r.ok, true);
});

test('a failure inside the error handling ends the run', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const boom = n('test.boom');
  const eh = n('utility.error_handler');
  const boom2 = n('test.boom');
  const after = n('test.say', { text: 'after' });
  const r = await new Run(graph([t, boom, eh, boom2, after], [edge(t, 'next', boom), edge(eh, 'next', boom2), edge(boom2, 'next', after)]), engine(said)).start();
  assert.deepEqual(said, []);
  assert.equal(r.ok, false);
});

test('unsupported blocks fail with a clear key', async () => {
  const t = n('trigger.slash');
  const x = n('action.teleport');
  const r = await new Run(graph([t, x], [edge(t, 'next', x)]), engine([])).start();
  assert.equal(r.errorKey, 'error.run.unsupported_block');
});

test('disabled blocks are skipped', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const off = n('test.say', { text: 'off' }, { disabled: true });
  const on = n('test.say', { text: 'on' });
  await new Run(graph([t, off, on], [edge(t, 'next', off), edge(off, 'next', on)]), engine(said)).start();
  assert.deepEqual(said, ['on']);
});

test('the step limit stops endless graphs', async () => {
  const t = n('trigger.slash');
  const a = n('test.say', { text: 'a' });
  const b = n('test.say', { text: 'b' });
  const e = engine([]);
  e.limits = { ...limits, maxSteps: 20 };
  const r = await new Run(graph([t, a, b], [edge(t, 'next', a), edge(a, 'next', b), edge(b, 'next', a)]), e).start();
  assert.equal(r.errorKey, 'error.run.too_many_steps');
});

test('run variables, equations and text blocks', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const set = n('action.set_variable', { var_name: 'count', value: '5' });
  const eq = n('action.run_equation', { var_name: 'count', math: 'multiply', operand: '{option_times}' });
  const txt = n('action.manipulate_text', { input: 'hello {local.count}', operation: 'uppercase', variable: 'shout' });
  const say = n('test.say', { text: '{shout}' });
  const g = graph([t, set, eq, txt, say], [edge(t, 'next', set), edge(set, 'next', eq), edge(eq, 'next', txt), edge(txt, 'next', say)]);
  await new Run(g, engine(said), {}, { option_times: '3' }).start();
  assert.deepEqual(said, ['HELLO 15']);
});

test('chance picks by percentage', async () => {
  const t = n('trigger.slash');
  const c = n('condition.chance');
  const always = n('condition.state', { percent: 100 });
  const said: string[] = [];
  const a = n('test.say', { text: 'yes' });
  await new Run(graph([t, c, always, a], [edge(t, 'next', c), edge(c, 'branches', always), edge(always, 'next', a)]), engine(said)).start();
  assert.deepEqual(said, ['yes']);
});

test('compare operators', () => {
  assert.equal(compare('10', 'gt', '9'), true);
  assert.equal(compare('abc', 'gt', '9'), false);
  assert.equal(compare('Hello World', 'contains', 'world'), true);
  assert.equal(compare('a, b, c', 'in', 'b'), true);
  assert.equal(compare('2026-01-02', 'after', '2026-01-01'), true);
});

test('durations and IDs', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.throws(() => parseDuration('soon'));
  assert.equal(snowflake('<@123456789012345678>', 'user'), '123456789012345678');
  assert.throws(() => snowflake('Kljub', 'user'));
});

test('playback trace: changed variables, filled settings, log lines, error message', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const setV = n('test.set');
  const a = n('test.say', { text: 'You have {coins}' });
  const boom = n('test.boom');
  const e = engine(said, [['test.log', (node, run) => run.logLine(run.str(node, 'text'))], ['test.set', (_node, run) => void run.vars.set('coins', '5')]]);
  const lg = n('test.log', { text: 'coins={coins}' });
  const run = new Run(graph([t, setV, a, lg, boom], [edge(t, 'next', setV), edge(setV, 'next', a), edge(a, 'next', lg), edge(lg, 'next', boom)]), e, {}, { user: 'Kljub' });
  run.trace = true;
  assert.deepEqual(run.startVars(), { user: 'Kljub' });
  const r = await run.start();
  assert.equal(r.ok, false);
  assert.equal(r.errorNode?.id, boom.id);
  const bySay = r.steps.find((s) => s.node === a.id)!;
  assert.equal(bySay.values?.text, 'You have 5');
  assert.equal(r.steps.find((s) => s.node === setV.id)!.vars?.coins, '5');
  assert.equal(r.steps.find((s) => s.node === lg.id)!.log, 'coins=5');
  assert.equal(r.steps.at(-1)!.status, 'error');
  assert.ok(typeof r.steps[0]!.t === 'number');
});

test('without trace the steps stay small', async () => {
  const t = n('trigger.slash');
  const a = n('test.say', { text: 'x' });
  const r = await new Run(graph([t, a], [edge(t, 'next', a)]), engine([]), {}, {}).start();
  assert.deepEqual(Object.keys(r.steps[1]!).sort(), ['node', 'status', 'type']);
});

test('fail flow "continue" skips the failed block, the run still counts as failed', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const boom = n('test.boom');
  const a = n('test.say', { text: 'after' });
  const run = new Run(graph([t, boom, a], [edge(t, 'next', boom), edge(boom, 'next', a)]), engine(said), {}, {});
  run.failFlow = 'continue';
  const r = await run.start();
  assert.deepEqual(said, ['after']);
  assert.equal(r.ok, false);
  assert.equal(r.errorKey, 'error.test.boom');
  assert.equal(r.errorNode?.id, boom.id);
});

test('an error port handles the failure: the run is ok', async () => {
  const t = n('trigger.slash');
  const boom = n('test.boom', {}, { paths: true });
  const a = n('test.say', { text: 'handled' });
  const said: string[] = [];
  const r = await new Run(graph([t, boom, a], [edge(t, 'next', boom), edge(boom, 'error', a)]), engine(said), {}, {}).start();
  assert.equal(r.ok, true);
  assert.deepEqual(said, ['handled']);
});

test('a click long after the command does not hit the run time limit', async () => {
  const said: string[] = [];
  const t = n('trigger.slash');
  const btn = n('test.say', { text: 'command' });
  const after = n('test.say', { text: 'after click' });
  const run = new Run(graph([t, btn, after], [edge(t, 'next', btn), edge(btn, 'next', after)]), { ...engine(said), limits: { ...limits, maxRuntimeMs: 50 } }, {}, {});
  await new Promise((r) => setTimeout(r, 80));
  const r = await run.continueFrom(btn.id);
  assert.equal(r.ok, true, r.errorKey);
  assert.deepEqual(said, ['after click']);
});
