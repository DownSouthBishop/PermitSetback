// Regression tests for the needs-attention rollup (server-side port of what
// projects.html used to compute client-side) and the digest loop's
// idempotency — it must not re-notify for the same unresolved items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');

const { insertProject, markProjectPaidStmt, linkProjectToUserStmt, getOrCreateUser } = await import('../db.js');
const { computeAttentionItems } = await import('../attention.js');
const { runAttentionDigestPass } = await import('../attention-digest.js');

function makeProject({ paid = false, risks = [], flags = [] } = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', JSON.stringify(flags), JSON.stringify(risks), '4-8 weeks', 'test', 'narrative text', null, now, now);
  if (paid) markProjectPaidStmt.run('full', now, now, id);
  return id;
}

test('an unpaid project surfaces as "not unlocked yet"', () => {
  const user = getOrCreateUser('attention-test-1@example.com');
  const projectId = makeProject({ paid: false });
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), projectId);

  const items = computeAttentionItems(user.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].reason, 'Not unlocked yet');
});

test('a project with risks/flags and no outcome outranks one with none', () => {
  const user = getOrCreateUser('attention-test-2@example.com');
  const quiet = makeProject({ paid: true });
  const concerning = makeProject({ paid: true, risks: ['a risk'], flags: ['a flag'] });
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), quiet);
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), concerning);

  const items = computeAttentionItems(user.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].projectId, concerning);
});

test('a user with no attention items produces no items', () => {
  const user = getOrCreateUser('attention-test-3@example.com');
  const projectId = makeProject({ paid: true });
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), projectId);

  assert.deepEqual(computeAttentionItems(user.id), []);
});

test('the digest pass does not re-log an unchanged set of items on a second run', async () => {
  const user = getOrCreateUser('attention-test-4@example.com');
  const projectId = makeProject({ paid: true, risks: ['a risk'] });
  linkProjectToUserStmt.run(user.id, new Date().toISOString(), projectId);

  const logs1 = [];
  await runAttentionDigestPass(msg => logs1.push(msg));
  assert.ok(logs1.some(l => l.includes(`User ${user.id}:`)), 'expected the first run to log this user');

  const logs2 = [];
  await runAttentionDigestPass(msg => logs2.push(msg));
  assert.ok(!logs2.some(l => l.includes(`User ${user.id}:`)), 'expected the second run to skip this user (unchanged)');
});
