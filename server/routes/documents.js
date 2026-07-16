// Documents — the supporting paperwork beyond the permit narrative that
// already exists on the project (project.narrative, written at roadmap
// generation time). GET /api/projects/:id/documents lists saved documents;
// POST generates the remaining set in one LLM call and persists them.
import { sendJson, requirePaid, checkRateLimit } from '../http-utils.js';
import { callLLMJSON } from '../ai.js';
import { getProjectStmt, insertDocumentStmt, getDocumentsByProjectStmt } from '../db.js';

// Display labels only — doc_type values themselves (the DB column and the
// LLM response shape below) are unchanged, so existing rows and the JSON
// contract stay stable across this rename.
const DOC_LABELS = {
  permit_checklist: 'Gather-This Checklist',
  owner_summary: 'Client Proposal Summary',
  contractor_summary: 'Your Internal Scope Sheet',
  hoa_questions: 'HOA Questions',
  inspection_checklist: 'Inspection Checklist',
  building_dept_questions: 'Building Department Questions'
};
const DOC_TYPES = Object.keys(DOC_LABELS);

const SYSTEM_PROMPT = `You are Setback's document generator for U.S. construction/improvement permitting. Given a project's location, description, trade, the agencies involved, the jurisdiction flags, and the rejection risks already identified for it, generate six supporting documents. Plain text only — no markdown formatting (no #, *, or **) since this is exported as-is for the user to copy, print, or hand to someone.

1. permit_checklist — the gather-this checklist: everything needed to submit, specific to the agencies and flags already identified for this project (not a generic checklist).
2. owner_summary — a Client Proposal Summary: what the contractor hands the homeowner to win the job. Plain English, no jargon, framed as "what I handle so you don't have to" — the permits and risks are the contractor's problem to manage, not the homeowner's to worry about.
3. contractor_summary — the contractor's own Internal Scope Sheet: scope, the specific code requirements and risks already identified, what to have ready. Technical, for the contractor's own use, not for the client.
4. hoa_questions — specific questions to ask an HOA before submitting, grounded in this project's actual flags/risks. If nothing suggests an HOA is likely involved, say so briefly instead of inventing questions.
5. inspection_checklist — the inspections this project will likely require, in the order they'd typically happen.
6. building_dept_questions — specific questions to ask the building department, grounded in the actual flags/risks already identified — not generic questions. These are things to confirm before submitting; the building department has the final word.

Keep each document tight — 100-200 words, not an essay. A checklist or question list should be short lines, not paragraphs.

Respond with ONLY valid JSON (no markdown, no preamble), in exactly this shape:
{"documents":[{"docType":"permit_checklist","content":"..."},{"docType":"owner_summary","content":"..."},{"docType":"contractor_summary","content":"..."},{"docType":"hoa_questions","content":"..."},{"docType":"inspection_checklist","content":"..."},{"docType":"building_dept_questions","content":"..."}]}
Include all six, in that order. Keep every content field specific to this project — reference the actual agencies/flags/risks given, not boilerplate.`;

function isValidDocuments(obj) {
  return obj && Array.isArray(obj.documents) && obj.documents.length > 0 && obj.documents.every(d =>
    d && DOC_TYPES.includes(d.docType) && typeof d.content === 'string' && d.content.trim().length > 0
  );
}

async function generateDocuments(project) {
  const userText = `Project location: ${project.location}\nProject description: ${project.description}\nTrade: ${project.trade}\nAgencies: ${project.agencies}\nJurisdiction flags: ${project.flags}\nRejection risks: ${project.risks}`;
  // Six documents in one response needs real headroom — 2500 and then 4500
  // both truncated mid-generation and broke the JSON. Tightened the prompt
  // to ask for shorter documents AND raised the ceiling, rather than either
  // alone.
  const result = await callLLMJSON({
    systemPrompt: SYSTEM_PROMPT, userText, maxTokens: 6000, isValid: isValidDocuments, timeoutMs: 150_000,
    projectId: project.id, callType: 'documents'
  });
  return result.documents;
}

function documentRowToJson(row) {
  return { id: row.id, docType: row.doc_type, title: DOC_LABELS[row.doc_type] || row.doc_type, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
}

// Includes the permit narrative generated at roadmap time as a synthetic,
// non-persisted first document, so the Documents tab is the one place that
// shows everything — not just what this module itself generated.
function withNarrative(project, docs) {
  return [
    { id: 'narrative', docType: 'permit_narrative', title: 'Permit Narrative', content: project.narrative, createdAt: project.created_at, updatedAt: project.updated_at },
    ...docs
  ];
}

// Generates and persists the document set if none exists yet, or returns
// the existing set (without the synthetic narrative — callers that want it
// prepended use withNarrative separately, same as the routes below).
// Shared by the POST route and the post-payment pre-generation pass in
// server/pregenerate.js.
export async function generateAndSaveDocuments(project) {
  const existing = getDocumentsByProjectStmt.all(project.id);
  if (existing.length > 0) return existing.map(documentRowToJson);

  const docs = await generateDocuments(project);
  const now = new Date().toISOString();
  return docs.map(d => {
    const docId = crypto.randomUUID();
    insertDocumentStmt.run(docId, project.id, d.docType, d.content, now, now);
    return { id: docId, docType: d.docType, title: DOC_LABELS[d.docType] || d.docType, content: d.content, createdAt: now, updatedAt: now };
  });
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleDocumentsRoutes(req, res, ip) {
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/documents$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    const rows = getDocumentsByProjectStmt.all(id);
    sendJson(res, 200, { documents: withNarrative(project, rows.map(documentRowToJson)) });
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/documents$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;

    // Already generated — return the existing set instead of paying for
    // another LLM call and duplicating rows (matches cost.js/feasibility.js).
    const existing = getDocumentsByProjectStmt.all(id);
    if (existing.length > 0) { sendJson(res, 200, { documents: withNarrative(project, existing.map(documentRowToJson)) }); return true; }

    if (checkRateLimit(res, ip)) return true;
    try {
      const saved = await generateAndSaveDocuments(project);
      sendJson(res, 200, { documents: withNarrative(project, saved) });
    } catch (err) {
      console.error('Document generation failed:', err.message);
      sendJson(res, 502, { error: 'Document generation failed — try again in a moment.' });
    }
    return true;
  }

  return false;
}
