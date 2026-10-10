// One plugin for one bot in its own child process (SDK manager side).
//
// Isolation: node --permission with read access only to the plugin folder
// and the host folder, no write, no child processes, no workers, no addons;
// an empty environment (no token, no keys, no REDIS_URL); 64 MB heap. The
// host removes network access (Node 24 has no net permission).
//
// Trust: nothing that comes from the child is trusted. Every call is checked
// for shape, size, rate and permission here; the bot ID is fixed by the
// manager and never taken from the plugin.

import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from './catalog.js';
import { SdkError } from './errors.js';
import type { Manifest, Permission } from './manifest.js';

export interface SdkLimits {
  memoryMb: number;
  callsPerSecond: number;
  messageBytes: number;
  callTimeoutMs: number;
  blockTimeoutMs: number;
  restartsPer10Min: number;
}

/** What a plugin call may do, by method; the manager implements them. */
export type CallHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;


const MAX_PENDING = 50;

export const HOST_FILE = join(dirname(fileURLToPath(import.meta.url)), 'host', 'host.js');

type Pending = { ok: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout };

/** State of a plugin process in the task manager. */
export type TaskState = 'starting' | 'running' | 'restarting' | 'stopped' | 'crashed' | 'killed' | 'failed';

/** One row of the task manager (bothub:plugin-tasks:<botId>). */
export interface TaskInfo {
  pluginId: string;
  name: string;
  version: string;
  state: TaskState;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  calls: number;
  callsPerMinute: number;
  memoryBytes: number | null;
  cpuPercent: number | null;
  /** Why it is not running: sdk.plugin.killed_disabled, sdk.plugin.too_many_crashes, … */
  reason: string | null;
}

/** Memory (RSS) and CPU ticks of a process from /proc (Linux); null elsewhere. */
function procStats(pid: number): { rss: number; ticks: number } | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) * 1024;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the name in parentheses: utime and stime are 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { rss, ticks: Number(fields[11]) + Number(fields[12]) };
  } catch {
    return null;
  }
}

export class PluginProcess {
  private child: ChildProcess | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private windowStart = 0;
  private windowCalls = 0;
  private restarts: number[] = [];
  private stopped = false;
  private startedAt: number | undefined;
  private calls = 0;
  private callTimes: number[] = [];
  private cpuSample: { ticks: number; at: number } | undefined;
  /** Set when the task manager (or the guard) killed the process. */
  killedReason: string | undefined;
  /**
   * Asked before every SDK call: false (the plugin was switched off) kills
   * the process at once, the call is not run.
   */
  guard: () => boolean = () => true;
  /** Permissions the plugin may use (manifest ∩ SDK policy). */
  get permissions(): ReadonlySet<Permission> {
    return this.granted;
  }

  /** Blocks the plugin exported after init. */
  blocks: string[] = [];
  /** Why the plugin was switched off (too many crashes), or undefined. */
  disabledReason: string | undefined;

  constructor(
    readonly botId: number,
    readonly manifest: Manifest,
    readonly pluginDir: string,
    /** Manifest ∩ granted ∩ SDK policy. */
    private readonly granted: ReadonlySet<Permission>,
    private config: Record<string, unknown>,
    private readonly handlers: Record<string, CallHandler>,
    private readonly limits: SdkLimits,
    private readonly onLog: (level: 'info' | 'warning' | 'error', key: string, params: Record<string, unknown>) => void,
  ) {}

