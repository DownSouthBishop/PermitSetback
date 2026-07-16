// Risk Intelligence — every risk gets likelihood, impact, priority,
// mitigation, and confidence, distinct from Feasibility's go/no-go concerns:
// permitting delays, inspection failures, cost overrun risk, scheduling and
// contractor risk, code-compliance risk, weather/seasonal risk, and
// neighbor/dispute risk. GET /api/projects/:id/risk lists saved findings;
// POST generates a fresh batch via the LLM and persists them. Findings live
// in project_findings with category = 'risk' (Feasibility Intelligence
// shares the table via category = 'feasibility', so this file never touches
// those rows).
import { readBody, sendJson, requirePaid, checkRateLimit } from '../http-utils.js';
import { callLLMJSON } from '../ai.js';
import { getProjectStmt, insertFindingStmt, getFindingsByProjectStmt } from '../db.js';

const SYSTEM_PROMPT = `You are Setback's risk analyst. Given a US construction/improvement project's location, description, and trade, identify risks that could delay the project, blow the budget, or block approval — beyond a basic feasibility screen: permitting delays, inspection failures, cost overrun risk, contractor/scheduling risk, weather/seasonal risk, code-compliance risk, and neighbor/dispute risk.

Be specific to the jurisdiction and project where you can, but hedge anything you're not certain of rather than inventing a precise rule ("commonly delays", "often adds") — this is not a legal or engineering determination.

Respond with ONLY valid JSON (no markdown, no preamble), in exactly this shape:
{"risks":[{"label":"short risk name","detail":"1-3 sentence explanation of the risk and what it means for this project","likelihood":"high|medium|low","impact":"high|medium|low","priority":"high|medium|low","mitigation":"1-2 sentence concrete step that reduces this risk","confidence":"confirmed|likely|uncertain"}]}
Only include risks that plausibly apply given the location, description, and trade — do not pad the list to hit a count. If nothing notable applies, respond with {"risks":[]}.`;

function isValidRisks(obj) {
  return obj && Array.isArray(obj.risks) && obj.risks.every(r =>
    r && typeof r.label === 'string' && typeof r.detail === 'string'
  );
}

async function generateRiskFindings(project) {
  const userText = `Project location: ${project.location}\nProject description: ${project.description}\nTrade: ${project.trade}`;
  const result = await callLLMJSON({
    systemPrompt: SYSTEM_PROMPT, userText, maxTokens: 1500, isValid: isValidRisks,
    projectId: project.id, callType: 'risk'
  });
  return result.risks;
}

function findingRowToJson(row) {
  return {
    id: row.id,
    label: row.label,
    detail: row.detail,
    likelihood: row.likelihood,
    impact: row.impact,
    priority: row.priority,
    mitigation: row.mitigation,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Generates and persists risk findings if none exist yet, or returns the
// existing set — shared by the POST route below and the post-payment
// pre-generation pass in server/pregenerate.js.
export async function generateAndSaveRisk(project) {
  const existing = getFindingsByProjectStmt.all(project.id, 'risk');
  if (existing.length > 0) return existing.map(findingRowToJson);

  const risks = await generateRiskFindings(project);
  const now = new Date().toISOString();
  return risks.map(r => {
    const findingId = crypto.randomUUID();
    insertFindingStmt.run(findingId, project.id, 'risk', r.label, r.detail, r.likelihood || null, r.impact || null, r.priority || null, r.mitigation || null, r.confidence || null, now, now);
    return { id: findingId, label: r.label, detail: r.detail, likelihood: r.likelihood || null, impact: r.impact || null, priority: r.priority || null, mitigation: r.mitigation || null, confidence: r.confidence || null, createdAt: now, updatedAt: now };
  });
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleRiskRoutes(req, res, ip) {
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/risk$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    const rows = getFindingsByProjectStmt.all(id, 'risk');
    sendJson(res, 200, { findings: rows.map(findingRowToJson) });
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/risk$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    await readBody(req); // no request body expected — drain it before responding

    // Already generated — return the existing findings instead of paying for
    // another LLM call and duplicating rows (matches cost.js/timeline.js).
    const existing = getFindingsByProjectStmt.all(id, 'risk');
    if (existing.length > 0) { sendJson(res, 200, { findings: existing.map(findingRowToJson) }); return true; }

    if (checkRateLimit(res, ip)) return true;
    try {
      const saved = await generateAndSaveRisk(project);
      sendJson(res, 200, { findings: saved });
    } catch (err) {
      console.error('Risk generation failed:', err.message);
      sendJson(res, 502, { error: 'Risk analysis failed — try again in a moment.' });
    }
    return true;
  }

  return false;
}
