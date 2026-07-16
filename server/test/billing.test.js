// Regression tests for subscription + expediter-pack billing
// (routes/billing.js, and the webhook's subscription/pack handling). Same
// split as stripe.test.js: no real Stripe network calls, so this covers
// auth/validation short-circuits and webhook-driven DB state, using a real
// signed payload against a real STRIPE_WEBHOOK_SECRET (pure HMAC, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = 'whsec_test_billing';

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
delete process.env.GOOGLE_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

const { server } = await import('../index.js');
const {
  getOrCreateUser, insertSessionStmt, insertSubscriptionStmt, getActiveSubscriptionByUserStmt,
  getSubscriptionByStripeIdStmt, getAvailablePackForUserStmt, updateSubscriptionStatusStmt
} = await import('../db.js');

after(() => server.close());

function signedWebhookHeaders(payload) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return { body, headers: { 'stripe-signature': `t=${timestamp},v1=${sig}`, 'content-type': 'application/json' } };
}

// Same as routes/auth.js's verify step (create-or-find user, mint a
// session), just called directly against the DB instead of over HTTP — the
// magic-link request/verify round trip itself is covered by auth's own
// tests, and going straight to the DB here keeps this file's request count
// well under the 10/min/IP rate limit shared with the auth routes.
function makeUser(email) {
  const user = getOrCreateUser(email);
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  insertSessionStmt.run(token, user.id, now.toISOString(), expires.toISOString());
  return { sessionToken: token, userId: user.id };
}

test('subscription create-checkout-session requires auth', async () => {
  const res = await fetch(`${BASE}/api/subscription/create-checkout-session`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('subscription create-checkout-session refuses new subscriptions by default (withdrawn from sale)', async () => {
  const { sessionToken } = await makeUser('subscriber1@example.com');
  const res = await fetch(`${BASE}/api/subscription/create-checkout-session`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }
  });
  assert.equal(res.status, 403);
});

test('subscription create-checkout-session fails gracefully with no Stripe key configured, when re-enabled', async () => {
  process.env.SUBSCRIPTIONS_ENABLED = 'true';
  try {
    const { sessionToken } = await makeUser('subscriber2@example.com');
    const res = await fetch(`${BASE}/api/subscription/create-checkout-session`, {
      method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }
    });
    assert.equal(res.status, 502);
  } finally {
    delete process.env.SUBSCRIPTIONS_ENABLED;
  }
});

test('expediter-pack create-checkout-session requires auth', async () => {
  const res = await fetch(`${BASE}/api/expediter-pack/create-checkout-session`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('expediter-pack create-checkout-session fails gracefully with no Stripe key configured', async () => {
  const { sessionToken } = await makeUser('expediter1@example.com');
  const res = await fetch(`${BASE}/api/expediter-pack/create-checkout-session`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }
  });
  assert.equal(res.status, 502);
});

test('expediter-pack create-checkout-session rejects a size that is not "starter" or "bulk"', async () => {
  const { sessionToken } = await makeUser('expediter-badsize@example.com');
  const res = await fetch(`${BASE}/api/expediter-pack/create-checkout-session`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ size: 'jumbo' })
  });
  assert.equal(res.status, 400);
});

test('subscription confirm-checkout with no session_id is rejected', async () => {
  const res = await fetch(`${BASE}/api/subscription/confirm-checkout`);
  assert.equal(res.status, 400);
});

test('expediter-pack confirm-checkout with no session_id is rejected', async () => {
  const res = await fetch(`${BASE}/api/expediter-pack/confirm-checkout`);
  assert.equal(res.status, 400);
});

test('cancel-subscription requires auth', async () => {
  const res = await fetch(`${BASE}/api/subscription/cancel`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('cancel-subscription 404s when the account has no active subscription', async () => {
  const { sessionToken } = await makeUser('nosub@example.com');
  const res = await fetch(`${BASE}/api/subscription/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'other' })
  });
  assert.equal(res.status, 404);
});

test('cancel-subscription rejects an invalid exit reason', async () => {
  const { sessionToken, userId } = await makeUser('canceler1@example.com');
  const now = new Date().toISOString();
  insertSubscriptionStmt.run(crypto.randomUUID(), userId, `sub_${crypto.randomUUID()}`, 'active', now, now, now);
  const res = await fetch(`${BASE}/api/subscription/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'nonsense' })
  });
  assert.equal(res.status, 400);
});

