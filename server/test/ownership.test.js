// Regression test for the project-ownership bug this audit found: a known
// project id used to let a second, unrelated account claim (steal) a
// project that already belonged to someone else. See db.js's
// linkProjectToUserStmt (the "AND user_id IS NULL" guard) and
// routes/auth.js's verify handler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused'; // required at startup; never actually called in this test
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject } = await import('../db.js');

let fixtureId;

before(async () => {
  fixtureId = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(
    fixtureId, 'Broward County, Florida', 'Test project', 'pool', 'anthropic',
    '[]', '[]', '[]', '4-8 weeks', 'test', 'test narrative', null, now, now
  );
});

after(() => server.close());

test('the original claimant gets the project', async () => {
  const linkRes = await fetch(`${BASE}/api/auth/request-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@test.com', projectId: fixtureId })
  });
  const { devLink } = await linkRes.json();
  const token = new URL(devLink).searchParams.get('token');

  const verifyRes = await fetch(`${BASE}/api/auth/verify?token=${token}`);
  const body = await verifyRes.json();
  assert.equal(verifyRes.status, 200);
  assert.ok(body.projects.some(p => p.id === fixtureId), 'owner should see the project after verifying');
});

test('a second account cannot claim an already-claimed project', async () => {
  const linkRes = await fetch(`${BASE}/api/auth/request-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'attacker@test.com', projectId: fixtureId })
  });
  const { devLink } = await linkRes.json();
  const token = new URL(devLink).searchParams.get('token');

  const verifyRes = await fetch(`${BASE}/api/auth/verify?token=${token}`);
  const body = await verifyRes.json();
  assert.equal(verifyRes.status, 200);
  assert.equal(body.projects.length, 0, 'attacker must not receive a project they never owned');
});
