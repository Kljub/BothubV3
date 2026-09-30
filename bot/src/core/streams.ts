// Redis Streams consumer (shared/streams.json). Streams instead of Pub/Sub,
// so events are not lost while the bot restarts. Entries are acknowledged
// after they were handled; a failed entry is logged and acknowledged too, so
// one bad entry cannot block the stream.

import { createClient } from 'redis';
import { log } from './log.js';

export const STREAM_EVENTS = 'bothub:events';
export const STREAM_JOBS = 'bothub:jobs';
export const STREAM_RESULTS = 'bothub:results';
const GROUP = 'bot';

type RedisClient = ReturnType<typeof createClient>;
type Handler = (data: Record<string, unknown>) => Promise<void>;

export class StreamConsumer {
  private client: RedisClient;
  private stopped = false;

  constructor(
    url: string,
    private readonly consumer: string,
  ) {
    this.client = createClient({ url });
    this.client.on('error', (err) => log.warn('redis error', { err }));
  }

  async connect(): Promise<void> {
    await this.client.connect();
    for (const stream of [STREAM_EVENTS, STREAM_JOBS]) {
      try {
        await this.client.xGroupCreate(stream, GROUP, '$', { MKSTREAM: true });
      } catch (err) {
        if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
      }
    }
  }

  async publishResult(result: Record<string, unknown>): Promise<void> {
    await this.client.xAdd(STREAM_RESULTS, '*', { data: JSON.stringify(result) }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 10_000 } });
  }

  /** Reads both streams until stop(); pending entries of this consumer first. */
  async run(handlers: Record<string, Handler>): Promise<void> {
    const streams = Object.keys(handlers);
    // "0" re-delivers entries this consumer read but did not acknowledge (crash).
    let ids = Object.fromEntries(streams.map((s) => [s, '0']));
    while (!this.stopped) {
      let reply;
      try {
        reply = await this.client.xReadGroup(GROUP, this.consumer, streams.map((key) => ({ key, id: ids[key]! })), { COUNT: 50, BLOCK: 5000 });
      } catch (err) {
        if (this.stopped) return;
        log.warn('stream read failed, retrying', { err });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const list = (reply ?? []) as { name: string; messages: { id: string; message: Record<string, string> }[] }[];
      let sawPending = false;
      for (const stream of list) {
        if (ids[stream.name] === '0' && stream.messages.length === 0) ids[stream.name] = '>';
        for (const entry of stream.messages) {
          sawPending ||= ids[stream.name] === '0';
          try {
            await handlers[stream.name]!(JSON.parse(entry.message.data ?? '{}') as Record<string, unknown>);
          } catch (err) {
            log.error('stream entry failed', { stream: stream.name, id: entry.id, err });
          }
          await this.client.xAck(stream.name, GROUP, entry.id);
        }
      }
      if (!sawPending) ids = Object.fromEntries(streams.map((s) => [s, '>']));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client.quit().catch(() => undefined);
  }
}
