# BotHub SDK v1: API

Generated from `shared/sdk-permissions.json` by `sdk/scripts/api-doc.mjs`; do not edit by hand.

Call a function as `ctx.<area>.<name>(...)`. A call needs its permission declared in `bothub-plugin.json` and switched on in the SDK policies (admin). Planned calls exist already and answer `sdk.call.not_available`.

**Status:** 144 of 233 calls available.

Events (`discord.events`, `bothub.events`): messageCreate, messageUpdate, messageDelete, reactionAdd, reactionRemove; guildMemberAdd, guildMemberRemove, guildMemberUpdate; guildCreate, guildDelete, channelCreate, channelDelete, channelUpdate, roleCreate, roleDelete, roleUpdate; voiceStateUpdate; interactionCreate; bot.ready, bot.start, bot.stop, bot.restart, bot.shutdown, plugin.load, plugin.enable, plugin.disable, plugin.unload.

## plugin

| Call | Permission | Risk | Status |
|---|---|---|---|
| `plugin.getInfo()` | core (always) |  | ✅ |
| `plugin.getId()` | core (always) |  | ✅ |
| `plugin.getVersion()` | core (always) |  | ✅ |
| `plugin.getConfig()` | core (always) |  | ✅ |
| `plugin.isEnabled()` | core (always) |  | ✅ |
| `plugin.getPath()` | core (always) |  | ✅ |
| `plugin.getManifest()` | core (always) |  | ✅ |

## logger

| Call | Permission | Risk | Status |
|---|---|---|---|
| `logger.debug()` | core (always) |  | ✅ |
| `logger.info()` | core (always) |  | ✅ |
| `logger.warn()` | core (always) |  | ✅ |
| `logger.error()` | core (always) |  | ✅ |
| `logger.success()` | core (always) |  | ✅ |

## config

| Call | Permission | Risk | Status |
|---|---|---|---|
| `config.get()` | core (always) |  | ✅ |
| `config.set()` | core (always) |  | ✅ |
| `config.has()` | core (always) |  | ✅ |
| `config.delete()` | core (always) |  | ✅ |
| `config.setOptions()` | core (always) |  | ✅ |
| `config.getAll()` | core (always) |  | ✅ |
| `config.checkAccess()` | core (always) |  | ✅ |

## utils

| Call | Permission | Risk | Status |
|---|---|---|---|
| `utils.uuid()` | core (always) |  | ✅ |
| `utils.random()` | core (always) |  | ✅ |
| `utils.hash()` | core (always) |  | ✅ |
| `utils.formatDate()` | core (always) |  | ✅ |
| `utils.formatDuration()` | core (always) |  | ✅ |
| `utils.formatNumber()` | core (always) |  | ✅ |
| `utils.validate()` | core (always) |  | 🕓 planned |

## locale

| Call | Permission | Risk | Status |
|---|---|---|---|
| `locale.get()` | core (always) |  | 🕓 planned |
| `locale.translate()` | core (always) |  | 🕓 planned |
| `locale.has()` | core (always) |  | 🕓 planned |
| `locale.getAvailable()` | core (always) |  | 🕓 planned |

## rateLimit

| Call | Permission | Risk | Status |
|---|---|---|---|
| `rateLimit.check()` | core (always) |  | 🕓 planned |
| `rateLimit.consume()` | core (always) |  | 🕓 planned |
| `rateLimit.reset()` | core (always) |  | 🕓 planned |

## resources

| Call | Permission | Risk | Status |
|---|---|---|---|
| `resources.readFile()` | core (always) |  | 🕓 planned |
| `resources.exists()` | core (always) |  | 🕓 planned |
| `resources.getPath()` | core (always) |  | 🕓 planned |
| `resources.usage()` | resources.usage | low | 🕓 planned |

## guild

