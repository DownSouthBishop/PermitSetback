// Post-timeline outcome email (Appendix A §6.4) — asks whether the county
// ever ruled, once a paid project's estimated timeline has had time to
// play out. Answering (any of the four options) grants a referral code as
// thanks, via the same mintReferralCodeForProject a full-price purchase
// already grants one through (routes/checkout.js).
//
// ponytail: every project's timeline is a free-text range ("4-8 weeks"),
// not a number — parsing that per-project into an exact date is real work
// for a single email's timing. A fixed delay past paid_at is the shortcut;
// upgrade to parsing project.timeline (or the structured
// project_timeline_phases durations) if the send date ever needs to track
// the actual estimate instead of a worst-case constant.
//
// Runs two ways, same shape as learn.js/attention-digest.js/drip.js:
//   1. Automatically, on the existing interval, inside index.js.
//   2. Manually, for inspection: node --env-file=.env outcome-email.js
import { getOutcomeEmailCandidatesStmt, markOutcomeEmailSentStmt } from './db.js';
import { sendEmail } from './email.js';
import { signOutcome } from './outcome-signing.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DELAY_DAYS = Number(process.env.OUTCOME_EMAIL_DELAY_DAYS) || 60;

function outcomeLink(origin, projectId, outcome) {
  return `${origin}/api/projects/${projectId}/outcome-report?outcome=${outcome}&sig=${signOutcome(projectId, outcome)}`;
}

function buildEmail(project, origin) {
  const buttons = [
    ['approved', 'Approved as drafted'],
    ['comments', 'Approved with changes'],
    ['rejected', 'Rejected'],
    ['not_yet_filed', "Haven't filed yet"]
  ];
  const html = `
    <p>One question, thirty seconds: how did the county rule?</p>
    <p>${buttons.map(([v, label]) => `<a href="${outcomeLink(origin, project.id, v)}">${label}</a>`).join(' &nbsp;|&nbsp; ')}</p>
    <p>Every answer makes the next contractor's packet in your county sharper. As thanks: answer and we'll send you a $48-off referral code — use it or hand it to another contractor.</p>
  `;
  const text = `One question, thirty seconds: how did the county rule?\n\n${buttons.map(([v, label]) => `${label}: ${outcomeLink(origin, project.id, v)}`).join('\n')}\n\nEvery answer makes the next contractor's packet in your county sharper. As thanks: answer and we'll send you a $48-off referral code — use it or hand it to another contractor.`;
  return { subject: `Did ${project.location} get approved?`, html, text };
}

// Never throws — a failed pass should never take down the server or block
// the next scheduled attempt.
export async function runOutcomeEmailPass(log = console.log) {
  const origin = process.env.DRIP_EMAIL_ORIGIN;
  if (!origin) { log('[outcome-email] DRIP_EMAIL_ORIGIN not set — skipping this pass.'); return; }
  if (!process.env.OUTCOME_SIGNING_SECRET) { log('[outcome-email] OUTCOME_SIGNING_SECRET not set — skipping this pass.'); return; }

  try {
    const cutoff = new Date(Date.now() - DELAY_DAYS * DAY_MS).toISOString();
    const candidates = getOutcomeEmailCandidatesStmt.all(cutoff).filter(p => p.lead_email);
    let sent = 0;
    for (const project of candidates) {
      try {
        const result = markOutcomeEmailSentStmt.run(new Date().toISOString(), project.id);
        if (result.changes > 0) { await sendEmail({ to: project.lead_email, ...buildEmail(project, origin) }); sent++; }
      } catch (err) {
        console.error(`[outcome-email] send failed for project ${project.id}:`, err.message);
      }
    }
    log(`[outcome-email] Checked ${candidates.length} candidate(s) — ${sent} email(s) sent.`);
  } catch (err) {
    console.error('[outcome-email] Pass failed (non-fatal):', err.message);
  }
}

// Only auto-run when executed directly (node outcome-email.js), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runOutcomeEmailPass();
  console.log('Done.');
}
