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

/** REDIS_URL with the password of KEYS_DIR/redis.pass (written by the redis service), unless the URL has one. */
export function redisUrlOf(env: NodeJS.ProcessEnv, readPass: (file: string) => string | null = readPassFile): string {
  const url = env.REDIS_URL || 'redis://127.0.0.1:6379';
  if (url.includes('@') || !env.KEYS_DIR) return url;
  const pass = readPass(join(env.KEYS_DIR, 'redis.pass'));
  return pass ? url.replace(/^redis:\/\//, `redis://:${encodeURIComponent(pass)}@`) : url;
}

function readPassFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env): Config {
  const dataDir = env.DATA_DIR || '/data';
  return {
    dataDir,
    sharedDir: env.SHARED_DIR || '/shared',
    redisUrl: redisUrlOf(env),
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