| Call | Permission | Risk | Status |
|---|---|---|---|
| `guild.getMembers()` | discord.members.read | medium | ✅ |
| `guild.get()` | discord.guilds.read | low | ✅ |
| `guild.list()` | discord.guilds.read | low | ✅ |
| `guild.getChannels()` | discord.guilds.read | low | ✅ |
| `guild.getRoles()` | discord.guilds.read | low | ✅ |
| `guild.getEmojis()` | discord.guilds.read | low | ✅ |
| `guild.getSettings()` | discord.server.read | low | 🕓 planned |
| `guild.edit()` | discord.server.manage | high | 🕓 planned |
| `guild.snapshot()` | discord.server.backup | medium | ✅ |
| `guild.restore()` | discord.server.restore | high | ✅ |

## member

| Call | Permission | Risk | Status |
|---|---|---|---|
| `member.get()` | discord.members.read | medium | ✅ |
| `member.list()` | discord.members.read | medium | ✅ |
| `member.getPresence()` | discord.members.presence | medium | 🕓 planned |
| `member.setNickname()` | discord.members.nicknames | medium | ✅ |
| `member.timeout()` | discord.members.timeout | high | ✅ |
| `member.kick()` | discord.members.kick | high | ✅ |
| `member.ban()` | discord.members.ban | high | ✅ |
| `member.unban()` | discord.members.ban | high | ✅ |
| `member.addRole()` | discord.roles.assign | high | ✅ |
| `member.removeRole()` | discord.roles.assign | high | ✅ |
| `member.voiceMute()` | discord.voice.mute | high | ✅ |
| `member.voiceDeafen()` | discord.voice.mute | high | ✅ |
| `member.voiceMove()` | discord.voice.move | high | ✅ |
| `member.voiceDisconnect()` | discord.voice.move | high | ✅ |

## message

| Call | Permission | Risk | Status |
|---|---|---|---|
| `message.get()` | discord.messages.read | medium | ✅ |
| `message.getAttachments()` | discord.messages.attachments | medium | 🕓 planned |
| `message.send()` | discord.messages.send | medium | ✅ |
| `message.dm()` | discord.messages.send | medium | ✅ |
| `message.sendFile()` | discord.messages.files | medium | ✅ |
| `message.react()` | discord.messages.react | low | ✅ |
| `message.pin()` | discord.messages.pin | medium | ✅ |
| `message.unpin()` | discord.messages.pin | medium | ✅ |
| `message.edit()` | discord.messages.edit | medium | ✅ |
| `message.delete()` | discord.messages.edit | medium | ✅ |

## channel

| Call | Permission | Risk | Status |
|---|---|---|---|
| `channel.get()` | discord.channels.read | low | ✅ |
| `channel.list()` | discord.channels.read | low | ✅ |
| `channel.create()` | discord.channels.write | high | ✅ |
| `channel.edit()` | discord.channels.write | high | ✅ |
| `channel.delete()` | discord.channels.write | high | ✅ |
| `channel.setPermissions()` | discord.channels.permissions | high | ✅ |

## invite

| Call | Permission | Risk | Status |
|---|---|---|---|
| `invite.list()` | discord.invites.manage | medium | 🕓 planned |
| `invite.create()` | discord.invites.manage | medium | 🕓 planned |
| `invite.delete()` | discord.invites.manage | medium | 🕓 planned |

## role

| Call | Permission | Risk | Status |
|---|---|---|---|
| `role.get()` | discord.roles.read | low | ✅ |
| `role.list()` | discord.roles.read | low | ✅ |
| `role.addToMember()` | discord.roles.assign | high | ✅ |
| `role.removeFromMember()` | discord.roles.assign | high | ✅ |
| `role.create()` | discord.roles.write | high | ✅ |
| `role.edit()` | discord.roles.write | high | ✅ |
| `role.delete()` | discord.roles.write | high | ✅ |

## emoji

| Call | Permission | Risk | Status |
|---|---|---|---|
| `emoji.list()` | discord.emojis.read | low | ✅ |
| `emoji.get()` | discord.emojis.read | low | ✅ |
| `emoji.create()` | discord.emojis.manage | high | ✅ |
| `emoji.delete()` | discord.emojis.manage | high | ✅ |

