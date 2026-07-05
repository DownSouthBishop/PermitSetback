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
import { handleAuthRoutes } from './routes/auth.js';
import { handleAdvisorRoutes } from './routes/advisor.js';
import { handleFeasibilityRoutes } from './routes/feasibility.js';
import { handleRiskRoutes } from './routes/risk.js';
import { handleTimelineRoutes } from './routes/timeline.js';
import { handleCostRoutes } from './routes/cost.js';
import { handleTasksRoutes } from './routes/tasks.js';
import { handleDocumentsRoutes } from './routes/documents.js';
import { handleOverviewRoutes } from './routes/overview.js';
import { handleGeocodeRoutes } from './routes/geocode.js';
import { handleStaticRoutes } from './static.js';

const PORT = process.env.PORT || 8787;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}
if (!process.env.GOOGLE_API_KEY) {
  console.log('GOOGLE_API_KEY not set — running on Anthropic only, no fallback. That is fine for now.');
}

export const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Railway (and most PaaS/CDN fronts) terminate the connection at an edge
  // proxy, so req.socket.remoteAddress is the proxy's address, not the
  // visitor's — that would silently put every visitor in one rate-limit
  // bucket. Trust the first hop of X-Forwarded-For when present (the edge
  // sets this; it isn't attacker-controlled unless something is badly
  // misconfigured), falling back to the socket for plain local dev.
  const forwardedFor = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwardedFor || req.socket.remoteAddress || 'unknown';

  if (await handleLegacyRoutes(req, res, ip)) return;
  if (await handleProjectsRoutes(req, res, ip)) return;
  if (await handleAuthRoutes(req, res, ip)) return;
  if (await handleAdvisorRoutes(req, res, ip)) return;
  if (await handleFeasibilityRoutes(req, res, ip)) return;
  if (await handleRiskRoutes(req, res, ip)) return;
  if (await handleTimelineRoutes(req, res, ip)) return;
  if (await handleCostRoutes(req, res, ip)) return;
  if (await handleTasksRoutes(req, res, ip)) return;
  if (await handleDocumentsRoutes(req, res, ip)) return;
  if (await handleOverviewRoutes(req, res)) return;
  if (await handleGeocodeRoutes(req, res, ip)) return;
  if (await handleStaticRoutes(req, res)) return;

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Setback backend listening on http://localhost:${PORT}`);
});
