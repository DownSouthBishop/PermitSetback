// Passwordless magic-link accounts: POST /api/auth/request-link,
// GET /api/auth/verify, GET /api/me/projects.
import { readBody, sendJson, checkRateLimit } from '../http-utils.js';
import {
  getOrCreateUser, insertMagicLinkStmt, getMagicLinkStmt, markMagicLinkUsedStmt,
  insertSessionStmt, linkProjectToUserStmt, getProjectsByUserStmt, getSessionUserStmt,
  getActiveSubscriptionByUserStmt, getPackCreditsByUserStmt, getProjectStmt
} from '../db.js';
import { computeAttentionItems } from '../attention.js';
import { sendEmail } from '../email.js';
import { packLabelForCredits } from '../stripe.js';

// True once a real sender is configured, or once this is genuinely a
// production deploy — either way, the sign-in link must never be handed
// back in the API response from this point on (that was a full
// account-takeover hole: anyone could POST any email and get back a valid
// login link for it). Below this line, devLink stays response-only for
// local dev with no email sender wired up.
function mustEmailLink() {
  return !!process.env.RESEND_API_KEY || process.env.NODE_ENV === 'production';
}

const PORT = process.env.PORT || 8787;

// Reads the bearer session token off the request and resolves it to a user,
// or null if missing/expired/unknown — callers just check for null. Exported
// so routes/projects.js can identify a subscriber/pack-holder when deciding
// price, without duplicating this lookup.
export function getSessionUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = getSessionUserStmt.get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// The teaser's "email me my results link" capture (an unpaid project) wants
// the richer results-recap email (Appendix A §6.1) — location, counts, the
// guarantee line — not the bare "here's your sign-in link" utility copy
// every other request-link call site (subscribe, save-after-payment,
// projects.html sign-in) wants instead. Same endpoint, same magic-link
// mechanism; only the email content branches on whether there's an unpaid
// project attached. "Permits" in the approved copy becomes "agencies" here
// — this app has no separate permit count, only agencies/flags/risks.
function buildRequestLinkEmail(project, link) {
  if (!project || project.paid) {
    return {
      subject: 'Your Setback sign-in link',
      html: `<p>Here's your sign-in link — it expires in 15 minutes:</p><p><a href="${link}">${link}</a></p>`,
      text: `Here's your sign-in link — it expires in 15 minutes: ${link}`
    };
  }
  const agencyCount = JSON.parse(project.agencies).length;
  const riskCount = JSON.parse(project.risks).length;
  return {
    subject: `Your permit results for ${project.location} — ${agencyCount} agencies, ${riskCount} risks found`,
    html: `
      <p>Here's your link — it's saved for 7 days: <a href="${link}">Open my results</a></p>
      <p>The short version: this project touches ${agencyCount} agencies and we flagged ${riskCount} rejection risk${riskCount === 1 ? '' : 's'} worth knowing before anyone quotes it. The full packet — names, narratives, checklists, and the client-ready PDF — is behind the link.</p>
      <p>&mdash; Setback<br>Rejected as drafted? Refunded in full.</p>
    `,
    text: `Here's your link — it's saved for 7 days: ${link}\n\nThe short version: this project touches ${agencyCount} agencies and we flagged ${riskCount} rejection risk${riskCount === 1 ? '' : 's'} worth knowing before anyone quotes it. The full packet — names, narratives, checklists, and the client-ready PDF — is behind the link.\n\n— Setback. Rejected as drafted? Refunded in full.`
  };
}

function projectSummary(p) {
  return {
    id: p.id, location: p.location, description: p.description, trade: p.trade,
    outcomeStatus: p.outcome_status, createdAt: p.created_at, paid: !!p.paid, tier: p.tier
  };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleAuthRoutes(req, res, ip) {
  if (req.method === 'POST' && req.url === '/api/auth/request-link') {
    if (checkRateLimit(res, ip)) return true;
    try {
      const { email, projectId } = JSON.parse((await readBody(req)) || '{}');
      if (typeof email !== 'string' || !email.includes('@')) {
        sendJson(res, 400, { error: 'a valid email is required' });
        return true;
      }
      getOrCreateUser(email);
      const token = crypto.randomUUID();
      const now = new Date();
      const expires = new Date(now.getTime() + 15 * 60_000);
      insertMagicLinkStmt.run(token, email, projectId || null, now.toISOString(), expires.toISOString());
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${req.headers.host}`;
      const link = `${origin}/api/auth/verify?token=${token}`;

      if (mustEmailLink()) {
        // Never let a send failure change this response's shape — that
        // would let someone distinguish "email sent" from "email failed"
        // per address, which is its own small oracle. Log and move on.
        try {
          const project = projectId ? getProjectStmt.get(projectId) : null;
          const { subject, html, text } = buildRequestLinkEmail(project, link);
          await sendEmail({ to: email, subject, html, text });
        } catch (err) {
          console.error('[auth] sendEmail failed:', err.message);
        }
        sendJson(res, 200, { ok: true });
      } else {
        // Local dev only, no email sender configured: hand the link back
        // directly instead of emailing it.
        sendJson(res, 200, { devLink: link });
      }
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/auth/verify')) {
    const token = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('token');
    const link = token && getMagicLinkStmt.get(token);
    if (!link) { sendJson(res, 400, { error: 'invalid or unknown link' }); return true; }
    if (link.used_at) { sendJson(res, 400, { error: 'this link has already been used' }); return true; }
    if (new Date(link.expires_at).getTime() < Date.now()) { sendJson(res, 400, { error: 'this link has expired' }); return true; }

    markMagicLinkUsedStmt.run(new Date().toISOString(), token);
    const user = getOrCreateUser(link.email);

    if (link.project_id) {
      linkProjectToUserStmt.run(user.id, new Date().toISOString(), link.project_id);
    }

    const sessionToken = crypto.randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    insertSessionStmt.run(sessionToken, user.id, now.toISOString(), expires.toISOString());

    const projects = getProjectsByUserStmt.all(user.id).map(projectSummary);
    sendJson(res, 200, { sessionToken, projects, subscribed: !!getActiveSubscriptionByUserStmt.get(user.id) });
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/me/projects') {
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'not authenticated' }); return true; }
    const projects = getProjectsByUserStmt.all(user.id).map(projectSummary);
    sendJson(res, 200, { projects, subscribed: !!getActiveSubscriptionByUserStmt.get(user.id) });
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/me/attention') {
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'not authenticated' }); return true; }
    sendJson(res, 200, { items: computeAttentionItems(user.id) });
    return true;
  }

  // Expediter pack usage — every pack the account has ever bought, so
  // someone burning through a prepaid pack can see how many pulls are left
  // instead of finding out only when redeem-pack-credit starts failing.
  if (req.method === 'GET' && req.url === '/api/me/packs') {
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'not authenticated' }); return true; }
    const packs = getPackCreditsByUserStmt.all(user.id).map(p => ({
      creditsTotal: p.credits_total, creditsUsed: p.credits_used, createdAt: p.created_at,
      label: packLabelForCredits(p.credits_total)
    }));
    sendJson(res, 200, { packs });
    return true;
  }

  return false;
}
