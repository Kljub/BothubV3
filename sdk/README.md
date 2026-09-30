# BotHub Plugin SDK (v1)

Plugins add builder blocks to BotHub. They run **sandboxed**: every plugin
runs for every bot in its own process, and the only way out is the SDK
manager in the bot. A plugin never gets a database connection, the bot token,
environment variables, the network or files outside its own folder.

## Files of a plugin

```
my-plugin/
├── bothub-plugin.json   manifest (shared/plugin-manifest.schema.json)
└── index.js             ES module, default export = the plugin
```

`index.js` may import other files of its own folder. It cannot import
`node:net`, `node:http(s)`, `node:child_process`, `node:worker_threads`,
`node:module`, `node:sqlite` and similar modules, and `fetch` does not exist.

## Manifest

```json
{
  "id": "counter",
  "name": "Counter",
  "version": "1.0.0",
  "sdk": 1,
  "main": "index.js",
  "permissions": ["storage", "log"],
  "blocks": [{ "name": "count", "definition": { "labelKey": "Count up", "inputs": [], "outputs": [], "config": {} } }]
}
```

A block `count` of plugin `counter` becomes the node type
`plugin.counter.count` in the builder. `definition` is a node definition as
in `shared/node-definition.schema.json` (ports, config, results).

## Permissions

| Permission | Calls |
|---|---|
| `storage` | `ctx.storage.get/set/delete/list`: key-value storage of the plugin for this bot |
| `discord.send_messages` | `ctx.discord.sendMessage(channelId, message)` |
| `discord.guild_info` | `ctx.discord.guildInfo(guildId)`: name and member count of a server of the bot |
| `log` | `ctx.log(level, text)`: entry in the bot log |

A call works only when the permission is declared in the manifest **and**
granted by the user for the bot **and** allowed by the admin's SDK policy.
Otherwise it fails with `sdk.call.denied`.

## Limits (shared/sdk-permissions.json)

- 64 MB memory per plugin process, no code from strings (`eval`, `new Function`).
- 50 calls per second, 64 KB per message, 5 s per call, 10 s per block.
- Storage: 1,000 keys, 16 KB per value, 1 MB per plugin and bot.
- Discord: 5 messages per 5 seconds; mentions are not pinged.
- A block that does not answer in time is stopped and the plugin restarted;
  after 3 restarts in 10 minutes the plugin is switched off for the bot.

## The plugin

```js
/** @type {import('@bothub/sdk').PluginDefinition} */
export default {
  async start(ctx) {
    await ctx.log('info', 'started');
  },
  blocks: {
    async count(ctx, { config, vars }) {
      const key = `${vars['server.id']}:${config.counter}`;
      const n = Number((await ctx.storage.get(key)) ?? '0') + 1;
      await ctx.storage.set(key, String(n));
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
