---
title: Data Storage
summary: Your own variables for counters, lists and settings.
---
**Data Storage** (Modules → Utility) holds your own variables.

## A variable

- **Key**: `a-z`, `0-9` and `_`, used as `{var.<key>}`.
- **Type**: text, number, list, object or a list of objects.
- **Owner**: one value for everything, **one per member** or **one per channel**.
- **Per server**: separate values per server (default) or one for all.
- **Default value**.

## Use it

In the builders there are blocks to **set**, **change** (add, subtract, append to a list), **read** and **reset** variables. The Data Storage page shows the stored values and lets you edit them by hand.

Plugins can create their own variables too (for example the Work plugin). They show up in their own group.

> [!NOTE]
> An event *variable changed* lets you react to changes, e.g. give a role when a counter reaches 100.
