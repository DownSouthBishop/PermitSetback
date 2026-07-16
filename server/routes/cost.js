// Cost Intelligence: POST /api/projects/:id/cost (generate, once — cheap and
// idempotent, no re-billing the LLM on repeat visits), GET /api/projects/:id/cost
// (list). Self-contained Anthropic call following server/llm.js's pattern —
// not importing from llm.js since its callAnthropic/callGemini are wired to
// the permit-roadmap SYSTEM_PROMPT specifically.
import { readBody, sendJson, requirePaid, checkRateLimit } from '../http-utils.js';
import { callLLMJSON } from '../ai.js';
import { getProjectStmt, insertCostStmt, getCostsByProjectStmt } from '../db.js';

const SYSTEM_PROMPT = `You are Setback's cost estimator for U.S. construction and improvement projects. Given a project's location, description, and trade, break down the likely costs into line items.

Cover only the categories that actually apply to this project — typical candidates: permit fees, engineering/design, survey, impact fees, inspection fees, construction/materials, contractor labor, contingency. Do not include a category that plainly doesn't apply.

Every number is a range, not a point estimate — real costs vary by jurisdiction and contractor. Keep ranges realistic and hedge appropriately ("typically", "commonly") rather than inventing false precision.

Respond with ONLY valid JSON (no markdown, no preamble), in exactly this shape:
{"costs":[{"category":"short category name","lowEstimate":1200,"highEstimate":2600,"note":"one sentence on what drives this range"}]}
Keep it to the 4-8 categories that actually apply.`;

function isValidCostEstimate(obj) {
  return obj && Array.isArray(obj.costs) && obj.costs.every(c =>
    c && typeof c.category === 'string' &&
    (c.lowEstimate == null || typeof c.lowEstimate === 'number') &&
    (c.highEstimate == null || typeof c.highEstimate === 'number')
  );
}

async function generateCostEstimate(project) {
  const userText = `Project location: ${project.location}\nProject description: ${project.description}\nTrade: ${project.trade}`;
  return callLLMJSON({
    systemPrompt: SYSTEM_PROMPT, userText, maxTokens: 1200, isValid: isValidCostEstimate,
    projectId: project.id, callType: 'cost'
  });
}

function costRowToJson(row) {
  return {
    id: row.id,
    category: row.category,
    lowEstimate: row.low_estimate,
    highEstimate: row.high_estimate,
    note: row.note,
    createdAt: row.created_at
  };
}

// Generates and persists a cost estimate if none exists yet, or returns the
// existing one — shared by the POST route below and the post-payment
// pre-generation pass in server/pregenerate.js.
export async function generateAndSaveCost(project) {
  const existing = getCostsByProjectStmt.all(project.id);
  if (existing.length > 0) return existing.map(costRowToJson);

  const { costs } = await generateCostEstimate(project);
  const now = new Date().toISOString();
  for (const c of costs) {
    insertCostStmt.run(crypto.randomUUID(), project.id, c.category, c.lowEstimate ?? null, c.highEstimate ?? null, c.note ?? null, now);
  }
  return getCostsByProjectStmt.all(project.id).map(costRowToJson);
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleCostRoutes(req, res, ip) {
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/cost$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    const costs = getCostsByProjectStmt.all(id).map(costRowToJson);
    sendJson(res, 200, { costs });
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/cost$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;

    // Already generated — return the existing breakdown instead of paying
    // for another LLM call and duplicating rows.
    const existing = getCostsByProjectStmt.all(id);
    if (existing.length > 0) { sendJson(res, 200, { costs: existing.map(costRowToJson) }); return true; }

    if (checkRateLimit(res, ip)) return true;

    try {
      const costs = await generateAndSaveCost(project);
      sendJson(res, 200, { costs });
    } catch (err) {
      console.error('Cost estimate generation failed:', err.message);
      sendJson(res, 502, { error: 'Could not generate a cost estimate right now — try again in a moment.' });
    }
    return true;
  }

  return false;
}
