// Regression test for the magic-link account-takeover fix: the sign-in link
// must never appear in the response body once a real email sender is
// configured (or NODE_ENV is production) — see server/routes/auth.js and
// server/email.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8800;
const BASE = `http://localhost:${PORT}`;

process.env.SETBACK_DB_PATH = join(mkdtempSync(join(tmpdir(), 'setback-test-')), 'data.db');
process.env.PORT = String(PORT);
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
delete process.env.GOOGLE_API_KEY;
delete process.env.RESEND_API_KEY;
process.env.NODE_ENV = 'test';

const { server } = await import('../index.js');

after(() => server.close());

test('with no email sender configured, the dev link is returned directly (local dev keeps working)', async () => {
  const res = await fetch(`${BASE}/api/auth/request-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com' })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.devLink && body.devLink.includes('/api/auth/verify?token='), 'expected a devLink in the response');
});

test('once RESEND_API_KEY is set, the response never contains a link or token — even if the send fails', async () => {
  process.env.RESEND_API_KEY = 'test-resend-key';
  const originalFetch = globalThis.fetch;
  let calledResendWith = null;
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://api.resend.com/')) {
      calledResendWith = { url, opts };
      return new Response('bad request', { status: 400 });
    }
    return originalFetch(url, opts);
  };
  try {
    const res = await fetch(`${BASE}/api/auth/request-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'prod@example.com' })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true }, 'response must carry no token/link, even though the send failed');
    assert.ok(calledResendWith, 'expected the route to attempt a Resend send');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
  }
});
