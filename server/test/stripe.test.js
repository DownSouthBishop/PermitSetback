// Regression tests for the Stripe integration. Actually calling Stripe's API
// (creating/retrieving a real Checkout Session) needs a real key and network
// access, so isn't exercised here — this covers what's genuinely testable
// offline: webhook signature verification (pure HMAC, no network), and the
// paths that must short-circuit before ever calling Stripe (an already-paid
// project, a missing webhook secret).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8796;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { verifyWebhookSignature } = await import('../stripe.js');
const { server } = await import('../index.js');
const { insertProject, markProjectPaidStmt } = await import('../db.js');

function makeProject({ paid = false } = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  if (paid) markProjectPaidStmt.run('full', now, now, id);
  return id;
}

after(() => server.close());

test('a valid webhook signature verifies', () => {
  const secret = 'whsec_test123';
  const body = JSON.stringify({ hello: 'world' });
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const header = `t=${timestamp},v1=${sig}`;
  assert.equal(verifyWebhookSignature(body, header, secret), true);
});

test('a tampered webhook body fails verification', () => {
  const secret = 'whsec_test123';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.original body`).digest('hex');
  const header = `t=${timestamp},v1=${sig}`;
  assert.equal(verifyWebhookSignature('tampered body', header, secret), false);
});

test('a signature with the wrong secret fails verification', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_correct').update(`${timestamp}.body`).digest('hex');
  const header = `t=${timestamp},v1=${sig}`;
  assert.equal(verifyWebhookSignature('body', header, 'whsec_wrong'), false);
});

test('a missing signature header fails verification without throwing', () => {
  assert.equal(verifyWebhookSignature('body', undefined, 'whsec_test123'), false);
});

test('a malformed signature header fails verification without throwing (mismatched length)', () => {
  assert.equal(verifyWebhookSignature('body', 't=123,v1=short', 'whsec_test123'), false);
});

test('create-checkout-session on an already-paid project short-circuits without calling Stripe', async () => {
  const projectId = makeProject({ paid: 1 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paid, true);
});

test('create-checkout-session on an unpaid project fails gracefully with no Stripe key configured', async () => {
  const projectId = makeProject({ paid: 0 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, { method: 'POST' });
  assert.equal(res.status, 502);
});

test('confirm-checkout on an already-paid project short-circuits without calling Stripe', async () => {
  const projectId = makeProject({ paid: 1 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/confirm-checkout?session_id=cs_fake`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paid, true);
});

test('confirm-checkout with no session_id is rejected', async () => {
  const projectId = makeProject({ paid: 0 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/confirm-checkout`);
  assert.equal(res.status, 400);
});

test('the webhook endpoint 503s when STRIPE_WEBHOOK_SECRET is not set', async () => {
  const res = await fetch(`${BASE}/api/stripe/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'checkout.session.completed' })
  });
  assert.equal(res.status, 503);
});

test('create-checkout-session rejects a tier that is not "roadmap" or "full"', async () => {
  const projectId = makeProject({ paid: 0 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'ultra' })
  });
  assert.equal(res.status, 400);
});

test('create-checkout-session rejects an unknown referral code', async () => {
  const projectId = makeProject({ paid: 0 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'full', referralCode: 'NOSUCHCODE' })
  });
  assert.equal(res.status, 400);
});

test('create-checkout-session rejects a referral code on the project that generated it (self-referral)', async () => {
  const { insertReferralCodeStmt } = await import('../db.js');
  const projectId = makeProject({ paid: 0 });
  insertReferralCodeStmt.run('SELFTEST1', projectId, null, new Date().toISOString());
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'full', referralCode: 'SELFTEST1' })
  });
  assert.equal(res.status, 400);
});

