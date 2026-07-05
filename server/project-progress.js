// Shared "has this module actually been run yet" checks — used by Task
// Center (which "generate X" prompts to surface) and Project Overview (which
// journey steps are complete). One source of truth for both, computed live
// from existing data rather than a separate status field that could drift.
import { getFindingsByProjectStmt, getCostsByProjectStmt, getTimelinePhasesByProjectStmt, getDocumentsByProjectStmt } from './db.js';

export function getProjectProgress(projectId) {
  return {
    feasibility: getFindingsByProjectStmt.all(projectId, 'feasibility').length > 0,
    permits: true, // agencies/flags/risks/narrative are generated at project creation — always present once paid
    cost: getCostsByProjectStmt.all(projectId).length > 0,
    timeline: getTimelinePhasesByProjectStmt.all(projectId).length > 0,
    risk: getFindingsByProjectStmt.all(projectId, 'risk').length > 0,
    documents: getDocumentsByProjectStmt.all(projectId).length > 0
  };
}
