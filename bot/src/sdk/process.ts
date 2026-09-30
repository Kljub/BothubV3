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


export const HOST_FILE = join(dirname(fileURLToPath(import.meta.url)), 'host', 'host.js');

type Pending = { ok: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout };

export class PluginProcess {
  private child: ChildProcess | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private windowStart = 0;
  private windowCalls = 0;
  private restarts: number[] = [];
  private stopped = false;
  /** Blocks the plugin exported after init. */
  blocks: string[] = [];
  /** Why the plugin was switched off (too many crashes), or undefined. */
  disabledReason: string | undefined;

  constructor(
    readonly botId: number,
    readonly manifest: Manifest,
    private readonly pluginDir: string,
    /** Manifest ∩ granted ∩ SDK policy. */
    private readonly granted: ReadonlySet<Permission>,
    private readonly config: Record<string, unknown>,
    private readonly handlers: Record<string, CallHandler>,
    private readonly limits: SdkLimits,
    private readonly onLog: (level: 'info' | 'warning' | 'error', key: string, params: Record<string, unknown>) => void,
  ) {}

  /** Starts the child, loads the plugin and runs its start(). */
  async start(): Promise<void> {
    this.stopped = false;
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
    // Output of the plugin: kept short, only for the log.
    const tail = (buf: Buffer) => this.onLog('info', 'sdk.plugin.output', { plugin: this.manifest.id, text: buf.toString('utf8').slice(0, 500) });
    child.stdout?.on('data', tail);
    child.stderr?.on('data', tail);
    child.on('message', (m) => this.onMessage(m));
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
    const blocks = await this.invoke('init', { pluginDir: this.pluginDir, main: this.manifest.main, botId: this.botId, config: this.config }, this.limits.callTimeoutMs);
    this.blocks = Array.isArray(blocks) ? blocks.filter((b): b is string => typeof b === 'string') : [];
    await this.invoke('start', {}, this.limits.blockTimeoutMs);
  }

  /** Runs a block of the plugin; the answer is checked by the caller. */
  runBlock(name: string, config: Record<string, unknown>, vars: Record<string, string>): Promise<unknown> {
    return this.invoke('block', { name, config, vars }, this.limits.blockTimeoutMs);
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

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    if (JSON.stringify(msg).length > this.limits.messageBytes) {
      this.onLog('warning', 'sdk.plugin.message_too_big', { plugin: this.manifest.id });
      this.child?.kill('SIGKILL');
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
    if (msg.type === 'call' && typeof msg.id === 'number') void this.onCall(msg.id, msg.method, msg.params);
  }

  private async onCall(id: number, method: unknown, params: unknown): Promise<void> {
    const reply = (body: Record<string, unknown>) => this.child?.connected && this.child.send({ id, type: 'reply', ...body });
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
      if (perm !== 'core' && !this.granted.has(perm)) throw new SdkError('sdk.call.denied', { permission: perm });
      const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const result = await this.handlers[method]!(p);
      reply({ result: result ?? null });
    } catch (err) {
      const key = err instanceof SdkError ? err.key : (err as Error)?.message?.startsWith('error.') ? (err as Error).message : 'sdk.call.failed';
      if (key === 'sdk.call.denied') this.onLog('warning', key, { plugin: this.manifest.id, method: String(method), permission: catalog().callPermission.get(String(method)) });
      reply({ error: key });
    }
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = undefined;
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
    setTimeout(() => void this.start().catch((err) => this.onLog('error', 'sdk.plugin.start_failed', { plugin: this.manifest.id, message: String(err) })), 1000 * this.restarts.length).unref();
  }
}
