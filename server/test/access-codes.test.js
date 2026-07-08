// Regression test for the access-code unlock system — the free-access path
// for beta testers and the founder, independent of payment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject } = await import('../db.js');
const db = (await import('../db.js')).db;

function makeProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  return id;
}

function makeCode(code, { maxUses = null, expiresAt = null } = {}) {
  db.prepare('INSERT INTO access_codes (code, label, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, 'test code', maxUses, expiresAt, new Date().toISOString());
}

after(() => server.close());

test('a valid unlimited code unlocks a project', async () => {
  const projectId = makeProject();
  makeCode('GOODCODE');
  const res = await fetch(`${BASE}/api/projects/${projectId}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'goodcode' })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.paid, true);
  assert.equal(body.narrative, 'narrative text');
});

test('an unknown code is rejected', async () => {
  const projectId = makeProject();
  const res = await fetch(`${BASE}/api/projects/${projectId}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'NOPE' })
  });
  assert.equal(res.status, 400);
});

test('a code past its max uses is rejected', async () => {
  makeCode('ONEUSE', { maxUses: 1 });
  const firstProject = makeProject();
  const first = await fetch(`${BASE}/api/projects/${firstProject}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ONEUSE' })
  });
  assert.equal(first.status, 200);

  const secondProject = makeProject();
  const second = await fetch(`${BASE}/api/projects/${secondProject}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ONEUSE' })
  });
  assert.equal(second.status, 400);
});

test('an expired code is rejected', async () => {
  makeCode('EXPIRED', { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
  const projectId = makeProject();
  const res = await fetch(`${BASE}/api/projects/${projectId}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'EXPIRED' })
  });
  assert.equal(res.status, 400);
});

test('two concurrent redemptions of a max_uses:1 code cannot both succeed', async () => {
  makeCode('RACECODE', { maxUses: 1 });
  const p1 = makeProject();
  const p2 = makeProject();
  const [r1, r2] = await Promise.all([
    fetch(`${BASE}/api/projects/${p1}/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'RACECODE' }) }),
    fetch(`${BASE}/api/projects/${p2}/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'RACECODE' }) })
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 400], `expected exactly one 200 and one 400, got ${statuses}`);

  const finalCount = db.prepare('SELECT uses_count FROM access_codes WHERE code = ?').get('RACECODE').uses_count;
  assert.equal(finalCount, 1, 'uses_count must reflect exactly one successful redemption, not two');
});

test('an unlimited code can unlock multiple different projects', async () => {
  makeCode('FOUNDERCODE');
  const p1 = makeProject();
  const p2 = makeProject();
  const r1 = await fetch(`${BASE}/api/projects/${p1}/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'FOUNDERCODE' }) });
  const r2 = await fetch(`${BASE}/api/projects/${p2}/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'FOUNDERCODE' }) });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});
