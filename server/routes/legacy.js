// The original roadmap-generation + analytics endpoints: POST /api/roadmap,
// POST /api/outcome, POST /api/event, GET /api/stats.
//
// POST /api/roadmap now creates the Project row itself and returns only
// counts — not the agencies/flags/risks/narrative content. That content is
// only ever returned once the project is paid (see routes/projects.js's
// GET /api/projects/:id, gated on the real Stripe checkout/confirm/webhook
// flow). Previously this endpoint returned the full result directly, which
// meant the entire paid answer was already sitting in the browser before
// checkout ever ran; the teaser screen was only hiding it, not gating it.
import { readBody, sendJson, checkRateLimit, checkGenerousRateLimit } from '../http-utils.js';
import { classifyTrade } from '../classify.js';
import { generateRoadmap } from '../llm.js';
import { db, insertRoadmap, insertProject, insertOutcome, insertEvent, getTodayUsageCostStmt } from '../db.js';

// Hard dollar ceiling on today's unpaid generation spend — /api/roadmap has
// no auth and no payment gate, so this is the backstop against a runaway
// loop (or a rate-limit bypass) burning real Anthropic budget. Paid module
// generation (behind requirePaid elsewhere) never calls this.
const DAILY_UNPAID_SPEND_CAP_USD = Number(process.env.DAILY_UNPAID_SPEND_CAP_USD) || 20;

function todayUnpaidSpendExceeded() {
  const utcDayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  return getTodayUsageCostStmt.get(utcDayStart).total > DAILY_UNPAID_SPEND_CAP_USD;
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleLegacyRoutes(req, res, ip) {
  if (req.method === 'POST' && req.url === '/api/roadmap') {
    if (checkRateLimit(res, ip)) return true;
    if (todayUnpaidSpendExceeded()) {
      sendJson(res, 503, { error: 'Temporarily at capacity — try again shortly.' });
      return true;
    }
    try {
      const { location, description } = JSON.parse((await readBody(req)) || '{}');
      if (!location || !description) { sendJson(res, 400, { error: 'location and description are required' }); return true; }

      const trade = classifyTrade(description);
      const { provider, result } = await generateRoadmap(location, description, trade);
      insertRoadmap.run(new Date().toISOString(), location, description, trade, provider, result.unrecognized ? 1 : 0);

      if (result.unrecognized) {
        sendJson(res, 200, { unrecognized: true, message: result.message });
        return true;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      insertProject.run(
        id, location, description, trade, provider,
        JSON.stringify(result.agencies), JSON.stringify(result.flags), JSON.stringify(result.risks),
        result.timeline, result.timelineNote, result.narrative,
        null, now, now
      );
      sendJson(res, 200, {
        id, provider,
        counts: { agencies: result.agencies.length, flags: result.flags.length, risks: result.risks.length }
      });
    } catch (err) {
      console.error('Request failed:', err.message);
      sendJson(res, 502, { error: 'Both providers failed or returned an unusable response.' });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/outcome') {
    if (checkGenerousRateLimit(res, ip)) return true;
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
    if (checkGenerousRateLimit(res, ip)) return true;
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
    // Paid count specifically, not roadmapsGenerated — the "first 100
    // roadmaps" intro-pricing line is a claim about purchases, not teasers.
    const paidCount = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE paid = 1').get().n;
    sendJson(res, 200, { roadmapsGenerated: roadmapCount, outcomesReported: outcomeCount, approvedAsDrafted: approvedCount, introRoadmapsPaid: paidCount });
    return true;
  }

  return false;
}
