// Subscription + expediter-pack billing: create-checkout-session/confirm for
// each, and cancel-subscription. Project-scoped one-off checkout (and the
// referral mechanic) stays in routes/projects.js — these two live here
// because they're account-scoped (a user, not a project).
import { readBody, sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';
import {
  db, insertSubscriptionStmt, getActiveSubscriptionByUserStmt, getSubscriptionByStripeIdStmt,
  updateSubscriptionStatusStmt, insertPackCreditsStmt
} from '../db.js';
import { createSubscriptionCheckoutSession, createPackCheckoutSession, retrieveCheckoutSession, cancelSubscription } from '../stripe.js';
import { getSessionUser } from './auth.js';

const VALID_CANCEL_REASONS = ['too_expensive', 'not_enough_volume', 'other'];

// Ad hoc — pack_credits allows multiple rows per user (see db.js), so
// there's no single boolean like projects.paid to short-circuit a repeat
// confirm on the same Checkout Session; this is what does that instead.
const getPackByStripeSessionStmt = db.prepare('SELECT id FROM pack_credits WHERE stripe_session_id = ?');

function originFromRequest(req) {
  const proto = req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

export async function handleBillingRoutes(req, res, ip) {
  if (req.method === 'POST' && req.url === '/api/subscription/create-checkout-session') {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'sign in to subscribe' }); return true; }
    try {
      const origin = originFromRequest(req);
      const session = await createSubscriptionCheckoutSession({
        userId: user.id,
        successUrl: `${origin}/?checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/`
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error('Stripe subscription checkout session creation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't start checkout — try again in a moment." });
    }
    return true;
  }

  const [confirmSubPath, confirmSubQs] = req.url.split('?');
  if (req.method === 'GET' && confirmSubPath === '/api/subscription/confirm-checkout') {
    const sessionId = new URLSearchParams(confirmSubQs || '').get('session_id');
    if (!sessionId) { sendJson(res, 400, { error: 'missing session_id' }); return true; }
    try {
      const session = await retrieveCheckoutSession(sessionId);
      if (session.mode !== 'subscription' || !session.subscription) {
        sendJson(res, 402, { error: 'subscription not confirmed' });
        return true;
      }
      // Full details (status, current_period_end) arrive via the
      // customer.subscription.created webhook, which may well land before
      // this request does — insert only if that hasn't already happened.
      if (!getSubscriptionByStripeIdStmt.get(session.subscription)) {
        const now = new Date().toISOString();
        insertSubscriptionStmt.run(crypto.randomUUID(), session.metadata?.userId, session.subscription, 'active', null, now, now);
      }
      sendJson(res, 200, { subscribed: true });
    } catch (err) {
      console.error('Stripe subscription confirmation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't confirm subscription — try again in a moment." });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/subscription/cancel') {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'not authenticated' }); return true; }
    const subscription = getActiveSubscriptionByUserStmt.get(user.id);
    if (!subscription) { sendJson(res, 404, { error: 'no active subscription on this account' }); return true; }
    try {
      const { reason } = JSON.parse((await readBody(req)) || '{}');
      if (!VALID_CANCEL_REASONS.includes(reason)) {
        sendJson(res, 400, { error: `reason must be one of: ${VALID_CANCEL_REASONS.join(', ')}` });
        return true;
      }
      await cancelSubscription(subscription.stripe_subscription_id);
      updateSubscriptionStatusStmt.run(subscription.status, subscription.current_period_end, reason, new Date().toISOString(), subscription.stripe_subscription_id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof SyntaxError) { sendJson(res, 400, { error: 'invalid request body' }); return true; }
      console.error('Stripe subscription cancellation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't cancel — try again in a moment." });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/expediter-pack/create-checkout-session') {
    if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }
    const user = getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'sign in to buy a pack' }); return true; }
    try {
      const origin = originFromRequest(req);
      const session = await createPackCheckoutSession({
        userId: user.id,
        successUrl: `${origin}/?checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/`
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error('Stripe pack checkout session creation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't start checkout — try again in a moment." });
    }
    return true;
  }

  const [confirmPackPath, confirmPackQs] = req.url.split('?');
  if (req.method === 'GET' && confirmPackPath === '/api/expediter-pack/confirm-checkout') {
    const sessionId = new URLSearchParams(confirmPackQs || '').get('session_id');
    if (!sessionId) { sendJson(res, 400, { error: 'missing session_id' }); return true; }
    try {
      const session = await retrieveCheckoutSession(sessionId);
      if (session.payment_status !== 'paid' || session.metadata?.type !== 'expediter_pack') {
        sendJson(res, 402, { error: 'payment not confirmed' });
        return true;
      }
      if (!getPackByStripeSessionStmt.get(sessionId)) {
        insertPackCreditsStmt.run(crypto.randomUUID(), session.metadata.userId, sessionId, 50, new Date().toISOString());
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('Stripe pack confirmation failed:', err.message);
      sendJson(res, 502, { error: "Couldn't confirm payment — try again in a moment." });
    }
    return true;
  }

  return false;
}
