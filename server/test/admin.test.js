// Regression tests for the ADMIN_SECRET-gated remote admin routes — the
// no-SSH-access path for managing a live deployment. Both routes must 404
// (not 401/403 — indistinguishable from "route doesn't exist") when the
// secret is missing or wrong, and the delete route must actually clean up
// every child row plus the matching roadmaps funnel row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const ADMIN_SECRET = 'test-admin-secret';

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
process.env.ADMIN_SECRET = ADMIN_SECRET;
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, insertRoadmap, insertFindingStmt, db } = await import('../db.js');

function makeProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const location = 'Denver, Colorado', description = 'Admin route test project', trade = 'fence';
  insertRoadmap.run(now, location, description, trade, 'anthropic', 0);
  insertProject.run(id, location, description, trade, 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative', null, now, now);
  insertFindingStmt.run(crypto.randomUUID(), id, 'feasibility', 'Test finding', 'detail', null, 'high', null, null, null, now, now);
  return id;
}

after(() => server.close());

test('POST /api/admin/access-codes 404s with no secret header', async () => {
  const res = await fetch(`${BASE}/api/admin/access-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'X', label: 'x' })
  });
  assert.equal(res.status, 404);
});

test('POST /api/admin/access-codes 404s with the wrong secret', async () => {
  const res = await fetch(`${BASE}/api/admin/access-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'wrong' }, body: JSON.stringify({ code: 'X', label: 'x' })
  });
  assert.equal(res.status, 404);
});

test('DELETE /api/admin/projects/:id 404s with no secret header', async () => {
  const id = makeProject();
  const res = await fetch(`${BASE}/api/admin/projects/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /api/admin/projects/:id removes the project, its child rows, and the matching roadmaps row', async () => {
  const id = makeProject();
  const res = await fetch(`${BASE}/api/admin/projects/${id}`, {
    method: 'DELETE', headers: { 'x-admin-secret': ADMIN_SECRET }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, id);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM projects WHERE id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_findings WHERE project_id = ?').get(id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roadmaps WHERE description = 'Admin route test project'").get().n, 0);
});
