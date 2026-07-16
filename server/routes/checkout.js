// Project-scoped payment paths: access-code redeem, real Stripe checkout
// (create-checkout-session / confirm-checkout), and pack-credit redemption.
// Split out of projects.js, which had accumulated project CRUD and every
// unlock mechanism together for unrelated reasons. Account-scoped billing
// (subscriptions, the expediter pack purchase itself) stays in billing.js.
import { randomInt } from 'node:crypto';
import { readBody, sendJson, checkRateLimit, originFromRequest } from '../http-utils.js';
import {
  getProjectStmt, markProjectPaidStmt,
  getAccessCodeStmt, incrementAccessCodeUsesStmt, insertAccessCodeRedemptionStmt,
  getActiveSubscriptionByUserStmt, getReferralCodeStmt, redeemReferralCodeStmt,
  insertReferralCodeStmt, getAvailablePackForUserStmt, incrementPackCreditsUsedStmt,
  linkProjectToUserStmt, getPartnerCodeStmt, insertPartnerRedemptionStmt, setProjectPackSourceStmt
} from '../db.js';
import { createCheckoutSession, retrieveCheckoutSession, createReferralPromotionCode } from '../stripe.js';
import { getSessionUser } from './auth.js';
import { projectRowToJson } from './projects.js';
import { pregenerateFullWorkspace } from '../pregenerate.js';

const VALID_TIERS = ['roadmap', 'full'];

// The pricing ladder (see server/db.js's pricing-overhaul comment for the
// tables this reads): $49 roadmap-only, $97 full workspace one-off, $49
// full workspace for an active subscriber or a valid unredeemed referral
// code. Pack credits (expediter Starter/Bulk packs) skip this entirely — they're
// consumed directly via POST /redeem-pack-credit, never through Stripe
// checkout, since they're already paid for.
function priceCentsFor(tier, { sessionUser, referralCodeRow, partnerCodeRow }) {
  if (tier === 'roadmap') return partnerCodeRow ? partnerCodeRow.price_cents : 4900;
  if (sessionUser && getActiveSubscriptionByUserStmt.get(sessionUser.id)) return 4900;
  if (referralCodeRow && !referralCodeRow.redeemed_project_id) return 4900;
  return 9700;
}

