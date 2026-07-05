// AI Advisor: GET /api/projects/:id/conversation, POST /api/projects/:id/conversation
import { readBody, sendJson, requirePaid } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import { getProjectStmt, insertConversationMessageStmt, getConversationByProjectStmt } from '../db.js';
import { askAdvisor } from '../llm.js';

function messageRowToJson(row) {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at };
}

function projectToAdvisorContext(row) {
  return {
    location: row.location,
    description: row.description,
    trade: row.trade,
    agencies: JSON.parse(row.agencies),
    flags: JSON.parse(row.flags),
    risks: JSON.parse(row.risks),
    timeline: row.timeline,
    timelineNote: row.timeline_note,
    narrative: row.narrative
  };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleAdvisorRoutes(req, res, ip) {
  const match = req.url.match(/^\/api\/projects\/([^/]+)\/conversation$/);
  if (!match) return false;
  const projectId = match[1];

  if (req.method === 'GET') {
    const project = getProjectStmt.get(projectId);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    const messages = getConversationByProjectStmt.all(projectId).map(messageRowToJson);
    sendJson(res, 200, { messages });
    return true;
  }

  if (req.method === 'POST') {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    try {
      const { message } = JSON.parse((await readBody(req)) || '{}');
      if (typeof message !== 'string' || !message.trim()) {
        sendJson(res, 400, { error: 'a non-empty message is required' });
        return true;
      }
      const project = getProjectStmt.get(projectId);
      if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (requirePaid(res, project)) return true;

      const history = getConversationByProjectStmt.all(projectId).map(r => ({ role: r.role, content: r.content }));
      const now = new Date().toISOString();
      insertConversationMessageStmt.run(crypto.randomUUID(), projectId, 'user', message.trim(), now);

      const { provider, reply } = await askAdvisor(projectToAdvisorContext(project), history, message.trim());
      insertConversationMessageStmt.run(crypto.randomUUID(), projectId, 'assistant', reply, new Date().toISOString());

      sendJson(res, 200, { provider, reply });
    } catch (err) {
      console.error('Setback: advisor call failed —', err);
      sendJson(res, 502, { error: 'The advisor is unavailable right now — try again in a moment.' });
    }
    return true;
  }

  return false;
}
