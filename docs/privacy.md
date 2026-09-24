# Data and privacy

The bot keeps as little data as it can, but whoever runs it still has to tell group members what's collected and for how long. This page describes what the code does. It isn't legal advice.

## What gets stored

For each report: an internal ID, the group ID, the author's Telegram user ID and first name, the coordinates, the category, the note, the timestamps, the status and the ID of the bot's card in the group. For each vote: who voted, on which report, which way and when. The history table records state changes (created, voted, note edited, resolved, expired, removed), not chat messages.

Update IDs and rate-limit counters are kept for a few days at most, to catch duplicates and abuse. Drafts expire after 30 minutes and are cleaned up by the cron job.

The bot ignores normal conversation and doesn't save the group chat. Since it's an admin, though, Telegram does deliver every group message to it, so don't tell people the bot can't read them.

No phone numbers, live locations, photos, audio or contacts are collected, and the map never asks for the browser's location. The coordinates are the ones people choose to send for a report, but together with their name they can still reveal something about them, so don't describe the data as anonymous.

## Who can see what

Report cards in the group are visible to anyone who can read the group. The map needs a signed Telegram login and checks membership again on every request. The API returns the author's first name but not their user ID.

The map page itself is public, but it shows nothing without a valid login. If your group is public, anyone who joins can see the map. And members can always take screenshots.

Telegram handles the messages. Cloudflare hosts the Worker and the database. The browser loads the Telegram Mini App script, Leaflet from unpkg and map tiles from OpenStreetMap, and those services see normal network requests. Tile requests show which area someone is looking at. There are no analytics or ads.

## Retention

Reports aren't deleted when they expire. They stay in D1 until you delete them. The map only lists the last 7 days, but members can still open older reports by ID.

Decide how long you want to keep reports, votes and backups, and let your members know. There's no automatic cleanup or anonymisation of old reports yet.

## Removing is not deleting

`/remove ID` hides a report from the map and replaces the card in the group with a short notice. The note is cleared, but the author ID, the coordinates, the votes and the history stay in the database.

To fully delete someone's data you have to do it by hand in D1: find and delete their rows in `reports`, `votes`, `report_history` and `users`. Don't forget the backups and the Telegram messages. There's no self-service delete command.

Editing or deleting a message in Telegram doesn't change the database, and deleting rows in D1 doesn't delete anything in Telegram.

## Tokens and backups

`.dev.vars` stores the bot token and the webhook secret in plain text. It's in `.gitignore` and the scripts make it readable only by you where the file system allows it, but it's still a plain file on your disk.

On Cloudflare the token and the webhook secret are stored as Worker secrets, not as plain variables, and nothing in `public/` contains them. The code doesn't log full updates or Telegram API URLs, which contain the token.

If the token leaks, revoke it in @BotFather. Put the new token in `.dev.vars` and delete the `WEBHOOK_SECRET` line so a new one gets generated, then run `npm run secrets:upload` and `npm run telegram:setup`. Keep your Cloudflare account and Wrangler login safe too.

`npm run db:backup` writes an unencrypted SQL dump with personal data into `backups/`. It only runs when you run it, and it should never end up in a repository.

## Worth pinning in the group

- Only share road info: where, what kind of problem, road and direction, a short description.
- No names of the people involved, plate numbers, medical details or photos of people.
- Reports and votes come from members and aren't official.
- Don't use your phone while driving.
- Who runs the bot, how to reach them, what's stored and for how long.

The `/privacy` text in the bot is generic, so add your own contact details and retention period to the pinned message.