## voice

| Call | Permission | Risk | Status |
|---|---|---|---|
| `voice.join()` | discord.voice.connect | medium | ✅ |
| `voice.leave()` | discord.voice.connect | medium | ✅ |
| `voice.state()` | discord.voice.connect | medium | ✅ |
| `voice.play()` | discord.voice.speak | medium | ✅ |
| `voice.stop()` | discord.voice.speak | medium | ✅ |

## webhook

| Call | Permission | Risk | Status |
|---|---|---|---|
| `webhook.list()` | discord.webhooks.read | medium | 🕓 planned |
| `webhook.get()` | discord.webhooks.read | medium | 🕓 planned |
| `webhook.create()` | discord.webhooks.create | high | 🕓 planned |
| `webhook.send()` | discord.webhooks.send | medium | 🕓 planned |
| `webhook.edit()` | discord.webhooks.manage | high | 🕓 planned |
| `webhook.delete()` | discord.webhooks.manage | high | 🕓 planned |

## economy

| Call | Permission | Risk | Status |
|---|---|---|---|
| `economy.currencies()` | modules.economy.balance.read | low | ✅ |
| `economy.get()` | modules.economy.balance.read | low | ✅ |
| `economy.bank()` | modules.economy.balance.read | low | ✅ |
| `economy.leaderboard()` | modules.economy.balance.read | low | ✅ |
| `economy.add()` | modules.economy.balance.write | high | ✅ |
| `economy.remove()` | modules.economy.balance.write | high | ✅ |
| `economy.transfer()` | modules.economy.balance.write | high | ✅ |
| `economy.bankTransfer()` | modules.economy.bank.write | high | ✅ |
| `economy.history()` | modules.economy.transactions | medium | 🕓 planned |
| `economy.getSettings()` | modules.economy.settings | high | 🕓 planned |
| `economy.setSettings()` | modules.economy.settings | high | 🕓 planned |

## dashboard

| Call | Permission | Risk | Status |
|---|---|---|---|
| `dashboard.getData()` | dashboard.read | medium | 🕓 planned |
| `dashboard.registerSettings()` | dashboard.settings | medium | 🕓 planned |
| `dashboard.registerPage()` | dashboard.pages | medium | 🕓 planned |
| `dashboard.registerComponent()` | dashboard.pages | medium | 🕓 planned |
| `dashboard.registerMenuItem()` | dashboard.pages | medium | 🕓 planned |
| `dashboard.getRoute()` | dashboard.pages | medium | 🕓 planned |

## events

| Call | Permission | Risk | Status |
|---|---|---|---|
| `events.discord()` | discord.events.messages | medium | ✅ |
| `events.discord()` | discord.events.members | medium | ✅ |
| `events.discord()` | discord.events.server | medium | ✅ |
| `events.discord()` | discord.events.voice | medium | ✅ |
| `events.discord()` | discord.events.interactions | medium | ✅ |
| `events.bothub()` | bothub.events | low | 🕓 planned |
| `events.on()` | events.plugin | low | 🕓 planned |
| `events.once()` | events.plugin | low | 🕓 planned |
| `events.off()` | events.plugin | low | 🕓 planned |
| `events.emit()` | events.plugin | low | 🕓 planned |
| `events.list()` | events.plugin | low | 🕓 planned |

## interaction

| Call | Permission | Risk | Status |
|---|---|---|---|
| `interaction.reply()` | discord.interactions.reply | medium | ✅ |
| `interaction.editReply()` | discord.interactions.reply | medium | ✅ |
| `interaction.deferReply()` | discord.interactions.reply | medium | ✅ |
| `interaction.followUp()` | discord.interactions.reply | medium | ✅ |
| `interaction.respond()` | discord.interactions.reply | medium | 🕓 planned |
| `interaction.update()` | discord.interactions.reply | medium | ✅ |
| `interaction.showModal()` | discord.modals | medium | ✅ |

