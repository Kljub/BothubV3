---
title: Variables and placeholders
summary: Placeholders like {user.name}, option values, block results and your own data.
---
Texts in blocks and messages may contain **placeholders** in curly braces. The variable picker (the `{}` button next to a field) lists every placeholder that fits there.

## Always there

| Placeholder | Value |
|---|---|
| `{user.id}`, `{user.name}`, `{user.mention}` | The member who used the command or caused the event |
| `{server.id}`, `{server.name}`, `{server.members}` | The server |
| `{channel.id}`, `{channel.name}`, `{channel.mention}` | The channel |
| `{command.name}` | The command |

## Options

Each option of a command is `{option_<name>}`, for example `{option_reason}`. An option that was left out is empty text.

## Results of blocks

Many blocks give results. A block with the variable name `px` gives `{px}` and often more, like `{px.balance}` or `{px.count}`. The block's info in the builder lists its results.

## Your own data

**Data Storage** variables are written `{var.<key>}`. They can hold one value, one per member or one per channel, separately per server. See [Data Storage](/docs/builder/data-storage).
