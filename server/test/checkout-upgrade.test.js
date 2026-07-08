// Regression tests for the Roadmap-to-Full-Workspace upgrade path
// (routes/checkout.js). Split into its own file/process rather than added
// to stripe.test.js — that file already runs exactly 10 rate-limited
// requests, at the shared 10/min/IP ceiling (server/rate-limit.js); a fresh
// process here gets its own rate-limiter state instead of tipping that file over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

const { server } = await import('../index.js');
const {
  insertProject, markProjectPaidStmt, getOrCreateUser, insertSessionStmt,
  insertSubscriptionStmt, insertReferralCodeStmt, getReferralCodeStmt
} = await import('../db.js');

after(() => server.close());

function makeProject({ tier = 'roadmap' } = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  markProjectPaidStmt.run(tier, now, now, id);
  return id;
}

test('create-checkout-session on a Roadmap-tier project does not short-circuit — it attempts the $48 upgrade', async () => {
  // No STRIPE_SECRET_KEY in this test env, so falling through to a real
  // Stripe call (rather than incorrectly short-circuiting like a
  // fully-paid project would) surfaces as a 502, not a 200.
  const projectId = makeProject({ tier: 'roadmap' });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, { method: 'POST' });
  assert.equal(res.status, 502);
});

test('create-checkout-session on a Roadmap-tier project rejects a request to re-buy the Roadmap tier', async () => {
  const projectId = makeProject({ tier: 'roadmap' });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'roadmap' })
  });
  assert.equal(res.status, 400);
});

test('create-checkout-session upgrades a Roadmap-tier project for free when the buyer has an active subscription', async () => {
  const user = getOrCreateUser('upgrade-subscriber@example.com');
  const token = crypto.randomUUID();
  const now = new Date();
  insertSessionStmt.run(token, user.id, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
  insertSubscriptionStmt.run(crypto.randomUUID(), user.id, `sub_${crypto.randomUUID()}`, 'active', null, now.toISOString(), now.toISOString());

  const projectId = makeProject({ tier: 'roadmap' });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tier: 'full' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paid, true);
  assert.equal(body.tier, 'full');
});

test('create-checkout-session upgrades a Roadmap-tier project for free with a valid unredeemed referral code, and consumes it', async () => {
  const referrerProjectId = makeProject({ tier: 'full' });
  insertReferralCodeStmt.run('UPGRADEFREE1', referrerProjectId, null, new Date().toISOString());

  const projectId = makeProject({ tier: 'roadmap' });
  const res = await fetch(`${BASE}/api/projects/${projectId}/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'full', referralCode: 'UPGRADEFREE1' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'full');
  assert.equal(getReferralCodeStmt.get('UPGRADEFREE1').redeemed_project_id, projectId);
});

test('confirm-checkout on a Roadmap-tier project does not short-circuit — it attempts to verify the upgrade session', async () => {
  const projectId = makeProject({ tier: 'roadmap' });
  const res = await fetch(`${BASE}/api/projects/${projectId}/confirm-checkout?session_id=cs_fake_upgrade`);
  assert.equal(res.status, 502);
});
