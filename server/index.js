// Setback backend — composition root. Wires the route modules together and
// starts listening. Route logic lives in ./routes/*, persistence in ./db.js,
// AI provider calls in ./llm.js. See each file for its own notes.
//
// Run: node --env-file=.env index.js   (Node 22.5+ for node:sqlite; no npm install needed)

import { createServer } from 'node:http';
import { sendJson } from './http-utils.js';
import { handleLegacyRoutes } from './routes/legacy.js';
import { handleProjectsRoutes } from './routes/projects.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleAdvisorRoutes } from './routes/advisor.js';
import { handleFeasibilityRoutes } from './routes/feasibility.js';
import { handleRiskRoutes } from './routes/risk.js';
import { handleTimelineRoutes } from './routes/timeline.js';

const PORT = process.env.PORT || 8787;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}
if (!process.env.GOOGLE_API_KEY) {
  console.log('GOOGLE_API_KEY not set — running on Anthropic only, no fallback. That is fine for now.');
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const ip = req.socket.remoteAddress || 'unknown';

  if (await handleLegacyRoutes(req, res, ip)) return;
  if (await handleProjectsRoutes(req, res)) return;
  if (await handleAuthRoutes(req, res, ip)) return;
  if (await handleAdvisorRoutes(req, res)) return;
  if (await handleFeasibilityRoutes(req, res)) return;
  if (await handleRiskRoutes(req, res)) return;
  if (await handleTimelineRoutes(req, res, ip)) return;

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Setback backend listening on http://localhost:${PORT}`);
});
