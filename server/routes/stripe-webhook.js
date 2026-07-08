// Stripe webhook — defense-in-depth alongside /confirm-checkout. The
// success-redirect path (routes/projects.js) already verifies payment
// directly against Stripe's API before marking a project paid, and that
// alone is a legitimate, secure confirmation — this webhook exists for the
// case a webhook exists to cover: someone completes payment but closes the
// tab (or their connection drops) before the redirect back completes.
//
// Needs STRIPE_WEBHOOK_SECRET, which only exists once a webhook endpoint is
// registered against a real public URL in the Stripe Dashboard (or via
// `stripe listen` locally) — this route no-ops safely without it rather
// than failing startup, since it isn't required for the core paywall to work.
import { readBody, sendJson } from '../http-utils.js';
import { verifyWebhookSignature } from '../stripe.js';
import {
  getProjectStmt, markProjectPaidStmt, db, getSubscriptionByStripeIdStmt,
  insertSubscriptionStmt, updateSubscriptionStatusStmt, insertPackCreditsStmt
} from '../db.js';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const getPackByStripeSessionStmt = db.prepare('SELECT id FROM pack_credits WHERE stripe_session_id = ?');

// Older and newer Stripe API versions nest the owning subscription id at a
// different path on an Invoice object — this covers both rather than
// pinning (and thus needing to track) one specific API version.
function subscriptionIdFromInvoice(invoice) {
  return invoice.subscription || invoice.parent?.subscription_details?.subscription || null;
}

export async function handleStripeWebhookRoutes(req, res) {
  if (req.method !== 'POST' || req.url !== '/api/stripe/webhook') return false;

  if (!WEBHOOK_SECRET) {
    console.warn('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set — ignoring.');
    sendJson(res, 503, { error: 'webhook not configured' });
    return true;
  }

  const rawBody = await readBody(req);
  const signature = req.headers['stripe-signature'];
  if (!verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
    sendJson(res, 400, { error: 'invalid signature' });
    return true;
  }

  try {
    const event = JSON.parse(rawBody);
    const sub = event.data.object;

    if (event.type === 'checkout.session.completed') {
      const projectId = sub.metadata?.projectId;
      const project = projectId && getProjectStmt.get(projectId);
      if (project && !project.paid && sub.payment_status === 'paid') {
        const now = new Date().toISOString();
        markProjectPaidStmt.run(sub.metadata?.tier || 'full', now, now, projectId);
      }
      // Expediter pack — the same one-time-payment confirmation as a
      // project, just keyed by session id instead of a project id since a
      // pack belongs to an account, not a project. See
      // routes/billing.js's confirm-checkout for the redirect-path twin of
      // this (same dedupe-by-session-id guard, for whichever gets there first).
      if (sub.metadata?.type === 'expediter_pack' && sub.payment_status === 'paid' && !getPackByStripeSessionStmt.get(sub.id)) {
        insertPackCreditsStmt.run(crypto.randomUUID(), sub.metadata.userId, sub.id, 50, new Date().toISOString());
      }
    }

    // Contractor $49/mo membership lifecycle. All three subscription events
    // carry the full Subscription object as event.data.object, so no extra
    // Stripe API round-trip is needed to get status/current_period_end.
    if (event.type === 'customer.subscription.created') {
      if (!getSubscriptionByStripeIdStmt.get(sub.id)) {
        const now = new Date().toISOString();
        insertSubscriptionStmt.run(crypto.randomUUID(), sub.metadata?.userId, sub.id, sub.status, new Date(sub.current_period_end * 1000).toISOString(), now, now);
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const existing = getSubscriptionByStripeIdStmt.get(sub.id);
      if (existing) {
        // Preserve whatever cancel_reason is already on the row (set by our
        // own /api/subscription/cancel endpoint) — stays null only if this
        // subscription was canceled some other way (e.g. Stripe Dashboard).
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
        updateSubscriptionStatusStmt.run(status, new Date(sub.current_period_end * 1000).toISOString(), existing.cancel_reason, new Date().toISOString(), sub.id);
      }
    }
    if (event.type === 'invoice.payment_failed') {
      const stripeSubscriptionId = subscriptionIdFromInvoice(sub);
      const existing = stripeSubscriptionId && getSubscriptionByStripeIdStmt.get(stripeSubscriptionId);
      if (existing) {
        updateSubscriptionStatusStmt.run('past_due', existing.current_period_end, existing.cancel_reason, new Date().toISOString(), stripeSubscriptionId);
      }
    }

    sendJson(res, 200, { received: true });
  } catch (err) {
    console.error('Stripe webhook handling failed:', err.message);
    sendJson(res, 400, { error: 'invalid payload' });
  }
  return true;
}
