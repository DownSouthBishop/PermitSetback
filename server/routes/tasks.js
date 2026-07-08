// Task Center — next actions derived deterministically from data already on
// the project. No LLM call: cheap, instant, and never invents a task that
// isn't grounded in something the project actually flagged.
//
// Two kinds of task:
//  - Concern tasks: persisted (project_tasks), one per high-impact
//    feasibility finding, high-priority risk, or jurisdiction flag from the
//    original roadmap. Synced idempotently via source_id so repeat views
//    don't duplicate them. These can be marked done — there's no automatic
//    signal that a real-world concern got resolved, so the user says so.
//  - Step tasks: computed live from getProjectProgress, never persisted —
//    "run this module" prompts that disappear on their own once the module
//    has data. Doing the thing is what marks it done, not a checkbox.
import { readBody, sendJson, requirePaid, checkRateLimit } from '../http-utils.js';
import {
  getProjectStmt, insertTaskStmt, getTasksByProjectStmt, getTaskBySourceStmt, updateTaskStatusStmt,
  getFindingsByProjectStmt
} from '../db.js';
import { getProjectProgress } from '../project-progress.js';

function taskRowToJson(row) {
  return { id: row.id, title: row.title, detail: row.detail, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

// Flags are one long sentence with no natural label — every flag-derived
// task used to share the identical title "Address jurisdiction flag,"
// making a 5-6-item list unscannable. Derive a short distinct title from the
// flag's own leading clause instead; the full text still lives in detail.
//
// MAX_TITLE_LEN is deliberately tight (not just "under one line") — the
// leading clause itself is sometimes a full 70+ character sentence, and at
// a looser cap the "short" title ends up being almost the entire opening
// sentence of detail, reading as a duplicate instead of a label.
const MAX_TITLE_LEN = 42;
export function shortTitleFromFlag(flagText) {
  // Split only on em-dash or sentence-ending punctuation — NOT a plain
  // hyphen, which shows up constantly in compound construction terms
  // ("post-footing", "slope-rear", "tie-in") and would cut mid-word.
  const clause = flagText.split(/\s*—\s*|(?<=[.:;])\s/)[0].trim();
  const base = clause.length > 4 ? clause : flagText;
  return base.length > MAX_TITLE_LEN ? base.slice(0, MAX_TITLE_LEN - 3).replace(/\s+\S*$/, '') + '…' : base;
}

function syncConcernTasks(project) {
  const now = new Date().toISOString();

  JSON.parse(project.flags || '[]').forEach((flagText, i) => {
    const sourceId = `flag:${i}`;
    if (!getTaskBySourceStmt.get(project.id, sourceId)) {
      insertTaskStmt.run(crypto.randomUUID(), project.id, sourceId, shortTitleFromFlag(flagText), flagText, 'open', null, now, now);
    }
  });

  getFindingsByProjectStmt.all(project.id, 'feasibility').filter(f => f.impact === 'high').forEach(f => {
    const sourceId = `feasibility:${f.id}`;
    if (!getTaskBySourceStmt.get(project.id, sourceId)) {
      insertTaskStmt.run(crypto.randomUUID(), project.id, sourceId, `Resolve: ${f.label}`, f.detail, 'open', null, now, now);
    }
  });

  getFindingsByProjectStmt.all(project.id, 'risk').filter(f => f.priority === 'high').forEach(f => {
    const sourceId = `risk:${f.id}`;
    if (!getTaskBySourceStmt.get(project.id, sourceId)) {
      const detail = f.mitigation ? `${f.detail} Mitigation: ${f.mitigation}` : f.detail;
      insertTaskStmt.run(crypto.randomUUID(), project.id, sourceId, `Mitigate: ${f.label}`, detail, 'open', null, now, now);
    }
  });
}

function stepTasks(projectId) {
  const progress = getProjectProgress(projectId);
  const steps = [];
  if (!progress.feasibility) steps.push({ id: 'missing:feasibility', title: 'Run a feasibility check', detail: 'Screen for flood zones, wetlands, HOA rules, and other go/no-go concerns.', link: 'feasibility' });
  if (!progress.cost) steps.push({ id: 'missing:cost', title: 'Generate a cost estimate', detail: 'See planning-stage cost ranges for permits, engineering, and construction.', link: 'cost' });
  if (!progress.timeline) steps.push({ id: 'missing:timeline', title: 'Generate a project timeline', detail: 'Break the project into phases and see which one is most likely to slip.', link: 'timeline' });
  if (!progress.risk) steps.push({ id: 'missing:risk', title: 'Run a risk assessment', detail: 'Identify permitting, cost, schedule, and compliance risks beyond the feasibility screen.', link: 'risk' });
  if (!progress.documents) steps.push({ id: 'missing:documents', title: 'Generate your permit documents', detail: 'Checklists and summaries ready to hand to your contractor, HOA, or the building department.', link: 'documents' });
  return steps.map(s => ({ ...s, detail: s.detail, status: 'open' }));
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleTasksRoutes(req, res, ip) {
  const getMatch = req.url.match(/^\/api\/projects\/([^/]+)\/tasks$/);
  if (req.method === 'GET' && getMatch) {
    const project = getProjectStmt.get(getMatch[1]);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    syncConcernTasks(project);
    const concernTasks = getTasksByProjectStmt.all(project.id).map(taskRowToJson);
    sendJson(res, 200, { tasks: [...concernTasks, ...stepTasks(project.id)] });
    return true;
  }

  const statusMatch = req.url.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/status$/);
  if (req.method === 'POST' && statusMatch) {
    if (checkRateLimit(res, ip)) return true;
    const [, projectId, taskId] = statusMatch;
    const project = getProjectStmt.get(projectId);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    if (taskId.startsWith('missing:')) { sendJson(res, 400, { error: 'this task completes itself once its module has data' }); return true; }
    try {
      const { status } = JSON.parse((await readBody(req)) || '{}');
      if (!['open', 'done'].includes(status)) { sendJson(res, 400, { error: 'status must be open or done' }); return true; }
      updateTaskStatusStmt.run(status, new Date().toISOString(), taskId, projectId);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  return false;
}
