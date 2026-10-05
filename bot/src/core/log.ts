// JSON lines on stdout; the container runtime collects them. Never log
// tokens or other secrets (the leak guard masks them anyway).

import { redact } from './leakguard.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }, (_key, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(redact(line) + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.BOTHUB_DEBUG) write('debug', msg, fields);
  },
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