// Upgrading a project already paid at the Roadmap tier ($49) to Full
// Workspace only ever charges the $48 difference from the standard $97 —
// unless the buyer's subscription or referral code already prices Full
// Workspace at the same $49 they already paid for Roadmap, in which case
// there's nothing left to charge (an active subscriber or valid referral
// code holder never had a reason to buy Roadmap-only in the first place,
// since both tiers cost them the same $49).
function upgradePriceCentsFor({ sessionUser, referralCodeRow }) {
  const alreadyAtFullRate = (sessionUser && getActiveSubscriptionByUserStmt.get(sessionUser.id))
    || (referralCodeRow && !referralCodeRow.redeemed_project_id);
  return alreadyAtFullRate ? 0 : 4800;
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

// Returns true if this module handled the request (response already sent),
// false if the caller should try the next route module.
export async function handleCheckoutRoutes(req, res, ip) {
  // Access-code unlock — a permanent second door alongside the real Stripe
  // checkout flow, for beta testers and the founder.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/redeem$/.test(req.url)) {
    if (checkRateLimit(res, ip)) return true;
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

      // This check above is a fast-path, not the real gate — two concurrent
      // redemptions of a max_uses:1 code could otherwise both pass it before
      // either writes. incrementAccessCodeUsesStmt's own WHERE clause
      // (db.js) is the real, atomic gate; .changes tells us whether *this*
      // request actually won the redemption or lost a race that happened
      // between the check above and here.
      const result = incrementAccessCodeUsesStmt.run(normalizedCode);
      if (result.changes === 0) {
        sendJson(res, 400, { error: 'this access code has reached its use limit' }); return true;
      }

      const now = new Date().toISOString();
      if (!project.paid) markProjectPaidStmt.run('full', now, now, id);
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
    if (checkRateLimit(res, ip)) return true;
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }

    // A Roadmap-tier project is "paid" but not done — it's the one paid
    // state that can still buy something more (the $48 upgrade to Full
    // Workspace below). Anything else already paid has nothing left to sell.
    const isRoadmapUpgrade = project.paid && project.tier === 'roadmap';
    if (project.paid && !isRoadmapUpgrade) { sendJson(res, 200, projectRowToJson(project)); return true; }

    let tier = 'full';
    let referralCode;
    let partnerCode;
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.tier !== undefined) {
        if (!VALID_TIERS.includes(body.tier)) { sendJson(res, 400, { error: 'tier must be "roadmap" or "full"' }); return true; }
        tier = body.tier;
      }
      referralCode = typeof body.referralCode === 'string' ? body.referralCode.trim().toUpperCase() : undefined;
      partnerCode = typeof body.partnerCode === 'string' ? body.partnerCode.trim().toUpperCase() : undefined;
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
      return true;
    }

    if (isRoadmapUpgrade && tier !== 'full') {
      sendJson(res, 400, { error: "This project is already unlocked at the Roadmap tier — pass tier: \"full\" to upgrade to the Full Workspace." });
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

    // A partner code (e.g. HORSEPOWER) is the mirror image of a referral
    // code — it only ever applies to the roadmap tier, at whatever flat
    // price_cents it was minted with (see server/create-partner-code.js).
    let partnerCodeRow;
    if (tier === 'roadmap' && partnerCode) {
      partnerCodeRow = getPartnerCodeStmt.get(partnerCode);
      if (!partnerCodeRow) { sendJson(res, 400, { error: 'invalid partner code' }); return true; }
    }

    const sessionUser = getSessionUser(req);

    if (isRoadmapUpgrade) {
      const upgradeCents = upgradePriceCentsFor({ sessionUser, referralCodeRow });
      // Already paid the full-tier rate via the Roadmap purchase (an active
      // subscriber or referral-code holder) — unlock directly, same as the
      // access-code/pack-credit paths, no $0 Stripe session to create.
      if (upgradeCents === 0) {
        const now = new Date().toISOString();
        markProjectPaidStmt.run('full', now, now, id);
        if (referralCodeRow) redeemReferralCodeStmt.run(id, now, referralCode);
        sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
        return true;
      }
      try {
        const origin = originFromRequest(req);
        const session = await createCheckoutSession({
          projectId: id,
          amountCents: upgradeCents,
          label: `Setback — ${project.trade} permit workspace upgrade (Roadmap to Full)`,
          successUrl: `${origin}/?project=${encodeURIComponent(id)}&checkout_session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}/?project=${encodeURIComponent(id)}`,
          metadata: { tier: 'full', referralCode: referralCodeRow ? referralCode : undefined }
        });
        sendJson(res, 200, { url: session.url });
      } catch (err) {
        console.error('Stripe checkout session creation failed:', err.message);
        sendJson(res, 502, { error: "Couldn't start checkout — try again in a moment." });
      }
      return true;
    }

    try {
      const origin = originFromRequest(req);
      const amountCents = priceCentsFor(tier, { sessionUser, referralCodeRow, partnerCodeRow });
      const session = await createCheckoutSession({
        projectId: id,
        amountCents,
        label: `Setback — ${project.trade} permit ${tier === 'roadmap' ? 'roadmap' : 'workspace'}`,
        successUrl: `${origin}/?project=${encodeURIComponent(id)}&checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/?project=${encodeURIComponent(id)}`,
        metadata: { tier, referralCode: referralCodeRow ? referralCode : undefined, partnerCode: partnerCodeRow ? partnerCode : undefined }
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error('Stripe checkout session creation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't start checkout — try again in a moment." });
    }
    return true;
  }

  // Pack-credit unlock — an expediter who's prepaid for a Starter/Bulk pack
  // skips Stripe entirely; this just spends one credit against whichever of
  // their packs is oldest (see getAvailablePackForUserStmt). Requires a
  // session (the pack belongs to an account, not a project), unlike the
  // access-code path above which is anonymous by design.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/redeem-pack-credit$/.test(req.url)) {
    if (checkRateLimit(res, ip)) return true;
    const id = req.url.split('/')[3];
    const sessionUser = getSessionUser(req);
    if (!sessionUser) { sendJson(res, 401, { error: 'sign in to use a pack credit' }); return true; }
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (project.paid) { sendJson(res, 200, projectRowToJson(project)); return true; }

    const pack = getAvailablePackForUserStmt.get(sessionUser.id);
    if (!pack) { sendJson(res, 400, { error: 'no available pack credits on this account' }); return true; }

    // The SELECT above is a fast-path, not the real gate — two concurrent
    // unlocks against the same account's last remaining credit could both
    // pass it before either writes. incrementPackCreditsUsedStmt's own
    // credits_used < credits_total guard (db.js) is the real, atomic gate.
    const result = incrementPackCreditsUsedStmt.run(pack.id);
    if (result.changes === 0) {
      sendJson(res, 400, { error: 'no available pack credits on this account' }); return true;
    }

    const now = new Date().toISOString();
    markProjectPaidStmt.run('full', now, now, id);
    setProjectPackSourceStmt.run(pack.id, id);
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
    // A Roadmap-tier project falls through here rather than short-circuiting
    // — it's the one paid state with a pending purchase left to confirm (the
    // Roadmap-to-Full upgrade session created above).
    if (project.paid && project.tier === 'full') { sendJson(res, 200, projectRowToJson(project)); return true; }
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
      // Fire every module's generator now instead of making the buyer wait
      // per-tab after they've already paid — fire-and-forget, never awaited
      // here (see server/pregenerate.js).
      if (tier === 'full') pregenerateFullWorkspace(project);

      // A referral code used at checkout gets consumed here, not at session
      // creation — someone abandoning checkout shouldn't burn a friend's
      // single-use code. Guarded by redeemed_project_id IS NULL in the SQL
      // itself, so a double-confirm (e.g. a retried request) can't redeem
      // the same code twice.
      if (session.metadata?.referralCode) {
        redeemReferralCodeStmt.run(id, now, session.metadata.referralCode);
      }

      // Partner-code redemption (e.g. HORSEPOWER) — logged for
      // partner-report.js to trace forward to the account and check
      // subscription tenure against the referrer's equity KPI.
      if (session.metadata?.partnerCode) {
        insertPartnerRedemptionStmt.run(crypto.randomUUID(), session.metadata.partnerCode, id, now);
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

  return false;
}
