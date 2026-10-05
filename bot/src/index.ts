// BotHub NodeCore: waits for the database, starts all autostart bots and
// follows the Redis streams (events from the API, start/stop jobs).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, readShared, type GraphLimits } from './core/config.js';
import { waitForSchema } from './core/db.js';
import { log } from './core/log.js';
import { BotManager } from './core/manager.js';
import { loadPolicy, PluginManager } from './sdk/manager.js';
import { useCatalog } from './sdk/catalog.js';
import { secretValue } from './core/secrets-global.js';
import { Repo } from './core/repo.js';
import { loadSecretKey } from './core/secrets.js';
import { StreamConsumer, STREAM_EVENTS, STREAM_JOBS } from './core/streams.js';
import { markCleanStop, redisHeartbeatStore, startHeartbeat, type HeartbeatStore } from './core/heartbeat.js';
import { definitions } from './graph/interpreter.js';
import type { NodeDefinition } from './graph/types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const abort = new AbortController();
  let manager: BotManager | undefined;
  let streams: StreamConsumer | undefined;
  let heartbeat: (HeartbeatStore & { close(): Promise<void> }) | undefined;

  const shutdown = async (signal: string) => {
    log.info('bot process stopping', { signal });
    abort.abort();
    if (heartbeat) {
      await markCleanStop(heartbeat).catch((err) => log.warn('clean stop marker failed', { err }));
      await heartbeat.close();
    }
    await streams?.stop();
    await manager?.stopAll();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(signal));
  // All bots share this process: a stray error in one bot must not stop the others.
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));

  log.info('bot process started', { dataDir: config.dataDir });
  const expected = readShared<{ version: number }>(config, 'db-schema.json').version;
  const db = await waitForSchema(config.dbPath, expected, abort.signal);
  log.info('database ready', { schemaVersion: expected });

  const nodeDir = join(config.sharedDir, 'nodes');
  const defs = definitions(readdirSync(nodeDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(nodeDir, f), 'utf8')) as NodeDefinition));
  const limits = readShared<GraphLimits>(config, 'graph-limits.json');
  const repo = new Repo(db);

  // SDK manager: plugins run sandboxed and reach Discord and the database only through it.
  useCatalog(join(config.sharedDir, 'sdk-permissions.json'));
  const sdk = readShared<{ permissions: { key: string; risk: string }[]; limits: ConstructorParameters<typeof PluginManager>[1]['limits'] }>(config, 'sdk-permissions.json');
  const plugins = new PluginManager(db, { pluginsDir: join(config.dataDir, 'plugins'), limits: sdk.limits, modules: readShared<{ modules: { key: string }[] }>(config, 'modules.json').modules.map((m) => m.key), moduleCategories: Object.fromEntries(readShared<{ modules: { key: string; category: string }[] }>(config, 'modules.json').modules.map((m) => [m.key, m.category])), policy: () => loadPolicy(db, sdk.permissions) }, {
    sendMessage: (botId, channelId, message, files) => manager!.instance(botId)?.pluginSend(channelId, message, files) ?? Promise.reject(new Error('error.bot.not_running')),
    guildInfo: async (botId, guildId) => {
      const bot = manager!.instance(botId);
      if (!bot) throw new Error('error.bot.not_running');
      return bot.pluginGuildInfo(guildId);
    },
    guildList: async (botId) => {
      const bot = manager!.instance(botId);
      if (!bot) throw new Error('error.bot.not_running');
      return bot.pluginGuildList();
    },
    secret: (botId, key) => secretValue(repo, () => loadSecretKey(config.dataDir), botId, key),
    voice: (botId) => manager!.instance(botId)?.voice,
    discord: (botId) => manager!.instance(botId)?.pluginApi(),
    log: (botId, level, plugin, text) => {
      if (level === 'info') repo.logUpdate(botId, 'log.update.plugin', { plugin, text });
      else repo.logCode(botId, level === 'error' ? 'ERR-1009' : 'WAR-2009', { plugin, reason: text });
    },
  });

  // The key is read when a bot starts: the API may create it after us.
  const secretKey = () => loadSecretKey(config.dataDir);
  manager = new BotManager(repo, { repo, defs, limits, plugins, secretKey }, secretKey);
  await manager.startAll();
  const idleTimer = setInterval(() => void manager?.stopIdle().catch((err) => log.warn('idle stop failed', { err })), 300_000);
  idleTimer.unref();

  streams = new StreamConsumer(config.redisUrl, config.consumerName);
  await streams.connect();
  const onHeartbeatError = (err: unknown) => log.warn('heartbeat failed', { err });
  heartbeat = await redisHeartbeatStore(config.redisUrl, onHeartbeatError);
  startHeartbeat(heartbeat, () => manager?.runningCount() ?? 0, onHeartbeatError);
  log.info('listening for events and jobs');
  const m = manager;
  const s = streams;
  // Entries are handed to the bot's own queue and acknowledged at once, so
  // one bot's slow start does not hold up the stream for the others. After a
  // crash, startAll() rebuilds the state from the database.
  const botKey = (entry: Record<string, unknown>) => (typeof entry.botId === 'number' ? entry.botId : 0);
  await streams.run({
    [STREAM_EVENTS]: async (ev) => {
      void m.enqueue(botKey(ev), () => m.handleEvent(ev as { type: string; botId?: number })).catch((err) => log.error('event failed', { ev, err }));
    },
    [STREAM_JOBS]: async (job) => {
      if (job.type === 'core.restart') {
        // Resource overview: exit after this entry is acknowledged; Docker or
        // supervisord starts the process again. An old entry (redelivered
        // after the restart) is only acknowledged.
        if (typeof job.requestedAt !== 'number' || Date.now() / 1000 - job.requestedAt > 60) return;
        await s.publishResult({ jobId: job.jobId, ok: true });
        setTimeout(() => void shutdown('restart request'), 1000);
        return;
      }
      void m
        .enqueue(botKey(job), () => m.handleJob(job as { type: string; botId?: number }))
        .then((result) => s.publishResult({ jobId: job.jobId, ...result }))
        .catch((err) => log.error('job failed', { job, err }));
    },
  });
}

main().catch((err) => {
  log.error('bot process failed', { err });
  process.exit(1);
});
