import type { Context, Env, Report, TgUpdate } from './types.js';
import { CATEGORIES, chatMessageLink, coordinates, groupId, integer, isMember, nowSeconds, statusAt, timeZone } from './domain.js';
import { HttpError, equalSecret, json, readJson, verifyInitData } from './security.js';
import { Store } from './store.js';
import { processUpdate, relevantUpdate } from './bot.js';
import { flushReport, member, TelegramError } from './telegram.js';

function eventDto(report: Report, now: number): Record<string, unknown> {
  return {
    id: report.id, latitude: report.latitude, longitude: report.longitude,
    category: report.category, description: report.description, status: statusAt(report, now),
    reported_by: report.display_name || 'Member',
    observed_at: report.observed_at, created_at: report.created_at, expires_at: report.expires_at,
    last_confirmed_at: report.last_confirmed_at, resolved_at: report.resolved_at,
    confirmations: report.confirmations || 0, clear_votes: report.clear_votes || 0,
    message_url: chatMessageLink(report.chat_id, report.message_id)
  };
}
function checkConfig(env: Env): void {
  groupId(env);
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 24) throw new Error('CONFIG_SECRETS');
}
async function webhook(request: Request, env: Env, store: Store, now: number): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', env.WEBHOOK_SECRET)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  const data = await readJson(request);
  if (!data || typeof data !== 'object' || !('update_id' in data)
    || !Number.isSafeInteger(data.update_id) || Number(data.update_id) < 0) throw new HttpError(400, 'Invalid Telegram update.');
  const update = data as TgUpdate;
  if (!relevantUpdate(update, env)) return json({ ok: true });
  const claim = await store.claimUpdate(update.update_id, now);
  if (claim === 'done') return json({ ok: true });
  if (claim === 'busy') return json({ error: 'Update is already being processed, try again later.' }, 503);
  try {
    // Only answer 200 once everything has been saved, so Telegram retries on failure.
    await processUpdate(env, store, update, now);
    await store.finishUpdate(update.update_id, now);
    return json({ ok: true });
  } catch (error) {
    // 400/403 from Telegram (bot blocked or kicked, message deleted, missing rights) won't go away
    // on retry, and a failing update would hold up the ones queued behind it.
    if (error instanceof TelegramError && [400, 403].includes(error.code)) {
      await store.finishUpdate(update.update_id, now);
      console.error('UPDATE_DROPPED', { update_id: update.update_id, code: error.code });
      return json({ ok: true });
    }
    await store.releaseUpdate(update.update_id);
    console.error('UPDATE_RETRY_REQUIRED', { update_id: update.update_id });
    return json({ error: 'Temporary error, try again later.' }, 503);
  }
}
async function api(request: Request, env: Env, store: Store, now: number): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/events') return json({ error: 'Not found.' }, 404);
  if (request.method !== 'GET') return json({ error: 'The map API is read-only.' }, 405);
  const actor = await verifyInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN, now);
  // Checked on every request so that people who leave the group lose access straight away.
  if (!isMember(await member(env, actor.id))) throw new HttpError(403, 'The map is only available to group members.');
  if (!await store.allow(`map:${actor.id}`, 20, 60, now)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
  const mode = url.searchParams.get('mode') || 'active';
  if (!['active', '24h', '7d'].includes(mode)) throw new HttpError(400, 'Invalid time range.');
  const rawBefore = url.searchParams.get('before');
  const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
  if (!Number.isSafeInteger(before) || before <= 0) throw new HttpError(400, 'Invalid cursor.');
  const requestedId = url.searchParams.get('id');
  if (requestedId !== null) {
    const id = Number(requestedId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid ID.');
    const report = await store.report(id, now);
    if (!report || report.status === 'removed') throw new HttpError(404, 'Report not found.');
    return json({ event: eventDto(report, now), generated_at: now });
  }
  const rows = await store.list(mode as 'active' | '24h' | '7d', now, before);
  const items = rows.slice(0, 200);
  const lat = Number(env.MAP_CENTER_LAT); const lon = Number(env.MAP_CENTER_LON);
  return json({
    events: items.map(r => eventDto(r, now)), next_cursor: rows.length > 200 ? items.at(-1)!.id : null,
    generated_at: now, title: env.APP_TITLE || 'Road alerts', mode,
    center: coordinates(lat, lon) ? [lat, lon] : [42.5, 12.5],
    zoom: integer(env.MAP_ZOOM, 6, 3, 18),
    time_zone: timeZone(env),
    categories: CATEGORIES
  });
}
export async function maintenance(env: Env, now: number): Promise<void> {
  const store = new Store(env.DB, groupId(env));
  await store.maintenance(now);
  const rows = await env.DB.prepare(`SELECT id FROM reports WHERE chat_id=? AND dirty=1
    AND retry_at<=? AND delivery_lock_until<=? ORDER BY updated_at LIMIT 4`)
    .bind(store.chatId, now, now).all<{ id: number }>();
  for (const { id } of rows.results) await flushReport(env, store, id, now);
}
export default {
  async fetch(request: Request, env: Env, _context: Context): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/') && !path.startsWith('/telegram/') && path !== '/health') {
      return env.ASSETS.fetch(request);
    }
    try {
      checkConfig(env);
      const store = new Store(env.DB, groupId(env));
      const now = nowSeconds();
      if (path === '/health') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
        await env.DB.prepare('SELECT id FROM reports LIMIT 1').first();
        return json({ ok: true, version: '0.1.0' });
      }
      if (path === '/telegram/webhook') return await webhook(request, env, store, now);
      if (path.startsWith('/api/')) return await api(request, env, store, now);
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof TelegramError) return json({ error: 'Could not reach Telegram to check your membership. Try again.' }, 503);
      console.error('REQUEST_FAILED');
      return json({ error: 'Service unavailable. Check the configuration, the database and the quotas.' }, 503);
    }
  },
  async scheduled(_event: unknown, env: Env, _context: Context): Promise<void> {
    checkConfig(env);
    await maintenance(env, nowSeconds());
  }
};
