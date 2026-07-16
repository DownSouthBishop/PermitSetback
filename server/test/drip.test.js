// Regression test for the day-2/day-6 drip emails (server/drip.js): correct
// candidates, no double-send, and paid/expired/unsubscribed projects are
// excluded (which is how "purchase cancels the sequence" and "unsubscribe
// is honored" are actually implemented — see db.js's getDripCandidatesStmt).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8807;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.DRIP_EMAIL_ORIGIN = 'https://setback.example';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const {
  insertProject, markProjectPaidStmt, insertMagicLinkStmt, getProjectStmt, unsubscribeProjectStmt
} = await import('../db.js');
const { runDripPass } = await import('../drip.js');

after(() => server.close());

function makeCapturedProject({ ageDays, paid = false }) {
  const id = crypto.randomUUID();
  const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '["risk1"]', '4-8 weeks', 'note', 'narrative text', null, createdAt, createdAt);
  insertMagicLinkStmt.run(crypto.randomUUID(), 'lead@example.com', id, createdAt, createdAt);
  if (paid) markProjectPaidStmt.run('full', createdAt, createdAt, id);
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

test('a project 3 days old gets the day-2 email, not day-6', async () => {
  const { sent, restore } = stubResend();
  try {
    const id = makeCapturedProject({ ageDays: 3 });
    await runDripPass(() => {});
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /What a rejected permit actually costs/);
    const row = getProjectStmt.get(id);
    assert.ok(row.drip_day2_sent_at);
    assert.equal(row.drip_day6_sent_at, null);
  } finally { restore(); }
});

test('a project 7 days old gets both day-2 and day-6 in one pass, each once', async () => {
  const { sent, restore } = stubResend();
  try {
    makeCapturedProject({ ageDays: 7 });
    await runDripPass(() => {});
    assert.equal(sent.length, 2);
  } finally { restore(); }
});

test('running the pass twice never double-sends', async () => {
  const { sent, restore } = stubResend();
  try {
    makeCapturedProject({ ageDays: 3 });
    await runDripPass(() => {});
    await runDripPass(() => {});
    assert.equal(sent.length, 1, 'the second pass must not re-send the day-2 email');
  } finally { restore(); }
});

test('a paid project never receives drip emails', async () => {
  const { sent, restore } = stubResend();
  try {
    makeCapturedProject({ ageDays: 7, paid: true });
    await runDripPass(() => {});
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

test('an unsubscribed project is excluded even if otherwise due', async () => {
  const { sent, restore } = stubResend();
  try {
    const id = makeCapturedProject({ ageDays: 7 });
    unsubscribeProjectStmt.run(new Date().toISOString(), id);
    await runDripPass(() => {});
    assert.equal(sent.length, 0);
  } finally { restore(); }
});
