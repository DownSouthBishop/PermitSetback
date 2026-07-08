// Remote admin routes for managing a live deployment with no SSH or
// filesystem access to the host — gated by ADMIN_SECRET, 404s entirely if
// that env var isn't set, so both routes are inert unless deliberately
// enabled. Split out of projects.js, which had accumulated project CRUD,
// checkout, and these alongside each other for unrelated reasons.
import { readBody, sendJson, checkRateLimit } from '../http-utils.js';
import { getProjectStmt, insertAccessCodeStmt, db } from '../db.js';

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleAdminRoutes(req, res, ip) {
  // ponytail: one-off admin route for minting access codes without SSH/filesystem
  // access to whatever host this runs on.
  if (req.method === 'POST' && req.url === '/api/admin/access-codes') {
    const secret = process.env.ADMIN_SECRET;
    // Secret check first, rate limit second — a wrong/missing secret must
    // always 404 the same way regardless of attempt count, so this route
    // stays indistinguishable from one that doesn't exist to anyone without
    // the secret. Rate limiting only guards the authenticated path.
    if (!secret || req.headers['x-admin-secret'] !== secret) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (checkRateLimit(res, ip)) return true;
    try {
      const { code, label, maxUses, expiresAt } = JSON.parse((await readBody(req)) || '{}');
      if (typeof code !== 'string' || !code.trim() || typeof label !== 'string' || !label.trim()) {
        sendJson(res, 400, { error: 'code and label are required' }); return true;
      }
      const normalizedCode = code.trim().toUpperCase();
      insertAccessCodeStmt.run(normalizedCode, label.trim(), maxUses ?? null, expiresAt ?? null, new Date().toISOString());
      sendJson(res, 200, { code: normalizedCode });
    } catch (err) {
      sendJson(res, 400, { error: err.message.includes('UNIQUE') ? 'that code already exists' : 'invalid request body' });
    }
    return true;
  }

  // ponytail: same no-SSH problem as the access-codes route above, for the
  // same reason — cleaning up test/seed data created directly against a
  // live deployment (e.g. via curl, the way this route itself was exercised)
  // with no filesystem access to the host to do it by hand. Deletes the
  // project, every child row keyed by project_id, and the matching
  // roadmaps-table funnel row (which has no project_id — it's a separate
  // funnel-tracking table — so it's matched by location+description+trade
  // instead) so /api/stats reflects the cleanup too.
  if (req.method === 'DELETE' && /^\/api\/admin\/projects\/[^/]+$/.test(req.url)) {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.headers['x-admin-secret'] !== secret) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (checkRateLimit(res, ip)) return true;
    const id = req.url.split('/')[4];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }

    for (const table of ['project_findings', 'project_costs', 'project_timeline_phases', 'project_tasks', 'project_documents', 'project_conversations', 'refund_claims', 'access_code_redemptions']) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    }
    db.prepare('DELETE FROM roadmaps WHERE location = ? AND description = ? AND trade = ?').run(project.location, project.description, project.trade);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    sendJson(res, 200, { deleted: id });
    return true;
  }

  return false;
}
