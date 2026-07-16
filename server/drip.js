// Day-2 and day-6 drip emails (Appendix A §6.2/§6.3) to unpaid projects with
// a captured email on file (someone requested a magic link for it — see
// getDripCandidatesStmt in db.js). Sent-state is tracked per project so
// nothing double-sends; a purchase (paid = 1) or an expired/unsubscribed
// project drops out of the candidate query entirely, which is what "purchase
// cancels the sequence" and "unsubscribe is honored" actually mean here —
// there's no separate cancellation flag to maintain.
//
// Runs two ways, same shape as learn.js/attention-digest.js:
//   1. Automatically, on the existing interval, inside index.js.
//   2. Manually, for inspection: node --env-file=.env drip.js
import { getDripCandidatesStmt, markDrip2SentStmt, markDrip6SentStmt } from './db.js';
import { sendEmail } from './email.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function unsubscribeLink(origin, projectId) {
  return `${origin}/api/projects/${projectId}/unsubscribe`;
}

function day2Email(project, origin) {
  const riskCount = JSON.parse(project.risks).length;
  return {
    subject: 'What a rejected permit actually costs',
    text: `Not the fee — the fee is small. The cost is two to six weeks of a stalled job, a client who's now nervous, and a resubmission you're doing for free. Your results for ${project.location} flagged ${riskCount} specific way${riskCount === 1 ? '' : 's'} this project type gets rejected in your jurisdiction — and what heads each one off. That list alone is worth the $49.\n\nOpen my results (saved for 5 more days): ${origin}/?project=${project.id}\n\nUnsubscribe: ${unsubscribeLink(origin, project.id)}`,
    html: `<p>Not the fee — the fee is small. The cost is two to six weeks of a stalled job, a client who's now nervous, and a resubmission you're doing for free. Your results for ${project.location} flagged ${riskCount} specific way${riskCount === 1 ? '' : 's'} this project type gets rejected in your jurisdiction — and what heads each one off. That list alone is worth the $49.</p><p><a href="${origin}/?project=${project.id}">Open my results</a> — saved for 5 more days.</p><p style="font-size:12px;color:#888;"><a href="${unsubscribeLink(origin, project.id)}">Unsubscribe</a></p>`
  };
}

function day6Email(project, origin) {
  return {
    subject: `Your ${project.location} results expire tomorrow`,
    text: `We hold results for 7 days, then clear them. Yours go tomorrow. If the job is still live, the full packet is $49-$97, guaranteed: if the county rejects the application as we drafted it, you get every dollar back.\n\nOpen my results — last day: ${origin}/?project=${project.id}\n\nIf the job fell through — no hard feelings. Run the next one when it calls you.\n\nUnsubscribe: ${unsubscribeLink(origin, project.id)}`,
    html: `<p>We hold results for 7 days, then clear them. Yours go tomorrow. If the job is still live, the full packet is $49&ndash;$97, guaranteed: if the county rejects the application as we drafted it, you get every dollar back.</p><p><a href="${origin}/?project=${project.id}">Open my results — last day</a></p><p>If the job fell through — no hard feelings. Run the next one when it calls you.</p><p style="font-size:12px;color:#888;"><a href="${unsubscribeLink(origin, project.id)}">Unsubscribe</a></p>`
  };
}

// Never throws — a failed pass should never take down the server or block
// the next scheduled attempt. A single project's send failing doesn't stop
// the rest of the batch (each is caught independently).
export async function runDripPass(log = console.log) {
  // No public origin config exists elsewhere in this app (static.js serves
  // whatever host the request came in on) — DRIP_EMAIL_ORIGIN is this pass's
  // own, since it runs off the request path entirely and has no Host header
  // to derive one from.
  const origin = process.env.DRIP_EMAIL_ORIGIN;
  if (!origin) { log('[drip] DRIP_EMAIL_ORIGIN not set — skipping this pass.'); return; }

  try {
    const candidates = getDripCandidatesStmt.all().filter(p => p.lead_email);
    const now = Date.now();
    let day2Sent = 0, day6Sent = 0;

    for (const project of candidates) {
      const ageMs = now - new Date(project.created_at).getTime();
      try {
        // Marked sent before the send actually happens, not after — the
        // guarantee this exists for is "never twice," not "always
        // eventually," so a send that fails after this point is simply
        // missed rather than retried next pass. Same WHERE-guarded-write
        // pattern as incrementAccessCodeUsesStmt (db.js): .changes === 0
        // means another pass already claimed this send.
        if (ageMs >= 2 * DAY_MS && !project.drip_day2_sent_at) {
          const result = markDrip2SentStmt.run(new Date().toISOString(), project.id);
          if (result.changes > 0) { await sendEmail({ to: project.lead_email, ...day2Email(project, origin) }); day2Sent++; }
        }
        if (ageMs >= 6 * DAY_MS && !project.drip_day6_sent_at) {
          const result = markDrip6SentStmt.run(new Date().toISOString(), project.id);
          if (result.changes > 0) { await sendEmail({ to: project.lead_email, ...day6Email(project, origin) }); day6Sent++; }
        }
      } catch (err) {
        console.error(`[drip] send failed for project ${project.id}:`, err.message);
      }
    }
    log(`[drip] Checked ${candidates.length} candidate(s) — ${day2Sent} day-2 email(s), ${day6Sent} day-6 email(s) sent.`);
  } catch (err) {
    console.error('[drip] Pass failed (non-fatal):', err.message);
  }
}

// Only auto-run when executed directly (node drip.js), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runDripPass();
  console.log('Done.');
}
