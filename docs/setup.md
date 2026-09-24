# Setup

This guide connects your Telegram bot and Cloudflare account and deploys the Worker. You only need your computer for the setup. Once it's deployed, everything runs on Cloudflare and you can switch the computer off.

What you need:

- Windows, macOS or Linux with Node.js 22.16 or newer
- a Cloudflare account (the free Workers plan is enough)
- a Telegram group where you're an admin

All commands below work the same in PowerShell, Terminal or any other shell.

## 1. Create the bot

Open [@BotFather](https://t.me/BotFather), send `/newbot` and choose a name and a username. BotFather gives you a token. Treat it like a password.

Add the bot to your group and make it an admin. It doesn't need the ban, invite or delete permissions. If your group uses topics, pick the topic the bot should post in and note its ID, or just use General.

## 2. Install

Open a terminal in the project folder (the one with `package.json`) and run:

```sh
npm install
npm run check
```

## 3. Create the database

```sh
npx wrangler login
npx wrangler d1 create road-alert-db
```

The first command opens your browser so you can log in to Cloudflare. The second creates the database and prints a `database_id`, which looks like a UUID. Copy it, you'll need it in step 5.

If you want to stay at zero cost, check that your account is on Workers Free and don't enable any paid add-ons.

## 4. Find the group ID

```sh
npm run telegram:discover
```

The script asks for the bot token (typing is hidden) and saves it in `.dev.vars` along with a random webhook secret. Then it asks you to send `/id@your_bot_username` in the group. Do that, press Enter, and the script prints the ID of every group it saw. Supergroup IDs are negative and usually start with `-100`.

The bot won't answer `/id`. The script only reads the message to get the chat ID.

If the bot already has a webhook (because something else uses it), the script stops instead of removing it. Create a new bot in that case.

## 5. Configure

```sh
npm run configure
```

It asks for the `database_id`, the group ID, the map title, where the map should start, the time zone and the topic ID. It checks that the bot can see the group and is an admin, then saves everything in `wrangler.jsonc`. The token is not written there.

The starting position is just the initial view. As soon as there are reports, the map zooms to fit them. It doesn't limit where reports can come from.

## 6. Create the tables and deploy

```sh
npm run db:remote
npm run deploy
npm run secrets:upload
```

This creates the tables in the remote database, deploys the Worker and the map, and uploads `BOT_TOKEN` and `WEBHOOK_SECRET` as Worker secrets. The deploy prints your Worker address, something like:

```text
https://road-alert-bot.your-subdomain.workers.dev
```

Until the secrets are uploaded, `/health` returns an error. That's expected.

## 7. Connect Telegram

```sh
npm run telegram:setup
```

Paste the Worker address from the previous step. The script checks `/health`, asks you to confirm, then sets the webhook, the command list and the Map button in private chats.

There's one step you have to do by hand. In @BotFather, open `/mybots`, pick your bot and go to **Bot Settings > Configure Mini App**. Enable the main Mini App and enter your Worker address with a trailing `/`. Without this, the **Open on map** buttons in the group won't work, even though the Map button in private chats will. BotFather's menus move around from time to time, so look around if it's not exactly there.

## 8. Try it

In a test group:

1. Send `/report`, then send a location.
2. Pick a category and tap **Publish without note**. A report card appears in the group.
3. Tap **Open on map** and check the report is there.
4. From a second account in the group, tap **Still there**. The counter goes to 1 and stays at 1 if you tap again.
5. From an account that isn't in the group, the map should refuse access.
6. As the author, send `/resolve ID`. The card switches to resolved, and the report leaves the Active view but stays in the history.

Write TEST in your notes and don't post fake accidents in a real group. The [launch checklist](launch-checklist.md) has the full list of things to check before going live.

## Troubleshooting and backups

```sh
npm run telegram:status
npm run db:backup
```

`telegram:status` shows the webhook address, how many updates are waiting and the last error Telegram got from the Worker. `db:backup` exports the remote database into `backups/`, which Git ignores. The export contains personal data, so keep it somewhere safe. Nothing backs up the database automatically.

In the group, `/status` (admins only) shows how many reports are stored and how many cards are waiting to be synced. For CPU time, errors and D1 usage, check the Cloudflare dashboard.

## Updating

Keep `package-lock.json` and your `wrangler.jsonc`, and don't share `.dev.vars`.

```sh
npm run check
npm run db:backup
npm run db:remote
npm run deploy
```

Read any new migration before applying it. To run the bot in a second group, deploy a separate Worker with its own database instead of changing `ALLOWED_CHAT_ID`.
