// Real KPI report from actual logged data — not a guess. Manual CLI, same
// pattern as usage-report.js/learn.js.
//
//   node --env-file=.env kpi-report.js
//
// Revenue figures here are estimated from list price by tier/pack (paid
// projects × $49/$97, packs × their list price) — a referral/subscriber
// discount would still count at full price, so this slightly overstates
// revenue. There's no separate payment ledger to derive an exact figure
// from; re-verify against Stripe's own dashboard before trusting this for
// a real financial decision, same caveat usage-report.js gives its cost figures.
import { db, getUsageSummaryStmt } from './db.js';
import { packLabelForCredits, PACK_SIZES } from './stripe.js';

function money(n) {
  return `$${n.toFixed(2)}`;
}
function pct(n, d) {
  return d === 0 ? 'n/a (no data yet)' : `${((n / d) * 100).toFixed(1)}%`;
}

console.log('=== Teasers & conversion ===');
const roadmapCount = db.prepare('SELECT COUNT(*) AS n FROM roadmaps WHERE unrecognized = 0').get().n;
const paidCount = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE paid = 1').get().n;
console.log(`Teasers generated: ${roadmapCount}`);
console.log(`Paid projects: ${paidCount}`);
console.log(`Teaser -> paid conversion: ${pct(paidCount, roadmapCount)}`);

console.log('\n=== Tier split (paid projects) ===');
const tierSplit = db.prepare("SELECT tier, COUNT(*) AS n FROM projects WHERE paid = 1 GROUP BY tier").all();
for (const row of tierSplit) console.log(`${row.tier || 'unknown'}: ${row.n}`);

console.log('\n=== Expediter/Bid Pack sales ===');
const packSales = db.prepare('SELECT credits_total, COUNT(*) AS n FROM pack_credits GROUP BY credits_total').all();
let packRevenue = 0;
if (packSales.length === 0) {
  console.log('No packs sold yet.');
} else {
  for (const row of packSales) {
    const label = packLabelForCredits(row.credits_total);
    const kind = Object.keys(PACK_SIZES).find(k => PACK_SIZES[k].credits === row.credits_total);
    const priceUsd = kind ? PACK_SIZES[kind].amountCents / 100 : 0;
    packRevenue += priceUsd * row.n;
    console.log(`${label} (${row.credits_total} credits): ${row.n} sold, ~${money(priceUsd * row.n)}`);
  }
}

console.log('\n=== Repeat-buyer rate ===');
const buyerCounts = db.prepare('SELECT user_id, COUNT(*) AS n FROM projects WHERE paid = 1 AND user_id IS NOT NULL GROUP BY user_id').all();
const repeatBuyers = buyerCounts.filter(b => b.n >= 2).length;
console.log(`Accounts with 1+ paid project: ${buyerCounts.length}`);
console.log(`Accounts with 2+ paid projects: ${repeatBuyers}`);
console.log(`Repeat-buyer rate: ${pct(repeatBuyers, buyerCounts.length)}`);

console.log('\n=== Packet download rates (per full-tier paid project) ===');
const fullTierCount = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE paid = 1 AND tier = 'full'").get().n;
const clientPacketDownloads = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'bid_packet_downloaded'").get().n;
const submissionPackDownloads = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'submission_pack_downloaded'").get().n;
console.log(`Client Packet downloaded: ${clientPacketDownloads} (${pct(clientPacketDownloads, fullTierCount)} of full-tier projects)`);
console.log(`City Submission Pack downloaded: ${submissionPackDownloads} (${pct(submissionPackDownloads, fullTierCount)} of full-tier projects)`);

console.log('\n=== Drip capture & conversion ===');
const capturedLeads = db.prepare('SELECT COUNT(DISTINCT project_id) AS n FROM magic_links WHERE project_id IS NOT NULL').get().n;
const drippedProjects = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE drip_day2_sent_at IS NOT NULL OR drip_day6_sent_at IS NOT NULL').get().n;
const dripConversions = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'drip_converted'").get().n;
console.log(`Projects with a captured email: ${capturedLeads} (${pct(capturedLeads, roadmapCount)} of teasers)`);
console.log(`Projects that received a drip email: ${drippedProjects}`);
console.log(`Drip -> purchase conversions: ${dripConversions} (${pct(dripConversions, drippedProjects)} of dripped projects)`);

console.log('\n=== Outcome-report rate ===');
const outcomeEmailsSent = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE outcome_email_sent_at IS NOT NULL').get().n;
const outcomeReports = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'outcome_reported'").get().n;
console.log(`Outcome emails sent: ${outcomeEmailsSent}`);
console.log(`Outcome reports received: ${outcomeReports} (${pct(outcomeReports, outcomeEmailsSent)} of sent)`);

console.log('\n=== Refund claims ===');
const refundClaims = db.prepare('SELECT status, COUNT(*) AS n FROM refund_claims GROUP BY status').all();
if (refundClaims.length === 0) console.log('No refund claims filed yet.');
for (const row of refundClaims) console.log(`${row.status}: ${row.n}`);

console.log('\n=== COGS vs. revenue (estimated) ===');
const usageByType = getUsageSummaryStmt.all();
const totalCogs = usageByType.reduce((sum, row) => sum + (row.cost_usd || 0), 0);
const roadmapOnlyPaid = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE paid = 1 AND tier = 'roadmap'").get().n;
const projectRevenue = roadmapOnlyPaid * 49 + fullTierCount * 97;
const totalRevenue = projectRevenue + packRevenue;
console.log(`Total logged API cost (COGS): ${money(totalCogs)}`);
console.log(`Estimated project revenue: ${money(projectRevenue)} (${roadmapOnlyPaid} roadmap x $49, ${fullTierCount} full x $97)`);
console.log(`Estimated pack revenue: ${money(packRevenue)}`);
console.log(`Estimated total revenue: ${money(totalRevenue)}`);
console.log(`Estimated margin: ${money(totalRevenue - totalCogs)}`);

console.log('\nRevenue figures are list-price estimates, not a real payment ledger — see this file\'s header comment. Re-verify against Stripe before trusting this for a real financial decision.');
