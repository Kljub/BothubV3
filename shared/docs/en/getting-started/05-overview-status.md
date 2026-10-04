---
title: Overview, status and logs
summary: Usage numbers, the bot's presence and what went wrong.
---
## Overview

The **Overview** of a bot shows tiles with the totals and one small chart per number:

- **New members** (joins and leaves), **Active users** (who wrote, used a command or was in voice), **Messages**, **Voice minutes**, **Moderation** (commands and AutoMod), **Commands**, **Plugin usages**.
- Hover a point of a chart to see its value and time.
- Filter by **server** and **time range** (24 hours, 7 days, 30 days or your own range).
- Below: the top commands, top plugins and top moderation actions.

The numbers are kept for 35 days.

## Status

Under **Status** you set how the bot appears in Discord:

- **Online status** (online, idle, do not disturb, invisible).
- **Activity** like *Playing …* or *Watching …*, or a **custom status** with an emoji.
- **Rotation**: several entries that change at an interval. Variables like `{servers}` are filled in.
- **Profile**: bio and pronouns of the bot.

## Logs

**Logs** lists what happened: starts, errors of commands and events, missing permissions, problems of plugins. Every entry has a code (e.g. `WAR-2002`) and a readable text. Use the filter to show only warnings and errors.

> [!TIP]
> A command does nothing? Look at the logs first: usually a permission of the bot or a missing setting is the reason.
