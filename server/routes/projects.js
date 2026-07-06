// Project persistence: GET /api/projects/:id, POST /api/projects/:id/unlock,
// POST /api/projects/:id/outcome.
//
// There used to be a POST /api/projects here that accepted a fully-formed
// roadmap (agencies/flags/risks/narrative/etc.) straight from the client and
// stored whatever it was given, unauthenticated and unrated-limited. It's
// gone — POST /api/roadmap (routes/legacy.js) creates the project server-side
// now, from a roadmap the server itself generated. Nothing accepts arbitrary
// roadmap content from a client anymore.
import { readBody, sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import {
  getProjectStmt, updateProjectOutcomeStmt, insertOutcome, markProjectPaidStmt,
  getAccessCodeStmt, incrementAccessCodeUsesStmt, insertAccessCodeRedemptionStmt,
  insertRefundClaimStmt, db
} from '../db.js';
import { createCheckoutSession, retrieveCheckoutSession } from '../stripe.js';

// Same "first 100 paid roadmaps" intro-price check /api/stats already
// exposes to the client for display — this is the one that actually
// decides what to charge, server-side, never trusting a client-supplied
// price. $19 while under the introductory cap, $39 after.
function currentPriceCents() {
  const paidCount = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE paid = 1').get().n;
  return paidCount < 100 ? 1900 : 3900;
}

// Stripe redirects the browser here directly, so it needs an absolute
// URL — derived from the request itself (Host header + whether this hop
// is HTTPS) rather than hardcoded, so it's correct in both local dev and
// behind Railway's TLS-terminating edge.
function originFromRequest(req) {
  const proto = req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

function projectRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    confidenceScore: row.confidence_score,
    riskScore: row.risk_score,
    location: row.location,
    description: row.description,
    trade: row.trade,
    provider: row.provider,
    paid: !!row.paid,
    agencies: JSON.parse(row.agencies),
    flags: JSON.parse(row.flags),
    risks: JSON.parse(row.risks),
    timeline: row.timeline,
    timelineNote: row.timeline_note,
    narrative: row.narrative,
    // Generic bucket for fields added after the original roadmap shape
    // (cost estimate, timeline breakdown, next actions, etc.) — null until
    // something actually writes to it.
    extra: row.extra ? JSON.parse(row.extra) : null,
    outcomeStatus: row.outcome_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Teaser shape for a project that hasn't been paid for yet — counts only,
// no agencies/flags/risks/narrative content.
function projectTeaserJson(row) {
  return {
    id: row.id,
    paid: false,
    location: row.location,
    description: row.description,
    trade: row.trade,
    counts: {
      agencies: JSON.parse(row.agencies).length,
      flags: JSON.parse(row.flags).length,
      risks: JSON.parse(row.risks).length
    }
  };
}

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleProjectsRoutes(req, res, ip) {
  // DEV STUB — stands in for real payment confirmation (e.g. a Stripe
  // webhook firing after a successful charge). Marks the project paid and
  // hands back the full content. Whatever replaces this later should call
  // markProjectPaidStmt the same way, only after verifying the charge.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/unlock$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!project.paid) {
      console.warn(`DEV MODE: unlocking project ${id} without payment verification — replace before real launch.`);
      markProjectPaidStmt.run(new Date().toISOString(), new Date().toISOString(), id);
    }
    sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
    return true;
  }

  // Access-code unlock — a permanent second door alongside payment, for
  // beta testers and the founder. Independent of whatever real payment
  // integration replaces the /unlock dev-stub later; this keeps working
  // exactly the same after that happens.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/redeem$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    try {
      const { code } = JSON.parse((await readBody(req)) || '{}');
      if (typeof code !== 'string' || !code.trim()) { sendJson(res, 400, { error: 'an access code is required' }); return true; }
      const normalizedCode = code.trim().toUpperCase();
      const accessCode = getAccessCodeStmt.get(normalizedCode);
      if (!accessCode) { sendJson(res, 400, { error: 'invalid access code' }); return true; }
      if (accessCode.expires_at && new Date(accessCode.expires_at).getTime() < Date.now()) {
        sendJson(res, 400, { error: 'this access code has expired' }); return true;
      }
      if (accessCode.max_uses !== null && accessCode.uses_count >= accessCode.max_uses) {
        sendJson(res, 400, { error: 'this access code has reached its use limit' }); return true;
      }

      const now = new Date().toISOString();
      if (!project.paid) markProjectPaidStmt.run(now, now, id);
      incrementAccessCodeUsesStmt.run(normalizedCode);
      insertAccessCodeRedemptionStmt.run(crypto.randomUUID(), normalizedCode, id, now);
      sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  // Real Stripe Checkout — creates a session for this project at whatever
  // the current server-decided price is, and returns the hosted Stripe URL
  // for the frontend to redirect to. Nothing here marks a project paid;
  // that only happens once /confirm-checkout (or the webhook) verifies the
  // session actually completed with Stripe.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/create-checkout-session$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (project.paid) { sendJson(res, 200, projectRowToJson(project)); return true; }

    try {
      const origin = originFromRequest(req);
      const session = await createCheckoutSession({
        projectId: id,
        amountCents: currentPriceCents(),
        label: `Setback — ${project.trade} permit roadmap`,
        successUrl: `${origin}/?project=${encodeURIComponent(id)}&checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/?project=${encodeURIComponent(id)}`
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error('Stripe checkout session creation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't start checkout — try again in a moment." });
    }
    return true;
  }

  // The return leg: Stripe sent the browser back here with a session id.
  // Verify directly against Stripe's API (never trust the query string
  // alone) before marking anything paid — this alone is a legitimate,
  // secure confirmation path even with no webhook reachable yet (e.g. local
  // dev). The webhook (routes/stripe-webhook.js) is defense-in-depth for
  // the case where someone closes the tab before the redirect completes.
  const [confirmUrlPath, confirmQs] = req.url.split('?');
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/confirm-checkout$/.test(confirmUrlPath)) {
    const id = confirmUrlPath.split('/')[3];
    const sessionId = new URLSearchParams(confirmQs || '').get('session_id');
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (project.paid) { sendJson(res, 200, projectRowToJson(project)); return true; }
    if (!sessionId) { sendJson(res, 400, { error: 'missing session_id' }); return true; }

    try {
      const session = await retrieveCheckoutSession(sessionId);
      if (session.payment_status !== 'paid' || session.metadata?.projectId !== id) {
        sendJson(res, 402, { error: 'payment not confirmed' });
        return true;
      }
      const now = new Date().toISOString();
      markProjectPaidStmt.run(now, now, id);
      sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
    } catch (err) {
      console.error('Stripe checkout confirmation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't confirm payment — try again in a moment." });
    }
    return true;
  }

  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/outcome$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    try {
      const { outcome } = JSON.parse((await readBody(req)) || '{}');
      const validOutcomes = ['approved', 'comments', 'rejected'];
      if (!validOutcomes.includes(outcome)) {
        sendJson(res, 400, { error: 'a valid outcome is required' });
        return true;
      }
      const project = getProjectStmt.get(id);
      if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }

      const now = new Date().toISOString();
      updateProjectOutcomeStmt.run(outcome, now, now, id);
      insertOutcome.run(now, project.location, project.description, project.trade, outcome);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  // The refund guarantee ("send us the rejection notice... that's the whole
  // process") had no actual destination in the product before this. Anyone
  // can file one — there's no automated eligibility check (the promise is
  // "we missed something," which only a human can judge against the actual
  // rejection notice) — this just makes sure the claim reaches someone
  // instead of evaporating. Reviewed manually via server/refund-claims.js.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/refund-claim$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    try {
      const { details, contactEmail } = JSON.parse((await readBody(req)) || '{}');
      if (!details || typeof details !== 'string' || !details.trim()) {
        sendJson(res, 400, { error: 'tell us what happened — a few words on what was missing or wrong' });
        return true;
      }
      const project = getProjectStmt.get(id);
      if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }

      insertRefundClaimStmt.run(crypto.randomUUID(), id, project.outcome_status || 'rejected', details.trim().slice(0, 4000), (contactEmail || '').trim().slice(0, 200) || null, new Date().toISOString());
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  if (req.method === 'GET' && /^\/api\/projects\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    sendJson(res, 200, project.paid ? projectRowToJson(project) : projectTeaserJson(project));
    return true;
  }

  return false;
}
