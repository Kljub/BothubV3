// Graph interpreter: runs one command, event or timed event. It knows the
// graph rules (ports, conditions, error paths, limits) but nothing about
// Discord; blocks are handlers registered by the caller.
//
// Rules shared with the builder and its simulation:
//   * The run starts at the trigger and follows flow edges (port "next").
//   * Options plug into the trigger (port "options"); their values are the
//     placeholders {option_<name>} and the option's variable.
//   * A condition fans out through "branches" to state blocks; the first
//     matching state continues (or all of them with multi = "all"), else the
//     Else state.
//   * A failing block continues at its "error" port when paths are on,
//     otherwise at the error handler. A second failure ends the run.
//   * Limits from shared/graph-limits.json: steps, run time, Discord calls.

import { setTimeout as sleep } from 'node:timers/promises';
import type { GraphLimits } from '../core/config.js';
import { compare } from './compare.js';
import type { Edge, Graph, GraphNode, NodeDefinition } from './types.js';

/** A failure with an i18n key (error.run.*), shown in logs and the dashboard. */
export class GraphError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(key);
    this.name = 'GraphError';
  }
}

/** Thrown by the Stop Loop block; ends the innermost running loop. */
export class StopLoop extends Error {}

/** Ends the whole run from inside a handler (failure inside a loop body). */
class EndRun extends Error {
  constructor(readonly error: GraphError | undefined) {
    super('end run');
  }
}

/** A block handler returns the output port to continue at ("next" when void). */
export type Handler = (node: GraphNode, run: Run) => Promise<string | void> | string | void;

export interface Engine {
  defs: Map<string, NodeDefinition>;
  handlers: Map<string, Handler>;
  limits: GraphLimits;
  /** Match conditions: role, permission, channel, user, status, subcommand. */
  match(cond: GraphNode, state: GraphNode, run: Run): Promise<boolean> | boolean;
  /** Placeholders the run does not know itself, e.g. stored variables. */
  lookup?(name: string, run: Run): string | undefined;
}

export interface Step {
  node: string;
  type: string;
  status: 'ok' | 'error';
  errorKey?: string;
}

export interface RunResult {
  ok: boolean;
  steps: Step[];
  errorKey?: string;
}

const PLACEHOLDER = /\{([A-Za-z0-9_][A-Za-z0-9_.:-]{0,99})\}/g;

export class Run {
  readonly vars = new Map<string, string>();
  readonly steps: Step[] = [];
  private readonly byId = new Map<string, GraphNode>();
  private readonly out = new Map<string, Edge[]>();
  private stepCount = 0;
  private discordCalls = 0;
  private waitedMs = 0;
  private readonly startedAt = Date.now();
  private failure: GraphError | undefined;
  private handlingError = false;
  private loopDepth = 0;
  private stopRequested = false;

  constructor(
    readonly graph: Graph,
    readonly engine: Engine,
    /** Discord objects for the handlers (interaction, guild, member, …). */
    readonly data: Record<string, unknown> = {},
    vars: Record<string, string> = {},
  ) {
    for (const n of graph.nodes) this.byId.set(n.id, n);
    for (const e of graph.edges) {
      const key = `${e.from.node}:${e.from.port}`;
      const list = this.out.get(key);
      if (list) list.push(e);
      else this.out.set(key, [e]);
    }
    for (const [k, v] of Object.entries(vars)) this.vars.set(k, v);
  }

  // ---------- values ----------

  /** Replaces {placeholders}; unknown ones stay as they are. */
  render(text: string): string {
    return text.replace(PLACEHOLDER, (whole, name: string) => this.vars.get(name) ?? this.engine.lookup?.(name, this) ?? whole);
  }

  raw(node: GraphNode, key: string): unknown {
    return node.config[key] ?? this.engine.defs.get(node.type)?.config?.properties?.[key]?.default;
  }

  str(node: GraphNode, key: string): string {
    const v = this.raw(node, key);
    return v === undefined || v === null ? '' : this.render(String(v));
  }

  num(node: GraphNode, key: string): number {
    const text = this.str(node, key).trim();
    const n = Number(text);
    if (text === '' || !Number.isFinite(n)) throw new GraphError('error.run.not_a_number', { field: key, value: text });
    return n;
  }

  bool(node: GraphNode, key: string): boolean {
    const v = this.raw(node, key);
    return v === true || v === 'true';
  }

