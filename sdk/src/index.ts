// @bothub/sdk: what a BotHub plugin can use.
//
// A plugin is an ES module whose default export is definePlugin({...}). It
// runs in its own process under the SDK manager of the bot: no database, no
// bot token, no network, no files outside its folder. Everything it may do
// goes through `ctx`, and every call is checked against the permissions the
// user granted for the bot (shared/sdk-permissions.json).

/** Permissions of SDK v1 (bothub-plugin.json "permissions"). */
export type Permission = 'storage' | 'discord.send_messages' | 'discord.guild_info' | 'log';

/** A message like the "Send or Edit a Message" block builds it. */
export interface Message {
  mode?: 'normal' | 'v2';
  content?: string;
  embeds?: Array<{
    color?: string;
    title?: string;
    url?: string;
    description?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text?: string; icon_url?: string };
    image_url?: string;
    thumbnail_url?: string;
    timestamp?: boolean;
  }>;
}

export interface PluginContext {
  /** Bot the call belongs to; storage and Discord calls stay inside it. */
  readonly botId: number;
  /** Plugin settings the user saved for this bot. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Key-value storage of this plugin for this bot (permission "storage"). */
  readonly storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /** Discord through the bot; the plugin never sees the token. */
  readonly discord: {
    /** permission "discord.send_messages"; returns the message ID. */
    sendMessage(channelId: string, message: Message | string): Promise<string>;
    /** permission "discord.guild_info" */
    guildInfo(guildId: string): Promise<{ id: string; name: string; memberCount: number }>;
  };
  /** Writes to the bot log in the dashboard (permission "log"). */
  log(level: 'info' | 'warning' | 'error', text: string): Promise<void>;
}

/** What a builder block of the plugin gets: its config and the run's variables. */
export interface BlockInput {
  /** Block config with placeholders already filled in. */
  config: Record<string, unknown>;
  /** Variables of the run ({user.id} → vars['user.id']). */
  vars: Record<string, string>;
}

export interface BlockResult {
  /** Output port to continue at; default "next". */
  port?: string;
  /** Results stored under the block's variable: '' → {Var1}, '.count' → {Var1.count}. */
  results?: Record<string, string>;
}

export type BlockHandler = (ctx: PluginContext, input: BlockInput) => Promise<BlockResult | void> | BlockResult | void;

export interface PluginDefinition {
  /** Handlers of the blocks in bothub-plugin.json "blocks", by name. */
  blocks?: Record<string, BlockHandler>;
  /** Called once per bot when the plugin starts. */
  start?(ctx: PluginContext): Promise<void> | void;
}

/** Marks the default export of a plugin (keeps types; no runtime logic). */
export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

/** Errors a plugin can throw on purpose; the key shows up in the bot log. */
export class PluginError extends Error {
  constructor(readonly key: string, message?: string) {
    super(message ?? key);
    this.name = 'PluginError';
  }
}
