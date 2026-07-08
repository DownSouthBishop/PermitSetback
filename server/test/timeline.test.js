// Regression test for the timeline response shape — this endpoint used to
// return a bare array while every sibling module (cost, feasibility, risk,
// documents) wraps its list in a named key ({costs:[]}, {findings:[]}, etc).
// Silently drifted from the shared shape; this locks in the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, insertTimelinePhaseStmt } = await import('../db.js');

function makeProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative', null, now, now);
  return id;
}

after(() => server.close());

test('GET /api/projects/:id/timeline wraps phases in a { phases } object, not a bare array', async () => {
  const { markProjectPaidStmt } = await import('../db.js');
  const id = makeProject();
  const now = new Date().toISOString();
  markProjectPaidStmt.run('full', now, now, id);
  insertTimelinePhaseStmt.run(crypto.randomUUID(), id, 'Design', 0, '2 weeks', 'pending', 0, null, now);
  insertTimelinePhaseStmt.run(crypto.randomUUID(), id, 'Permitting', 1, '6 weeks', 'pending', 1, 'Reviewer backlog', now);

  const res = await fetch(`${BASE}/api/projects/${id}/timeline`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.phases), 'response must have a .phases array, matching cost/{costs}, feasibility/{findings}, etc.');
  assert.equal(body.phases.length, 2);
  assert.equal(body.phases[1].isBottleneck, true);
});

test('POST /api/projects/:id/timeline returns existing phases wrapped the same way, without regenerating', async () => {
  const { markProjectPaidStmt } = await import('../db.js');
  const id = makeProject();
  const now = new Date().toISOString();
  markProjectPaidStmt.run('full', now, now, id);
  insertTimelinePhaseStmt.run(crypto.randomUUID(), id, 'Design', 0, '2 weeks', 'pending', 0, null, now);

  const res = await fetch(`${BASE}/api/projects/${id}/timeline`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.phases));
  assert.equal(body.phases.length, 1);
});
