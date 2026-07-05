// Regression test for the paywall bug this audit found: the full roadmap
// (agencies/flags/risks/narrative) used to be sent to the client before any
// payment happened. This checks the server-side gate directly: unpaid
// projects must never expose that content, and /unlock must be what flips it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8792;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused'; // required at startup; never actually called in this test
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject } = await import('../db.js');

let fixtureId;
const agencies = [{ name: 'Test Agency', detail: 'test' }];
const narrative = 'a secret paid narrative';

before(async () => {
  fixtureId = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(
    fixtureId, 'Broward County, Florida', 'Test project', 'pool', 'anthropic',
    JSON.stringify(agencies), '["flag1"]', '["risk1"]', '4-8 weeks', 'test', narrative, null, now, now
  );
});

after(() => server.close());

test('an unpaid project exposes counts only, never content', async () => {
  const res = await fetch(`${BASE}/api/projects/${fixtureId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.paid, false);
  assert.deepEqual(body.counts, { agencies: 1, flags: 1, risks: 1 });
  assert.equal(body.agencies, undefined, 'agencies must not be present before payment');
  assert.equal(body.narrative, undefined, 'narrative must not be present before payment');
});

test('unlock marks the project paid and returns full content', async () => {
  const res = await fetch(`${BASE}/api/projects/${fixtureId}/unlock`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.paid, true);
  assert.equal(body.narrative, narrative);
  assert.deepEqual(body.agencies, agencies);
});

test('after unlock, GET now returns the full content', async () => {
  const res = await fetch(`${BASE}/api/projects/${fixtureId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.paid, true);
  assert.equal(body.narrative, narrative);
});
