// The "needs attention" loop — turns the rollup that used to only exist if
// a contractor happened to open projects.html into something that actually
// checks on a schedule.
//
// Runs two ways, same shape as learn.js:
//   1. Automatically, on an interval, inside the main server process (index.js).
//   2. Manually, for inspection: node --env-file=.env attention-digest.js
//
// What this does NOT do yet: send an email. There is no email provider
// wired up in this app (see README's "What still isn't real" — magic links
// have the same gap, returned directly instead of emailed). Faking an email
// send here would be worse than not having one; this logs exactly what a
// real digest email would say, at the point where wiring a provider in
// later is a one-function change; not a redesign.
import { getAllUserIdsWithProjectsStmt, getAttentionDigestStmt, upsertAttentionDigestStmt } from './db.js';
import { computeAttentionItems } from './attention.js';

function hashItems(items) {
  // Cheap fingerprint, not a security hash — this only needs to detect
  // "did the set of attention items change since we last logged," so a
  // collision-resistant hash isn't the job here.
  return items.map(it => `${it.projectId}:${it.reason}`).sort().join('|');
}

// Exported so index.js can run this on a timer, and so it can still be
// invoked directly for a one-off manual run. Never throws — a failed pass
// should never take down the server or block the next scheduled attempt.
export async function runAttentionDigestPass(log = console.log) {
  try {
    const userIds = getAllUserIdsWithProjectsStmt.all().map(r => r.id);
    let notified = 0;

    for (const userId of userIds) {
      const items = computeAttentionItems(userId);
      if (items.length === 0) continue; // acts-when: nothing to report, skip silently

      const hash = hashItems(items);
      const existing = getAttentionDigestStmt.get(userId);
      if (existing && existing.items_hash === hash) continue; // self-check: unchanged since last digest, don't re-notify

      log(`[attention-digest] User ${userId}: ${items.length} item(s) need attention —`);
      for (const it of items) {
        log(`  - ${it.location} (${it.trade}): ${it.reason}`);
      }
      upsertAttentionDigestStmt.run(userId, hash, new Date().toISOString());
      notified++;
    }

    log(`[attention-digest] Checked ${userIds.length} account(s), ${notified} with a new/changed digest.`);
  } catch (err) {
    console.error('[attention-digest] Pass failed (non-fatal):', err.message);
  }
}

// Only auto-run when executed directly (node attention-digest.js), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runAttentionDigestPass();
  console.log('Done.');
}
