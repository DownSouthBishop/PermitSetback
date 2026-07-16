// Setback backend — composition root. Wires the route modules together,
// serves the static frontend (./static.js), and starts listening. Route
// logic lives in ./routes/*, persistence in ./db.js, AI provider calls in
// ./llm.js. See each file for its own notes.
//
// Local dev: node --env-file=.env index.js   (Node 22.5+ for node:sqlite; no npm install needed)
// Production: set ANTHROPIC_API_KEY (and optionally GOOGLE_API_KEY, PORT) as
// real environment variables on the host, then `node index.js` — no .env
// file involved once the platform injects them.

import { createServer } from 'node:http';
import { sendJson } from './http-utils.js';
import { handleLegacyRoutes } from './routes/legacy.js';
import { handleProjectsRoutes } from './routes/projects.js';
import { handleCheckoutRoutes } from './routes/checkout.js';
import { handleAdminRoutes } from './routes/admin.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleBillingRoutes } from './routes/billing.js';
import { handleAdvisorRoutes } from './routes/advisor.js';
import { handleFeasibilityRoutes } from './routes/feasibility.js';
import { handleRiskRoutes } from './routes/risk.js';
import { handleTimelineRoutes } from './routes/timeline.js';
import { handleCostRoutes } from './routes/cost.js';
import { handleTasksRoutes } from './routes/tasks.js';
import { handleDocumentsRoutes } from './routes/documents.js';
import { handleOverviewRoutes } from './routes/overview.js';
import { handleGeocodeRoutes } from './routes/geocode.js';
import { handleStripeWebhookRoutes } from './routes/stripe-webhook.js';
import { handleStaticRoutes, SECURITY_HEADERS, isHttpsRequest } from './static.js';
import { runLearningPass } from './learn.js';
import { runAttentionDigestPass } from './attention-digest.js';
import { sweepRateLimitMaps } from './rate-limit.js';
import { runExpiryPass } from './expiry.js';
import { runDripPass } from './drip.js';
import { runOutcomeEmailPass } from './outcome-email.js';
import { db } from './db.js';

const PORT = process.env.PORT || 8787;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}
if (!process.env.GOOGLE_API_KEY) {
  console.log('GOOGLE_API_KEY not set — Gemini (the free-tier primary) is unavailable; running on the Anthropic fallback only.');
}

export const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Applied here — the one place every request passes through — rather than
  // only on static-file responses (the original split). Payment and session
  // data flow through /api/* too; those responses were getting none of this
  // before. HSTS is conditional on the hop actually being HTTPS, same reason
  // static.js originally guarded it: sending it over plain HTTP is actively
  // harmful in local dev (see static.js's isHttpsRequest comment).
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (isHttpsRequest(req)) res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      db.prepare('SELECT 1').get();
      sendJson(res, 200, { status: 'ok' });
    } catch (err) {
      sendJson(res, 503, { status: 'error', error: 'database unavailable' });
    }
    return;
  }

  // Railway (and most PaaS/CDN fronts) terminate the connection at an edge
  // proxy, so req.socket.remoteAddress is the proxy's address, not the
  // visitor's — that would silently put every visitor in one rate-limit
  // bucket. X-Forwarded-For is a client-appended, comma-separated chain
  // (each proxy hop appends the address it saw); the LEFTMOST entry is
  // whatever the original client sent and is fully attacker-controlled — a
  // request can spoof "X-Forwarded-For: 1.2.3.4" to get a fresh rate-limit
  // bucket on every call. Only the RIGHTMOST N entries were actually
  // appended by trusted infrastructure, where N is how many proxy hops sit
  // in front of this process (TRUSTED_PROXY_HOPS, default 1 — Railway's
  // single edge). x-real-ip, when a proxy sets it, is a single trusted
  // value with nothing to spoof around it and takes priority.
  const trustedHops = Number(process.env.TRUSTED_PROXY_HOPS) || 1;
  const xRealIp = (req.headers['x-real-ip'] || '').trim();
  const xffChain = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const ip = xRealIp || xffChain[xffChain.length - trustedHops] || req.socket.remoteAddress || 'unknown';

  if (await handleLegacyRoutes(req, res, ip)) return;
  if (await handleProjectsRoutes(req, res, ip)) return;
  if (await handleCheckoutRoutes(req, res, ip)) return;
  if (await handleAdminRoutes(req, res, ip)) return;
  if (await handleAuthRoutes(req, res, ip)) return;
  if (await handleBillingRoutes(req, res, ip)) return;
  if (await handleAdvisorRoutes(req, res, ip)) return;
  if (await handleFeasibilityRoutes(req, res, ip)) return;
  if (await handleRiskRoutes(req, res, ip)) return;
  if (await handleTimelineRoutes(req, res, ip)) return;
  if (await handleCostRoutes(req, res, ip)) return;
  if (await handleTasksRoutes(req, res, ip)) return;
  if (await handleDocumentsRoutes(req, res, ip)) return;
  if (await handleOverviewRoutes(req, res, ip)) return;
  if (await handleGeocodeRoutes(req, res, ip)) return;
  if (await handleStripeWebhookRoutes(req, res)) return;
  if (await handleStaticRoutes(req, res)) return;

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Setback backend listening on http://localhost:${PORT}`);
});

// The outcome-learning loop (learn.js) used to require someone to remember
// to run it by hand — a real mechanism that stayed dormant in practice.
// Running it here, on a timer inside the same long-running process, is what
// actually makes it compound: no external cron needed, matches this app's
// one-deployable-service shape. Delayed 30s past boot so it never competes
// with startup, then every 6 hours — frequent enough that a real beta
// tester's outcome report surfaces same-day, infrequent enough not to waste
// API calls when nothing new has come in (runLearningPass() is a no-op,
// zero LLM calls, when no group has crossed the report threshold).
// .unref() on both: this timer must never be the thing keeping the process
// alive (it would otherwise stop `node --test` from exiting, since every
// test file imports this module) — the HTTP server's own listening socket
// is what keeps a real deployment alive, same as before this existed.
// ponytail: the attention-digest loop rides the same 6-hour timer as the
// learning pass rather than getting its own interval — a rejected permit or
// an unresolved risk doesn't change fast enough to need finer-grained
// checking. Split into its own interval if these ever need to diverge.
setTimeout(() => {
  runLearningPass();
  runAttentionDigestPass();
  sweepRateLimitMaps();
  runExpiryPass();
  runDripPass();
  runOutcomeEmailPass();
  setInterval(() => {
    runLearningPass(); runAttentionDigestPass(); sweepRateLimitMaps();
    runExpiryPass(); runDripPass(); runOutcomeEmailPass();
  }, 6 * 60 * 60 * 1000).unref();
}, 30_000).unref();
