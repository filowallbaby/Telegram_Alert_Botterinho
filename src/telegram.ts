import type { Env, InlineButton, Membership, Report, TgMessage } from './types.js';
import { CATEGORIES, dateTime, groupId, html, integer, mapLink, statusAt, timeZone } from './domain.js';
import { Store } from './store.js';

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter: number, public notModified = false) {
    super(`TELEGRAM_${code}`); // Keep the URL (it contains the token) and payloads out of error messages.
  }
}
export async function telegram<T>(env: Env, method: string, payload: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
    });
  } catch { throw new TelegramError(503, 30); }
  let body: { ok: boolean; result: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
  try { body = await response.json() as typeof body; }
  catch { throw new TelegramError(502, 30); }
  if (!response.ok || !body.ok) {
    throw new TelegramError(body.error_code || response.status, body.parameters?.retry_after || 30,
      body.description?.includes('message is not modified') === true);
  }
  return body.result;
}
export function markup(rows: InlineButton[][]): { inline_keyboard: InlineButton[][] } { return { inline_keyboard: rows }; }
export function groupThread(env: Env): Record<string, number> {
  const id = integer(env.GROUP_THREAD_ID, 0, 0, Number.MAX_SAFE_INTEGER);
  return id ? { message_thread_id: id } : {};
}
/** Keeps a reply in the same forum topic. Reply threads in groups without topics are ignored. */
export function sameTopic(msg: TgMessage): Record<string, number> {
  return msg.is_topic_message && msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
}
export async function send(env: Env, chatId: number, text: string,
  extra: Record<string, unknown> = {}): Promise<TgMessage> {
  return telegram<TgMessage>(env, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(chatId === groupId(env) ? groupThread(env) : {}), ...extra
  });
}
export async function edit(env: Env, chatId: number, messageId: number, text: string,
  rows: InlineButton[][] = []): Promise<void> {
  try {
    await telegram(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text,
      parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup(rows) });
  } catch (error) { if (!(error instanceof TelegramError && error.notModified)) throw error; }
}
export async function answer(env: Env, id: string, text: string, alert = false): Promise<void> {
  try { await telegram(env, 'answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 190), show_alert: alert }); }
  catch (error) {
    // Callback queries expire after a while. That shouldn't undo a saved change or block the update.
    if (!(error instanceof TelegramError)) throw error;
  }
}
export function member(env: Env, userId: number): Promise<Membership> {
  return telegram<Membership>(env, 'getChatMember', { chat_id: groupId(env), user_id: userId });
}
export function reportCard(env: Env, report: Report, now: number): { text: string; rows: InlineButton[][] } {
  const status = statusAt(report, now);
  if (status === 'removed') return { text: `<b>Report #${report.id} was removed</b>`, rows: [] };
  const zone = timeZone(env);
  const label = { active: 'Active', resolved: 'Resolved by the group', expired: 'Expired' }[status];
  const lines = [
    `<b>${html(CATEGORIES[report.category].label.toUpperCase())} · #${report.id}</b>`, label,
    `Location: ${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`,
    `Reported: ${dateTime(report.observed_at, zone)}`,
    `By: ${html(report.display_name || 'Member')}`,
    report.description ? `\n${html(report.description)}` : '',
    `\nStill there: ${report.confirmations || 0}`
  ];
  if (status === 'active') {
    lines.push(`Gone: ${report.clear_votes || 0}`);
    lines.push(`Expires: ${dateTime(report.expires_at, zone)}`);
  } else if (status === 'resolved' && report.resolved_at) lines.push(`Resolved: ${dateTime(report.resolved_at, zone)}`);
  else if (status === 'expired') lines.push('Nobody updated this report in time. The problem may or may not still be there.');
  const rows: InlineButton[][] = status === 'active' ? [[
    { text: `Still there (${report.confirmations || 0})`, callback_data: `vote:confirm:${report.id}` },
    { text: 'Gone', callback_data: `vote:clear:${report.id}` }
  ]] : [];
  rows.push([{ text: 'Open on map', url: mapLink(env, report.id) }]);
  return { text: lines.filter(Boolean).join('\n'), rows };
}
/**
 * Posts or updates the group card for a report. Rows with dirty=1 act as a small queue that the
 * cron job drains, so the webhook never has to wait for Telegram to accept a message.
 */
export async function flushReport(env: Env, store: Store, id: number, now: number): Promise<boolean> {
  // The lease stops two runs from posting at the same time. It can't make sendMessage exactly-once
  // (see docs/architecture.md).
  const lease = await env.DB.prepare(`UPDATE reports SET delivery_lock_until=?,delivery_attempts=delivery_attempts+1
    WHERE id=? AND chat_id=? AND dirty=1 AND retry_at<=? AND delivery_lock_until<=? RETURNING id`)
    .bind(now + 60, id, store.chatId, now, now).first();
  if (!lease) return false;
  const report = await store.report(id, now);
  if (!report) return false;
  const card = reportCard(env, report, now);
  try {
    let messageId = report.message_id;
    // No point posting a card just to say it was removed.
    if (!messageId && report.status !== 'removed') {
      const message = await send(env, store.chatId, card.text, { reply_markup: markup(card.rows) });
      messageId = message.message_id;
    } else if (messageId) await edit(env, store.chatId, messageId, card.text, card.rows);
    await env.DB.prepare(`UPDATE reports SET message_id=?,delivery_lock_until=0,retry_at=0,
      dirty=CASE WHEN revision=? THEN 0 ELSE 1 END WHERE id=?`)
      .bind(messageId, report.revision, id).run();
    return true;
  } catch (error) {
    const delay = error instanceof TelegramError ? Math.max(30, error.retryAfter) : 60;
    // 400/403 usually means a config problem (bot kicked, no rights), so back off for an hour.
    // The report is still in the database and on the map in the meantime.
    const retry = error instanceof TelegramError && [400, 403].includes(error.code) ? 3600 : delay;
    await env.DB.prepare('UPDATE reports SET delivery_lock_until=0,retry_at=? WHERE id=?')
      .bind(now + retry, id).run();
    console.error('REPORT_DELIVERY_DEFERRED', { report_id: id, code: error instanceof TelegramError ? error.code : 500 });
    return false;
  }
}
