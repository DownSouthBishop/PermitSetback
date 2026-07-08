// Mint or list access codes — the free-unlock path for beta testers and the
// founder, independent of payment. Manual CLI, same pattern as learn.js.
//
// Create a permanent, unlimited-use code for yourself:
//   node --env-file=.env create-access-code.js --code FOUNDER2026 --label "Founder — permanent" --unlimited
//
// Create a limited-use code for one beta tester:
//   node --env-file=.env create-access-code.js --code JOESROOFING --label "Beta: Joe's Roofing" --max-uses 5
//
// Add an expiry date (optional, ISO date):
//   node --env-file=.env create-access-code.js --code TRIAL30 --label "30-day trial batch" --max-uses 20 --expires 2026-08-15
//
// See what's already out there, and how much each code has been used:
//   node --env-file=.env create-access-code.js --list

import { insertAccessCodeStmt, listAccessCodesStmt } from './db.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

if (flag('list')) {
  const rows = listAccessCodesStmt.all();
  if (rows.length === 0) {
    console.log('No access codes yet.');
  } else {
    for (const r of rows) {
      const usesText = r.max_uses === null ? `${r.uses_count} uses (unlimited)` : `${r.uses_count}/${r.max_uses} uses`;
      const expiryText = r.expires_at ? `expires ${r.expires_at}` : 'never expires';
      console.log(`${r.code} — "${r.label}" — ${usesText} — ${expiryText}`);
    }
  }
  process.exit(0);
}

const code = arg('code');
const label = arg('label');
if (!code || !label) {
  console.error('Usage: node create-access-code.js --code CODE --label "who this is for" [--max-uses N | --unlimited] [--expires YYYY-MM-DD]');
  console.error('   or: node create-access-code.js --list');
  process.exit(1);
}

const normalizedCode = code.trim().toUpperCase();
const maxUses = flag('unlimited') ? null : (arg('max-uses') ? parseInt(arg('max-uses'), 10) : null);
const expiresArg = arg('expires');
const expiresAt = expiresArg ? new Date(expiresArg).toISOString() : null;

try {
  insertAccessCodeStmt.run(normalizedCode, label, maxUses, expiresAt, new Date().toISOString());
  console.log(`Created code "${normalizedCode}" — ${label} — ${maxUses === null ? 'unlimited uses' : `${maxUses} uses`}${expiresAt ? `, expires ${expiresAt}` : ', never expires'}.`);
} catch (err) {
  console.error(`Failed to create code: ${err.message}`);
  process.exit(1);
}
