---
title: Custom and timed events
summary: Run blocks when something happens on Discord, or on a schedule.
---
## Custom events

**Custom Events** (Modules → Utility) work like commands, but start on something that happens on Discord:

- a member joins or leaves, gets or loses a role,
- a message is sent, edited, deleted or gets a reaction,
- someone joins a voice channel,
- a button or select menu of the bot is used,
- a Data Storage variable changes, and more.

The trigger block of the event gives the matching placeholders, e.g. `{message.content}` or `{member.id}`.

## Timed events

**Timed Events** (Modules → Utility) are schedules: an **interval** (at least 10 seconds) or **times of day** (up to 24, e.g. `08:00, 20:30`) on chosen **weekdays**. A timed event starts every custom event of the type *When a timed event runs* that picked it; `{schedule.name}` and `{schedule.next}` are available there.

The time settings of the page hold the **time zone** (modules like the economy lottery use it too) and a **default server**: timed events run there, and `{DEFAULT_SERVER}` can be used in any server ID field.

> [!TIP]
> A timed event has no member and no channel by itself: choose the channel in the blocks that send something.
