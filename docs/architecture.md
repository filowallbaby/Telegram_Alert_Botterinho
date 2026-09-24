# Architecture

## Overview

Telegram sends updates to `/telegram/webhook`. The Worker checks the secret token header, drops anything that isn't from the configured group or from a private chat, takes a lease on the update ID and runs the bot logic. D1 stores drafts, reports, votes and a log of state changes.

The map is a static page served by Workers Static Assets. It calls `GET /api/events` and sends the Mini App `initData` in a header. The Worker checks the signature and the user's membership before returning anything. `/api/*`, `/telegram/*` and `/health` go through the Worker; everything else is served straight from the assets.

There's no bot framework and no runtime dependency. The Worker talks to the Bot API with plain `fetch`.

## Tables

| Table | What it holds |
|---|---|
| `users` | Telegram user ID and first name. No phone number, last name or profile photo. |
| `drafts` | A location waiting for a category and a note. Expires after 30 minutes. |
| `reports` | Published reports, with status, expiry time and the state of the card in the group. |
| `votes` | One row per report and user: "still there" or "gone", with a timestamp. |
| `report_history` | Created, votes, note edits, resolved, expired, removed. |
| `processed_updates` | Update IDs and leases so an update isn't processed twice. The payload isn't stored. |
| `rate_limits` | Short-lived counters. |

Timestamps are Unix seconds in UTC and are shown in the `TIME_ZONE` setting. `observed_at` is when the location was sent, which isn't necessarily when the problem started.

## Report lifecycle

A report starts as `active` and ends up `resolved`, `expired` or `removed`. A closed report can't be reopened; someone has to send a new one.

How long a report stays active depends on the category (see `src/domain.ts`): traffic 1 hour, accident and hazard 2 hours, weather 3 hours, road closed 12 hours, roadworks 24 hours. These are starting values, adjust them to what makes sense in your area. Confirmations don't extend the expiry. The map treats a report as expired as soon as `expires_at` has passed, even if the cron job hasn't updated the row yet.

The author or an admin can close an active report at any time. For everyone else it takes agreement: by default two different people have to tap **Gone** within 15 minutes, and after the latest **Still there**. `COMMUNITY_RESOLVE_VOTES` sets the number (2 to 10). Each person has one vote per report. They can change it, and tapping again after 15 minutes refreshes the timestamp without counting twice.

## Idempotency and delivery

Each location creates a draft whose ID comes from the update ID, and `reports.draft_id` is unique, so a retried update can't create a second report. Publishing and voting use D1 batches, which run as a single transaction. An update that finished is never processed again. If an update is still being processed when Telegram retries it, the webhook returns 503 and Telegram tries again later.

Sending a message to Telegram can't be part of a D1 transaction, so the report is saved first and flagged as `dirty`. Together with `retry_at` and `delivery_lock_until`, this turns the `reports` table into a small queue. If a post fails, the row stays dirty and the cron job tries again later, respecting Telegram's `retry_after`. A `revision` counter makes sure a change that arrives while a card is being updated isn't lost.

When Telegram answers an update with 400 or 403 (bot kicked out, message deleted, missing rights), retrying won't help, so the update is marked as done and logged instead of being retried forever.

Messages to Telegram are not exactly-once. If Telegram accepts a message but the response gets lost before the `message_id` is saved, the retry can post a second card. There's still only one report in the database, and an admin can delete the extra message by hand.

## Cron

A cron trigger runs every 5 minutes. Each run deletes expired drafts, old update IDs and old rate-limit counters, marks up to 10 reports as expired and syncs up to 4 cards with Telegram. The amount of work per run is capped. With a lot of traffic, card updates can lag behind, but the map always reads the current state from D1.

The webhook is registered with `max_connections=1`. That's enough for a local group and avoids races between updates. One of the tests checks that a maintenance run with 10 expiries stays under 50 queries.

## Map security

`initData` is validated with HMAC-SHA256 using the bot token, following the Telegram docs. Only `hash` is removed from the data-check string; `signature` stays in. A session is accepted for one hour, with 30 seconds of tolerance for clock skew. Duplicate parameters, oversized payloads and invalid user IDs are rejected.

A valid signature proves who the user is, not that they're in the group, so every API request also calls `getChatMember`. The browser never gets to choose which chat to read. The API is read-only: votes and admin actions all go through the bot.

`initData` travels in a header and never in the URL, and API responses are sent with `Cache-Control: no-store`. Text is escaped in Telegram's HTML messages, and the map builds the page with `textContent`. Leaflet is pinned to 1.9.4 with the SRI hashes published by the Leaflet project.

## Ideas for later

The history table already has what's needed for leaderboards and stats. Detecting duplicate reports would have to handle opposite carriageways and roads that cross over each other, since distance alone isn't enough. A heatmap would show where people send reports, which isn't quite the same as where accidents happen.
