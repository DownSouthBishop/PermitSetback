// Regression test for the Client Packet branding endpoint (Phase 2.1):
// full-tier only (covered generically in module-gating.test.js), a valid
// update round-trips, and a non-http(s) logo URL is rejected outright since
// it's rendered as an <img src> on the print view.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8804;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { insertProject, markProjectPaidStmt } = await import('../db.js');

function makeFullTierProject() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertProject.run(id, 'Denver, Colorado', 'Test project', 'fence', 'anthropic', '[]', '[]', '[]', '4-8 weeks', 'test', 'narrative text', null, now, now);
  markProjectPaidStmt.run('full', now, now, id);
  return id;
}

after(() => server.close());

test('a valid branding update round-trips through GET', async () => {
  const id = makeFullTierProject();
  const res = await fetch(`${BASE}/api/projects/${id}/branding`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyName: 'Acme Contracting', companyContact: '(555) 010-0100', companyLogoUrl: 'https://example.com/logo.png' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.companyName, 'Acme Contracting');
  assert.equal(body.companyContact, '(555) 010-0100');
  assert.equal(body.companyLogoUrl, 'https://example.com/logo.png');

  const getRes = await fetch(`${BASE}/api/projects/${id}`);
  const getBody = await getRes.json();
  assert.equal(getBody.companyName, 'Acme Contracting');
});

test('a non-http(s) logo URL is rejected', async () => {
  const id = makeFullTierProject();
  const res = await fetch(`${BASE}/api/projects/${id}/branding`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyName: 'Acme', companyLogoUrl: 'javascript:alert(1)' })
  });
  assert.equal(res.status, 400);
});

test('branding is optional — an empty update clears to null rather than erroring', async () => {
  const id = makeFullTierProject();
  const res = await fetch(`${BASE}/api/projects/${id}/branding`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.companyName, null);
  assert.equal(body.companyLogoUrl, null);
});
