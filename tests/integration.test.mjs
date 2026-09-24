import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { maintenance } from '../.test-build/index.js';
import { flushReport } from '../.test-build/telegram.js';
import { fixture, webhook, locationUpdate, callbackUpdate, textUpdate, apiRequest,
  signedInit, seedReport, ALICE, BOB, CAROL, ADMIN, NOW } from './helpers.mjs';

async function completeFlow(f) {
  assert.equal((await webhook(f.env, locationUpdate(f.env))).status, 200);
  let draft = await f.store.draft('d1');
  assert.ok(draft.prompt_message_id);
  await webhook(f.env, callbackUpdate(f.env, 2, 'cat:accident:d1', ALICE, draft.prompt_message_id));
  await webhook(f.env, callbackUpdate(f.env, 3, 'pub:d1', ALICE, draft.prompt_message_id));
  draft = await f.store.draft('d1');
  return f.store.report(draft.published_report_id, NOW);
}

test('full flow: location, category, publish, then read it back from the map API', async t => {
  const f = fixture(t); const report = await completeFlow(f);
  assert.ok(report.message_id); assert.equal(report.category, 'accident');
  const response = await apiRequest(f.env);
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.events[0].id, report.id);
  assert.equal(body.events[0].latitude, 43.66);
  assert.equal(body.time_zone, 'Europe/Rome');
  assert.equal('user_id' in body.events[0], false);
  assert.equal(JSON.stringify(body).includes(f.env.BOT_TOKEN), false);
});
test('a repeated Telegram update does not post a second card', async t => {
  const f = fixture(t); await completeFlow(f);
  const before = f.calls.filter(c => c.method === 'sendMessage').length;
  await webhook(f.env, callbackUpdate(f.env, 3, 'pub:d1', ALICE, 1000));
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, before);
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 1);
});
test('the author can reply with a note, and other chat messages are ignored', async t => {
  const f = fixture(t);
  await webhook(f.env, locationUpdate(f.env));
  const draft = await f.store.draft('d1');
  await webhook(f.env, callbackUpdate(f.env, 2, 'cat:traffic:d1', ALICE, draft.prompt_message_id));
  await webhook(f.env, textUpdate(f.env, 3, 'Just chatting in the group'));
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 0);
  await webhook(f.env, textUpdate(f.env, 4, '<script>alert(1)</script> & towards the center', ALICE,
    { reply_to_message: { message_id: draft.prompt_message_id } }));
  const report = (await f.store.list('active', NOW))[0];
  assert.equal(report.description, '<script>alert(1)</script> & towards the center');
  const card = f.calls.find(c => c.method === 'sendMessage' && c.payload.text.includes('TRAFFIC JAM'));
  assert.ok(card.payload.text.includes('&lt;script&gt;'));
  assert.equal(card.payload.text.includes('<script>'), false);
});
test("another member can't finish someone else's draft", async t => {
  const f = fixture(t); await webhook(f.env, locationUpdate(f.env));
  const draft = await f.store.draft('d1');
  await webhook(f.env, callbackUpdate(f.env, 2, 'cat:traffic:d1', BOB, draft.prompt_message_id));
  assert.equal((await f.store.draft('d1')).category, null);
  assert.ok(f.calls.some(c => c.method === 'answerCallbackQuery' && c.payload.show_alert));
});
test("non-members can't use the bot in a private chat", async t => {
  const f = fixture(t); const outsider = { id: 404, first_name: 'Outsider' };
  const u = locationUpdate(f.env, 1, outsider); u.message.chat = { id: 404, type: 'private' };
  await webhook(f.env, u);
  assert.equal(await f.store.draft('d1'), null);
});
test('live locations are rejected and not saved', async t => {
  const f = fixture(t); const u = locationUpdate(f.env); u.message.location.live_period = 3600;
  await webhook(f.env, u);
  assert.equal(await f.store.draft('d1'), null);
});
test('messages from other chats are dropped before any database query', async t => {
  const f = fixture(t); const u = locationUpdate(f.env); u.message.chat.id = -100888;
  const before = f.env.DB.queries;
  await webhook(f.env, u);
  assert.equal(f.env.DB.queries, before);
});
test('the prompt stays in the forum topic but ignores plain reply threads', async t => {
  const f = fixture(t);
  const inTopic = locationUpdate(f.env, 1); inTopic.message.message_thread_id = 77; inTopic.message.is_topic_message = true;
  await webhook(f.env, inTopic);
  const replyThread = locationUpdate(f.env, 2, BOB); replyThread.message.message_thread_id = 55;
  await webhook(f.env, replyThread);
  const prompts = f.calls.filter(c => c.method === 'sendMessage');
  assert.equal(prompts[0].payload.message_thread_id, 77);
  assert.equal('message_thread_id' in prompts[1].payload, false);
});
test('a vote updates the card and only counts on the original message', async t => {
  const f = fixture(t); const report = await completeFlow(f);
  await webhook(f.env, callbackUpdate(f.env, 4, `vote:confirm:${report.id}`, BOB, report.message_id));
  assert.equal((await f.store.report(report.id, NOW)).confirmations, 1);
  await webhook(f.env, callbackUpdate(f.env, 5, `vote:confirm:${report.id}`, CAROL, report.message_id + 999));
  assert.equal((await f.store.report(report.id, NOW)).confirmations, 1);
});
test('the author can resolve a report, other members cannot', async t => {
  const f = fixture(t); const report = await completeFlow(f);
  await webhook(f.env, textUpdate(f.env, 4, `/resolve ${report.id}`, BOB));
  assert.equal((await f.store.report(report.id, NOW)).status, 'active');
  await webhook(f.env, textUpdate(f.env, 5, `/resolve ${report.id}`, ALICE));
  assert.equal((await f.store.report(report.id, NOW)).status, 'resolved');
});
test('only admins can remove a report, and it disappears from the API', async t => {
  const f = fixture(t); const report = await completeFlow(f);
  await webhook(f.env, textUpdate(f.env, 4, `/remove ${report.id}`, ALICE));
  assert.equal((await f.store.report(report.id, NOW)).status, 'active');
  await webhook(f.env, textUpdate(f.env, 5, `/remove ${report.id}`, ADMIN));
  assert.equal((await f.store.report(report.id, NOW)).status, 'removed');
  assert.equal((await apiRequest(f.env, signedInit(f.env), `?id=${report.id}`)).status, 404);
});
test('a temporary Telegram error returns 503 and the retry keeps the draft', async t => {
  const f = fixture(t); f.control.failure = method => method === 'sendMessage';
  assert.equal((await webhook(f.env, locationUpdate(f.env))).status, 503);
  assert.ok(await f.store.draft('d1'));
  assert.equal((await webhook(f.env, locationUpdate(f.env))).status, 200);
  assert.ok((await f.store.draft('d1')).prompt_message_id);
});
test('a permanent Telegram error is not retried forever', async t => {
  const f = fixture(t); f.control.failure = method => method === 'sendMessage' && 403;
  const u = locationUpdate(f.env, 1, BOB); u.message.chat = { id: BOB.id, type: 'private' };
  assert.equal((await webhook(f.env, u)).status, 200);
  assert.equal(await f.store.claimUpdate(1, NOW), 'done');
});
test('a failed card post stays queued and the cron job sends it later', async t => {
  const f = fixture(t); const report = await seedReport(f.store);
  f.control.failure = method => method === 'sendMessage';
  assert.equal(await flushReport(f.env, f.store, report.id, NOW), false);
  let saved = await f.store.report(report.id, NOW);
  assert.equal(saved.dirty, 1); assert.equal(saved.message_id, null);
  await maintenance(f.env, NOW + 31);
  saved = await f.store.report(report.id, NOW + 31);
  assert.ok(saved.message_id); assert.equal(saved.dirty, 0);
});
test('a cron run with 10 expiries stays under 50 D1 queries', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await seedReport(f.store, `d${i}`, ALICE, 'traffic');
  const before = f.env.DB.queries;
  await maintenance(f.env, NOW + 3601);
  assert.ok(f.env.DB.queries - before < 50, `Queries run: ${f.env.DB.queries - before}`);
});
test('cursor paging returns 200 per page without duplicates', async t => {
  const f = fixture(t);
  await f.store.user(ALICE, NOW);
  const insert = f.env.DB.sqlite.prepare(`INSERT INTO reports(draft_id,chat_id,user_id,latitude,longitude,category,
    created_at,observed_at,expires_at,updated_at) VALUES(?,?,?,43,10,'traffic',?,?,?,?)`);
  for (let i = 0; i < 205; i++) insert.run(`seed${i}`, f.store.chatId, ALICE.id, NOW, NOW, NOW + 3600, NOW);
  const first = await (await apiRequest(f.env)).json();
  assert.equal(first.events.length, 200); assert.ok(first.next_cursor);
  const second = await (await apiRequest(f.env, signedInit(f.env), `?before=${first.next_cursor}`)).json();
  assert.equal(second.events.length, 5); assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.events, ...second.events].map(r => r.id)).size, 205);
});
test('bad API parameters are rejected and the API is read-only', async t => {
  const f = fixture(t);
  assert.equal((await apiRequest(f.env, signedInit(f.env), '?mode=DROP%20TABLE')).status, 400);
  assert.equal((await apiRequest(f.env, signedInit(f.env), '?before=-1')).status, 400);
  const result = await worker.fetch(new Request('https://example.workers.dev/api/events', { method: 'POST' }), f.env, { waitUntil() {} });
  assert.equal(result.status, 405);
});
test('health check and static assets', async t => {
  const f = fixture(t);
  const health = await worker.fetch(new Request('https://example.workers.dev/health'), f.env, { waitUntil() {} });
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const asset = await worker.fetch(new Request('https://example.workers.dev/'), f.env, { waitUntil() {} });
  assert.equal(await asset.text(), 'static-test');
});