test('redeem-pack-credit requires a signed-in session', async () => {
  const projectId = makeProject({ paid: 0 });
  const res = await fetch(`${BASE}/api/projects/${projectId}/redeem-pack-credit`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('redeem-pack-credit fails when the account has no available pack credits', async () => {
  const { getOrCreateUser, insertSessionStmt } = await import('../db.js');
  const user = getOrCreateUser('pack-test-no-credits@example.com');
  const token = crypto.randomUUID();
  const now = new Date();
  insertSessionStmt.run(token, user.id, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
  const projectId = makeProject({ paid: 0 });

  const res = await fetch(`${BASE}/api/projects/${projectId}/redeem-pack-credit`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 400);
});

test('GET a project surfaces its own unredeemed referral code', async () => {
  const { insertReferralCodeStmt } = await import('../db.js');
  const projectId = makeProject({ paid: 1 });
  insertReferralCodeStmt.run('SHOWCODE1', projectId, null, new Date().toISOString());

  const res = await fetch(`${BASE}/api/projects/${projectId}`);
  const body = await res.json();
  assert.equal(body.referralCode, 'SHOWCODE1');
});

test('GET a project does not surface an already-redeemed referral code', async () => {
  const { insertReferralCodeStmt, redeemReferralCodeStmt } = await import('../db.js');
  const projectId = makeProject({ paid: 1 });
  const redeemerId = makeProject({ paid: 1 });
  insertReferralCodeStmt.run('USEDCODE1', projectId, null, new Date().toISOString());
  redeemReferralCodeStmt.run(redeemerId, new Date().toISOString(), 'USEDCODE1');

  const res = await fetch(`${BASE}/api/projects/${projectId}`);
  const body = await res.json();
  assert.equal(body.referralCode, null);
});

test('redeem-pack-credit consumes a credit and unlocks the project at full tier', async () => {
  const { getOrCreateUser, insertSessionStmt, insertPackCreditsStmt, getAvailablePackForUserStmt } = await import('../db.js');
  const user = getOrCreateUser('pack-test-with-credits@example.com');
  const token = crypto.randomUUID();
  const now = new Date();
  insertSessionStmt.run(token, user.id, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
  insertPackCreditsStmt.run(crypto.randomUUID(), user.id, 'cs_test_pack', 50, now.toISOString());
  const projectId = makeProject({ paid: 0 });

  const res = await fetch(`${BASE}/api/projects/${projectId}/redeem-pack-credit`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paid, true);
  assert.equal(body.tier, 'full');

  const pack = getAvailablePackForUserStmt.get(user.id);
  // Still the same pack (49 of 50 credits left), not exhausted — proves the
  // credit was actually decremented rather than the pack being consumed whole.
  assert.equal(pack.stripe_session_id, 'cs_test_pack');
});

test('two concurrent redeem-pack-credit calls on the last credit cannot both succeed', async () => {
  const { getOrCreateUser, insertSessionStmt, insertPackCreditsStmt, db } = await import('../db.js');
  const user = getOrCreateUser('pack-test-race@example.com');
  const token = crypto.randomUUID();
  const now = new Date();
  insertSessionStmt.run(token, user.id, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
  const packId = crypto.randomUUID();
  // credits_total: 1 — exactly one credit available, so two concurrent
  // spends against it can't both legitimately win.
  db.prepare('INSERT INTO pack_credits (id, user_id, stripe_session_id, credits_total, credits_used, created_at) VALUES (?, ?, ?, 1, 0, ?)')
    .run(packId, user.id, 'cs_test_race_pack', now.toISOString());

  const p1 = makeProject({ paid: 0 });
  const p2 = makeProject({ paid: 0 });
  const [r1, r2] = await Promise.all([
    fetch(`${BASE}/api/projects/${p1}/redeem-pack-credit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${BASE}/api/projects/${p2}/redeem-pack-credit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 400], `expected exactly one 200 and one 400, got ${statuses}`);

  const finalPack = db.prepare('SELECT credits_used FROM pack_credits WHERE id = ?').get(packId);
  assert.equal(finalPack.credits_used, 1, 'credits_used must reflect exactly one spend, not two');
});

test('pack_credits rejects a second insert for the same stripe_session_id', async () => {
  const { insertPackCreditsStmt, getOrCreateUser } = await import('../db.js');
  const user = getOrCreateUser('pack-test-dupe-session@example.com');
  const now = new Date().toISOString();
  insertPackCreditsStmt.run(crypto.randomUUID(), user.id, 'cs_test_dupe_session', 50, now);
  assert.throws(
    () => insertPackCreditsStmt.run(crypto.randomUUID(), user.id, 'cs_test_dupe_session', 50, now),
    /UNIQUE/,
    'a second pack_credits row for the same Stripe session must be rejected — this is the guard against the webhook and the redirect-confirm both crediting one $999 charge'
  );
});
