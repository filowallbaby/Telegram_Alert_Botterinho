import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../.test-build/index.js';
import { Store } from '../.test-build/store.js';

export const NOW = 1790244000;
export const ALICE = { id: 101, first_name: 'Alice' };
export const BOB = { id: 102, first_name: 'Bob' };
export const CAROL = { id: 103, first_name: 'Carol' };
export const ADMIN = { id: 999, first_name: 'Admin' };
export class LocalD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../database/migrations/0001_initial.sql', import.meta.url), 'utf8'));
    this.queries = 0;
  }
  prepare(sql) { return new LocalStatement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(s => s.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}
class LocalStatement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new LocalStatement(this.db, this.sql, params); }
  execute() {
    this.db.queries++;
    const statement = this.db.sqlite.prepare(this.sql);
    if (statement.columns().length) {
      const rows = statement.all(...this.params).map(row => ({ ...row }));
      const meta = this.db.sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
      return { results: rows, success: true, meta: { ...meta } };
    }
    const result = statement.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async first() { return this.execute().results[0] || null; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}
export function makeEnv(DB = new LocalD1()) {
  return {
    DB, ASSETS: { async fetch() { return new Response('static-test'); } },
    BOT_TOKEN: '123456789:TEST_TOKEN_NO_VALID_CREDENTIAL', WEBHOOK_SECRET: 'TEST_SECRET_123456789012345678901234',
    BOT_USERNAME: 'road_alert_test_bot', ALLOWED_CHAT_ID: '-1001234567890', APP_TITLE: 'Test group',
    MAP_CENTER_LAT: '42.5', MAP_CENTER_LON: '12.5', MAP_ZOOM: '6', TIME_ZONE: 'Europe/Rome',
    MAX_REPORTS_PER_HOUR: '10', COMMUNITY_RESOLVE_VOTES: '2'
  };
}
export function fixture(t) {
  const env = makeEnv(); t.after(() => env.DB.close());
  t.mock.method(Date, 'now', () => NOW * 1000);
  const calls = []; let nextMessage = 1000;
  const members = new Map([[101, 'member'], [102, 'member'], [103, 'member'], [999, 'administrator']]);
  const control = { failure: null };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected external fetch');
    const method = url.pathname.split('/').at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    // control.failure returns true for a 429, or a specific error code. It only fires once.
    const failure = control.failure?.(method, payload);
    if (failure) {
      control.failure = null;
      const code = failure === true ? 429 : failure;
      return Response.json({ ok: false, error_code: code, description: code === 429 ? 'Too Many Requests' : 'Forbidden: bot was blocked by the user',
        parameters: code === 429 ? { retry_after: 30 } : undefined }, { status: code });
    }
    if (method === 'getChatMember') return Response.json({ ok: true, result: { status: members.get(payload.user_id) || 'left' } });
    if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: nextMessage++, date: NOW,
      chat: { id: payload.chat_id, type: payload.chat_id < 0 ? 'supergroup' : 'private' }, text: payload.text } });
    return Response.json({ ok: true, result: true });
  });
  const store = new Store(env.DB, Number(env.ALLOWED_CHAT_ID));
  return { env, store, calls, members, control };
}
export async function webhook(env, update, secret = env.WEBHOOK_SECRET) {
  return worker.fetch(new Request('https://example.workers.dev/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update)
  }), env, { waitUntil() {} });
}
export function locationUpdate(env, id = 1, user = ALICE) {
  return { update_id: id, message: { message_id: id + 100, date: NOW, from: user,
    chat: { id: Number(env.ALLOWED_CHAT_ID), type: 'supergroup' }, location: { latitude: 43.66, longitude: 10.63 } } };
}
export function callbackUpdate(env, id, data, user, messageId, chatId = Number(env.ALLOWED_CHAT_ID)) {
  return { update_id: id, callback_query: { id: `cb-${id}`, from: user, data,
    message: { message_id: messageId, date: NOW, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' } } } };
}
export function textUpdate(env, id, text, user = ALICE, extra = {}) {
  return { update_id: id, message: { message_id: id + 100, date: NOW, from: user, text,
    chat: { id: Number(env.ALLOWED_CHAT_ID), type: 'supergroup' }, ...extra } };
}
export async function seedReport(store, id = 'd1', user = ALICE, type = 'accident', now = NOW) {
  let draft = await store.createDraft(id, user, store.chatId, 100, 43.66, 10.63, now, now);
  await store.chooseCategory(id, type); draft = await store.draft(id);
  return store.publish(draft, now, 100);
}
export function signedInit(env, user = ALICE, date = NOW, extra = {}) {
  const params = new URLSearchParams({ auth_date: String(date), query_id: 'TEST_QUERY', user: JSON.stringify(user), ...extra });
  params.sort();
  const check = [...params].map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  params.set('hash', hash); return params.toString();
}
export function apiRequest(env, init = signedInit(env), query = '') {
  return worker.fetch(new Request(`https://example.workers.dev/api/events${query}`, {
    headers: { 'X-Telegram-Init-Data': init }
  }), env, { waitUntil() {} });
}
