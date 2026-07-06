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
import { getProjectStmt, markProjectPaidStmt } from '../db.js';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const projectId = session.metadata?.projectId;
      const project = projectId && getProjectStmt.get(projectId);
      if (project && !project.paid && session.payment_status === 'paid') {
        const now = new Date().toISOString();
        markProjectPaidStmt.run(now, now, projectId);
      }
    }
    sendJson(res, 200, { received: true });
  } catch (err) {
    console.error('Stripe webhook handling failed:', err.message);
    sendJson(res, 400, { error: 'invalid payload' });
  }
  return true;
}
