// Fires every Full Workspace module's generator in parallel the moment a
// project is confirmed paid at the full tier, instead of making the buyer
// wait 30-150s per tab, one at a time, after they've already paid. Called
// from both confirmation paths (routes/checkout.js's confirm-checkout and
// routes/stripe-webhook.js) — fire-and-forget, never awaited by the HTTP
// response, since a slow or failed module here should never delay or break
// the payment confirmation itself. Each generateAndSaveX already no-ops if
// that module's content exists, so a double-fire (redirect path AND webhook
// both landing) never double-generates or double-bills.
import { generateAndSaveFeasibility } from './routes/feasibility.js';
import { generateAndSaveRisk } from './routes/risk.js';
import { generateAndSaveCost } from './routes/cost.js';
import { generateAndSaveTimeline } from './routes/timeline.js';
import { generateAndSaveDocuments } from './routes/documents.js';

const MODULES = [
  ['feasibility', generateAndSaveFeasibility],
  ['risk', generateAndSaveRisk],
  ['cost', generateAndSaveCost],
  ['timeline', generateAndSaveTimeline],
  ['documents', generateAndSaveDocuments]
];

export function pregenerateFullWorkspace(project) {
  for (const [name, generate] of MODULES) {
    generate(project).catch(err => {
      console.error(`[pregenerate] ${name} failed for project ${project.id}:`, err.message);
    });
  }
}
