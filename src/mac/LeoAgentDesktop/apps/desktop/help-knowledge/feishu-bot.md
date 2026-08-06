---
id: feishu-bot
title: Setting up the FeiShu (Lark) bot
summary: Configure the FeiShu bot (App ID / App Secret) in Settings > IM bots to get DM notifications and bot interaction.
tab: im-bot
---
Cindy can send DMs and take commands through a FeiShu (Lark) bot. (This is unrelated to signing into Cindy — you sign in with your Cindy account; FeiShu is no longer a login method.)

**Setting up the bot:**

- Open Settings > IM bots, then the FeiShu Bot section.
- Paste the bot's **App ID** and **App Secret**, then click **Bind**.
- The status badge updates: **needs-config** → **connecting** → **connected** (or **conflict** / **error**).

**Binding the bot to you:**

- After the badge shows **connected**, the page instructs you to DM the bot a code (or click an action) to complete the binding. Until you bind, the bot won't know which FeiShu user to DM.

**Notifications:**

- Toggle **message notifications** on the same page to get bot DMs when sessions finish, or when the bot has updates for you.
- The desktop-OS-level "session finished" notification is a separate toggle in **Settings > General > Notifications**.

**Notes:**

- The "conflict" badge state means another Cindy instance is already bound to the same bot for this user — typical when running dev + release simultaneously. Disconnect on one side to clear it.
- Settings > IM bots also hosts the Slack and Telegram bindings (the "Cindy" tab) and a bring-your-own Discord bot, alongside this FeiShu bot.
