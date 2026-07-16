// Regression test for the KPI events fired at purchase-confirmation time
// (routes/checkout.js's confirm-checkout, routes/billing.js's expediter-pack
// confirm-checkout): second_purchase, drip_converted, bid_pack_purchased.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8810;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const {
  db, insertProject, getOrCreateUser, linkProjectToUserStmt, markProjectPaidStmt
} = await import('../db.js');

after(() => server.close());

function eventsNamed(name) {
  return db.prepare('SELECT * FROM events WHERE name = ?').all(name);
}

// Stubs retrieveCheckoutSession's underlying fetch to report a paid,
// full-tier session for the given project — confirm-checkout's KPI-event
// logging only runs after Stripe confirms payment, so this is what lets
// these tests reach it without a real Stripe account.
function stubStripeSessionPaid(projectId) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://api.stripe.com/v1/checkout/sessions/')) {
      return new Response(JSON.stringify({ payment_status: 'paid', metadata: { projectId, tier: 'full' }, amount_total: 9700 }), { status: 200 });
    }
    // Any other Stripe call this path triggers (e.g. minting a referral
    // promotion code) — a generic success, since these tests care about
    // the KPI events, not the referral-mint side effect.
    if (typeof url === 'string' && url.startsWith('https://api.stripe.com/')) {
      return new Response(JSON.stringify({ id: 'stripe_test_id' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function makeProject({ paid = false } = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  if (paid) markProjectPaidStmt.run('full', now, now, id);
  return id;
}

test('a second paid project for the same user logs second_purchase', async () => {
  const user = getOrCreateUser(`second-purchase-${crypto.randomUUID()}@example.com`);
  const firstId = makeProject({ paid: true });
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), firstId);

  const secondId = makeProject();
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), secondId);

  const before = eventsNamed('second_purchase').length;
  const restore = stubStripeSessionPaid(secondId);
  try {
    await fetch(`${BASE}/api/projects/${secondId}/confirm-checkout?session_id=cs_test_123`);
  } finally { restore(); }
  assert.equal(eventsNamed('second_purchase').length, before + 1);
});

test('a first-ever paid project for a user does not log second_purchase', async () => {
  const user = getOrCreateUser(`first-purchase-${crypto.randomUUID()}@example.com`);
  const id = makeProject();
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), id);

  const before = eventsNamed('second_purchase').length;
  const restore = stubStripeSessionPaid(id);
  try {
    await fetch(`${BASE}/api/projects/${id}/confirm-checkout?session_id=cs_test_456`);
  } finally { restore(); }
  assert.equal(eventsNamed('second_purchase').length, before);
});

test('a project that already received a drip email logs drip_converted on purchase', async () => {
  const id = makeProject();
  db.prepare('UPDATE projects SET drip_day2_sent_at = ? WHERE id = ?').run(new Date().toISOString(), id);

  const before = eventsNamed('drip_converted').length;
  const restore = stubStripeSessionPaid(id);
  try {
    await fetch(`${BASE}/api/projects/${id}/confirm-checkout?session_id=cs_test_789`);
  } finally { restore(); }
  assert.equal(eventsNamed('drip_converted').length, before + 1);
});

test('a project with no drip email sent does not log drip_converted', async () => {
  const id = makeProject();
  const before = eventsNamed('drip_converted').length;
  const restore = stubStripeSessionPaid(id);
  try {
    await fetch(`${BASE}/api/projects/${id}/confirm-checkout?session_id=cs_test_000`);
  } finally { restore(); }
  assert.equal(eventsNamed('drip_converted').length, before);
});