test('the webhook rejects a bad signature', async () => {
  const res = await fetch(`${BASE}/api/stripe/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({ type: 'customer.subscription.created' })
  });
  assert.equal(res.status, 400);
});

test('customer.subscription.created webhook inserts a subscription row', async () => {
  const { userId } = await makeUser('webhook-created@example.com');
  const stripeSubId = `sub_${crypto.randomUUID()}`;
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const { body, headers } = signedWebhookHeaders({
    type: 'customer.subscription.created',
    data: { object: { id: stripeSubId, status: 'active', current_period_end: periodEnd, metadata: { userId: String(userId) } } }
  });
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);
  const row = getSubscriptionByStripeIdStmt.get(stripeSubId);
  assert.equal(row.status, 'active');
  assert.equal(row.user_id, userId);
  const active = getActiveSubscriptionByUserStmt.get(userId);
  assert.equal(active.stripe_subscription_id, stripeSubId);
});

test('customer.subscription.deleted webhook marks the row canceled and preserves an already-recorded cancel reason', async () => {
  const { userId } = await makeUser('webhook-deleted@example.com');
  const stripeSubId = `sub_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  insertSubscriptionStmt.run(crypto.randomUUID(), userId, stripeSubId, 'active', now, now, now);
  // cancel_reason gets recorded directly (no Stripe key configured in this
  // test, so the endpoint's own Stripe call would 502 — bypass the endpoint
  // and set it the same way it does, to isolate what this test is checking).
  updateSubscriptionStatusStmt.run('active', now, 'too_expensive', now, stripeSubId);

  const { body, headers } = signedWebhookHeaders({
    type: 'customer.subscription.deleted',
    data: { object: { id: stripeSubId, status: 'canceled', current_period_end: Math.floor(Date.now() / 1000) } }
  });
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);
  const row = getSubscriptionByStripeIdStmt.get(stripeSubId);
  assert.equal(row.status, 'canceled');
  assert.equal(row.cancel_reason, 'too_expensive');
});

test('invoice.payment_failed webhook marks the subscription past_due', async () => {
  const { userId } = await makeUser('webhook-failed@example.com');
  const stripeSubId = `sub_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  insertSubscriptionStmt.run(crypto.randomUUID(), userId, stripeSubId, 'active', now, now, now);

  const { body, headers } = signedWebhookHeaders({
    type: 'invoice.payment_failed',
    data: { object: { subscription: stripeSubId } }
  });
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);
  const row = getSubscriptionByStripeIdStmt.get(stripeSubId);
  assert.equal(row.status, 'past_due');
});

test('checkout.session.completed webhook credits an expediter pack once, not twice on a retried webhook', async () => {
  const { userId } = await makeUser('webhook-pack@example.com');
  const stripeSessionId = `cs_${crypto.randomUUID()}`;
  const { body, headers } = signedWebhookHeaders({
    type: 'checkout.session.completed',
    data: { object: { id: stripeSessionId, payment_status: 'paid', metadata: { type: 'expediter_pack', userId: String(userId) } } }
  });
  const res1 = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res1.status, 200);
  const res2 = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res2.status, 200);

  const pack = getAvailablePackForUserStmt.get(userId);
  // No size in metadata — defaults to the Bulk pack (50 credits), same as
  // every pack sold before the Starter size existed.
  assert.equal(pack.credits_total, 50);
});

test('checkout.session.completed webhook credits a Starter pack at 15 credits, not the Bulk default', async () => {
  const { userId } = await makeUser('webhook-pack-starter@example.com');
  const stripeSessionId = `cs_${crypto.randomUUID()}`;
  const { body, headers } = signedWebhookHeaders({
    type: 'checkout.session.completed',
    data: { object: { id: stripeSessionId, payment_status: 'paid', metadata: { type: 'expediter_pack', userId: String(userId), size: 'starter' } } }
  });
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);

  const pack = getAvailablePackForUserStmt.get(userId);
  assert.equal(pack.credits_total, 15);
});

test('checkout.session.completed webhook credits a Bid Pack at 5 credits', async () => {
  const { userId } = await makeUser('webhook-pack-bid5@example.com');
  const stripeSessionId = `cs_${crypto.randomUUID()}`;
  const { body, headers } = signedWebhookHeaders({
    type: 'checkout.session.completed',
    data: { object: { id: stripeSessionId, payment_status: 'paid', metadata: { type: 'expediter_pack', userId: String(userId), size: 'bid5' } } }
  });
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);

  const pack = getAvailablePackForUserStmt.get(userId);
  assert.equal(pack.credits_total, 5);
});

test('expediter-pack create-checkout-session accepts "bid5" as a valid size', async () => {
  const { sessionToken } = await makeUser('expediter-bid5@example.com');
  const res = await fetch(`${BASE}/api/expediter-pack/create-checkout-session`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ size: 'bid5' })
  });
  // No STRIPE_SECRET_KEY in this test env — 502 (Stripe call attempted and
  // failed) proves validation passed, as opposed to the 400 a rejected size
  // would produce.
  assert.equal(res.status, 502);
});
