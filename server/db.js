// Persistence layer — SQLite via node:sqlite. Every generated roadmap, every
// outcome report, every Project, and basic funnel events land here.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const db = new DatabaseSync(join(__dirname, 'data.db'));

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
  "ALTER TABLE projects ADD COLUMN extra TEXT"
]) {
  try { db.exec(stmt); } catch (err) { /* column already exists — fine */ }
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
export const insertProject = db.prepare(`
  INSERT INTO projects (id, user_id, location, description, trade, provider, agencies, flags, risks, timeline, timeline_note, narrative, extra, created_at, updated_at)
  VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
export const updateProjectOutcomeStmt = db.prepare('UPDATE projects SET outcome_status = ?, outcome_reported_at = ?, updated_at = ? WHERE id = ?');
export const linkProjectToUserStmt = db.prepare('UPDATE projects SET user_id = ?, updated_at = ? WHERE id = ?');
export const getProjectsByUserStmt = db.prepare(`
  SELECT id, location, description, trade, outcome_status, created_at
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
