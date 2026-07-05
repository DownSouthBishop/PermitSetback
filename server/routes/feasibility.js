// Feasibility Intelligence — surfaces concerns the user should see before
// permits are even discussed: flood zones, wetlands, HOA, historic district,
// lot restrictions, utilities, environmental and zoning concerns.
// GET /api/projects/:id/feasibility lists saved findings; POST generates a
// fresh batch via the LLM and persists them. Findings live in
// project_findings with category = 'feasibility' (Risk Intelligence shares
// the table via category = 'risk', so this file never touches those rows).
import { readBody, sendJson, requirePaid } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import { callAnthropicJSON } from '../ai.js';
import { getProjectStmt, insertFindingStmt, getFindingsByProjectStmt } from '../db.js';

const SYSTEM_PROMPT = `You are Setback's feasibility analyst. Given a US construction/improvement project's location, description, and trade, identify concerns that could affect feasibility BEFORE the applicant gets to permits: flood zones, wetlands, HOA restrictions, historic district designation, lot/setback restrictions, utility conflicts, environmental concerns, and zoning concerns.

Be specific to the jurisdiction named where you can, but hedge anything you're not certain of rather than inventing a precise rule ("commonly restricted", "may require") — this is not a legal or environmental determination.

Respond with ONLY valid JSON (no markdown, no preamble), in exactly this shape:
{"findings":[{"label":"short concern name","detail":"1-3 sentence explanation of the concern and what it means for this project","impact":"high|medium|low","confidence":"confirmed|likely|uncertain"}]}
Only include findings that plausibly apply given the location, description, and trade — do not pad the list to hit a count. If nothing notable applies, respond with {"findings":[]}.`;

function isValidFindings(obj) {
  return obj && Array.isArray(obj.findings) && obj.findings.every(f =>
    f && typeof f.label === 'string' && typeof f.detail === 'string'
  );
}

async function generateFeasibilityFindings(project) {
  const userText = `Project location: ${project.location}\nProject description: ${project.description}\nTrade: ${project.trade}`;
  const result = await callAnthropicJSON({
    systemPrompt: SYSTEM_PROMPT, userText, maxTokens: 1500, isValid: isValidFindings
  });
  return result.findings;
}

function findingRowToJson(row) {
  return {
    id: row.id,
    label: row.label,
    detail: row.detail,
    impact: row.impact,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleFeasibilityRoutes(req, res, ip) {
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/feasibility$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    const rows = getFindingsByProjectStmt.all(id, 'feasibility');
    sendJson(res, 200, { findings: rows.map(findingRowToJson) });
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/feasibility$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    await readBody(req); // no request body expected — drain it before responding

    // Already generated — return the existing findings instead of paying for
    // another LLM call and duplicating rows (matches cost.js/timeline.js).
    const existing = getFindingsByProjectStmt.all(id, 'feasibility');
    if (existing.length > 0) { sendJson(res, 200, { findings: existing.map(findingRowToJson) }); return true; }

    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    try {
      const findings = await generateFeasibilityFindings(project);
      const now = new Date().toISOString();
      const saved = findings.map(f => {
        const findingId = crypto.randomUUID();
        insertFindingStmt.run(findingId, id, 'feasibility', f.label, f.detail, null, f.impact || null, null, null, f.confidence || null, now, now);
        return { id: findingId, label: f.label, detail: f.detail, impact: f.impact || null, confidence: f.confidence || null, createdAt: now, updatedAt: now };
      });
      sendJson(res, 200, { findings: saved });
    } catch (err) {
      console.error('Feasibility generation failed:', err.message);
      sendJson(res, 502, { error: 'Feasibility analysis failed — try again in a moment.' });
    }
    return true;
  }

  return false;
}
