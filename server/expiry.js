// The 7-day unpaid-results window — makes the "saved for 7 days" promise in
// the results email (server/auth.js's buildRequestLinkEmail, §6.1) actually
// true. Clears the teaser-visible content on any unpaid project past the
// window; the row itself (location, trade, created_at) stays for analytics
// — nothing is deleted. Paid projects never expire (excluded by the query
// itself, not a special case here).
//
// Runs two ways, same shape as learn.js/attention-digest.js:
//   1. Automatically, on the existing interval, inside index.js.
//   2. Manually, for inspection: node --env-file=.env expiry.js
import { expireUnpaidProjectsStmt } from './db.js';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Never throws — a failed pass should never take down the server or block
// the next scheduled attempt.
export function runExpiryPass(log = console.log) {
  try {
    const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
    const result = expireUnpaidProjectsStmt.run(new Date().toISOString(), cutoff);
    if (result.changes > 0) log(`[expiry] Cleared ${result.changes} unpaid project(s) past the 7-day window.`);
  } catch (err) {
    console.error('[expiry] Pass failed (non-fatal):', err.message);
  }
}

// Only auto-run when executed directly (node expiry.js), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  runExpiryPass();
  console.log('Done.');
}
