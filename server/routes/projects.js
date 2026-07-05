// Project persistence: GET /api/projects/:id, POST /api/projects/:id/unlock,
// POST /api/projects/:id/outcome.
//
// There used to be a POST /api/projects here that accepted a fully-formed
// roadmap (agencies/flags/risks/narrative/etc.) straight from the client and
// stored whatever it was given, unauthenticated and unrated-limited. It's
// gone — POST /api/roadmap (routes/legacy.js) creates the project server-side
// now, from a roadmap the server itself generated. Nothing accepts arbitrary
// roadmap content from a client anymore.
import { readBody, sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import { getProjectStmt, updateProjectOutcomeStmt, insertOutcome, markProjectPaidStmt } from '../db.js';

function projectRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    confidenceScore: row.confidence_score,
    riskScore: row.risk_score,
    location: row.location,
    description: row.description,
    trade: row.trade,
    provider: row.provider,
    paid: !!row.paid,
    agencies: JSON.parse(row.agencies),
    flags: JSON.parse(row.flags),
    risks: JSON.parse(row.risks),
    timeline: row.timeline,
    timelineNote: row.timeline_note,
    narrative: row.narrative,
    // Generic bucket for fields added after the original roadmap shape
    // (cost estimate, timeline breakdown, next actions, etc.) — null until
    // something actually writes to it.
    extra: row.extra ? JSON.parse(row.extra) : null,
    outcomeStatus: row.outcome_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Teaser shape for a project that hasn't been paid for yet — counts only,
// no agencies/flags/risks/narrative content.
function projectTeaserJson(row) {
  return {
    id: row.id,
    paid: false,
    location: row.location,
    description: row.description,
    trade: row.trade,
    counts: {
      agencies: JSON.parse(row.agencies).length,
      flags: JSON.parse(row.flags).length,
      risks: JSON.parse(row.risks).length
    }
  };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleProjectsRoutes(req, res, ip) {
  // DEV STUB — stands in for real payment confirmation (e.g. a Stripe
  // webhook firing after a successful charge). Marks the project paid and
  // hands back the full content. Whatever replaces this later should call
  // markProjectPaidStmt the same way, only after verifying the charge.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/unlock$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!project.paid) {
      console.warn(`DEV MODE: unlocking project ${id} without payment verification — replace before real launch.`);
      markProjectPaidStmt.run(new Date().toISOString(), new Date().toISOString(), id);
    }
    sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/outcome$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    try {
      const { outcome } = JSON.parse((await readBody(req)) || '{}');
      const validOutcomes = ['approved', 'comments', 'rejected'];
      if (!validOutcomes.includes(outcome)) {
        sendJson(res, 400, { error: 'a valid outcome is required' });
        return true;
      }
      const project = getProjectStmt.get(id);
      if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }

      const now = new Date().toISOString();
      updateProjectOutcomeStmt.run(outcome, now, now, id);
      insertOutcome.run(now, project.location, project.description, project.trade, outcome);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'GET' && /^\/api\/projects\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    sendJson(res, 200, project.paid ? projectRowToJson(project) : projectTeaserJson(project));
    return true;
  }

  return false;
}