  /** Starts the child, loads the plugin and runs its start(). */
  async start(): Promise<void> {
    if (this.stopped) throw new SdkError('sdk.plugin.stopped');
    const child = fork(HOST_FILE, [], {
      cwd: this.pluginDir,
      env: {},
      execPath: process.execPath,
      execArgv: [
        '--permission',
        `--allow-fs-read=${this.pluginDir}`,
        `--allow-fs-read=${dirname(HOST_FILE)}`,
        `--max-old-space-size=${this.limits.memoryMb}`,
        '--disallow-code-generation-from-strings',
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child = child;
    this.startedAt = Date.now();
    this.cpuSample = undefined;
    // Output of the plugin: kept short, only for the log.
    const tail = (buf: Buffer) => this.onLog('info', 'sdk.plugin.output', { plugin: this.manifest.id, text: buf.toString('utf8').slice(0, 500) });
    child.stdout?.on('data', tail);
    child.stderr?.on('data', tail);
    child.on('message', (m) => this.onMessage(child, m));
    child.on('exit', (code) => this.onExit(child, code));
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new SdkError('sdk.plugin.no_hello')), this.limits.callTimeoutMs);
      child.once('message', () => {
        clearTimeout(timer);
        ok();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        fail(new SdkError('sdk.plugin.exited'));
      });
    });
    const m = this.manifest;
    const manifest = { id: m.id, name: m.name, version: m.version, permissions: m.permissions };
    const blocks = await this.invoke('init', { pluginDir: this.pluginDir, main: m.main, botId: this.botId, config: this.config, manifest }, this.limits.callTimeoutMs);
    this.blocks = Array.isArray(blocks) ? blocks.filter((b): b is string => typeof b === 'string') : [];
    await this.invoke('start', {}, this.limits.blockTimeoutMs);
    this.blocksReady = true;
  }

  /** A Discord event the plugin listed in "events" (payload: plain JSON). */
  runEvent(name: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.invoke('event', { name, payload }, this.limits.blockTimeoutMs);
  }

  /** A click, select or modal of the plugin's components ("components"/"modals" handlers). */
  runInteraction(kind: 'component' | 'modal', key: string, event: Record<string, unknown>): Promise<unknown> {
    return this.invoke(kind, { key, event }, this.limits.blockTimeoutMs);
  }

  /** An inbound webhook of "services.webhooks" (payload: the JSON the caller sent). */
  runWebhook(name: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.invoke('webhook', { name, payload }, this.limits.blockTimeoutMs);
  }

  /** A task of "services.tasks". */
  runTask(name: string): Promise<unknown> {
    return this.invoke('task', { name }, this.limits.blockTimeoutMs);
  }

  /** Runs a block of the plugin; the answer is checked by the caller. */
  runBlock(name: string, config: Record<string, unknown>, vars: Record<string, string>, interaction?: string): Promise<unknown> {
    return this.invoke('block', { name, config, vars, interaction }, this.limits.blockTimeoutMs);
  }

  /** New settings (dashboard save, config.set): ctx.config answers with them at once, also after a restart. */
  setConfig(config: Record<string, unknown>): void {
    this.config = config;
    if (this.child?.connected) void this.invoke('config', { config }, this.limits.callTimeoutMs).catch(() => undefined);
  }

  /** Settings saved on the dashboard: the new ones, then the plugin's onConfigChange (time of a block). */
  configChanged(config: Record<string, unknown>): Promise<unknown> {
    this.config = config;
    return this.invoke('config', { config, changed: true }, this.limits.blockTimeoutMs);
  }

  /**
   * Ends the process at once (SIGKILL, no onDisable): the task manager's
   * "End task", or a call of a plugin that was switched off. It stays off
   * until it is started again.
   */
  kill(reason: string): void {
    this.stopped = true;
    this.killedReason = reason;
    const child = this.child;
    this.child = undefined;
    this.startedAt = undefined;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.fail(new SdkError('sdk.plugin.killed'));
    }
    this.pending.clear();
    child?.kill('SIGKILL');
    this.onLog('warning', reason, { plugin: this.manifest.id });
  }

  get state(): TaskState {
    if (this.killedReason) return 'killed';
    if (this.disabledReason) return 'crashed';
    if (this.child?.connected) return this.startedAt && this.blocksReady ? 'running' : 'starting';
    if (this.stopped) return 'stopped';
    return this.restarts.length ? 'restarting' : 'starting';
  }

  private blocksReady = false;

  /** A row of the task manager; memory and CPU from /proc (Linux). */
  info(now = Date.now()): TaskInfo {
    this.callTimes = this.callTimes.filter((t) => now - t < 60_000);
    const pid = this.child?.connected ? (this.child.pid ?? null) : null;
    const st = pid ? procStats(pid) : null;
    let cpu: number | null = null;
    if (st) {
      // Clock ticks are 1/100 s: % of one core since the last sample.
      if (this.cpuSample && now > this.cpuSample.at) cpu = Math.round(((st.ticks - this.cpuSample.ticks) * 10 * 1000) / (now - this.cpuSample.at)) / 10;
      this.cpuSample = { ticks: st.ticks, at: now };
    }
    return {
      pluginId: this.manifest.id,
      name: this.manifest.name,
      version: this.manifest.version,
      state: this.state,
      pid,
      startedAt: pid && this.startedAt ? new Date(this.startedAt).toISOString() : null,
      restarts: this.restarts.filter((t) => now - t < 600_000).length,
      calls: this.calls,
      callsPerMinute: this.callTimes.length,
      memoryBytes: st ? st.rss : null,
      cpuPercent: cpu === null ? null : Math.max(0, cpu),
      reason: this.killedReason ?? this.disabledReason ?? null,
    };
  }

  /** Calls onDisable and onUnload (1 s at most), then ends the process. */
  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    if (child.connected) child.send({ type: 'shutdown' });
    setTimeout(() => child.kill('SIGKILL'), 1000).unref();
  }

  private invoke(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new SdkError(this.disabledReason ? 'sdk.plugin.disabled' : 'sdk.plugin.not_running'));
    // Backpressure: a plugin that cannot keep up (e.g. many messages) drops work instead of piling it up.
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new SdkError('sdk.plugin.busy'));
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new SdkError('sdk.plugin.timeout', { method }));
        // A plugin that hangs is restarted (onExit).
        child.kill('SIGKILL');
      }, timeoutMs);
      this.pending.set(id, { ok, fail, timer });
      child.send({ id, type: 'invoke', method, params });
    });
  }

  private onMessage(child: ChildProcess, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    if (JSON.stringify(msg).length > this.limits.messageBytes) {
      this.onLog('warning', 'sdk.plugin.message_too_big', { plugin: this.manifest.id });
      child.kill('SIGKILL');
      return;
    }
    if (msg.type === 'result' && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (typeof msg.error === 'string') p.fail(new SdkError('sdk.plugin.failed', { message: msg.error }));
      else p.ok(msg.result);
      return;
    }
    if (msg.type === 'crash') {
      this.onLog('error', 'sdk.plugin.crashed', { plugin: this.manifest.id, message: String(msg.error ?? '').slice(0, 500) });
      return;
    }
    if (msg.type === 'call' && typeof msg.id === 'number') void this.onCall(child, msg.id, msg.method, msg.params);
  }

  // Replies go to the child that asked, also while it shuts down (onDisable, onUnload).
  private async onCall(child: ChildProcess, id: number, method: unknown, params: unknown): Promise<void> {
    const reply = (body: Record<string, unknown>) => child.connected && child.send({ id, type: 'reply', ...body });
    // Switched off (dashboard, App Store) but still calling the SDK, also in
    // its last second after stop(): end the task, the call is not run.
    if (!this.guard()) {
      if (this.child === child) this.kill('sdk.plugin.killed_disabled');
      else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        this.killedReason = 'sdk.plugin.killed_disabled';
        this.onLog('warning', 'sdk.plugin.killed_disabled', { plugin: this.manifest.id });
      }
      return;
    }
    this.calls++;
    this.callTimes.push(Date.now());
    if (this.callTimes.length > 5000) this.callTimes = this.callTimes.slice(-2500);
    try {
      // Rate limit per second.
      const now = Date.now();
      if (now - this.windowStart >= 1000) {
        this.windowStart = now;
        this.windowCalls = 0;
      }
      if (++this.windowCalls > this.limits.callsPerSecond) throw new SdkError('sdk.call.rate_limited');
      // Order: known call, built, permission (core calls need none).
      const cat = catalog();
      const perm = typeof method === 'string' ? cat.callPermission.get(method) : undefined;
      if (typeof method !== 'string' || !perm) throw new SdkError('sdk.call.unknown');
      if (!cat.implemented.has(method) || !this.handlers[method]) throw new SdkError('sdk.call.not_available');
      // module.*: modules.read (every module) or one modules.<key>.read; the handler checks the module.
      const moduleCall = perm === 'modules.read' && [...this.granted].some((g) => /^modules\.[a-z0-9-]+\.read$/.test(g));
      if (perm !== 'core' && !this.granted.has(perm) && !moduleCall) throw new SdkError('sdk.call.denied', { permission: perm });
      const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const result = await this.handlers[method]!(p);
      reply({ result: result ?? null });
    } catch (err) {
      // Keys of SdkError, VoiceError, GraphError …; anything else stays generic (no internals to the plugin).
      const own = (err as { key?: unknown })?.key;
      const msg = (err as Error)?.message;
      const key = typeof own === 'string' && /^(sdk|error)\.[a-z0-9_.]{1,80}$/.test(own) ? own : typeof msg === 'string' && /^error\.[a-z0-9_.]{1,80}$/.test(msg) ? msg : 'sdk.call.failed';
      if (key === 'sdk.call.denied') this.onLog('warning', key, { plugin: this.manifest.id, method: String(method), permission: catalog().callPermission.get(String(method)) });
      reply({ error: key });
    }
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.startedAt = undefined;
    this.blocksReady = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.fail(new SdkError('sdk.plugin.exited'));
    }
    this.pending.clear();
    if (this.stopped) return;
    // Restart with a limit: too many crashes switch the plugin off.
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 600_000);
    if (this.restarts.length >= this.limits.restartsPer10Min) {
      this.disabledReason = 'sdk.plugin.too_many_crashes';
      this.onLog('error', 'sdk.plugin.disabled', { plugin: this.manifest.id, code });
      return;
    }
    this.restarts.push(now);
    this.onLog('warning', 'sdk.plugin.restart', { plugin: this.manifest.id, code });
    setTimeout(() => {
      // stop() may have come in the meantime: then no new process.
      if (this.stopped) return;
      void this.start().catch((err) => this.onLog('error', 'sdk.plugin.start_failed', { plugin: this.manifest.id, message: String(err) }));
    }, 1000 * this.restarts.length).unref();
  }
}
