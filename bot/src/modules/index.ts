// Binds the ready-made modules to a bot's Discord client. Called once per
// client from BotInstance.login(); every handler checks whether its module
// is on and set up, so an unconfigured module does nothing.

import { Events, type Client } from 'discord.js';
import { log } from '../core/log.js';
import { cacheInvites, inviteChanged, inviteJoin, inviteLeave, levelingLeave, levelingMessage, levelingVoice, levelingVoiceInit, prepareReactionRoles, reactionRoles, suggestionMessage, suggestionVote } from './community.js';
import { automodHit, automodMedia, syncAutomod } from './automod.js';
import type { ModuleContext } from './context.js';
import { onCountingMessage, onStarReaction } from './games.js';
import { onBan, onMemberAdd, onMemberRemove } from './members.js';
import { ensureStickies, onMessage } from './messages.js';
import { globalChat, tempVoice } from './social.js';
import { ensurePanels, modmailMessage, onModuleInteraction } from './support.js';
import { ensureHoneypots, honeypotMessage } from './honeypot.js';
import { ModuleTimers } from './timers.js';
import { messageReward, syncCurrencies } from './economy.js';
import { afkMessage } from './afk.js';
import { thanksMessage } from './thanks.js';
import { linkfixMessage } from './linkfix.js';

export { ModuleContext } from './context.js';

const timers = new WeakMap<ModuleContext, ModuleTimers>();

export function bindModules(client: Client, ctx: ModuleContext, timezone: () => string): void {
  const guard = (name: string, p: Promise<unknown> | void) =>
    void Promise.resolve(p).catch((err) => log.warn('module handler failed', { botId: ctx.botId, handler: name, err: String(err) }));

  timers.get(ctx)?.stop();
  const t = new ModuleTimers(ctx, timezone);
  timers.set(ctx, t);

  syncCurrencies(ctx);
  client.once(Events.ClientReady, (c) => {
    t.start(c);
    const guilds = [...c.guilds.cache.values()];
    for (const g of guilds) guard('invites', cacheInvites(ctx, g));
    guard('reaction-roles', prepareReactionRoles(ctx, guilds));
    guard('panels', ensurePanels(ctx, guilds));
    guard('honeypot', ensureHoneypots(ctx, guilds));
    for (const g of guilds) guard('automod', syncAutomod(ctx, g));
    guard('stickies', ensureStickies(ctx, guilds));
    levelingVoiceInit(ctx, guilds);
  });
  ctx.onChange = () => {
    syncCurrencies(ctx);
    if (!client.isReady()) return;
    const guilds = [...client.guilds.cache.values()];
    guard('reaction-roles', prepareReactionRoles(ctx, guilds));
    guard('panels', ensurePanels(ctx, guilds));
    guard('honeypot', ensureHoneypots(ctx, guilds));
    for (const g of guilds) guard('automod', syncAutomod(ctx, g));
    guard('stickies', ensureStickies(ctx, guilds));
  };
  client.on(Events.AutoModerationActionExecution, (e) => guard('automod-hit', automodHit(ctx, e)));
  client.on(Events.InteractionCreate, (i) => guard('interaction', onModuleInteraction(ctx, i)));
  client.on(Events.GuildCreate, (g) => {
    guard('invites', cacheInvites(ctx, g));
    guard('automod', syncAutomod(ctx, g));
  });
  client.on(Events.InviteCreate, (i) => inviteChanged(ctx, i));
  client.on(Events.InviteDelete, (i) => inviteChanged(ctx, i));

  client.on(Events.MessageCreate, (msg) => {
    guard('message', onMessage(ctx, msg));
    guard('counting', onCountingMessage(ctx, msg));
    guard('leveling', levelingMessage(ctx, msg));
    guard('suggestions', suggestionMessage(ctx, msg));
    guard('global-chat', globalChat(ctx, msg));
    guard('modmail', modmailMessage(ctx, msg));
    guard('honeypot', honeypotMessage(ctx, msg));
    guard('automod-media', automodMedia(ctx, msg));
    guard('twitter-linkfix', linkfixMessage(ctx, msg));
    guard('economy-messages', messageReward(ctx, msg));
    guard('afk', afkMessage(ctx, msg));
    guard('thanks', thanksMessage(ctx, msg));
  });
  client.on(Events.MessageUpdate, (old, msg) => {
    // Link previews arrive with an edit: the media filter checks them then.
    if (msg.embeds.length > (old.partial ? 0 : old.embeds.length) || msg.attachments.size > (old.partial ? 0 : old.attachments.size)) {
      guard('automod-media', automodMedia(ctx, msg));
    }
    // Media channels also check edited messages (text added later).
    if (!msg.partial && ctx.enabled('media-channels')) guard('message-edit', onMessage(ctx, msg, true));
  });
  client.on(Events.GuildMemberAdd, (m) => {
    guard('member-add', onMemberAdd(ctx, m));
    guard('invite-join', inviteJoin(ctx, m));
  });
  client.on(Events.GuildMemberRemove, (m) => {
    guard('member-remove', onMemberRemove(ctx, m));
    guard('invite-leave', inviteLeave(ctx, m));
    guard('leveling-leave', levelingLeave(ctx, m));
  });
  client.on(Events.GuildBanAdd, (ban) => guard('ban', onBan(ctx, ban)));
  client.on(Events.MessageReactionAdd, (r, u) => {
    guard('star-add', onStarReaction(ctx, r, u));
    guard('reaction-role-add', reactionRoles(ctx, r, u, true));
    guard('suggestion-vote', suggestionVote(ctx, r, u));
  });
  client.on(Events.MessageReactionRemove, (r, u) => {
    guard('star-remove', onStarReaction(ctx, r, u));
    guard('reaction-role-remove', reactionRoles(ctx, r, u, false));
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    guard('leveling-voice', levelingVoice(ctx, before, after));
    guard('temp-voice', tempVoice(ctx, before, after));
  });
}
