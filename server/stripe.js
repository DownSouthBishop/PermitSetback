// Stripe integration — raw REST calls, no SDK. Matches how ai.js/llm.js call
// Anthropic and Gemini elsewhere in this app: this codebase deliberately has
// zero npm dependencies, and Stripe's REST API is stable and well-documented
// enough that the SDK isn't buying much for the two operations this needs
// (create a Checkout Session, verify one on return; webhook verification is
// a straightforward HMAC check, no SDK required for that either).
import crypto from 'node:crypto';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_API = 'https://api.stripe.com/v1';

// Stripe's API takes application/x-www-form-urlencoded with bracket
// notation for nested objects/arrays (e.g. line_items[0][quantity]=1) —
// this flattens a plain JS object into that shape so callers can build
// requests as normal nested objects instead of hand-writing bracket keys.
function toFormBody(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === 'object') parts.push(toFormBody(item, `${paramKey}[${i}]`));
        else parts.push(`${encodeURIComponent(`${paramKey}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof value === 'object') {
      parts.push(toFormBody(value, paramKey));
    } else {
      parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

async function stripeRequest(method, path, body) {
  if (!STRIPE_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      'authorization': `Bearer ${STRIPE_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: body ? toFormBody(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe returned ${res.status}`);
  return data;
}

// amountCents/label are decided server-side by the caller (never trust a
// client-supplied price) — see routes/projects.js for the intro-vs-regular
// pricing check this wraps. metadata.projectId is what the confirm step and
// the webhook use to tie a completed session back to the right project.
export async function createCheckoutSession({ projectId, amountCents, label, successUrl, cancelUrl, metadata }) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: { name: label }
      }
    }],
    metadata: { projectId, ...metadata },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

export async function retrieveCheckoutSession(sessionId) {
  return stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// ponytail: subscription Checkout supports an inline recurring price_data,
// same as the one-off session above — no need to pre-create and manage a
// persistent Price object for the $79/mo plan. subscription_data.metadata
// (not top-level metadata) is what Stripe copies onto the Subscription
// object itself, which is what the webhook's customer.subscription.* events
// carry — that's how it knows which user a given subscription belongs to.
//
// Launched at $79/mo, not $49 — this tier has never sold a single unit
// (verified against the real subscriptions table before repricing), so
// there's no existing subscriber to grandfather. $49 was a placeholder
// number in copy, never a tested price; there's no reason to launch a
// never-sold tier at a self-imposed discount off what expediters already
// pay a human for this same research.
export async function createSubscriptionCheckoutSession({ userId, successUrl, cancelUrl }) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: 7900,
        recurring: { interval: 'month' },
        product_data: { name: 'Setback — Contractor Membership' }
      }
    }],
    subscription_data: { metadata: { userId: String(userId) } },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

// Two prepaid pack sizes for expediters — Starter is the lower-commitment
// entry point, Bulk is the volume rate. Both are launch prices: this tier
// had zero real purchases (checked against pack_credits before repricing),
// so, same reasoning as the subscription above, there's no installed base
// to protect and no reason to under-price against a $500-2,500/job human
// expediter fee. Bulk's per-credit price is deliberately lower than
// Starter's (~$30 vs ~$37) — that gap is the one non-negotiable reason to
// buy the bigger pack instead of two Starters, not just "more credits."
export const PACK_SIZES = {
  starter: { credits: 15, amountCents: 54900, label: 'Setback — Expediter Starter Pack (15 roadmap credits)' },
  bulk: { credits: 50, amountCents: 149900, label: 'Setback — Expediter Pack (50 roadmap credits)' },
  // Contractor-tier pack (5 bid packets, $299) — same one-time-payment,
  // same pack_credits/redeem-pack-credit flow as the expediter sizes above,
  // just not white-label: see isWhiteLabelPack below. Priced against the
  // $97 single-packet rate (~$60/packet here), not against expediter volume.
  bid5: { credits: 5, amountCents: 29900, label: 'Setback — Bid Pack (5 bid packets)' }
};

