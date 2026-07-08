// Timeline Intelligence: POST /api/projects/:id/timeline (generate, once —
// returns the existing breakdown if one already exists instead of
// regenerating), GET /api/projects/:id/timeline (list, ordered by phase).
import { sendJson, requirePaid, checkRateLimit } from '../http-utils.js';
import { getProjectStmt, insertTimelinePhaseStmt, getTimelinePhasesByProjectStmt } from '../db.js';
import { generateTimelinePhases } from '../llm.js';

function phaseRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    estimatedDuration: row.estimated_duration,
    status: row.status,
    isBottleneck: !!row.is_bottleneck,
    note: row.note,
    createdAt: row.created_at
  };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleTimelineRoutes(req, res, ip) {
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/timeline$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;

    const existing = getTimelinePhasesByProjectStmt.all(id);
    if (existing.length > 0) {
      sendJson(res, 200, { phases: existing.map(phaseRowToJson) });
      return true;
    }

    if (checkRateLimit(res, ip)) return true;

    try {
      const { phases } = await generateTimelinePhases(project.location, project.description, project.trade, project.id);
      const now = new Date().toISOString();
      phases.forEach((phase, i) => {
        insertTimelinePhaseStmt.run(
          crypto.randomUUID(), id, phase.name, i,
          phase.estimatedDuration || null, 'pending',
          phase.isBottleneck ? 1 : 0, phase.note || null, now
        );
      });
      sendJson(res, 200, { phases: getTimelinePhasesByProjectStmt.all(id).map(phaseRowToJson) });
    } catch (err) {
      console.error('Timeline generation failed:', err.message);
      sendJson(res, 502, { error: 'Timeline generation failed — try again in a moment.' });
    }
    return true;
  }

  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/timeline$/.test(req.url)) {
    if (checkRateLimit(res, ip)) return true;
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    sendJson(res, 200, { phases: getTimelinePhasesByProjectStmt.all(id).map(phaseRowToJson) });
    return true;
  }

  return false;
}
