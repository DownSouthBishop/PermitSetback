// Regression tests for the cancel-flow save offer (routes/billing.js's
// POST /api/subscription/apply-retention-offer). Split into its own
// file/process rather than added to billing.test.js — that file is already
// near the shared 10/min/IP rate-limit ceiling (server/rate-limit.js); a
// fresh process here gets its own rate-limiter state instead of tipping it over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8801;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

const { server } = await import('../index.js');
const { getOrCreateUser, insertSessionStmt, insertSubscriptionStmt, getSubscriptionByStripeIdStmt, markRetentionOfferUsedStmt } = await import('../db.js');

after(() => server.close());

function makeUser(email) {
  const user = getOrCreateUser(email);
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  insertSessionStmt.run(token, user.id, now.toISOString(), expires.toISOString());
  return { sessionToken: token, userId: user.id };
}

test('apply-retention-offer requires auth', async () => {
  const res = await fetch(`${BASE}/api/subscription/apply-retention-offer`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('apply-retention-offer 404s when the account has no active subscription', async () => {
  const { sessionToken } = await makeUser('no-sub-retention@example.com');
  const res = await fetch(`${BASE}/api/subscription/apply-retention-offer`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }
  });
  assert.equal(res.status, 404);
});

test('apply-retention-offer rejects a second attempt once already used, without calling Stripe', async () => {
  const { sessionToken, userId } = await makeUser('already-used-retention@example.com');
  const now = new Date().toISOString();
  const stripeSubId = `sub_${crypto.randomUUID()}`;
  insertSubscriptionStmt.run(crypto.randomUUID(), userId, stripeSubId, 'active', now, now, now);
  markRetentionOfferUsedStmt.run(now, now, stripeSubId);

  const res = await fetch(`${BASE}/api/subscription/apply-retention-offer`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }
  });
  assert.equal(res.status, 400);
});

test('apply-retention-offer fails gracefully with no Stripe key configured, and does not mark the offer used', async () => {
  const { sessionToken, userId } = await makeUser('fresh-retention@example.com');
  const now = new Date().toISOString();
  const stripeSubId = `sub_${crypto.randomUUID()}`;
  insertSubscriptionStmt.run(crypto.randomUUID(), userId, stripeSubId, 'active', now, now, now);

  const res = await fetch(`${BASE}/api/subscription/apply-retention-offer`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }
  });
  assert.equal(res.status, 502);
  const row = getSubscriptionByStripeIdStmt.get(stripeSubId);
  assert.equal(row.retention_offer_used_at, null);
});
