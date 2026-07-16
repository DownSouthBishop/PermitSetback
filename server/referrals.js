// Referral code minting — shared by routes/checkout.js (a full-price
// purchase becomes a referrer) and routes/projects.js (answering the
// post-timeline outcome email becomes a referrer too). Lives in its own
// file rather than either route module so neither has to import the other.
import { randomInt } from 'node:crypto';
import { getReferralCodeByReferrerStmt, insertReferralCodeStmt } from './db.js';
import { createReferralPromotionCode } from './stripe.js';

// Shared out loud (emailed, texted to another contractor), so a short
// human-typeable alphabet rather than a UUID — no ambiguous characters
// (0/O, 1/I) since someone will be reading this off a screen to type it in.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateReferralCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  return code;
}

// Mints a referral code for a project, unless it already has one. A Stripe
// Promotion Code is minted alongside the local code for dashboard
// visibility; if that call fails, the referral still works (the local code
// is what's actually checked at redemption), just without a Stripe-side record.
export async function mintReferralCodeForProject(projectId) {
  if (getReferralCodeByReferrerStmt.get(projectId)) return;
  const code = generateReferralCode();
  let promotionCodeId = null;
  try {
    const promotionCode = await createReferralPromotionCode({ referrerProjectId: projectId });
    promotionCodeId = promotionCode.id;
  } catch (err) {
    console.error('Stripe referral promotion code creation failed:', err.message);
  }
  insertReferralCodeStmt.run(code, projectId, promotionCodeId, new Date().toISOString());
}
