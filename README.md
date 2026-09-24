# road-alert-bot

A Telegram bot for local road reports. Group members drop a pin, pick a category (accident, traffic jam, road closed, roadworks, hazard, weather) and the bot posts a report card in the group. Other members can tap **Still there** or **Gone**, and every report shows up on a map that opens inside Telegram and is only visible to members of the group.

It runs on Cloudflare Workers with a D1 database. The map uses Leaflet and OpenStreetMap tiles. For a local group it fits in the free plans, and there's no server to keep running.

## Features

- Report from the group or from a private chat with the bot: location, category, optional note.
- One vote per person per report, and authors can't confirm their own reports.
- A report is closed by its author, by an admin, or when two different members tap **Gone** within 15 minutes (the number is configurable).
- Reports expire after a time that depends on the category, from 1 hour for traffic to 24 hours for roadworks.
- The map checks the Telegram login signature and the user's group membership on every request.
- Filters for active reports, last 24 hours, last 7 days and category, 200 reports per page.
- Expired reports are kept in the database, so the history is there if you want stats later.
- Authors and admins can edit notes, admins can remove reports.
- Duplicate updates from Telegram are ignored, failed posts are retried by a cron job, and there are per-user rate limits.
- Scripts for the whole setup: finding the group ID, configuration, secrets, webhook and backups.

Not there yet: leaderboards, photos, reverse geocoding, weekly summaries, and merging two reports about the same accident. See [docs/limits.md](docs/limits.md) for the full list.

## Using it in a group

Send a location from Telegram's attachment menu. The bot replies asking for a category. Pick one, then reply to the bot's message with a short note (road, direction, what's happening) or tap **Publish without note**.

In a group the note has to be a reply to the bot's message. Anything else is ignored, so normal chat never ends up in a report. In a private chat with the bot the flow is the same, but only for members of the configured group. Live locations are rejected, people need to send a fixed point.

The bot needs to be an admin to see location messages and check who's a member. It doesn't need permission to ban users or delete messages.

## Commands

| Command | Who can use it |
|---|---|
| `/report`, `/map`, `/active`, `/help`, `/privacy` | Group members |
| `/publish`, `/cancel` | Anyone, for their own drafts |
| `/note ID text` | The author or an admin |
| `/resolve ID` | The author or an admin, active reports only |
| `/remove ID` | Admins. Hides the report from the map and blanks the card |
| `/status` | Admins. Shows report counts and cards waiting to sync |

## Configuration

Settings live in the `vars` section of `wrangler.jsonc`. `npm run configure` fills in most of them for you.

| Variable | Default | What it does |
|---|---|---|
| `BOT_USERNAME` | | The bot's username, without `@` |
| `ALLOWED_CHAT_ID` | | ID of the group the bot works in (a negative number) |
| `APP_TITLE` | `Road alerts` | Title shown on the map and in `/help` |
| `MAP_CENTER_LAT`, `MAP_CENTER_LON`, `MAP_ZOOM` | `42.5`, `12.5`, `6` | Where the map starts before there are any reports |
| `TIME_ZONE` | `Europe/Rome` | Time zone for the times shown on cards and on the map |
| `GROUP_THREAD_ID` | `0` | Topic the bot posts in, for groups with topics. `0` means General |
| `MAX_REPORTS_PER_HOUR` | `10` | Reports one person can post per hour |
| `COMMUNITY_RESOLVE_VOTES` | `2` | **Gone** votes needed to close a report (2 to 10) |

The bot token and the webhook secret are Worker secrets (`BOT_TOKEN`, `WEBHOOK_SECRET`) and are uploaded with `npm run secrets:upload`. The expiry time for each category is in `src/domain.ts`.

## Getting started

Follow [docs/setup.md](docs/setup.md). You'll need Node.js 22.16 or newer, a free Cloudflare account and a bot token from @BotFather.

Keep the bot token on your own machine. Don't commit it, don't put it in `public/`, and don't paste it into chats or screenshots.

## Development

```sh
npm install
npm run check
```

`npm run check` runs TypeScript in strict mode and the test suite. The tests run against a real in-memory SQLite database through a small D1-compatible adapter, with a fake Telegram API. Node prints a warning that `node:sqlite` is experimental, which is expected.

To run the Worker locally:

```sh
npm run db:local
npm run dev
```

Telegram can't send webhooks to `localhost`, so to try the bot for real you have to deploy it. Use a separate test bot and test group, with their own database.

### Browser test

`tests/browser-smoke.py` opens the map page in headless Chromium with a fake API and checks the main flows: no data without a login, filters, the detail view, HTML escaping, paging, small screens and revoked access. It's optional and isn't part of `npm run check`.

```sh
pip install playwright
playwright install chromium
python tests/browser-smoke.py
```

Set `CHROMIUM_PATH` if you'd rather use a Chromium you already have.

## Project layout

```text
src/                   The Worker: webhook, bot logic, auth, D1 queries, Telegram client
public/                The map page (HTML, CSS, JS) and static headers
database/migrations/   D1 schema
scripts/               Setup and admin scripts that run on your machine
tests/                 Node tests on SQLite, plus the optional browser test
docs/                  Setup guide, architecture, limits, privacy, launch checklist
wrangler.jsonc         Worker config (no secrets in here)
```

## Docs

- [Setup guide](docs/setup.md)
- [Architecture](docs/architecture.md)
- [Free tier limits and known gaps](docs/limits.md)
- [Data and privacy](docs/privacy.md)
- [Launch checklist](docs/launch-checklist.md)
