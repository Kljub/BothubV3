// Example BotHub plugin. The default export is what definePlugin() returns:
// a plain object, so the plugin needs no build step and no node_modules.
// API: sdk/API.md, types: @bothub/sdk (sdk/src/index.ts).

/** @type {import('@bothub/sdk').PluginDefinition} */
export default {
  async onEnable(ctx) {
    await ctx.logger.info(`${ctx.plugin.getId()} ${ctx.plugin.getVersion()} enabled for bot ${ctx.botId}`);
  },

  blocks: {
    // Block plugin.counter.count: counts per server and counter name.
    async count(ctx, { config, vars }) {
      const key = `${vars['server.id'] || 'dm'}:${String(config.counter || 'default').slice(0, 40)}`;
      const next = await ctx.storage.increment(key);
      return { results: { '': String(next) } };
    },
  },
};
