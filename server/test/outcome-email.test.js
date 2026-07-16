// Regression test for the post-timeline outcome email pass (server/outcome-email.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8809;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.DRIP_EMAIL_ORIGIN = 'https://setback.example';
process.env.OUTCOME_SIGNING_SECRET = 'test-signing-secret';
process.env.OUTCOME_EMAIL_DELAY_DAYS = '60';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, markProjectPaidStmt, insertMagicLinkStmt, getProjectStmt } = await import('../db.js');
const { runOutcomeEmailPass } = await import('../outcome-email.js');

after(() => server.close());

function makeCapturedPaidProject({ paidDaysAgo }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const paidAt = new Date(Date.now() - paidDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'note', 'narrative text', null, now, now);
  markProjectPaidStmt.run('full', paidAt, paidAt, id);
  insertMagicLinkStmt.run(crypto.randomUUID(), 'buyer@example.com', id, now, now);
  return id;
}

function stubResend() {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(opts.body));
      return new Response('{}', { status: 200 });
    }
    return originalFetch(url, opts);
  };
  return { sent, restore: () => { globalThis.fetch = originalFetch; } };
}

test('a project paid 61 days ago (past the 60-day delay) gets the outcome email', async () => {
  const { sent, restore } = stubResend();
  try {
    const id = makeCapturedPaidProject({ paidDaysAgo: 61 });
    await runOutcomeEmailPass(() => {});
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Did Denver, Colorado get approved\?/);
    assert.ok(getProjectStmt.get(id).outcome_email_sent_at);
  } finally { restore(); }
});

test('a project paid 10 days ago does not get the outcome email yet', async () => {
  const { sent, restore } = stubResend();
  try {
    makeCapturedPaidProject({ paidDaysAgo: 10 });
    await runOutcomeEmailPass(() => {});
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

test('running the pass twice never double-sends', async () => {
  const { sent, restore } = stubResend();
  try {
    makeCapturedPaidProject({ paidDaysAgo: 61 });
    await runOutcomeEmailPass(() => {});
    await runOutcomeEmailPass(() => {});
    assert.equal(sent.length, 1);
  } finally { restore(); }
});
