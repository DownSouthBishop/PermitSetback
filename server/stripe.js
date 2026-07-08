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
// persistent Price object for the $49/mo plan. subscription_data.metadata
// (not top-level metadata) is what Stripe copies onto the Subscription
// object itself, which is what the webhook's customer.subscription.* events
// carry — that's how it knows which user a given subscription belongs to.
export async function createSubscriptionCheckoutSession({ userId, successUrl, cancelUrl }) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: 4900,
        recurring: { interval: 'month' },
        product_data: { name: 'Setback — Contractor Membership' }
      }
    }],
    subscription_data: { metadata: { userId: String(userId) } },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
}

// $999 one-time purchase of 50 full-workspace credits. metadata.type is how
// the webhook tells this apart from a regular project payment (which keys
// off metadata.projectId instead).
export async function createPackCheckoutSession({ userId, successUrl, cancelUrl }) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: 99900,
        product_data: { name: 'Setback — Expediter Pack (50 roadmap credits)' }
      }
    }],
    metadata: { type: 'expediter_pack', userId: String(userId) },
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
