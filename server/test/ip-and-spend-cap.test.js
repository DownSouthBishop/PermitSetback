// Regression tests for two Phase 0 fixes in server/index.js and
// server/routes/legacy.js:
//   1. The rate limiter must key off the trusted (rightmost) X-Forwarded-For
//      hop, not the client-spoofable leftmost one.
//   2. Unpaid roadmap generation must refuse once today's real API spend
//      crosses DAILY_UNPAID_SPEND_CAP_USD.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8802;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;
process.env.TRUSTED_PROXY_HOPS = '1';
process.env.DAILY_UNPAID_SPEND_CAP_USD = '5';

const { server } = await import('../index.js');
const { insertApiUsageStmt } = await import('../db.js');

after(() => server.close());

// /api/auth/request-link stays on the tight (10/min) bucket even after
// Phase 0.3's read/write bucket split (auth POSTs are exactly what the
// tight bucket exists to protect), so it's a stable target for proving the
// IP fix here.
function postEvent(xff) {
  return fetch(`${BASE}/api/auth/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ email: 'ratelimit-test@example.com' })
  });
}

test('a spoofed leftmost X-Forwarded-For entry cannot dodge the rate limit', async () => {
  const realClientIp = '203.0.113.9'; // simulates the one hop our trusted edge actually appended
  let lastStatus;
  for (let i = 0; i < 11; i++) {
    const spoofedLeftmost = crypto.randomUUID(); // a different fake "client" on every request
    const res = await postEvent(`${spoofedLeftmost}, ${realClientIp}`);
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, 'the 11th request from the same real hop should be rate-limited despite the varying spoofed entry');
});

test('two different real hops each get their own bucket', async () => {
  const clientA = '198.51.100.1';
  const res = await postEvent(`anything, ${clientA}`);
  assert.notEqual(res.status, 429, 'a fresh real IP must not inherit another client\'s exhausted bucket');
});

test('unpaid roadmap generation refuses once today\'s spend crosses the cap', async () => {
  insertApiUsageStmt.run(crypto.randomUUID(), null, 'roadmap', 'anthropic', 'test-model', 100, 100, 6, new Date().toISOString());

  const res = await fetch(`${BASE}/api/roadmap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '192.0.2.55' },
    body: JSON.stringify({ location: 'Denver, Colorado', description: 'a fence' })
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /capacity/i);
});
