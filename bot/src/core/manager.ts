// Bot manager: all bots in one process, each with its own Discord client
// (BotInstance). Starts the autostart bots, follows changes from
// bothub:events and runs start/stop jobs from bothub:jobs.
//
// Bots do not wait for each other: every bot has its own work queue, so a
// slow login or restart of one bot never delays events of another.

import { clearSecretCache } from './secrets-global.js';
import { log } from './log.js';
import type { Repo } from './repo.js';
import { decrypt } from './secrets.js';
import { BotInstance, type InstanceDeps, type WebhookCall } from '../discord/instance.js';

export interface BotEvent {
  type: string;
  botId?: number;
}

export interface JobResult {
  ok: boolean;
  errorKey?: string;
}

export class BotManager {
  private readonly bots = new Map<number, BotInstance>();

  /** The running instance of a bot (SDK calls of its plugins). */
  instance(botId: number): BotInstance | undefined {
    return this.bots.get(botId);
  }
  private readonly queues = new Map<number, Promise<unknown>>();

  constructor(
    private readonly repo: Repo,
    private readonly deps: InstanceDeps,
    private readonly secretKey: () => Buffer,
  ) {}

  /** Bots that are logged in to Discord right now. */
  runningCount(): number {
    let n = 0;
    for (const b of this.bots.values()) if (b.running) n++;
    return n;
  }

  /** Starts all autostart bots in parallel (Discord rate limits logins per token, not per process). */
  async startAll(): Promise<void> {
    const ids = this.repo.bots().filter((b) => b.autostart && b.tokenEnc).map((b) => b.id);
    await Promise.allSettled(ids.map((id) => this.enqueue(id, () => this.start(id)).catch((err) => log.error('bot start failed', { botId: id, err }))));
    log.info('bots started', { count: this.bots.size, of: ids.length });
  }

  /**
   * Runs fn after the earlier work of the same bot (start, stop, reload never
   * overlap for one bot). Work of different bots runs side by side.
   */
  enqueue<T>(botId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(botId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.queues.set(botId, tail);
    void tail.then(() => {
      if (this.queues.get(botId) === tail) this.queues.delete(botId);
    });
    return next;
  }

  async start(botId: number): Promise<void> {
    const bot = this.repo.bot(botId);
    if (!bot) throw new Error('error.bot.not_found');
    if (!bot.tokenEnc) throw new Error('error.bot.no_token');
    const token = decrypt(this.secretKey(), bot.tokenEnc);
    let instance = this.bots.get(botId);
    if (!instance) {
      instance = new BotInstance(botId, this.deps);
      this.bots.set(botId, instance);
    }
    await instance.start(token);
  }

  async stop(botId: number): Promise<void> {
    await this.bots.get(botId)?.stop();
    this.bots.delete(botId);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.bots.keys()].map((id) => this.stop(id)));
  }

  async handleEvent(ev: BotEvent): Promise<void> {
    // Global plugin changes: every running bot restarts its plugins.
    if (ev.type === 'sdk.policies.changed' || ev.type === 'plugins.changed') {
      await Promise.allSettled([...this.bots.values()].filter((b) => b.running).map((b) => b.startPlugins()));
      return;
    }
    const id = ev.botId;
    if (ev.type === 'secrets.changed') {
      clearSecretCache(); // global: the next request reads the new values
      return;
    }
    if (typeof id !== 'number') return;
    switch (ev.type) {
      case 'bot.deleted':
        await this.stop(id);
        return;
      case 'bot.created':
      case 'bot.updated': {
        // Token or autostart may have changed: restart a running bot, start an autostart one.
        const bot = this.repo.bot(id);
        if (!bot) return this.stop(id);
        if (this.bots.get(id)?.running || (bot.autostart && bot.tokenEnc)) await this.start(id);
        return;
      }
      case 'plugin.webhook':
        // Only for a running bot: its plugins run only then.
        if (this.bots.get(id)?.running) this.deps.plugins?.dispatchWebhook(id, String((ev as unknown as Record<string, unknown>).pluginId ?? ''), String((ev as unknown as Record<string, unknown>).name ?? ''), ((ev as unknown as Record<string, unknown>).payload ?? {}) as Record<string, unknown>);
        return;
      case 'webhook.called':
        await this.bots.get(id)?.runWebhook(ev as unknown as WebhookCall);
        return;
      case 'timed.changed':
        this.bots.get(id)?.reloadTimed();
        return;
      case 'bot.presence':
        this.bots.get(id)?.applyPresence();
        return;
      case 'module.changed': {
        // Plugin settings (module "plugin:<id>"): the running plugin gets them at once.
        const module = String((ev as unknown as Record<string, unknown>).module ?? '');
        if (module.startsWith('plugin:')) this.deps.plugins?.refreshConfig(id, module.slice('plugin:'.length));
        await this.bots.get(id)?.reload();
        return;
      }
      case 'command.saved':
      case 'command.deleted':
      case 'commands.changed':
        await this.bots.get(id)?.reload();
        return;
      default:
        log.debug('unknown event', { type: ev.type });
    }
  }

  async handleJob(job: { type: string; botId?: number }): Promise<JobResult> {
    const id = job.botId;
    if (typeof id !== 'number') return { ok: false, errorKey: 'error.job.invalid' };
    try {
      if (job.type === 'message.send') {
        const j = job as { templateId?: unknown; target?: unknown };
        const bot = this.bots.get(id);
        if (!bot) return { ok: false, errorKey: 'error.bot.not_running' };
        if (typeof j.templateId !== 'number' || typeof j.target !== 'string') return { ok: false, errorKey: 'error.job.invalid' };
        await bot.sendTemplate(j.templateId, j.target);
        return { ok: true };
      }
      if (job.type === 'bot.start' || job.type === 'bot.restart') await this.start(id);
      else if (job.type === 'bot.stop') await this.stop(id);
      else return { ok: false, errorKey: 'error.job.unknown' };
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      return { ok: false, errorKey: msg.startsWith('error.') ? msg : 'error.bot.start_failed' };
    }
  }
}
