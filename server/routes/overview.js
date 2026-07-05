// Project Overview — the guided home screen. Computes real journey progress
// and simple, disclosed confidence/risk indicators from data already on the
// project. Nothing here is a black-box score: confidence is literally "how
// much of the intelligence-gathering journey is done," and risk is a
// transparent count of the high-severity findings already surfaced
// elsewhere, not a separate hidden model.
import { sendJson, requirePaid } from '../http-utils.js';
import { getProjectStmt, getFindingsByProjectStmt } from '../db.js';
import { getProjectProgress } from '../project-progress.js';

const STEPS = [
  { key: 'feasibility', label: 'Feasibility', link: 'feasibility' },
  { key: 'permits', label: 'Permits', link: 'permits' },
  { key: 'cost', label: 'Cost', link: 'cost' },
  { key: 'timeline', label: 'Timeline', link: 'timeline' },
  { key: 'risk', label: 'Risk', link: 'risk' },
  { key: 'documents', label: 'Documents', link: 'documents' }
];

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleOverviewRoutes(req, res) {
  const match = req.url.match(/^\/api\/projects\/([^/]+)\/overview$/);
  if (req.method !== 'GET' || !match) return false;

  const project = getProjectStmt.get(match[1]);
  if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (requirePaid(res, project)) return true;

  const progress = getProjectProgress(project.id);
  const steps = STEPS.map(s => ({ ...s, done: !!progress[s.key] }));
  const doneCount = steps.filter(s => s.done).length;
  const confidenceScore = Math.round((doneCount / steps.length) * 100);

  const highRisks = progress.risk ? getFindingsByProjectStmt.all(project.id, 'risk').filter(f => f.priority === 'high').length : 0;
  const highFeasibility = progress.feasibility ? getFindingsByProjectStmt.all(project.id, 'feasibility').filter(f => f.impact === 'high').length : 0;
  const riskScored = progress.risk || progress.feasibility;
  const riskScore = riskScored ? Math.min(100, highRisks * 20 + highFeasibility * 15) : null;
  const riskScoreBasis = riskScored
    ? `${highRisks} high-priority risk${highRisks === 1 ? '' : 's'}, ${highFeasibility} high-impact feasibility concern${highFeasibility === 1 ? '' : 's'}`
    : null;

  const status = doneCount >= steps.length ? 'Fully scoped' : doneCount <= 1 ? 'Just started' : 'In progress';
  const nextStep = steps.find(s => !s.done) || null;

  sendJson(res, 200, { steps, doneCount, totalSteps: steps.length, status, confidenceScore, riskScore, riskScoreBasis, nextStep });
  return true;
}
