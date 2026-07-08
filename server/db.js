// Persistence layer — SQLite via node:sqlite. Every generated roadmap, every
// outcome report, every Project, and basic funnel events land here.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Overridable so tests (and any future parallel worker) can point at a throwaway
// file instead of the real dev/production data.db, and so a real deployment
// can point it at a mounted volume (e.g. Railway) instead of the app's own
// source directory, which doesn't persist across deploys.
const DB_PATH = process.env.SETBACK_DB_PATH || join(__dirname, 'data.db');
// SQLite creates the database *file* itself if missing, but not the
// directory it lives in — on a freshly attached, never-before-written
// volume that directory may not exist yet, which surfaced as a bare
// "unable to open database file" with no indication why.
mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS roadmaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    trade TEXT NOT NULL DEFAULT 'other',
    provider TEXT NOT NULL,
    unrecognized INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    trade TEXT NOT NULL DEFAULT 'other',
    outcome TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    properties TEXT
  );
  -- Written only by the offline learning job (learn.js), read cheaply here
  -- on the live request path. The live path never calls an LLM to produce
  -- this — it's precomputed, so a busy hot path never pays for it.
  CREATE TABLE IF NOT EXISTS insights (
    location TEXT NOT NULL,
    trade TEXT NOT NULL,
    report_count INTEGER NOT NULL,
    approved_pct REAL NOT NULL,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (location, trade)
  );

  -- A generated roadmap becomes a durable Project once persisted, so a
  -- customer can come back to what they paid for instead of losing it on
  -- refresh. user_id starts NULL — a project is created before any account
  -- exists, and gets attached to a user only once they capture an email.
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    trade TEXT NOT NULL,
    provider TEXT NOT NULL,
    agencies TEXT NOT NULL,
    flags TEXT NOT NULL,
    risks TEXT NOT NULL,
    timeline TEXT NOT NULL,
    timeline_note TEXT NOT NULL,
    narrative TEXT NOT NULL,
    outcome_status TEXT,
    outcome_reported_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  -- One-time login tokens. project_id carries a project through the
  -- request-link -> verify round trip so it can be attached to the user as
  -- soon as the account exists, without the frontend having to make a
  -- second call.
  CREATE TABLE IF NOT EXISTS magic_links (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    project_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Child tables for the platform vision (SETBACK VISION 1.0) — everything
  -- keys off project_id so each module owns its own table and its own
  -- track can build without touching another module's rows.

  -- Feasibility Intelligence and Risk Intelligence share this shape (a
  -- labeled concern with likelihood/impact/priority/mitigation/confidence);
  -- category tells them apart so the two modules never collide on a row.
  CREATE TABLE IF NOT EXISTS project_findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL,
    likelihood TEXT,
    impact TEXT,
    priority TEXT,
    mitigation TEXT,
    confidence TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Cost Intelligence line items.
  CREATE TABLE IF NOT EXISTS project_costs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    category TEXT NOT NULL,
    low_estimate REAL,
    high_estimate REAL,
    note TEXT,
    created_at TEXT NOT NULL
  );

  -- Timeline Intelligence phases (feasibility -> design -> ... -> completion).
  CREATE TABLE IF NOT EXISTS project_timeline_phases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    estimated_duration TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    is_bottleneck INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL
  );

  -- Task Center. source_id identifies which underlying finding/flag a task
  -- was derived from (e.g. "flag:2", "risk:<finding-id>") so re-syncing on
  -- every view doesn't insert duplicates for the same concern. NULL for
  -- tasks that aren't tied to a specific finding.
  CREATE TABLE IF NOT EXISTS project_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_id TEXT,
    title TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Documents module — multiple generated document types per project.
  CREATE TABLE IF NOT EXISTS project_documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- AI Advisor conversation history, so a project's chat has memory instead
  -- of regenerating identical work on every question.
  CREATE TABLE IF NOT EXISTS project_conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Access codes: an unlock path independent of payment, for beta testers
  -- and the founder. max_uses NULL means unlimited; expires_at NULL means
  -- never expires. This stays alongside whatever real payment integration
  -- comes later — codes are a permanent second door, not a temporary hack.
  CREATE TABLE IF NOT EXISTS access_codes (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    max_uses INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  -- One row per redemption, so it's visible which code unlocked which
  -- project (and by extension, which beta tester did what).
  CREATE TABLE IF NOT EXISTS access_code_redemptions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    project_id TEXT NOT NULL,
    redeemed_at TEXT NOT NULL
  );

  -- Real per-call token usage and $ cost, one row per LLM call. This is what
  -- turns "what does a roadmap actually cost us" from a guess into a number
  -- you can query — see server/pricing.js for the rate table and
  -- server/routes/admin-usage.js for the report built on top of this.
  -- The refund guarantee ("send us the rejection notice... that's the whole
  -- process") had no destination anywhere in the product before this — a
  -- real gap between what's promised and what's buildable. This is that
  -- destination: a real capture point, reviewed manually by the founder
  -- (server/refund-claims.js), not an auto-processed refund — there's no
  -- real payment processor wired up yet for this to auto-process against.
  CREATE TABLE IF NOT EXISTS refund_claims (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    details TEXT NOT NULL,
    contact_email TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_usage_log (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    call_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL,
    created_at TEXT NOT NULL
  );

  -- Pricing overhaul (SETBACK VISION 1.0 pricing ladder): one-off tier,
  -- contractor subscription, expediter pack, referral codes. See
  -- server/routes/projects.js priceCentsFor() for how these combine into
  -- what a given user actually pays.

  -- Recurring $79/mo contractor membership. One active row per user; history
  -- of past subscriptions kept (status transitions to 'canceled'/'past_due'
  -- rather than deleting) so cancel-flow analysis has something to look at.
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stripe_subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_end TEXT,
    cancel_reason TEXT,
    retention_offer_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Expediter pack: one row per prepaid-pack purchase, Starter ($549/15) or
  -- Bulk ($1,499/50) — see server/stripe.js's PACK_SIZES for current pricing.
  -- credits_used is incremented as the firm unlocks projects against this
  -- pack instead of paying one-off; a firm can hold more than one pack over
  -- time (buys a second pack once the first is spent, or a different size),
  -- hence a table of purchases rather than a single counter on the user row.
  CREATE TABLE IF NOT EXISTS pack_credits (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stripe_session_id TEXT NOT NULL,
    credits_total INTEGER NOT NULL,
    credits_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_credits_session ON pack_credits(stripe_session_id);

  -- Referral codes: minted after a $97 full-tier purchase, redeemable once
  -- by a different project for the full tier at $49. redeemed_project_id
  -- stays NULL until used.
  CREATE TABLE IF NOT EXISTS referral_codes (
    code TEXT PRIMARY KEY,
    referrer_project_id TEXT NOT NULL,
    stripe_promotion_code_id TEXT,
    redeemed_project_id TEXT,
    created_at TEXT NOT NULL,
    redeemed_at TEXT
  );

  -- Partner codes: a standing discount code (e.g. HORSEPOWER) tied to an
  -- equity/affiliate arrangement, unlike referral_codes above which are
  -- single-use and minted per-purchase. price_cents is what tier costs when
  -- this code is applied at checkout. Reusable by design — partner_redemptions
  -- below is what lets us count how many people actually came through it.
  CREATE TABLE IF NOT EXISTS partner_codes (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    tier TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  -- One row per redemption, so partner-report.js can trace each one forward
  -- to the account and check subscription tenure against the KPI.
  CREATE TABLE IF NOT EXISTS partner_redemptions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    project_id TEXT NOT NULL,
    redeemed_at TEXT NOT NULL
  );

  -- One row per user, tracking the last "needs attention" digest computed
  -- for them (attention-digest.js). items_hash is a cheap fingerprint of
  -- the last-seen attention items — the digest pass only logs (eventually:
  -- emails) again when this changes, so an unresolved issue doesn't
  -- re-notify on every scheduled tick.
  CREATE TABLE IF NOT EXISTS attention_digests (
    user_id INTEGER PRIMARY KEY,
    items_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Schema evolves via additive, idempotent statements rather than a migration
// runner — the whole schema still fits on one screen. Revisit with a real
// migrations table if this list gets much longer than this.
for (const stmt of [
  // Older data.db files predate the trade column.
  "ALTER TABLE roadmaps ADD COLUMN trade TEXT NOT NULL DEFAULT 'other'",
  "ALTER TABLE outcomes ADD COLUMN trade TEXT NOT NULL DEFAULT 'other'",
  // Generic JSON bucket for roadmap-response fields added after the initial
  // agencies/flags/risks/timeline/narrative shape (e.g. cost estimate,
  // timeline breakdown, next actions) — avoids a fresh ALTER TABLE for every
  // new field a future roadmap-intelligence extension adds.
  "ALTER TABLE projects ADD COLUMN extra TEXT",
  // Project Overview fields — nullable until the Overview track (or a
  // future scoring pass) actually computes them.
  "ALTER TABLE projects ADD COLUMN name TEXT",
  "ALTER TABLE projects ADD COLUMN status TEXT",
  "ALTER TABLE projects ADD COLUMN confidence_score INTEGER",
  "ALTER TABLE projects ADD COLUMN risk_score INTEGER",
  // Paywall gate: the full roadmap (agencies/flags/risks/narrative) is only
  // ever returned once paid = 1. Every project starts unpaid.
  "ALTER TABLE projects ADD COLUMN paid INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE projects ADD COLUMN paid_at TEXT",
  // Task Center dedup key — see project_tasks CREATE TABLE comment above.
  "ALTER TABLE project_tasks ADD COLUMN source_id TEXT",
  // Which paywall level this project unlocked at — 'roadmap' ($49) or
  // 'full' ($97, or $49 via subscription/referral/pack credit). NULL until
  // paid = 1. Projects paid before this column existed are backfilled as
  // 'full' below, since the all-or-nothing paywall only ever unlocked
  // everything.
  "ALTER TABLE projects ADD COLUMN tier TEXT",
  // Guards the cancel-flow save offer (routes/billing.js) against being
  // granted more than once per subscription — without this, repeatedly
  // opening the cancel flow and accepting the offer each time would stack
  // discounted months indefinitely.
  "ALTER TABLE subscriptions ADD COLUMN retention_offer_used_at TEXT"
]) {
  try { db.exec(stmt); } catch (err) { /* column already exists — fine */ }
}

// One-time backfill, safe to run on every boot: any project paid before the
// tier column existed was paid under the old all-or-nothing paywall, which
// only ever unlocked the full workspace — so it's unambiguously 'full', not
// a guess.
db.exec("UPDATE projects SET tier = 'full' WHERE paid = 1 AND tier IS NULL");

// Both the redirect-confirm path and the webhook independently try to
// credit the same expediter-pack purchase (defense-in-depth against a
// closed tab — see routes/billing.js), each guarding with a plain SELECT
// first. Two near-simultaneous requests can both pass that SELECT before
// either INSERTs, granting double credits for one pack charge. This index
// turns the second INSERT into a rejected constraint violation instead.
// Wrapped like the ALTER TABLEs above rather than in the main schema
// block: if a duplicate stripe_session_id somehow already existed, CREATE
// UNIQUE INDEX would fail every boot and take the whole app down with it.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_credits_session ON pack_credits(stripe_session_id)');
} catch (err) {
  console.error('[db] Could not create idx_pack_credits_session — check pack_credits for duplicate stripe_session_id values:', err.message);
}

export const insertRoadmap = db.prepare(
  'INSERT INTO roadmaps (created_at, location, description, trade, provider, unrecognized) VALUES (?, ?, ?, ?, ?, ?)'
);
export const insertOutcome = db.prepare(
  'INSERT INTO outcomes (created_at, location, description, trade, outcome) VALUES (?, ?, ?, ?, ?)'
);
export const insertEvent = db.prepare(
  'INSERT INTO events (created_at, name, properties) VALUES (?, ?, ?)'
);
// Case-insensitive on location — real users type "Broward County, Florida"
// and "broward county, florida" for the same place, and an exact-match
// lookup would silently miss the insight for one of them.
export const getInsightStmt = db.prepare('SELECT summary, report_count FROM insights WHERE LOWER(location) = LOWER(?) AND trade = ?');

// --- projects + accounts -------------------------------------------------
// paid starts 0 (schema default) — a project is created the moment a roadmap
// is generated, before any payment, so the row exists to gate.
export const insertProject = db.prepare(`
  INSERT INTO projects (id, user_id, location, description, trade, provider, agencies, flags, risks, timeline, timeline_note, narrative, extra, created_at, updated_at)
  VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
export const updateProjectOutcomeStmt = db.prepare('UPDATE projects SET outcome_status = ?, outcome_reported_at = ?, updated_at = ? WHERE id = ?');
// Only ever called after confirming the project is currently unclaimed
// (user_id IS NULL) — see routes/auth.js. Guards against a known project id
// being used to reassign an already-claimed project to a different account.
export const linkProjectToUserStmt = db.prepare('UPDATE projects SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS NULL');
// Flips paid on a project and records which paywall tier it was paid at
// ('roadmap' or 'full') — see routes/projects.js priceCentsFor() for how
// tier is decided, and the pricing-ladder comment in db.js's CREATE TABLE
// block for the tables this interacts with (subscriptions, pack_credits,
// referral_codes).
export const markProjectPaidStmt = db.prepare(`UPDATE projects SET paid = 1, tier = ?, paid_at = ?, updated_at = ? WHERE id = ?`);

// --- access codes ---------------------------------------------------------
export const getAccessCodeStmt = db.prepare('SELECT * FROM access_codes WHERE code = ?');
export const insertAccessCodeStmt = db.prepare(`
  INSERT INTO access_codes (code, label, max_uses, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
// The WHERE guard makes this the one statement that decides whether a
// redemption is allowed, not a separate read-then-write — two concurrent
// redemptions of a max_uses:1 code can otherwise both pass an earlier
// SELECT-based check before either writes. Callers check .changes to know
// whether their redemption actually won (0 means the code was already
// exhausted, possibly by a request that arrived a moment earlier).
export const incrementAccessCodeUsesStmt = db.prepare(
  'UPDATE access_codes SET uses_count = uses_count + 1 WHERE code = ? AND (max_uses IS NULL OR uses_count < max_uses)'
);
export const insertAccessCodeRedemptionStmt = db.prepare(`
  INSERT INTO access_code_redemptions (id, code, project_id, redeemed_at)
  VALUES (?, ?, ?, ?)
`);
export const listAccessCodesStmt = db.prepare('SELECT * FROM access_codes ORDER BY created_at DESC');
export const getProjectsByUserStmt = db.prepare(`
  SELECT id, location, description, trade, outcome_status, created_at, paid, tier
  FROM projects WHERE user_id = ? ORDER BY created_at DESC
`);

export const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
export const insertUserStmt = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)');
export const insertMagicLinkStmt = db.prepare('INSERT INTO magic_links (token, email, project_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
export const getMagicLinkStmt = db.prepare('SELECT * FROM magic_links WHERE token = ?');
export const markMagicLinkUsedStmt = db.prepare('UPDATE magic_links SET used_at = ? WHERE token = ?');
export const insertSessionStmt = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
export const getSessionUserStmt = db.prepare(`
  SELECT users.id AS id, users.email AS email, sessions.expires_at AS expires_at
  FROM sessions JOIN users ON users.id = sessions.user_id
  WHERE sessions.token = ?
`);

// Finds or creates the user row for an email — request-link and verify both
// need this, and there's no password to check, just an identity to reuse.
export function getOrCreateUser(email) {
  const existing = getUserByEmailStmt.get(email);
  if (existing) return existing;
  insertUserStmt.run(email, new Date().toISOString());
  return getUserByEmailStmt.get(email);
}

// --- module child tables (Feasibility, Cost, Timeline, Risk, Tasks, Documents, AI Advisor) ---
// One insert + one list-by-project statement per table, so each track has a
// ready-made, shape-consistent starting point instead of inventing its own.

export const insertFindingStmt = db.prepare(`
  INSERT INTO project_findings (id, project_id, category, label, detail, likelihood, impact, priority, mitigation, confidence, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const getFindingsByProjectStmt = db.prepare(
  'SELECT * FROM project_findings WHERE project_id = ? AND category = ? ORDER BY created_at ASC'
);

export const insertCostStmt = db.prepare(`
  INSERT INTO project_costs (id, project_id, category, low_estimate, high_estimate, note, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
export const getCostsByProjectStmt = db.prepare('SELECT * FROM project_costs WHERE project_id = ? ORDER BY created_at ASC');

export const insertTimelinePhaseStmt = db.prepare(`
  INSERT INTO project_timeline_phases (id, project_id, name, sort_order, estimated_duration, status, is_bottleneck, note, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const getTimelinePhasesByProjectStmt = db.prepare(
  'SELECT * FROM project_timeline_phases WHERE project_id = ? ORDER BY sort_order ASC'
);

export const insertTaskStmt = db.prepare(`
  INSERT INTO project_tasks (id, project_id, source_id, title, detail, status, due_date, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const getTasksByProjectStmt = db.prepare('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC');
export const getTaskBySourceStmt = db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND source_id = ?');
export const updateTaskStatusStmt = db.prepare('UPDATE project_tasks SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?');

export const insertDocumentStmt = db.prepare(`
  INSERT INTO project_documents (id, project_id, doc_type, content, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
export const getDocumentsByProjectStmt = db.prepare('SELECT * FROM project_documents WHERE project_id = ? ORDER BY created_at ASC');

export const insertConversationMessageStmt = db.prepare(`
  INSERT INTO project_conversations (id, project_id, role, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
export const getConversationByProjectStmt = db.prepare(
  'SELECT * FROM project_conversations WHERE project_id = ? ORDER BY created_at ASC'
);

// --- Refund / guarantee claims ---------------------------------------------
export const insertRefundClaimStmt = db.prepare(`
  INSERT INTO refund_claims (id, project_id, outcome, details, contact_email, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'open', ?)
`);
export const listOpenRefundClaimsStmt = db.prepare("SELECT * FROM refund_claims WHERE status = 'open' ORDER BY created_at ASC");

// --- API usage / cost tracking --------------------------------------------
export const insertApiUsageStmt = db.prepare(`
  INSERT INTO api_usage_log (id, project_id, call_type, provider, model, input_tokens, output_tokens, cost_usd, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const getUsageSummaryStmt = db.prepare(`
  SELECT call_type, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
  FROM api_usage_log GROUP BY call_type ORDER BY cost_usd DESC
`);

// --- Subscriptions (contractor $79/mo plan) --------------------------------
export const insertSubscriptionStmt = db.prepare(`
  INSERT INTO subscriptions (id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
export const getActiveSubscriptionByUserStmt = db.prepare(
  "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
);
export const getSubscriptionByStripeIdStmt = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?');
export const updateSubscriptionStatusStmt = db.prepare(
  'UPDATE subscriptions SET status = ?, current_period_end = ?, cancel_reason = ?, updated_at = ? WHERE stripe_subscription_id = ?'
);
// The WHERE guard makes this the one statement that decides whether the
// retention offer can still be granted — same reasoning as
// incrementAccessCodeUsesStmt above. .changes === 0 means it was already used.
export const markRetentionOfferUsedStmt = db.prepare(
  "UPDATE subscriptions SET retention_offer_used_at = ?, updated_at = ? WHERE stripe_subscription_id = ? AND retention_offer_used_at IS NULL"
);

// --- Expediter pack credits -------------------------------------------------
export const insertPackCreditsStmt = db.prepare(`
  INSERT INTO pack_credits (id, user_id, stripe_session_id, credits_total, credits_used, created_at)
  VALUES (?, ?, ?, ?, 0, ?)
`);
// Packs are consumed oldest-first so a firm's earlier purchase runs out
// before a newer one, rather than leaving old packs stranded with unused
// credits — ORDER BY created_at ASC picks the oldest pack that still has
// room.
export const getAvailablePackForUserStmt = db.prepare(
  'SELECT * FROM pack_credits WHERE user_id = ? AND credits_used < credits_total ORDER BY created_at ASC LIMIT 1'
);
// Every pack a user has ever bought, not just the one currently being drawn
// from — an expediter checking usage wants to see all of them, including
// ones already exhausted.
export const getPackCreditsByUserStmt = db.prepare(
  'SELECT * FROM pack_credits WHERE user_id = ? ORDER BY created_at ASC'
);
// Same atomic-guard reasoning as incrementAccessCodeUsesStmt above — without
// the credits_used < credits_total guard here, two concurrent unlocks
// against someone's last remaining credit could both pass a separate
// SELECT-based check before either writes, spending one credit twice.
export const incrementPackCreditsUsedStmt = db.prepare(
  'UPDATE pack_credits SET credits_used = credits_used + 1 WHERE id = ? AND credits_used < credits_total'
);

// --- Referral codes ----------------------------------------------------------
export const insertReferralCodeStmt = db.prepare(`
  INSERT INTO referral_codes (code, referrer_project_id, stripe_promotion_code_id, created_at)
  VALUES (?, ?, ?, ?)
`);
export const getReferralCodeStmt = db.prepare('SELECT * FROM referral_codes WHERE code = ?');
// A project can only ever mint one referral code (confirm-checkout only
// inserts one per project), so "the" code for a project is unambiguous.
export const getReferralCodeByReferrerStmt = db.prepare(
  'SELECT * FROM referral_codes WHERE referrer_project_id = ? ORDER BY created_at DESC LIMIT 1'
);

// --- Partner codes -----------------------------------------------------------
export const getPartnerCodeStmt = db.prepare('SELECT * FROM partner_codes WHERE code = ?');
export const insertPartnerCodeStmt = db.prepare(`
  INSERT INTO partner_codes (code, label, tier, price_cents, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
export const listPartnerCodesStmt = db.prepare('SELECT * FROM partner_codes ORDER BY created_at DESC');
export const insertPartnerRedemptionStmt = db.prepare(`
  INSERT INTO partner_redemptions (id, code, project_id, redeemed_at)
  VALUES (?, ?, ?, ?)
`);
export const listPartnerRedemptionsStmt = db.prepare(`
  SELECT r.project_id, r.redeemed_at, p.user_id
  FROM partner_redemptions r JOIN projects p ON p.id = r.project_id
  WHERE r.code = ? ORDER BY r.redeemed_at ASC
`);
export const getSubscriptionsByUserStmt = db.prepare(
  'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at ASC'
);

// --- Attention digest (needs-attention loop) --------------------------------
export const getAllUserIdsWithProjectsStmt = db.prepare(
  'SELECT DISTINCT user_id AS id FROM projects WHERE user_id IS NOT NULL'
);
export const getAttentionDigestStmt = db.prepare('SELECT * FROM attention_digests WHERE user_id = ?');
export const upsertAttentionDigestStmt = db.prepare(`
  INSERT INTO attention_digests (user_id, items_hash, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET items_hash = excluded.items_hash, updated_at = excluded.updated_at
`);
export const redeemReferralCodeStmt = db.prepare(
  'UPDATE referral_codes SET redeemed_project_id = ?, redeemed_at = ? WHERE code = ? AND redeemed_project_id IS NULL'
);
