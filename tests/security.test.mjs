import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, equalSecret, readJson } from '../.test-build/security.js';
import { category, coordinates, html, isMember, statusAt, chatMessageLink } from '../.test-build/domain.js';
import { makeEnv, signedInit, ALICE, NOW, fixture, apiRequest, webhook, locationUpdate } from './helpers.mjs';

const env = makeEnv();
test.after(() => env.DB.close());
test('initData signature matches an HMAC computed independently with node:crypto', async () => {
  assert.equal((await verifyInitData(signedInit(env), env.BOT_TOKEN, NOW)).id, ALICE.id);
});
test('the signature field is part of the HMAC check string', async () => {
  assert.equal((await verifyInitData(signedInit(env, ALICE, NOW, { signature: 'ED25519_TEST_FIELD' }), env.BOT_TOKEN, NOW)).id, ALICE.id);
});
test('tampering with the signed user is rejected', async () => {
  const p = new URLSearchParams(signedInit(env)); p.set('user', JSON.stringify({ id: 999, first_name: 'Fake' }));
  await assert.rejects(verifyInitData(p.toString(), env.BOT_TOKEN, NOW), { status: 401 });
});
test('old sessions and future timestamps are rejected', async () => {
  await assert.rejects(verifyInitData(signedInit(env, ALICE, NOW - 3601), env.BOT_TOKEN, NOW), { status: 401 });
  await assert.rejects(verifyInitData(signedInit(env, ALICE, NOW + 31), env.BOT_TOKEN, NOW), { status: 401 });
});
test('duplicate parameters and oversized input are rejected', async () => {
  await assert.rejects(verifyInitData(signedInit(env) + '&auth_date=0', env.BOT_TOKEN, NOW), { status: 401 });
  await assert.rejects(verifyInitData('a'.repeat(9000), env.BOT_TOKEN, NOW), { status: 401 });
});
test('secret comparison and HTML escaping', () => {
  assert.equal(equalSecret('', ''), false); assert.equal(equalSecret('abc', 'abd'), false);
  assert.equal(equalSecret('abc', 'abc'), true);
  assert.equal(html('<b>"A&B"</b>'), '&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
});
test('coordinate, category and status validation', () => {
  assert.equal(coordinates(NaN, 10), false); assert.equal(coordinates(43, 181), false);
  assert.equal(coordinates(43, 10), true); assert.equal(category('__proto__'), null);
  assert.equal(statusAt({ status: 'active', expires_at: NOW }, NOW), 'expired');
  assert.equal(statusAt({ status: 'resolved', expires_at: NOW }, NOW), 'resolved');
  assert.equal(isMember({ status: 'restricted', is_member: false }), false);
  assert.equal(chatMessageLink(-12345, 1), null);
});
test('body size limit applies even without Content-Length', async () => {
  const r = new Request('https://example.test', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(100) }) });
  await assert.rejects(readJson(r, 20), { status: 413 });
});
test('a webhook call without the secret never reaches the database', async t => {
  const { env } = fixture(t); const before = env.DB.queries;
  assert.equal((await webhook(env, locationUpdate(env), 'wrong')).status, 401);
  assert.equal(env.DB.queries, before);
});
test('the map API rejects requests without initData', async t => {
  const { env } = fixture(t); assert.equal((await apiRequest(env, '')).status, 401);
});
test('the map API rejects non-members even with a valid signature', async t => {
  const { env } = fixture(t);
  assert.equal((await apiRequest(env, signedInit(env, { id: 404, first_name: 'Outsider' }))).status, 403);
});
test('leaving the group revokes access on the next request', async t => {
  const { env, members } = fixture(t);
  assert.equal((await apiRequest(env)).status, 200);
  members.set(ALICE.id, 'left');
  assert.equal((await apiRequest(env)).status, 403);
});
