# BotHub Plugin SDK (v1)

Plugins add builder blocks to BotHub. They run **sandboxed**: every plugin
runs for every bot in its own process, and the only way out is the SDK
manager in the bot. A plugin never gets a database connection, the bot token,
environment variables, the network or files outside its own folder.

## Files of a plugin

The plugin file is `bothub.json`; the folder layout (commands, events,
services, nodes, dashboard, lang, sounds) and the fields are described in
[shared/plugin-format.md](../shared/plugin-format.md), the schema is
`shared/plugin-manifest.schema.json`. A ready template, a scaffolder and
example plugins live in the market repo (BothubMarketPlace).

`index.js` (`main`) joins everything into one `definePlugin({ blocks, events,
tasks })` and may import other files of its own folder. It cannot import
`node:net`, `node:http(s)`, `node:child_process`, `node:worker_threads`,
`node:module`, `node:sqlite` and similar modules, and `fetch` does not exist.

- **events**: names from `bothub.json` "events" (needs `discord.events`); the
  handler gets a plain JSON payload with the builder variable names
  (`server.id`, `user.name`, `user.bot` as boolean …).
- **tasks**: `services.tasks` with `every` (min. 1m) or `cron` (UTC), needs
  `scheduler`.
- **API endpoints**: `ctx.http.endpoint(key, {method, path, query, json,
  headers})` for endpoints in `services.endpoints` that the admin shared with
  the plugin; the bot adds the key, the plugin never sees it.
- **voice**: `ctx.voice.join/leave/play/stop/state`; `play` takes a file of
  the plugin folder (`sounds/<name>.ogg|mp3|wav`, max. 10 MB), never a URL.

## Permissions and SDK policies

Every call belongs to a permission of `shared/sdk-permissions.json` (the full
list with status is in [API.md](API.md)). Core calls (plugin info, logger,
config, utils, locale, resources, rate limits) need none. For every other call
the permission must be

1. declared in the plugin's `bothub-plugin.json`, and
2. switched on in **admin > SDK Policies**. The switches are global for all
   bots and plugins. Default: risk low = on, medium and high = off.

Otherwise the call fails with `sdk.call.denied`. Planned calls answer
`sdk.call.not_available`.

## Installation

Plugins are installed **globally** (one version for all bots). Per bot a
plugin can be switched off; nothing else is set per bot.

## Limits (shared/sdk-permissions.json)

- 64 MB memory per plugin process, no code from strings (`eval`, `new Function`).
- 50 calls per second, 64 KB per message, 5 s per call, 10 s per block.
- Storage: 1,000 keys, 16 KB per value, 1 MB per plugin and bot.
- Discord: 5 messages per 5 seconds; mentions are not pinged.
- Lifecycle: `onLoad`, `onEnable` when the plugin starts for a bot; `onDisable`,
  `onUnload` when it stops (1 second, then the process ends).
- A block that does not answer in time is stopped and the plugin restarted;
  after 3 restarts in 10 minutes the plugin is switched off for the bot.

## The plugin

```js
/** @type {import('@bothub/sdk').PluginDefinition} */
export default {
  async onEnable(ctx) {
    await ctx.logger.info(`${ctx.plugin.getId()} started`);
  },
  blocks: {
    async count(ctx, { config, vars }) {
      const key = `${vars['server.id']}:${config.counter}`;
      const n = await ctx.storage.increment(key);
      return { results: { '': String(n) } }; // {Var1} in later blocks
    },
  },
};
```

A block gets its `config` with placeholders already filled in and the run's
variables in `vars`. It returns `results` (stored under the block's variable,
`''` → `{Var1}`, `'.count'` → `{Var1.count}`) and optionally `port`, the
output to continue at (default `next`).

Types: `src/index.ts` (`PluginContext`, `BlockInput`, `BlockResult`,
`definePlugin`). A complete example is in `examples/counter/`.

## How the sandbox works

- `node --permission` with read access only to the plugin folder, no write,
  no child processes, no workers, no native addons.
- Empty environment; the host clears `process.env` again.
- Node 24 has no network permission, so the host removes `fetch` and
  `WebSocket` and refuses the network, process and loader modules before the
  plugin loads.
- The process is not trusted: the manager (bot/src/sdk/process.ts) checks
  every call for shape, size, rate and permission. The bot ID of a call is
  set by the manager, never by the plugin.