## files

| Call | Permission | Risk | Status |
|---|---|---|---|
| `files.read()` | files.read | medium | 🕓 planned |
| `files.list()` | files.read | medium | 🕓 planned |
| `files.write()` | files.write | medium | 🕓 planned |
| `files.delete()` | files.delete | medium | 🕓 planned |
| `files.list()` | storage.files | low | ✅ |
| `files.put()` | storage.files | low | ✅ |
| `files.get()` | storage.files | low | ✅ |
| `files.delete()` | storage.files | low | ✅ |
| `files.fromDiscord()` | storage.files | low | ✅ |

## media

| Call | Permission | Risk | Status |
|---|---|---|---|
| `media.upload()` | media.upload | medium | 🕓 planned |

## globalConfig

| Call | Permission | Risk | Status |
|---|---|---|---|
| `globalConfig.get()` | config.global | high | 🕓 planned |
| `globalConfig.set()` | config.global | high | 🕓 planned |

## services

| Call | Permission | Risk | Status |
|---|---|---|---|
| `services.tasks()` | scheduler | low | ✅ |

## scheduler

| Call | Permission | Risk | Status |
|---|---|---|---|
| `scheduler.timeout()` | scheduler | low | 🕓 planned |
| `scheduler.interval()` | scheduler | low | 🕓 planned |
| `scheduler.cron()` | scheduler | low | 🕓 planned |
| `scheduler.every()` | scheduler | low | 🕓 planned |
| `scheduler.cancel()` | scheduler | low | 🕓 planned |
| `scheduler.list()` | scheduler | low | 🕓 planned |

## storage

| Call | Permission | Risk | Status |
|---|---|---|---|
| `storage.get()` | storage | low | ✅ |
| `storage.set()` | storage | low | ✅ |
| `storage.has()` | storage | low | ✅ |
| `storage.delete()` | storage | low | ✅ |
| `storage.increment()` | storage | low | ✅ |
| `storage.decrement()` | storage | low | ✅ |
| `storage.clear()` | storage | low | ✅ |
| `storage.transaction()` | storage | low | 🕓 planned |

## globalStorage

| Call | Permission | Risk | Status |
|---|---|---|---|
| `globalStorage.get()` | storage.global | medium | ✅ |
| `globalStorage.set()` | storage.global | medium | ✅ |
| `globalStorage.has()` | storage.global | medium | ✅ |
| `globalStorage.delete()` | storage.global | medium | ✅ |
| `globalStorage.increment()` | storage.global | medium | ✅ |
| `globalStorage.decrement()` | storage.global | medium | ✅ |
| `globalStorage.clear()` | storage.global | medium | ✅ |

## collection

| Call | Permission | Risk | Status |
|---|---|---|---|
| `collection.create()` | storage.collections | low | 🕓 planned |
| `collection.find()` | storage.collections | low | 🕓 planned |
| `collection.findOne()` | storage.collections | low | 🕓 planned |
| `collection.count()` | storage.collections | low | 🕓 planned |
| `collection.insert()` | storage.collections | low | 🕓 planned |
| `collection.update()` | storage.collections | low | 🕓 planned |
| `collection.upsert()` | storage.collections | low | 🕓 planned |
| `collection.delete()` | storage.collections | low | 🕓 planned |

## variables

| Call | Permission | Risk | Status |
|---|---|---|---|
| `variables.create()` | data.variables | medium | ✅ |
| `variables.delete()` | data.variables | medium | ✅ |
| `variables.list()` | data.variables | medium | ✅ |
| `variables.get()` | data.variables | medium | ✅ |
| `variables.set()` | data.variables | medium | ✅ |
| `variables.reset()` | data.variables | medium | ✅ |

## cache

