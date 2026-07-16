// Regression test for Phase 2.3's post-payment pre-generation (server/pregenerate.js).
// A real LLM call isn't exercisable offline, so this covers what's genuinely
// testable without one: pregenerateFullWorkspace never blocks the caller
// (fire-and-forget), and it's a true no-op — no duplicate rows, no thrown
// error — when every module already has content, which is the exact
// double-fire scenario (confirm-checkout AND the webhook both landing) this
// exists to make safe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8805;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const {
  insertProject, insertFindingStmt, insertCostStmt, insertTimelinePhaseStmt, insertDocumentStmt,
  getFindingsByProjectStmt, getCostsByProjectStmt, getTimelinePhasesByProjectStmt, getDocumentsByProjectStmt
} = await import('../db.js');
const { pregenerateFullWorkspace } = await import('../pregenerate.js');

after(() => server.close());

function makeFullyPopulatedProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  insertFindingStmt.run(crypto.randomUUID(), id, 'feasibility', 'label', 'detail', null, 'high', null, null, 'confirmed', now, now);
  insertFindingStmt.run(crypto.randomUUID(), id, 'risk', 'label', 'detail', 'high', 'high', 'high', 'mitigation', 'confirmed', now, now);
  insertCostStmt.run(crypto.randomUUID(), id, 'Permit Fees', 100, 300, 'note', now);
  insertTimelinePhaseStmt.run(crypto.randomUUID(), id, 'Permit Application', 0, '2-3 weeks', 'pending', 0, null, now);
  insertDocumentStmt.run(crypto.randomUUID(), id, 'owner_summary', 'content', now, now);
  return { id, location: 'Denver, Colorado', description: 'Test project', trade: 'fence' };
}

test('pregenerateFullWorkspace returns immediately without waiting on the generators', () => {
  const project = { id: crypto.randomUUID(), location: 'Denver, Colorado', description: 'Test project', trade: 'fence' };
  const start = Date.now();
  pregenerateFullWorkspace(project);
  // Generous threshold — the point isn't a strict timing budget, it's proving
  // this returns long before a real LLM round-trip (seconds) could complete.
  assert.ok(Date.now() - start < 500, 'must not block the caller — the whole point is not delaying the HTTP response');
});

test('pregenerateFullWorkspace is a no-op when every module already has content (double-fire safety)', async () => {
  const project = makeFullyPopulatedProject();
  pregenerateFullWorkspace(project);
  // The guard checks are synchronous DB reads inside each generateAndSaveX,
  // but the outer call is still a promise chain — give it a tick to run the
  // no-op branch (no network call happens in this branch at all) before
  // asserting nothing changed.
  await new Promise(r => setTimeout(r, 100));

  assert.equal(getFindingsByProjectStmt.all(project.id, 'feasibility').length, 1);
  assert.equal(getFindingsByProjectStmt.all(project.id, 'risk').length, 1);
  assert.equal(getCostsByProjectStmt.all(project.id).length, 1);
  assert.equal(getTimelinePhasesByProjectStmt.all(project.id).length, 1);
  assert.equal(getDocumentsByProjectStmt.all(project.id).length, 1);
});
