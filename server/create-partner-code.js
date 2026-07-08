// Mint or list partner codes — standing discount codes tied to an
// equity/affiliate arrangement (e.g. HORSEPOWER), redeemable by many people
// at a fixed price on one tier. Manual CLI, same pattern as
// create-access-code.js; see partner-report.js to check redemptions against
// a KPI.
//
// Create the roadmap-tier partner code:
//   node --env-file=.env create-partner-code.js --code HORSEPOWER --label "Partner: South Florida contractor / car guy" --tier roadmap --price 19.99
//
// See what's already out there:
//   node --env-file=.env create-partner-code.js --list

import { insertPartnerCodeStmt, listPartnerCodesStmt } from './db.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

if (flag('list')) {
  const rows = listPartnerCodesStmt.all();
  if (rows.length === 0) {
    console.log('No partner codes yet.');
  } else {
    for (const r of rows) {
      console.log(`${r.code} — "${r.label}" — ${r.tier} tier at $${(r.price_cents / 100).toFixed(2)}`);
    }
  }
  process.exit(0);
}

const code = arg('code');
const label = arg('label');
const tier = arg('tier');
const price = arg('price');
if (!code || !label || !tier || !price) {
  console.error('Usage: node create-partner-code.js --code CODE --label "who this is for" --tier roadmap|full --price 19.99');
  console.error('   or: node create-partner-code.js --list');
  process.exit(1);
}
if (!['roadmap', 'full'].includes(tier)) {
  console.error('--tier must be "roadmap" or "full"');
  process.exit(1);
}

const normalizedCode = code.trim().toUpperCase();
const priceCents = Math.round(parseFloat(price) * 100);

try {
  insertPartnerCodeStmt.run(normalizedCode, label, tier, priceCents, new Date().toISOString());
  console.log(`Created partner code "${normalizedCode}" — ${label} — ${tier} tier at $${(priceCents / 100).toFixed(2)}.`);
} catch (err) {
  console.error(`Failed to create code: ${err.message}`);
  process.exit(1);
}
