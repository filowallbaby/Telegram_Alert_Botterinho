# Free tier limits and known gaps

The project is meant to run for free on Cloudflare and Telegram. The numbers below come from the provider docs as of September 2026. Prices and limits change, so check the links at the bottom before relying on them.

## Cloudflare

Workers Free gives you 100,000 requests a day and 10 ms of CPU time per request. Time spent waiting on the network doesn't count as CPU. Static assets are free and don't count as Worker requests.

D1 Free gives you 5 million rows read and 100,000 rows written per day, and 5 GB of storage per account with a maximum of 500 MB per database. The limits are on rows scanned, not on queries, so indexes matter.

On the free plan, going over a limit makes requests fail until the limit resets. You don't get billed. If you want to stay free, don't upgrade to Workers Paid to get around a limit.

Reports are never deleted automatically, so the database keeps growing. A report takes a few hundred bytes, so 500 MB goes a long way, but keep an eye on it.

## Map traffic

The map refreshes every 2 minutes, but only while it's on screen and showing active reports. Each request returns up to 200 reports, and **Load more** fetches the next page.

Some rough numbers: 100 people keeping the map open for 30 minutes a day means about 1,500 refreshes a day. 200 people keeping it open around the clock would mean about 144,000, which is more than the Workers Free limit on its own.

CPU time hasn't been profiled on Cloudflare yet. Keep an eye on the CPU and error graphs in the dashboard during the first days with a small group.

## Telegram

Regular bot messages are free and don't need Telegram Premium. The bot handles 429 responses and has a retry queue, but under heavy load card updates can be delayed.

The bot only sees messages sent after it joined, so it can't import old locations from the group history. Telegram keeps undelivered updates for 24 hours, which means updates sent during a longer outage are lost.

## Map tiles

Leaflet is loaded from unpkg with SRI hashes. If the CDN is down, the list of reports still works without the map.

The map uses the standard OpenStreetMap tiles, which are run by volunteers under a [usage policy](https://operations.osmfoundation.org/policies/tiles/). The page keeps the attribution visible, sends normal browser requests and doesn't prefetch or store tiles offline. If your usage gets big, switch to a different tile provider.

## Known gaps

- One group per deployment.
- No import of old messages, no leaderboards, no merging of duplicate reports. Two cards can be about the same accident.
- Votes can be gamed by someone with several accounts.
- Road names aren't looked up from the coordinates, people write them in the note.
- There's no geographic boundary, a report can be anywhere in the world.
- Editing or deleting the original Telegram message doesn't update the report. Use `/note` or `/remove` instead.
- No photos, reverse geocoding, routing, or notifications outside Telegram.

## Links

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Telegram bots FAQ](https://core.telegram.org/bots/faq)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/binding/) and [headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [limits](https://developers.cloudflare.com/d1/platform/limits/), [Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Leaflet downloads](https://leafletjs.com/download.html)
- [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