// pack_credits has no "kind"/size column — unnecessary, since the three
// pack sizes (5/15/50 credits) are already numerically distinct. Used to
// tell a contractor's Bid Pack apart from an expediter pack wherever that
// matters: display labels here, and white-label eligibility in the print
// views (server/routes/documents.js) — a project unlocked from a
// starter/bulk credit is white-label, one unlocked from a bid5 credit
// always carries the Setback footer, same as a $97 single purchase.
export function packKindForCredits(creditsTotal) {
  const entry = Object.entries(PACK_SIZES).find(([, v]) => v.credits === creditsTotal);
  return entry ? entry[0] : 'bulk';
}
export function packLabelForCredits(creditsTotal) {
  return { starter: 'Expediter Starter', bulk: 'Expediter Bulk', bid5: 'Bid Pack' }[packKindForCredits(creditsTotal)];
}
export function isWhiteLabelPack(creditsTotal) {
  return packKindForCredits(creditsTotal) !== 'bid5';
}

// metadata.type is how the webhook tells this apart from a regular project
// payment (which keys off metadata.projectId instead); metadata.size is how
// it knows how many credits this particular session bought.
export async function createPackCheckoutSession({ userId, size, successUrl, cancelUrl }) {
  const pack = PACK_SIZES[size] || PACK_SIZES.bulk;
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: pack.amountCents,
        product_data: { name: pack.label }
      }
    }],
    metadata: { type: 'expediter_pack', userId: String(userId), size: size in PACK_SIZES ? size : 'bulk' },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

// A real Stripe Promotion Code for dashboard visibility/audit alongside the
// referral_codes row — the actual $49 price is still enforced server-side
// (routes/projects.js priceCentsFor reads referral_codes directly), so this
// is never applied at Checkout; it only needs to exist and be single-use.
export async function createReferralPromotionCode({ referrerProjectId }) {
  const coupon = await stripeRequest('POST', '/coupons', {
    amount_off: 4800,
    currency: 'usd',
    duration: 'once',
    max_redemptions: 1,
    metadata: { referrerProjectId }
  });
  return stripeRequest('POST', '/promotion_codes', {
    coupon: coupon.id,
    max_redemptions: 1,
    metadata: { referrerProjectId }
  });
}

// ponytail: cancel_at_period_end (grace-period cancel) rather than an
// immediate DELETE — a contractor who paid for the month keeps the $49 rate
// until it actually ends, which is what current_period_end on the
// subscriptions row is for. Swap to DELETE /subscriptions/:id if the product
// call is to cut access off immediately instead.
export async function cancelSubscription(stripeSubscriptionId) {
  return stripeRequest('POST', `/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, {
    cancel_at_period_end: true
  });
}

// Cancel-flow save offer: $24 off for 2 months (brings the $79/mo plan to
// $55/mo, ~30% off — the top of the "20-30% off, 2-3 months" sweet spot,
// not a 50%+ discount that trains people to cancel for deals) on an
// existing subscription. A fresh single-purpose coupon per call, same
// coupon-then-apply shape as createReferralPromotionCode above — there's no
// shared discount code to manage since each one only ever applies to the
// one subscription it was created for.
export async function applyRetentionDiscount(stripeSubscriptionId) {
  const coupon = await stripeRequest('POST', '/coupons', {
    amount_off: 2400,
    currency: 'usd',
    duration: 'repeating',
    duration_in_months: 2
  });
  return stripeRequest('POST', `/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, {
    coupon: coupon.id
  });
}

// Manual webhook signature check per Stripe's documented scheme: the
// Stripe-Signature header carries a timestamp and one or more v1 HMAC-SHA256
// signatures of "{timestamp}.{raw body}", keyed by the webhook's signing
// secret. No SDK needed — it's one HMAC comparison.
export function verifyWebhookSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  if (!timestamp || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  // timingSafeEqual throws (rather than returning false) on mismatched
  // buffer lengths — a malformed or tampered signature would otherwise
  // crash the request instead of just failing verification.
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(parts.v1);
  return expectedBuf.length === givenBuf.length && crypto.timingSafeEqual(expectedBuf, givenBuf);
}
