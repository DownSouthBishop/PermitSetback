// Regression test for a gap found during final review: feasibility, risk,
// cost, timeline, documents, the AI advisor, tasks, and overview all read
// project data server-side but had no paid check of their own — only
// project.html's client-side redirect stood between an unpaid project and
// its full sub-module content. requirePaid() (http-utils.js) closes that;
// this confirms every route actually calls it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8793;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused'; // required at startup; these routes shouldn't reach the LLM before the paid check
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, markProjectPaidStmt } = await import('../db.js');

let fixtureId;
let roadmapTierId;

before(async () => {
  fixtureId = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(
    fixtureId, 'Broward County, Florida', 'Test project', 'pool', 'anthropic',
    '[]', '[]', '[]', '4-8 weeks', 'test', 'test narrative', null, now, now
  );

  // Paid, but at the $49 roadmap-only tier — the actual bug this file
  // originally missed: requirePaid() checked project.paid alone, which is
  // true for both tiers, so a roadmap-tier buyer could reach every one of
  // these endpoints directly and get the $97 full-workspace content for free.
  roadmapTierId = crypto.randomUUID();
  insertProject.run(
    roadmapTierId, 'Broward County, Florida', 'Test project', 'pool', 'anthropic',
    '[]', '[]', '[]', '4-8 weeks', 'test', 'test narrative', null, now, now
  );
  markProjectPaidStmt.run('roadmap', now, now, roadmapTierId);
});

after(() => server.close());

const endpoints = [
  ['GET', '/feasibility'],
  ['POST', '/feasibility'],
  ['GET', '/risk'],
  ['POST', '/risk'],
  ['GET', '/cost'],
  ['POST', '/cost'],
  ['GET', '/timeline'],
  ['POST', '/timeline'],
  ['GET', '/documents'],
  ['POST', '/documents'],
  ['GET', '/conversation'],
  ['GET', '/tasks'],
  ['GET', '/overview'],
  ['POST', '/branding']
];

for (const [method, path] of endpoints) {
  test(`unpaid project: ${method} ${path} returns 402, not content`, async () => {
    const res = await fetch(`${BASE}/api/projects/${fixtureId}${path}`, { method });
    assert.equal(res.status, 402, `expected 402 for ${method} ${path}, got ${res.status}`);
  });
}

test('task status update also requires paid', async () => {
  const res = await fetch(`${BASE}/api/projects/${fixtureId}/tasks/some-task-id/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' })
  });
  assert.equal(res.status, 402);
});

test('unknown project id still 404s before the paid check matters', async () => {
  const res = await fetch(`${BASE}/api/projects/${crypto.randomUUID()}/feasibility`);
  assert.equal(res.status, 404);
});

for (const [method, path] of endpoints) {
  test(`roadmap-tier project (paid, not full): ${method} ${path} still returns 402`, async () => {
    const res = await fetch(`${BASE}/api/projects/${roadmapTierId}${path}`, { method });
    assert.equal(res.status, 402, `expected 402 for ${method} ${path} on a roadmap-tier project, got ${res.status}`);
  });
}
