// Regression test for the refund/guarantee claim capture path — the
// destination the guarantee promise ("send us the rejection notice") never
// actually had before this existed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, db } = await import('../db.js');

function makeProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  return id;
}

after(() => server.close());

test('a claim with details is accepted and stored', async () => {
  const projectId = makeProject();
  const res = await fetch(`${BASE}/api/projects/${projectId}/refund-claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ details: 'They rejected it for missing an electrical permit we never flagged.', contactEmail: 'test@example.com' })
  });
  assert.equal(res.status, 200);

  const row = db.prepare('SELECT * FROM refund_claims WHERE project_id = ?').get(projectId);
  assert.ok(row);
  assert.equal(row.status, 'open');
  assert.equal(row.contact_email, 'test@example.com');
});

test('a claim with no details is rejected', async () => {
  const projectId = makeProject();
  const res = await fetch(`${BASE}/api/projects/${projectId}/refund-claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details: '   ' })
  });
  assert.equal(res.status, 400);
});

test('a claim against an unknown project 404s', async () => {
  const res = await fetch(`${BASE}/api/projects/${crypto.randomUUID()}/refund-claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details: 'something' })
  });
  assert.equal(res.status, 404);
});
