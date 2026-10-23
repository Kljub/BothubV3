// The bot's own webhook per channel, for messages "as someone" (Send
// Message with another sender, Counting in webhook mode). A thread posts
// through the webhook of its parent channel.

import { PermissionFlagsBits, type Channel, type Client, type Webhook } from 'discord.js';

const HOOK_NAME = 'BotHub';
const cache = new Map<string, Webhook>();

export interface HookTarget {
  hook: Webhook;
  /** Set when the message goes into a thread of the hook's channel. */
  threadId?: string;
}

/** Can the bot post through a webhook in this channel (Manage Webhooks)? */
export function canUseWebhook(channel: Channel): boolean {
  const parent = channel.isThread() ? channel.parent : channel;
  if (!parent || !('permissionsFor' in parent) || !('fetchWebhooks' in parent)) return false;
  return parent.permissionsFor(channel.client.user)?.has(PermissionFlagsBits.ManageWebhooks) ?? false;
}

/** The bot's webhook in the channel (reused, else created); null when the channel cannot have one. */
export async function ownWebhook(channel: Channel): Promise<HookTarget | null> {
  const parent = channel.isThread() ? channel.parent : channel;
  if (!parent || !('fetchWebhooks' in parent) || !('createWebhook' in parent)) return null;
  const threadId = channel.isThread() ? channel.id : undefined;
  const cached = cache.get(parent.id);
  if (cached) return { hook: cached, threadId };
  const me = channel.client.user.id;
  const list = await parent.fetchWebhooks();
  // Older webhooks of the bot (e.g. "BotHub Counting") are reused too.
  const hook = list.find((h) => h.owner?.id === me && h.token && h.name === HOOK_NAME) ?? list.find((h) => h.owner?.id === me && h.token) ?? (await parent.createWebhook({ name: HOOK_NAME }));
  cache.set(parent.id, hook);
  return { hook, threadId };
}

/** The bot's webhook that sent this message, or null (another sender, or the hook is gone). */
export async function webhookOf(client: Client, channel: Channel, webhookId: string): Promise<HookTarget | null> {
  const own = await ownWebhook(channel).catch(() => null);
  if (own && own.hook.id === webhookId) return own;
  const hook = await client.fetchWebhook(webhookId).catch(() => null);
  if (!hook || hook.owner?.id !== client.user?.id || !hook.token) return null;
  return { hook, threadId: channel.isThread() ? channel.id : undefined };
}

/** A webhook was deleted on Discord: the next message creates a new one. */
export function forgetWebhook(channelId: string): void {
  cache.delete(channelId);
}
