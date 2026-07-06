// Real COGS report from actual logged API usage — not a guess. Manual CLI,
// same pattern as learn.js and create-access-code.js.
//
//   node --env-file=.env usage-report.js
//
// Prints cost by call type, and per-project totals for any project that has
// run more than one module (i.e. someone who explored the workspace, not
// just the base roadmap) — that per-project number is the one that actually
// matters against the $19/$39 price, not the cost of a single roadmap call.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(process.env.SETBACK_DB_PATH || join(__dirname, 'data.db'));

function money(n) {
  return n == null ? 'n/a (unpriced model)' : `$${n.toFixed(4)}`;
}

console.log('=== Cost by call type ===');
const byType = db.prepare(`
  SELECT call_type, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
  FROM api_usage_log GROUP BY call_type ORDER BY cost_usd DESC
`).all();

if (byType.length === 0) {
  console.log('No usage logged yet — this fills in as the app is actually used.');
} else {
  let totalCost = 0;
  for (const row of byType) {
    console.log(`${row.call_type}: ${row.calls} call(s), ${row.input_tokens} in / ${row.output_tokens} out tokens, ${money(row.cost_usd)} total (avg ${money(row.cost_usd / row.calls)}/call)`);
    totalCost += row.cost_usd || 0;
  }
  console.log(`\nTotal logged spend: ${money(totalCost)}`);
}

console.log('\n=== Cost per project (projects with 2+ calls — i.e. explored beyond the base roadmap) ===');
const byProject = db.prepare(`
  SELECT project_id, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd, GROUP_CONCAT(call_type) AS call_types
  FROM api_usage_log WHERE project_id IS NOT NULL GROUP BY project_id HAVING calls >= 2 ORDER BY cost_usd DESC
`).all();

if (byProject.length === 0) {
  console.log('No project has used more than one module yet.');
} else {
  for (const row of byProject) {
    const margin19 = row.cost_usd == null ? null : 19 - row.cost_usd;
    console.log(`${row.project_id}: ${row.calls} calls (${row.call_types}) — ${money(row.cost_usd)} cost — margin at $19: ${margin19 == null ? 'n/a' : money(margin19)}`);
  }
}

console.log('\nPricing source: platform.claude.com/docs, fetched 2026-07-06 (server/pricing.js). Re-verify before trusting this for a real pricing decision — rates change.');
