// Project persistence: GET /api/projects/:id, POST /api/projects/:id/unlock,
// POST /api/projects/:id/outcome.
//
// There used to be a POST /api/projects here that accepted a fully-formed
// roadmap (agencies/flags/risks/narrative/etc.) straight from the client and
// stored whatever it was given, unauthenticated and unrated-limited. It's
// gone — POST /api/roadmap (routes/legacy.js) creates the project server-side
// now, from a roadmap the server itself generated. Nothing accepts arbitrary
// roadmap content from a client anymore.
import { randomInt } from 'node:crypto';
import { readBody, sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import {
  getProjectStmt, updateProjectOutcomeStmt, insertOutcome, markProjectPaidStmt,
  getAccessCodeStmt, incrementAccessCodeUsesStmt, insertAccessCodeRedemptionStmt,
  insertAccessCodeStmt, insertRefundClaimStmt, db,
  getActiveSubscriptionByUserStmt, getReferralCodeStmt, redeemReferralCodeStmt,
  insertReferralCodeStmt, getAvailablePackForUserStmt, incrementPackCreditsUsedStmt,
  linkProjectToUserStmt, getReferralCodeByReferrerStmt
} from '../db.js';
import { createCheckoutSession, retrieveCheckoutSession, createReferralPromotionCode } from '../stripe.js';
import { getSessionUser } from './auth.js';

const VALID_TIERS = ['roadmap', 'full'];

// The pricing ladder (see server/db.js's pricing-overhaul comment for the
// tables this reads): $49 roadmap-only, $97 full workspace one-off, $49
// full workspace for an active subscriber or a valid unredeemed referral
// code. Pack credits (expediter $999/50) skip this entirely — they're
// consumed directly via POST /redeem-pack-credit, never through Stripe
// checkout, since they're already paid for.
function priceCentsFor(tier, { sessionUser, referralCodeRow }) {
  if (tier === 'roadmap') return 4900;
  if (sessionUser && getActiveSubscriptionByUserStmt.get(sessionUser.id)) return 4900;
  if (referralCodeRow && !referralCodeRow.redeemed_project_id) return 4900;
  return 9700;
}

// Referral codes are shared out loud (emailed, texted to another
// contractor), so they use a short human-typeable alphabet rather than a
// UUID — no ambiguous characters (0/O, 1/I) since someone will be reading
// this off a screen to type it in.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateReferralCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  return code;
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
  // Only ever surface a code this project actually minted, and only while
  // it's still unredeemed — a used-up code isn't something to keep showing
  // as if it's still shareable.
  const referralCodeRow = getReferralCodeByReferrerStmt.get(row.id);
  const referralCode = referralCodeRow && !referralCodeRow.redeemed_project_id ? referralCodeRow.code : null;
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
    tier: row.tier,
    referralCode,
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
      markProjectPaidStmt.run('full', new Date().toISOString(), new Date().toISOString(), id);
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
      if (!project.paid) markProjectPaidStmt.run('full', now, now, id);
      incrementAccessCodeUsesStmt.run(normalizedCode);
      insertAccessCodeRedemptionStmt.run(crypto.randomUUID(), normalizedCode, id, now);
      sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return true;
  }

  // ponytail: one-off admin route for minting access codes without SSH/filesystem
  // access to whatever host this runs on. Gated by ADMIN_SECRET; 404s entirely
  // if that env var isn't set, so it's inert unless deliberately enabled.
  if (req.method === 'POST' && req.url === '/api/admin/access-codes') {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.headers['x-admin-secret'] !== secret) { sendJson(res, 404, { error: 'not found' }); return true; }
    try {
      const { code, label, maxUses, expiresAt } = JSON.parse((await readBody(req)) || '{}');
      if (typeof code !== 'string' || !code.trim() || typeof label !== 'string' || !label.trim()) {
        sendJson(res, 400, { error: 'code and label are required' }); return true;
      }
      const normalizedCode = code.trim().toUpperCase();
      insertAccessCodeStmt.run(normalizedCode, label.trim(), maxUses ?? null, expiresAt ?? null, new Date().toISOString());
      sendJson(res, 200, { code: normalizedCode });
    } catch (err) {
      sendJson(res, 400, { error: err.message.includes('UNIQUE') ? 'that code already exists' : 'invalid request body' });
    }
    return true;
  }

  // ponytail: same no-SSH problem as the access-codes route above, for the
  // same reason — cleaning up test/seed data created directly against a
  // live deployment (e.g. via curl, the way this route itself was exercised)
  // with no filesystem access to the host to do it by hand. Deletes the
  // project, every child row keyed by project_id, and the matching
  // roadmaps-table funnel row (which has no project_id — it's a separate
  // funnel-tracking table — so it's matched by location+description+trade
  // instead) so /api/stats reflects the cleanup too.
  if (req.method === 'DELETE' && /^\/api\/admin\/projects\/[^/]+$/.test(req.url)) {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.headers['x-admin-secret'] !== secret) { sendJson(res, 404, { error: 'not found' }); return true; }
    const id = req.url.split('/')[4];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }

    for (const table of ['project_findings', 'project_costs', 'project_timeline_phases', 'project_tasks', 'project_documents', 'project_conversations', 'refund_claims', 'access_code_redemptions']) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    }
    db.prepare('DELETE FROM roadmaps WHERE location = ? AND description = ? AND trade = ?').run(project.location, project.description, project.trade);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    sendJson(res, 200, { deleted: id });
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

    let tier = 'full';
    let referralCode;
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.tier !== undefined) {
        if (!VALID_TIERS.includes(body.tier)) { sendJson(res, 400, { error: 'tier must be "roadmap" or "full"' }); return true; }
        tier = body.tier;
      }
      referralCode = typeof body.referralCode === 'string' ? body.referralCode.trim().toUpperCase() : undefined;
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
      return true;
    }

    // A referral code only ever applies to the full tier — it discounts the
    // $97 one-off down to $49, same destination price as the roadmap-only
    // tier, so there's nothing for it to discount on an already-$49 tier.
    let referralCodeRow;
    if (tier === 'full' && referralCode) {
      referralCodeRow = getReferralCodeStmt.get(referralCode);
      if (!referralCodeRow) { sendJson(res, 400, { error: 'invalid referral code' }); return true; }
      if (referralCodeRow.redeemed_project_id) { sendJson(res, 400, { error: 'this referral code has already been used' }); return true; }
      if (referralCodeRow.referrer_project_id === id) { sendJson(res, 400, { error: 'a referral code cannot be used on the project that generated it' }); return true; }
    }

    const sessionUser = getSessionUser(req);

    try {
      const origin = originFromRequest(req);
      const amountCents = priceCentsFor(tier, { sessionUser, referralCodeRow });
      const session = await createCheckoutSession({
        projectId: id,
        amountCents,
        label: `Setback — ${project.trade} permit ${tier === 'roadmap' ? 'roadmap' : 'workspace'}`,
        successUrl: `${origin}/?project=${encodeURIComponent(id)}&checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/?project=${encodeURIComponent(id)}`,
        metadata: { tier, referralCode: referralCodeRow ? referralCode : undefined }
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error('Stripe checkout session creation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't start checkout — try again in a moment." });
    }
    return true;
  }

  // Pack-credit unlock — an expediter who's prepaid for a $999/50-credit pack
  // skips Stripe entirely; this just spends one credit against whichever of
  // their packs is oldest (see getAvailablePackForUserStmt). Requires a
  // session (the pack belongs to an account, not a project), unlike the
  // access-code path above which is anonymous by design.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/redeem-pack-credit$/.test(req.url)) {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const id = req.url.split('/')[3];
    const sessionUser = getSessionUser(req);
    if (!sessionUser) { sendJson(res, 401, { error: 'sign in to use a pack credit' }); return true; }
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (project.paid) { sendJson(res, 200, projectRowToJson(project)); return true; }

    const pack = getAvailablePackForUserStmt.get(sessionUser.id);
    if (!pack) { sendJson(res, 400, { error: 'no available pack credits on this account' }); return true; }

    const now = new Date().toISOString();
    incrementPackCreditsUsedStmt.run(pack.id);
    markProjectPaidStmt.run('full', now, now, id);
    if (project.user_id === null) linkProjectToUserStmt.run(sessionUser.id, now, id);
    sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
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
      const tier = VALID_TIERS.includes(session.metadata?.tier) ? session.metadata.tier : 'full';
      markProjectPaidStmt.run(tier, now, now, id);

      // A referral code used at checkout gets consumed here, not at session
      // creation — someone abandoning checkout shouldn't burn a friend's
      // single-use code. Guarded by redeemed_project_id IS NULL in the SQL
      // itself, so a double-confirm (e.g. a retried request) can't redeem
      // the same code twice.
      if (session.metadata?.referralCode) {
        redeemReferralCodeStmt.run(id, now, session.metadata.referralCode);
      }

      // Full price, no subscription/referral discount applied — this buyer
      // becomes a referrer. amount_total (what Stripe actually charged) is
      // the source of truth here, not a re-derived price, since a
      // subscription could have lapsed between session creation and this
      // confirmation. A Stripe Promotion Code is minted alongside the local
      // code for dashboard visibility — if that call fails, the referral
      // still works (the local code is what's actually checked at
      // redemption), just without a Stripe-side record.
      if (tier === 'full' && session.amount_total === 9700) {
        const code = generateReferralCode();
        let promotionCodeId = null;
        try {
          const promotionCode = await createReferralPromotionCode({ referrerProjectId: id });
          promotionCodeId = promotionCode.id;
        } catch (err) {
          console.error('Stripe referral promotion code creation failed:', err.message);
        }
        insertReferralCodeStmt.run(code, id, promotionCodeId, now);
      }

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