  /** Stores a block result under its variable name ({Var1}, {Var1.id}, …). */
  setResult(node: GraphNode, suffix: string, value: unknown): void {
    const name = node.config.variable;
    if (typeof name === 'string' && name !== '') this.vars.set(name + suffix, value === undefined || value === null ? '' : String(value));
  }

  /** Every Discord API call counts against maxDiscordCallsPerRun. */
  countDiscordCall(): void {
    if (++this.discordCalls > this.engine.limits.maxDiscordCallsPerRun) {
      throw new GraphError('error.run.too_many_discord_calls', { max: this.engine.limits.maxDiscordCallsPerRun });
    }
  }

  /** Wait blocks: waiting does not count as run time. */
  async pause(ms: number): Promise<void> {
    await sleep(ms);
    this.waitedMs += ms;
  }

  // ---------- structure ----------

  node(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  targets(nodeId: string, port: string): GraphNode[] {
    return (this.out.get(`${nodeId}:${port}`) ?? []).map((e) => this.byId.get(e.to.node)).filter((n): n is GraphNode => !!n);
  }

  trigger(): GraphNode | undefined {
    return this.graph.nodes.find((n) => this.engine.defs.get(n.type)?.category === 'trigger');
  }

  /** Option blocks plugged into the trigger. */
  options(): GraphNode[] {
    const trig = this.trigger();
    if (!trig) return [];
    return this.graph.edges
      .filter((e) => e.to.node === trig.id && e.to.port === 'options')
      .map((e) => this.byId.get(e.from.node))
      .filter((n): n is GraphNode => !!n);
  }

  // ---------- loops ----------

  get inLoop(): boolean {
    return this.loopDepth > 0;
  }

  /**
   * Runs the flow at (nodeId, port) to its end, for loop blocks. Returns
   * "stop" when a Stop Loop block ran. A block failure that the error
   * handler took over ends the whole run, not just this round.
   */
  async branch(nodeId: string, port: string): Promise<'done' | 'stop'> {
    const before = this.failure;
    this.loopDepth++;
    let fatal: GraphError | undefined;
    try {
      fatal = await this.walkFrom(nodeId, port);
    } finally {
      this.loopDepth--;
    }
    if (fatal || this.failure !== before) throw new EndRun(fatal ?? this.failure);
    const stop = this.stopRequested;
    this.stopRequested = false;
    return stop ? 'stop' : 'done';
  }

  // ---------- running ----------

  async start(): Promise<RunResult> {
    const trig = this.trigger();
    if (!trig) return this.finish(new GraphError('error.run.no_trigger'));
    this.record(trig, 'ok');
    return this.finish(await this.walkFrom(trig.id, 'next'));
  }

  /** Continues a run later, e.g. when a button of its message is clicked. */
  async continueFrom(nodeId: string, port = 'next'): Promise<RunResult> {
    this.failure = undefined;
    return this.finish(await this.walkFrom(nodeId, port));
  }

  private finish(err: GraphError | undefined): RunResult {
    const e = err ?? this.failure;
    return e ? { ok: false, steps: this.steps, errorKey: e.key } : { ok: true, steps: this.steps };
  }

  private record(node: GraphNode, status: Step['status'], errorKey?: string): void {
    this.steps.push(errorKey ? { node: node.id, type: node.type, status, errorKey } : { node: node.id, type: node.type, status });
  }

  private checkLimits(): void {
    const { maxSteps, maxRuntimeMs } = this.engine.limits;
    if (++this.stepCount > maxSteps) throw new GraphError('error.run.too_many_steps', { max: maxSteps });
    if (Date.now() - this.startedAt - this.waitedMs > maxRuntimeMs) throw new GraphError('error.run.timeout', { max: maxRuntimeMs });
  }

  /** Follows the flow from (nodeId, port). Returns a fatal error, if any. */
  private async walkFrom(nodeId: string, port: string): Promise<GraphError | undefined> {
    let cur = this.targets(nodeId, port)[0];
    while (cur) {
      if (this.stopRequested) return undefined;
      try {
        this.checkLimits();
      } catch (err) {
        return err as GraphError; // limits end the run, no error handler
      }
      const node = cur;
      if (node.disabled) {
        cur = this.targets(node.id, 'next')[0];
        continue;
      }
      const def = this.engine.defs.get(node.type);

      if (def?.category === 'condition' && !def.compact) {
        let states: GraphNode[];
        try {
          states = await this.pickStates(node, def);
        } catch (err) {
          const next = await this.fail(node, err);
          if (next === null) return this.failure;
          cur = next;
          continue;
        }
        this.record(node, 'ok');
        if (states.length === 1) {
          this.record(states[0]!, 'ok');
          cur = this.targets(states[0]!.id, 'next')[0];
          continue;
        }
        // multi = "all": every matching state runs, one after the other.
        for (const st of states) {
          this.record(st, 'ok');
          const fatal = await this.walkFrom(st.id, 'next');
          if (fatal) return fatal;
          if (this.stopRequested) break;
        }
        return undefined;
      }

      let outPort = 'next';
      try {
        const handler = this.engine.handlers.get(node.type);
        if (!handler) throw new GraphError('error.run.unsupported_block', { type: node.type });
        outPort = (await handler(node, this)) || 'next';
        this.record(node, 'ok');
      } catch (err) {
        if (err instanceof EndRun) return err.error;
        if (err instanceof StopLoop) {
          this.record(node, 'ok');
          if (this.loopDepth > 0) {
            this.stopRequested = true;
            return undefined;
          }
          cur = this.targets(node.id, 'next')[0]; // outside a loop: no effect
          continue;
        }
        const next = await this.fail(node, err);
        if (next === null) return this.failure;
        cur = next;
        continue;
      }
      if (outPort === 'next' && node.paths) outPort = 'success';
      cur = this.targets(node.id, outPort)[0];
    }
    return undefined;
  }

  /**
   * A block failed: continue at its error port, else at the error handler.
   * Returns the next block, undefined to end this path, or null when the run
   * has to stop (failure inside the error handling).
   */
  private async fail(node: GraphNode, err: unknown): Promise<GraphNode | undefined | null> {
    const ge = err instanceof GraphError ? err : new GraphError('error.run.block_failed', { message: err instanceof Error ? err.message : String(err) });
    this.record(node, 'error', ge.key);
    const message = typeof ge.params.message === 'string' ? ge.params.message : ge.key;
    if (node.paths) {
      this.setResult(node, '.error', message);
      return this.targets(node.id, 'error')[0];
    }
    if (this.handlingError) {
      this.failure = ge;
      return null;
    }
    this.failure = ge;
    const handler = this.graph.nodes.find((n) => n.type === 'utility.error_handler');
    if (!handler) return null;
    this.handlingError = true;
    const v = typeof handler.config.variable === 'string' && handler.config.variable ? handler.config.variable : 'error';
    this.vars.set(v, message);
    this.vars.set(`${v}.key`, ge.key);
    this.vars.set(`${v}.block`, node.label || node.type);
    this.record(handler, 'ok');
    return this.targets(handler.id, 'next')[0];
  }

  /** States of a condition that match, in canvas order (left to right). */
  private async pickStates(cond: GraphNode, def: NodeDefinition): Promise<GraphNode[]> {
    const branches = this.targets(cond.id, 'branches').sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
    const elseState = branches.find((s) => s.type === 'condition.else');
    const states = branches.filter((s) => s.type !== 'condition.else' && !s.disabled);
    const all = this.raw(cond, 'multi') === 'all';
    const matched: GraphNode[] = [];

    if (def.conditionKind === 'chance') {
      let roll = Math.random() * 100;
      for (const st of states) {
        const p = Number(this.raw(st, 'percent') ?? 0);
        if (roll < p) {
          matched.push(st);
          break;
        }
        roll -= p;
      }
    } else {
      for (const st of states) {
        let hit: boolean;
        if (def.conditionKind === 'compare') {
          hit = compare(this.subject(cond), String(this.raw(st, 'operator') ?? 'eq'), this.str(st, 'value'));
        } else if (def.conditionKind === 'option') {
          const picked = (this.vars.get('__selected') ?? '').split('\u0000');
          hit = picked.includes(this.str(st, 'value'));
        } else {
          hit = await this.engine.match(cond, st, this);
        }
        if (hit) {
          matched.push(st);
          if (!all) break;
        }
      }
    }
    if (matched.length) return matched;
    return elseState ? [elseState] : [];
  }

  /** The value a compare condition checks (a variable, option or text). */
  private subject(cond: GraphNode): string {
    const subject = String(this.raw(cond, 'subject') ?? '');
    const source = this.raw(cond, 'source');
    if ((source === 'variable' || source === 'option') && !subject.includes('{')) return this.render(`{${subject}}`);
    return this.render(subject);
  }
}

export function definitions(list: NodeDefinition[]): Map<string, NodeDefinition> {
  return new Map(list.map((d) => [d.type, d]));
}
