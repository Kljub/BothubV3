---
title: Webhooks
summary: Let other services start your blocks.
---
**Webhooks** (Modules → Utility) give you URLs that other services can call with a **POST** request: a CI pipeline, a home automation system, a form.

1. **Add webhook**: give it a name. The last part of the URL is random (16 to 40 letters and digits) and works like a password; a webhook can also require a **key**.
2. Build what happens as a **custom event** of the type *When a webhook is called* and pick the webhook there. The request is available as `{webhook.name}`, `{webhook.body}` (the raw body) and `{webhook.json}`.
3. Use the **example request** of the page to test it. Switched off, the URL refuses calls.

> [!WARNING]
> Treat the URL and the key like passwords. Create a new one when it leaked.
