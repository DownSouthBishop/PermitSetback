// Regression test for the post-timeline outcome email's signed GET
// endpoint (routes/projects.js's outcome-report handler) and the signing
// helper it depends on (server/outcome-signing.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8808;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
process.env.OUTCOME_SIGNING_SECRET = 'test-signing-secret';
delete process.env.GOOGLE_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

const { server } = await import('../index.js');
const { insertProject, markProjectPaidStmt, getProjectStmt, getReferralCodeByReferrerStmt } = await import('../db.js');
const { signOutcome, verifyOutcomeSignature } = await import('../outcome-signing.js');

after(() => server.close());

function makePaidProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'note', 'narrative text', null, now, now);
  markProjectPaidStmt.run('full', now, now, id);
  return id;
}

test('signOutcome/verifyOutcomeSignature round-trip, and a tampered signature fails', () => {
  const sig = signOutcome('proj-1', 'approved');
  assert.equal(verifyOutcomeSignature('proj-1', 'approved', sig), true);
  assert.equal(verifyOutcomeSignature('proj-1', 'rejected', sig), false, 'signature must be bound to the specific outcome');
  assert.equal(verifyOutcomeSignature('proj-2', 'approved', sig), false, 'signature must be bound to the specific project');
});

test('a valid outcome-report link records the outcome and grants a referral code', async () => {
  const id = makePaidProject();
  const sig = signOutcome(id, 'approved');
  const res = await fetch(`${BASE}/api/projects/${id}/outcome-report?outcome=approved&sig=${sig}`);
  assert.equal(res.status, 200);
  assert.equal(getProjectStmt.get(id).outcome_status, 'approved');
  assert.ok(getReferralCodeByReferrerStmt.get(id), 'expected a referral code to be minted');
});

test('an invalid signature is rejected — no outcome recorded, no code granted', async () => {
  const id = makePaidProject();
  const res = await fetch(`${BASE}/api/projects/${id}/outcome-report?outcome=approved&sig=deadbeef`);
  assert.equal(res.status, 200); // always a friendly page, never a raw error
  assert.equal(getProjectStmt.get(id).outcome_status, null);
  assert.equal(getReferralCodeByReferrerStmt.get(id), undefined);
});

test('"not_yet_filed" grants the referral code but records no outcome', async () => {
  const id = makePaidProject();
  const sig = signOutcome(id, 'not_yet_filed');
  await fetch(`${BASE}/api/projects/${id}/outcome-report?outcome=not_yet_filed&sig=${sig}`);
  assert.equal(getProjectStmt.get(id).outcome_status, null);
  assert.ok(getReferralCodeByReferrerStmt.get(id));
});

test('clicking the link twice does not mint a second referral code', async () => {
  const id = makePaidProject();
  const sig = signOutcome(id, 'approved');
  await fetch(`${BASE}/api/projects/${id}/outcome-report?outcome=approved&sig=${sig}`);
  const firstCode = getReferralCodeByReferrerStmt.get(id).code;
  await fetch(`${BASE}/api/projects/${id}/outcome-report?outcome=approved&sig=${sig}`);
  assert.equal(getReferralCodeByReferrerStmt.get(id).code, firstCode);
});
