// Example BotHub plugin. The default export is what definePlugin() returns:
// a plain object, so the plugin needs no build step and no node_modules.
// Types: see @bothub/sdk (sdk/src/index.ts).

/** @type {import('@bothub/sdk').PluginDefinition} */
export default {
  async start(ctx) {
    await ctx.log('info', `Counter plugin started for bot ${ctx.botId}`);
  },

  blocks: {
    // Block plugin.counter.count: counts per server and counter name.
    async count(ctx, { config, vars }) {
      const key = `${vars['server.id'] || 'dm'}:${String(config.counter || 'default').slice(0, 40)}`;
      const next = Number((await ctx.storage.get(key)) ?? '0') + 1;
      await ctx.storage.set(key, String(next));
      return { results: { '': String(next) } };
    },
  },
};
