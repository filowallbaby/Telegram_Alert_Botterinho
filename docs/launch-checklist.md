# Launch checklist

Go through this after deploying, using a separate test bot and test group with at least one admin and two regular members. Start every test note with `TEST` so nobody mistakes it for a real report.

## Accounts and deploy

- [ ] The Cloudflare account is on Workers Free and no paid products are enabled.
- [ ] `ALLOWED_CHAT_ID` points to the test group, and the D1 database isn't shared with another deployment.
- [ ] `npm run check` passes and `package-lock.json` is committed.
- [ ] The remote migration ran, the Worker is deployed and both secrets are uploaded.
- [ ] `/health` returns `ok: true` and `npm run telegram:status` shows no recurring errors.
- [ ] The bot is an admin with only the permissions it needs and can post in the configured topic.
- [ ] The main Mini App is set up in BotFather.

## Reporting

- [ ] `/report` explains how to send a location, and a live location is rejected.
- [ ] A location sent in the group gets a category prompt. Nobody else can finish that draft.
- [ ] All six categories are there, and **Publish without note** creates exactly one card.
- [ ] Replying to the prompt with a note puts the note on the card and on the map. A message that isn't a reply is not used as a note.
- [ ] `/cancel` stops a draft from being published, and drafts left alone expire.
- [ ] A member can report from a private chat and the card shows up in the group. A non-member can't.
- [ ] The author can change the note with `/note ID text`. Another regular member can't.

## Votes, closing and expiry

- [ ] A second member taps **Still there**: the count goes to 1, and tapping again doesn't change it. The author can't confirm their own report.
- [ ] One member tapping **Gone** doesn't close the report. Two different members within 15 minutes do.
- [ ] The author or an admin can close an active report. Other members can't use `/resolve`.
- [ ] A resolved report leaves the Active view, stays in the history, and its card is updated.
- [ ] An expired report leaves the Active view even before the cron runs, and it's labelled Expired, not Resolved.
- [ ] `/remove ID` only works for admins and hides the report from the map.

To test expiry without waiting, edit `expires_at` in the test database. Don't shorten the expiry times in production just to test.

## Map and access

- [ ] The map opens from the Map button in the private chat and from a card in the group, on the Telegram apps your members use (check both iOS and Android).
- [ ] A normal browser and a Telegram user outside the group both see no data.
- [ ] After someone is removed from the group, their next map refresh is denied.
- [ ] Markers, categories, the list, the detail view and the link to the group message all match.
- [ ] The Active, 24 h and 7 days filters show the right reports, and times are in the configured time zone.
- [ ] The OpenStreetMap attribution is visible.
- [ ] No CSP, SRI or script errors in the browser console. The list still works if the map fails to load.
- [ ] The page works on a phone without scrolling sideways.
- [ ] With more than 200 reports, **Load more** fills in the rest of the list and the map.

## Errors, quotas and admin

- [ ] Make a card post fail in the test setup: the report stays in the database and the card goes out on a later cron run.
- [ ] The cron runs every 5 minutes and pending cards get synced.
- [ ] Check CPU time, errors (1102, 429), requests and D1 reads and writes in the Cloudflare dashboard.
- [ ] `npm run db:backup` works. Try restoring it into a separate database before you need it for real.
- [ ] Members know what's collected, how long it's kept and who to contact, and you've decided how to handle deletion requests.

When you move to the real group, start with a fresh database so the test reports don't show up as real ones.
