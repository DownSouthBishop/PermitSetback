// The original roadmap-generation + analytics endpoints, unchanged in
// behavior from before the Project/accounts work: POST /api/roadmap,
// POST /api/outcome, POST /api/event, GET /api/stats.
import { readBody, sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import { classifyTrade } from '../classify.js';
import { generateRoadmap } from '../llm.js';
import { db, insertRoadmap, insertOutcome, insertEvent } from '../db.js';

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleLegacyRoutes(req, res, ip) {
  if (req.method === 'POST' && req.url === '/api/roadmap') {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    try {
      const { location, description } = JSON.parse((await readBody(req)) || '{}');
      if (!location || !description) { sendJson(res, 400, { error: 'location and description are required' }); return true; }

      const trade = classifyTrade(description);
      const { provider, result } = await generateRoadmap(location, description, trade);
      insertRoadmap.run(new Date().toISOString(), location, description, trade, provider, result.unrecognized ? 1 : 0);
      sendJson(res, 200, { provider, result });
    } catch (err) {
      console.error('Request failed:', err.message);
      sendJson(res, 502, { error: 'Both providers failed or returned an unusable response.' });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/outcome') {
    try {
      const { location, description, outcome } = JSON.parse((await readBody(req)) || '{}');
      const validOutcomes = ['approved', 'comments', 'rejected'];
      if (!location || !description || !validOutcomes.includes(outcome)) {
        sendJson(res, 400, { error: 'location, description, and a valid outcome are required' });
        return true;
      }
      insertOutcome.run(new Date().toISOString(), location, description, classifyTrade(description), outcome);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/event') {
    try {
      const { name, properties } = JSON.parse((await readBody(req)) || '{}');
      if (!name) { sendJson(res, 400, { error: 'name is required' }); return true; }
      insertEvent.run(new Date().toISOString(), name, properties ? JSON.stringify(properties) : null);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/stats') {
    const roadmapCount = db.prepare('SELECT COUNT(*) AS n FROM roadmaps WHERE unrecognized = 0').get().n;
    const outcomeCount = db.prepare('SELECT COUNT(*) AS n FROM outcomes').get().n;
    const approvedCount = db.prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE outcome = 'approved'`).get().n;
    sendJson(res, 200, { roadmapsGenerated: roadmapCount, outcomesReported: outcomeCount, approvedAsDrafted: approvedCount });
    return true;
  }

  return false;
}
