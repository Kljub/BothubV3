// Service "tasks" ("scheduler"): every entry of bothub.json
// "services.tasks" needs a function in `tasks` below.
//   { name, every: "30m" | "6h" | "1d" } or { name, cron: "0 9 * * *" }
// (minimum 1 minute; cron in UTC). The bot runs it like a node (10 s
// timeout); a run that is still busy is skipped, not stacked. There is no
// trigger user or server: read what you need from settings and storage.
import { readJson, writeJson } from './storage.js';
import { setting } from './util.js';

const KEEP_DAYS = 30;

export const tasks = {
  // Posts a short report once a day (09:00 UTC) when a channel is set.
  async daily_report(ctx) {
    const run = await ctx.storage.increment('report:runs');
    const day = new Date().toISOString().slice(0, 10);
    const history = await readJson(ctx, 'report:history', []);
    history.push(day);
    await writeJson(ctx, 'report:history', history.slice(-KEEP_DAYS));

    const channel = setting(ctx, 'report_channel', null);
    if (channel?.id) {
      await ctx.message.send(channel.id, `Daily report #${run} (${day})`);
    }
    await ctx.logger.info(`daily report #${run}`);
  },

  // Drops old entries every 6 hours.
  async cleanup(ctx) {
    const history = await readJson(ctx, 'report:history', []);
    if (history.length > KEEP_DAYS) await writeJson(ctx, 'report:history', history.slice(-KEEP_DAYS));
  },
};
