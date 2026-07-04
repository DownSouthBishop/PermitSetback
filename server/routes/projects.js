// Project persistence: POST /api/projects, GET /api/projects/:id,
// POST /api/projects/:id/outcome.
import { readBody, sendJson } from '../http-utils.js';
import { insertProject, getProjectStmt, updateProjectOutcomeStmt, insertOutcome } from '../db.js';

function projectRowToJson(row) {
  return {
    id: row.id,
    location: row.location,
    description: row.description,
    trade: row.trade,
    provider: row.provider,
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

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleProjectsRoutes(req, res) {
  if (req.method === 'POST' && req.url === '/api/projects') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { location, description, trade, provider, agencies, flags, risks, timeline, timelineNote, narrative, extra } = body;
      if (!location || !description || !trade || !provider || !Array.isArray(agencies) || !Array.isArray(flags) || !Array.isArray(risks) || !timeline || !timelineNote || !narrative) {
        sendJson(res, 400, { error: 'location, description, trade, provider, agencies, flags, risks, timeline, timelineNote, and narrative are required' });
        return true;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      insertProject.run(
        id, location, description, trade, provider,
        JSON.stringify(agencies), JSON.stringify(flags), JSON.stringify(risks),
        timeline, timelineNote, narrative,
        extra ? JSON.stringify(extra) : null,
        now, now
      );
      sendJson(res, 200, { id });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/outcome$/.test(req.url)) {
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
    sendJson(res, 200, projectRowToJson(project));
    return true;
  }

  return false;
}
