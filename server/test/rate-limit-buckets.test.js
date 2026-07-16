// Regression test for Phase 0.3: read-only/low-risk POST traffic (here,
// POST /api/event) must not share the tight 10/min bucket that LLM-triggering,
// auth, and checkout POSTs use — otherwise a normal workspace session (a
// handful of analytics beacons) could 429 alongside real generation calls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8803;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;

const { server } = await import('../index.js');
const { sweepRateLimitMaps } = await import('../rate-limit.js');

after(() => server.close());

test('the generous bucket tolerates more than 10 requests/min from one IP', async () => {
  const ip = '192.0.2.201';
  const statuses = [];
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${BASE}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ name: 'test_event' })
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.every(s => s === 200), `expected all 15 generous-bucket requests to succeed, got ${statuses}`);
});

test('sweepRateLimitMaps runs without throwing', () => {
  assert.doesNotThrow(() => sweepRateLimitMaps());
});
