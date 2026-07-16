// Regression test for the 7-day unpaid-results window (server/expiry.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8806;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, getProjectStmt, markProjectPaidStmt } = await import('../db.js');
const { runExpiryPass } = await import('../expiry.js');

after(() => server.close());

function makeProject({ ageDays, paid = false } = {}) {
  const id = crypto.randomUUID();
  const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[{"name":"a"}]', '["flag"]', '["risk"]', '4-8 weeks', 'note', 'narrative text', null, createdAt, createdAt);
  if (paid) markProjectPaidStmt.run('full', createdAt, createdAt, id);
  return id;
}

test('an unpaid project past 7 days is cleared and marked expired', () => {
  const id = makeProject({ ageDays: 8 });
  runExpiryPass(() => {});
  const row = getProjectStmt.get(id);
  assert.ok(row.expired_at, 'expired_at should be set');
  assert.equal(row.agencies, '[]');
  assert.equal(row.narrative, '');
});

test('an unpaid project under 7 days old is untouched', () => {
  const id = makeProject({ ageDays: 3 });
  runExpiryPass(() => {});
  const row = getProjectStmt.get(id);
  assert.equal(row.expired_at, null);
  assert.equal(row.narrative, 'narrative text');
});

test('a paid project past 7 days never expires', () => {
  const id = makeProject({ ageDays: 30, paid: true });
  runExpiryPass(() => {});
  const row = getProjectStmt.get(id);
  assert.equal(row.expired_at, null);
  assert.equal(row.narrative, 'narrative text');
});

test('running the pass twice on the same project is a no-op the second time', () => {
  const id = makeProject({ ageDays: 8 });
  runExpiryPass(() => {});
  const firstExpiredAt = getProjectStmt.get(id).expired_at;
  runExpiryPass(() => {});
  assert.equal(getProjectStmt.get(id).expired_at, firstExpiredAt);
});
