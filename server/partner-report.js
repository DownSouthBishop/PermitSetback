// KPI tracker for a partner code's equity cliff: counts how many people
// redeemed the code, claimed their project (linked it to an account), and
// have been on Setback Pro for 2+ months. Manual CLI, same pattern as
// usage-report.js.
//
//   node --env-file=.env partner-report.js [CODE]
//
// Defaults to HORSEPOWER if no code is given.
import { listPartnerRedemptionsStmt, getSubscriptionsByUserStmt } from './db.js';

const code = (process.argv[2] || 'HORSEPOWER').toUpperCase();
const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;
const KPI_TARGET = 25;

const redemptions = listPartnerRedemptionsStmt.all(code);

if (redemptions.length === 0) {
  console.log(`No redemptions of ${code} yet.`);
  process.exit(0);
}

console.log(`=== ${code} redemptions (${redemptions.length}) ===`);
let qualifying = 0;
for (const r of redemptions) {
  let status = 'no account linked yet';
  if (r.user_id) {
    const subs = getSubscriptionsByUserStmt.all(r.user_id);
    // "Stayed on 2 months" — for a still-active subscription, measured to
    // now; for one that already ended, measured to when it did (updated_at
    // is when status last changed, i.e. when it was canceled).
    const qualifies = subs.some(s => {
      const start = new Date(s.created_at).getTime();
      const end = s.status === 'active' ? Date.now() : new Date(s.updated_at).getTime();
      return end - start >= TWO_MONTHS_MS;
    });
    status = qualifies ? '2+ months on Pro (counts)' : (subs.length ? 'subscribed, not yet 2 months' : 'no Pro subscription');
    if (qualifies) qualifying++;
  }
  console.log(`${r.project_id} — redeemed ${r.redeemed_at} — ${status}`);
}

console.log(`\n${qualifying}/${KPI_TARGET} toward the equity cliff KPI.`);
