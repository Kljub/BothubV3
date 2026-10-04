---
title: Get your bot verified
summary: What Discord's app verification needs from 75 servers on, and how BotHub helps.
---
A bot can join at most **100 servers** until Discord has **verified** it. You can apply from **75 servers** on. Verified bots get the ✓ badge next to their name.

![The path to a verified app: team, identity, app details, intents, submit](/static/docs/verify-steps.svg)

> [!NOTE]
> Discord changes the details from time to time. The checklist in the **App Verification** tab of your app always shows what is still missing; Discord's own guide: [How Do I Get My App Verified?](https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified)

## 1. Put the app into a team

In the [Developer Portal](https://discord.com/developers/applications) open **Teams**, create a team and transfer the app to it (*Transfer App to Team* in the app settings). The **owner of the team** is the person Discord verifies.

## 2. Two-factor sign-in and identity

- The team owner needs **two-factor authentication** on the Discord account.
- The team owner verifies their **identity** with Discord's provider **Stripe** (photo ID and a selfie). The ID is checked by Stripe, not shown to Discord users.

## 3. App details, Terms and Privacy

The app needs a **name**, an **icon**, a **description** of what it does, and the links to its **Terms of Service** and **Privacy Policy**.

BotHub has both pages ready: `/terms` and `/privacy` on your dashboard domain. Enter the operator details first:

![BotHub: operator details for the legal pages, shown on /terms and /privacy](/static/docs/verify-legal.svg)

1. In BotHub open the **user menu → Admin → Server Settings** and fill in **Legal: Terms and Privacy** (operator, contact e-mail; an address if you offer the bot to the public regularly). Save.
2. Open `https://<your-domain>/terms` and `/privacy` once and check them.
3. In the Developer Portal → **General Information** paste both URLs (A and B) and save.

![Developer Portal: General Information with the Terms of Service and Privacy Policy URL](/static/docs/verify-portal.svg)

> [!WARNING]
> The pages must be reachable from the internet over **https**. A dashboard that only runs in your home network does not work here: make the domain public first (Admin → Server Settings → Domain, reverse proxy).

## 4. Privileged intents

Unverified bots may use the privileged intents freely. Verified bots must **request** each one in the App Verification tab and explain why. Only request what your bot really uses; BotHub runs without the ones it does not get, and the modules that need them stay quiet (the log says so).

![What the privileged intents are for in BotHub](/static/docs/verify-intents.svg)

Example reasons you can adapt:

| Intent | Reason |
|---|---|
| Server Members | "Welcome and leave messages, automatic roles, verification and member counters for the servers that switched these features on." |
| Message Content | "Moderation filters (spam, links, bad words), automatic replies and counting games that need to read the message text in servers that switched them on." |
| Presence | Only if you use online counters or status events. |

## 5. Submit and wait

When every point of the checklist is green, click **Submit**. Discord reviews the app; this can take from a few days to some weeks. You get a message from Discord with the result. If something is missing, fix it and submit again.

## Checklist

- ☐ App in a team, team owner with 2FA
- ☐ Identity verified with Stripe
- ☐ Name, icon, description
- ☐ `/terms` and `/privacy` filled in BotHub, public over https, entered in the portal
- ☐ Privileged intents requested with reasons (only the ones you use)
- ☐ At least 75 servers, then **Submit**
