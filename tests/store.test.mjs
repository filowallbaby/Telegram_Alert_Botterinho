import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../.test-build/store.js';
import { reportCard } from '../.test-build/telegram.js';
import { fixture, seedReport, ALICE, BOB, CAROL, NOW } from './helpers.mjs';

test('publishing the same draft twice creates one report', async t => {
  const { store, env } = fixture(t);
  const report = await seedReport(store);
  const again = await store.publish(await store.draft('d1'), NOW, 10);
  assert.equal(again.id, report.id);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM report_history').first()).n, 1);
});
test('a failing statement rolls back the whole batch', async t => {
  const { env } = fixture(t);
  await assert.rejects(env.DB.batch([
    env.DB.prepare('INSERT INTO users VALUES(123,\'Test\',1,1)'),
    env.DB.prepare('INSERT INTO users VALUES(123,\'Duplicate\',1,1)')
  ]));
  assert.equal(await env.DB.prepare('SELECT * FROM users WHERE id=123').first(), null);
});
test('repeated confirmations count once and do not extend the report', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await store.vote(report, BOB, 'confirm', 10, 2, NOW + 10);
  const result = await store.vote(report, BOB, 'confirm', 11, 2, NOW + 300);
  assert.equal(result.confirmations, 1);
  assert.equal(result.last_confirmed_at, NOW + 10);
  assert.equal(result.expires_at, report.expires_at);
});
test('authors cannot confirm their own report', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await assert.rejects(store.vote(report, ALICE, 'confirm', 12, 2, NOW), { status: 400 });
});
test('two different members close a report, one member tapping twice does not', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await store.vote(report, BOB, 'clear', 1, 2, NOW + 1);
  const one = await store.vote(report, BOB, 'clear', 2, 2, NOW + 2);
  assert.equal(one.status, 'active'); assert.equal(one.clear_votes, 1);
  const two = await store.vote(report, CAROL, 'clear', 3, 2, NOW + 3);
  assert.equal(two.status, 'resolved'); assert.equal(two.resolved_at, NOW + 3);
});
test('old gone votes do not close the report', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await store.vote(report, BOB, 'clear', 1, 2, NOW + 1);
  const result = await store.vote(report, CAROL, 'clear', 2, 2, NOW + 1000);
  assert.equal(result.status, 'active'); assert.equal(result.clear_votes, 1);
});
test('a newer confirmation cancels out earlier gone votes', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await store.vote(report, BOB, 'clear', 1, 2, NOW + 1);
  await store.vote(report, CAROL, 'confirm', 2, 2, NOW + 20);
  const result = await store.vote(report, { id: 104, first_name: 'Dave' }, 'clear', 3, 2, NOW + 30);
  assert.equal(result.status, 'active'); assert.equal(result.clear_votes, 1);
});
test('switching from confirm to gone keeps the last confirmation time', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await store.vote(report, BOB, 'confirm', 1, 2, NOW + 10);
  const result = await store.vote(report, BOB, 'clear', 2, 2, NOW + 20);
  assert.equal(result.last_confirmed_at, NOW + 10); assert.equal(result.confirmations, 0);
});
test('expired reports leave the active view before the cron runs', async t => {
  const { store } = fixture(t); const report = await seedReport(store, 'd1', ALICE, 'traffic');
  assert.equal((await store.list('active', report.expires_at)).length, 0);
  assert.equal((await store.list('24h', report.expires_at)).length, 1);
});
test('maintenance marks reports as expired, never as resolved', async t => {
  const { store } = fixture(t); const report = await seedReport(store, 'd1', ALICE, 'traffic');
  await store.maintenance(NOW + 3601);
  const result = await store.report(report.id, NOW + 3601);
  assert.equal(result.status, 'expired'); assert.equal(result.resolved_at, null);
  assert.equal(await store.draft('d1'), null);
});
test('a removed report is hidden everywhere and its card is blanked', async t => {
  const { store, env } = fixture(t); const report = await seedReport(store);
  await store.close(report.id, ALICE, true, NOW);
  assert.equal((await store.list('7d', NOW)).length, 0);
  const card = reportCard(env, await store.report(report.id, NOW), NOW);
  assert.equal(card.text.includes('43.66'), false);
});
test('reports from another group are not visible', async t => {
  const { store, env } = fixture(t); const report = await seedReport(store);
  const other = new Store(env.DB, -100555);
  assert.equal(await other.report(report.id, NOW), null);
  assert.equal((await other.list('7d', NOW)).length, 0);
});
test('hourly and window rate limits are enforced', async t => {
  const { store } = fixture(t); await seedReport(store);
  await store.createDraft('d2', ALICE, store.chatId, 200, 43, 10, NOW, NOW);
  await store.chooseCategory('d2', 'traffic');
  await assert.rejects(store.publish(await store.draft('d2'), NOW, 1), { status: 429 });
  assert.equal(await store.allow('x', 1, 60, NOW), true);
  assert.equal(await store.allow('x', 1, 60, NOW), false);
  assert.equal(await store.allow('x', 1, 60, NOW + 60), true);
});
test('claimUpdate tells apart done, busy and expired leases', async t => {
  const { store } = fixture(t);
  assert.equal(await store.claimUpdate(1, NOW), 'claimed');
  assert.equal(await store.claimUpdate(1, NOW), 'busy');
  assert.equal(await store.claimUpdate(1, NOW + 61), 'claimed');
  await store.finishUpdate(1, NOW + 61);
  assert.equal(await store.claimUpdate(1, NOW + 999), 'done');
});
test('voting again after 15 minutes refreshes the vote without doubling it', async t => {
  const { store } = fixture(t); const report = await seedReport(store);
  await store.vote(report, BOB, 'clear', 1, 2, NOW + 1);
  const result = await store.vote(report, BOB, 'clear', 2, 2, NOW + 1000);
  assert.equal(result.clear_votes, 1); assert.equal(result.status, 'active');
});
