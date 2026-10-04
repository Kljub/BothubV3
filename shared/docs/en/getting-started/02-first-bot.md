---
title: Add your first bot
summary: Create a Discord application, add its token, invite the bot.
---
## 1. Create the bot at Discord

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Give it a name, open **Bot** and click **Reset Token**. Copy the token: it is shown only once.
3. Under **Privileged Gateway Intents** switch on **Server Members Intent**, **Presence Intent** and **Message Content Intent**. Without them welcome messages, leveling, AutoMod and message rewards cannot see members and messages; the log then shows *Privileged intent … is not enabled*.

> [!WARNING]
> The token is the password of your bot. Never post it anywhere. BotHub stores it encrypted and never shows it again.

## 2. Add it to BotHub

Click the bot switch at the top left, then **+ Add bot**, and paste the token. Name and ID come from Discord. The bot starts at once.

## 3. Invite it to your server

Open **Invite Bot** in the sidebar. The link asks for the permissions the modules need. Pick your server and confirm.

> [!NOTE]
> You need the *Manage Server* permission on that server to add a bot.

## 4. Check that it runs

- The dot next to the bot name is green while it is online.
- **Logs** shows the start and every problem.
- **Server** lists the servers it joined.

Next: [switch on modules](/docs/getting-started/modules).
