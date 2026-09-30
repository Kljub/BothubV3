// Settings come only from ENV, so the same code runs in docker-compose and
// later in the single AMP image (plan.md).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  dataDir: string;
  sharedDir: string;
  redisUrl: string;
  dbPath: string;
  consumerName: string;
}

export function loadConfig(env = process.env): Config {
  const dataDir = env.DATA_DIR || '/data';
  return {
    dataDir,
    sharedDir: env.SHARED_DIR || '/shared',
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    dbPath: join(dataDir, 'bothub.sqlite'),
    consumerName: env.HOSTNAME || 'bot',
  };
}

/** Reads a JSON file from shared/ (node definitions, limits, schema version). */
export function readShared<T>(config: Config, file: string): T {
  return JSON.parse(readFileSync(join(config.sharedDir, file), 'utf8')) as T;
}

export interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxSteps: number;
  maxLoopIterations: number;
  maxRuntimeMs: number;
  maxDiscordCallsPerRun: number;
}
