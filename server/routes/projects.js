// Project persistence: GET /api/projects/:id, POST /api/projects/:id/outcome,
// POST /api/projects/:id/refund-claim.
//
// There used to be a POST /api/projects here that accepted a fully-formed
// roadmap (agencies/flags/risks/narrative/etc.) straight from the client and
// stored whatever it was given, unauthenticated and unrated-limited. It's
// gone — POST /api/roadmap (routes/legacy.js) creates the project server-side
// now, from a roadmap the server itself generated. Nothing accepts arbitrary
// roadmap content from a client anymore.
//
// Every unlock mechanism (access-code redeem, Stripe checkout, pack-credit
// redemption) lives in routes/checkout.js instead — this file used to carry
// all of it plus the ADMIN_SECRET-gated admin routes (now routes/admin.js)
// for unrelated reasons.
import { readBody, sendJson, checkGenerousRateLimit, requirePaid } from '../http-utils.js';
import { getProjectStmt, updateProjectOutcomeStmt, insertOutcome, insertRefundClaimStmt, getReferralCodeByReferrerStmt, updateProjectBrandingStmt, getPackCreditsByIdStmt } from '../db.js';
import { isWhiteLabelPack } from '../stripe.js';

// White-label is an expediter Starter/Bulk pack entitlement, determined
// here from unlocked_via_pack_id (set once, at redemption time — see
// routes/checkout.js) — never from anything the client sends. Every
// non-pack unlock (direct $49/$97/$299 purchase, access code, referral
// code) is null here and therefore never white-label.
function isProjectWhiteLabel(row) {
  if (!row.unlocked_via_pack_id) return false;
  const pack = getPackCreditsByIdStmt.get(row.unlocked_via_pack_id);
  return !!pack && isWhiteLabelPack(pack.credits_total);
}

export function projectRowToJson(row) {
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
    companyName: row.company_name,
    companyContact: row.company_contact,
    companyLogoUrl: row.company_logo_url,
    whiteLabel: isProjectWhiteLabel(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// http/https only — this gets rendered as an <img src> on the Client Packet
// print view (Phase 2.2), so anything else (javascript:, data:, etc.) is
// rejected outright rather than merely escaped.
function isValidLogoUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
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
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/outcome$/.test(req.url)) {
    if (checkGenerousRateLimit(res, ip)) return true;
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
    if (checkGenerousRateLimit(res, ip)) return true;
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

  // Client Packet branding — full-tier only, same as the print views it
  // feeds (Phase 2.2). Revisable anytime, not a one-shot grant, so this is
  // a plain update rather than the atomic-guard pattern payment/entitlement
  // writes elsewhere in this file use.
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/branding$/.test(req.url)) {
    if (checkGenerousRateLimit(res, ip)) return true;
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (requirePaid(res, project)) return true;
    try {
      const { companyName, companyContact, companyLogoUrl } = JSON.parse((await readBody(req)) || '{}');
      const logoUrl = (companyLogoUrl || '').trim();
      if (logoUrl && !isValidLogoUrl(logoUrl)) {
        sendJson(res, 400, { error: 'logo URL must be a valid http:// or https:// link' });
        return true;
      }
      const now = new Date().toISOString();
      updateProjectBrandingStmt.run(
        (companyName || '').trim().slice(0, 200) || null,
        (companyContact || '').trim().slice(0, 200) || null,
        logoUrl || null,
        now, id
      );
      sendJson(res, 200, projectRowToJson(getProjectStmt.get(id)));
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
