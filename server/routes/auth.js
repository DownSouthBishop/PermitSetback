// Passwordless magic-link accounts: POST /api/auth/request-link,
// GET /api/auth/verify, GET /api/me/projects.
import { readBody, sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import {
  getOrCreateUser, insertMagicLinkStmt, getMagicLinkStmt, markMagicLinkUsedStmt,
  insertSessionStmt, linkProjectToUserStmt, getProjectsByUserStmt, getSessionUserStmt
} from '../db.js';
import { computeAttentionItems } from '../attention.js';

const PORT = process.env.PORT || 8787;

// Reads the bearer session token off the request and resolves it to a user,
// or null if missing/expired/unknown — callers just check for null. Exported
// so routes/projects.js can identify a subscriber/pack-holder when deciding
// price, without duplicating this lookup.
export function getSessionUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = getSessionUserStmt.get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

function projectSummary(p) {
  return { id: p.id, location: p.location, description: p.description, trade: p.trade, outcomeStatus: p.outcome_status, createdAt: p.created_at };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleAuthRoutes(req, res, ip) {
  // No real email sender is wired up yet (that's a cloud dependency this
  // build deliberately hasn't added without sign-off), so the link is
  // handed straight back in the response instead of being emailed. Swap
  // that in later without changing this shape.
  if (req.method === 'POST' && req.url === '/api/auth/request-link') {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    try {
      const { email, projectId } = JSON.parse((await readBody(req)) || '{}');
      if (typeof email !== 'string' || !email.includes('@')) {
        sendJson(res, 400, { error: 'a valid email is required' });
        return true;
      }
      getOrCreateUser(email);
      const token = crypto.randomUUID();
      const now = new Date();
      const expires = new Date(now.getTime() + 15 * 60_000);
      insertMagicLinkStmt.run(token, email, projectId || null, now.toISOString(), expires.toISOString());
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${req.headers.host}`;
      sendJson(res, 200, { devLink: `${origin}/api/auth/verify?token=${token}` });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/auth/verify')) {
    const token = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('token');
    const link = token && getMagicLinkStmt.get(token);
    if (!link) { sendJson(res, 400, { error: 'invalid or unknown link' }); return true; }
    if (link.used_at) { sendJson(res, 400, { error: 'this link has already been used' }); return true; }
    if (new Date(link.expires_at).getTime() < Date.now()) { sendJson(res, 400, { error: 'this link has expired' }); return true; }

    markMagicLinkUsedStmt.run(new Date().toISOString(), token);
    const user = getOrCreateUser(link.email);

    if (link.project_id) {
      linkProjectToUserStmt.run(user.id, new Date().toISOString(), link.project_id);
    }

    const sessionToken = crypto.randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    insertSessionStmt.run(sessionToken, user.id, now.toISOString(), expires.toISOString());

    const projects = getProjectsByUserStmt.all(user.id).map(projectSummary);
    sendJson(res, 200, { sessionToken, projects });
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/me/projects') {
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'not authenticated' }); return true; }
    const projects = getProjectsByUserStmt.all(user.id).map(projectSummary);
    sendJson(res, 200, { projects });
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/me/attention') {
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'not authenticated' }); return true; }
    sendJson(res, 200, { items: computeAttentionItems(user.id) });
    return true;
  }

  return false;
}
