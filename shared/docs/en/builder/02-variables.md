---
title: Variables and placeholders
summary: Placeholders like {user.name}, option values, block results and your own data.
---
Texts in blocks and messages may contain **placeholders** in curly braces. The variable picker (the `{}` button next to a field) lists every placeholder that fits there.

## Always there

| Placeholder | Value |
|---|---|
| `{user.id}`, `{user.name}`, `{user.mention}` | The member who used the command or caused the event |
| `{user.avatar}`, `{user.banner}` | Avatar and profile banner; `{user.banner}` is empty without a banner, so an embed leaves the image out |
| `{user.created}`, `{user.account_age}`, `{user.account_days}` | Account created (date), how long ago, and in days |
| `{user.joined}`, `{user.member_since}`, `{user.member_days}` | Joined this server (date), how long ago, and in days |
| `{server.id}`, `{server.name}`, `{server.members}` | The server |
| `{channel.id}`, `{channel.name}`, `{channel.mention}` | The channel |
| `{command.name}` | The command |

## Options

Each option of a command is `{option_<name>}`, for example `{option_reason}`. An option that was left out is empty text.

## Results of blocks

Many blocks give results. A block with the variable name `px` gives `{px}` and often more, like `{px.balance}` or `{px.count}`. The block's info in the builder lists its results.

## Your own data

**Data Storage** variables are written `{var.<key>}`. They can hold one value, one per member or one per channel, separately per server. See [Data Storage](/docs/builder/data-storage).

## Image cards

`{card.<name>}` draws a card of the Card Designer for the member and posts it with the message (in the text or as embed image). Spaces in the name become `_`, e.g. `{card.Welcome_Card}`. The variable picker lists your cards under *Image cards*.

## User menu commands

A command of the type *User menu* (right click on a member → Apps) has the right-clicked member as `{target}`: `{target.mention}`, `{target.avatar}`, `{target.banner}`, `{target.created}`, `{target.account_age}`, `{target.joined}`, `{target.member_since}`, `{target.roles}`, `{target.top_role}` and the other `user` fields. `{user}` stays the member who used the menu. The variable picker shows them under *Right-clicked member*.
