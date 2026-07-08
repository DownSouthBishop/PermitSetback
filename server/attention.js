// "Which of a contractor's active permits need attention" — the server-side
// version of the rollup projects.html originally computed client-side via
// one fetch per project (see that file's own ponytail note about the N+1
// this replaces). Shared by GET /api/me/attention (routes/auth.js) and the
// attention-digest loop (attention-digest.js), so the two can never drift
// out of sync on what counts as "needs attention."
import { getProjectsByUserStmt, getProjectStmt } from './db.js';

export function computeAttentionItems(userId) {
  const projects = getProjectsByUserStmt.all(userId);
  const items = [];

  for (const p of projects) {
    const full = getProjectStmt.get(p.id);
    if (!full) continue;

    if (!full.paid) {
      items.push({ projectId: p.id, location: p.location, trade: p.trade, reason: 'Not unlocked yet', weight: 1 });
      continue;
    }
    if (full.outcome_status === 'rejected') {
      items.push({ projectId: p.id, location: p.location, trade: p.trade, reason: 'Rejected — refund guarantee may apply', weight: 100 });
      continue;
    }
    const concernCount = JSON.parse(full.risks || '[]').length + JSON.parse(full.flags || '[]').length;
    if (!full.outcome_status && concernCount > 0) {
      items.push({
        projectId: p.id, location: p.location, trade: p.trade,
        reason: `${concernCount} risk${concernCount === 1 ? '' : 's'}/flags, no outcome recorded`,
        weight: 10 + concernCount
      });
    }
  }

  items.sort((a, b) => b.weight - a.weight);
  return items;
}