| Call | Permission | Risk | Status |
|---|---|---|---|
| `cache.get()` | cache | low | 🕓 planned |
| `cache.set()` | cache | low | 🕓 planned |
| `cache.has()` | cache | low | 🕓 planned |
| `cache.delete()` | cache | low | 🕓 planned |
| `cache.clear()` | cache | low | 🕓 planned |
| `cache.increment()` | cache | low | 🕓 planned |
| `cache.decrement()` | cache | low | 🕓 planned |

## module

| Call | Permission | Risk | Status |
|---|---|---|---|
| `module.get()` | modules.read or modules.<module>.read | medium | ✅ |
| `module.getId()` | modules.read or modules.<module>.read | medium | ✅ |
| `module.getName()` | modules.read or modules.<module>.read | medium | ✅ |
| `module.isEnabled()` | modules.read or modules.<module>.read | medium | ✅ |
| `module.getConfig()` | modules.read or modules.<module>.read | medium | ✅ |
| `module.list()` | modules.read or modules.<module>.read | medium | ✅ |

## plugins

| Call | Permission | Risk | Status |
|---|---|---|---|
| `plugins.get()` | plugins.interop | medium | 🕓 planned |
| `plugins.list()` | plugins.interop | medium | 🕓 planned |
| `plugins.isInstalled()` | plugins.interop | medium | 🕓 planned |
| `plugins.isEnabled()` | plugins.interop | medium | 🕓 planned |
| `plugins.getAPI()` | plugins.interop | medium | 🕓 planned |
| `plugins.emit()` | plugins.interop | medium | 🕓 planned |

## commands

| Call | Permission | Risk | Status |
|---|---|---|---|
| `commands.register()` | commands.manage | medium | 🕓 planned |
| `commands.unregister()` | commands.manage | medium | 🕓 planned |
| `commands.get()` | commands.manage | medium | 🕓 planned |
| `commands.list()` | commands.manage | medium | 🕓 planned |
| `commands.isEnabled()` | commands.manage | medium | 🕓 planned |
| `commands.getPermissions()` | commands.manage | medium | 🕓 planned |
| `commands.setPermissions()` | commands.manage | medium | 🕓 planned |

## permissions

| Call | Permission | Risk | Status |
|---|---|---|---|
| `permissions.check()` | permissions.check | low | 🕓 planned |
| `permissions.checkUser()` | permissions.check | low | 🕓 planned |
| `permissions.checkMember()` | permissions.check | low | 🕓 planned |
| `permissions.checkRole()` | permissions.check | low | 🕓 planned |
| `permissions.checkChannel()` | permissions.check | low | 🕓 planned |
| `permissions.require()` | permissions.check | low | 🕓 planned |

## moderation

| Call | Permission | Risk | Status |
|---|---|---|---|
| `moderation.warn()` | modules.moderation.cases | medium | ✅ |
| `moderation.record()` | modules.moderation.cases | medium | ✅ |
| `moderation.history()` | modules.moderation.cases | medium | ✅ |
| `moderation.getCase()` | modules.moderation.cases | medium | ✅ |
| `moderation.note()` | modules.moderation.cases | medium | ✅ |
| `moderation.notes()` | modules.moderation.cases | medium | ✅ |

## audit

| Call | Permission | Risk | Status |
|---|---|---|---|
| `audit.list()` | discord.audit.read | medium | ✅ |

## http

| Call | Permission | Risk | Status |
|---|---|---|---|
| `http.get()` | http.outbound | high | ✅ |
| `http.post()` | http.outbound | high | ✅ |
| `http.put()` | http.outbound | high | ✅ |
| `http.patch()` | http.outbound | high | ✅ |
| `http.delete()` | http.outbound | high | ✅ |
| `http.check()` | http.check | medium | ✅ |
| `http.secret()` | secrets.use | medium | ✅ |

## secrets

| Call | Permission | Risk | Status |
|---|---|---|---|
| `secrets.get()` | secrets.read | high | ✅ |
| `secrets.has()` | secrets.read | high | ✅ |

