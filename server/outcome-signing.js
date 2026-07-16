// Signs the four outcome-report links in the post-timeline email (Appendix
// A §6.4) so a click is provably a reply to a link this server actually
// sent, not just a guessed project id + outcome value — those links also
// grant a referral code, which is a real incentive to spam without this.
import crypto from 'node:crypto';

const SECRET = process.env.OUTCOME_SIGNING_SECRET;

export function signOutcome(projectId, outcome) {
  if (!SECRET) throw new Error('OUTCOME_SIGNING_SECRET is not set');
  return crypto.createHmac('sha256', SECRET).update(`${projectId}:${outcome}`).digest('hex');
}

export function verifyOutcomeSignature(projectId, outcome, signature) {
  if (!SECRET || !signature) return false;
  const expected = signOutcome(projectId, outcome);
  // timingSafeEqual throws on mismatched buffer lengths — a malformed
  // signature would otherwise crash the request instead of just failing
  // verification (same reasoning as stripe.js's verifyWebhookSignature).
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signature);
  return expectedBuf.length === givenBuf.length && crypto.timingSafeEqual(expectedBuf, givenBuf);
}
