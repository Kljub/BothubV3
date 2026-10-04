---
title: Command Builder
summary: Build your own slash commands from blocks, without code.
---
The **Command Builder** (Modules → Utility) is where you create your own commands. A command is a **graph**: blocks connected by lines, from the trigger to the answer.

## Create a command

1. Open **Command Builder** and click **New command**.
2. The **trigger** block holds the name and description (`/hello`). Add **options** (text, number, user, channel, role, choice, attachment) by connecting option blocks to it.
3. Drag blocks from the left list onto the canvas and connect them: **actions** (send a message, give a role, …), **conditions** (if/else), **variables** and the blocks of the modules and plugins.
4. **Save**. Switch the command on in the list; Discord shows it after a few seconds.

## Trigger settings

- **Hide replies**: only the user sees the answers.
- **Visibility option**: the name of a choice option with *Public* and *Only me*: the member picks per use who sees the answer.
- **Cooldown** per user, server or for everyone.
- **Permissions**: allowed and banned roles, required permissions, banned channels.
- **Command type**: slash command, or a right-click menu on a user or a message.

## Groups and versions

Commands can be sorted into **groups**. Every save keeps a version; an older one can be restored. Deleted commands stay under *Recently deleted* for 30 days.

## Errors

Connect an **Error handler** block to show something when a block fails, for example `❌ {error}`. `{error}` holds a readable reason.

Next: [Variables and blocks](/docs/builder/variables).
