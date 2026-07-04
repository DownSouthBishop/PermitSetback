// Setback backend — holds the AI provider keys server-side, so they never
// reach the browser. Anthropic (Claude) is primary; Google Gemini Flash is
// an optional fallback used only when the Anthropic call actually fails
// (timeout, 5xx, or a 429 rate limit) — not raced in parallel, to avoid
// paying for two calls on every request when one almost always succeeds.
//
// Also the real persistence layer: every generated roadmap, every outcome
// report, and basic funnel events land in a local SQLite file (data.db).
// This is what the "reported outcomes" data moat in the plan actually
// depends on — it had zero implementation before this.
//
// Run: node --env-file=.env index.js   (Node 22.5+ for node:sqlite; no npm install needed)

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY; // optional — fallback stays off until this is set

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}
if (!GOOGLE_KEY) {
  console.log('GOOGLE_API_KEY not set — running on Anthropic only, no fallback. That is fine for now.');
}

// --- persistence -------------------------------------------------------
const db = new DatabaseSync(join(__dirname, 'data.db'));
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

// Older data.db files predate the trade column — add it if missing rather
// than requiring anyone to delete and recreate the database.
for (const stmt of [
  "ALTER TABLE roadmaps ADD COLUMN trade TEXT NOT NULL DEFAULT 'other'",
  "ALTER TABLE outcomes ADD COLUMN trade TEXT NOT NULL DEFAULT 'other'"
]) {
  try { db.exec(stmt); } catch (err) { /* column already exists — fine */ }
}

const insertRoadmap = db.prepare(
  'INSERT INTO roadmaps (created_at, location, description, trade, provider, unrecognized) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertOutcome = db.prepare(
  'INSERT INTO outcomes (created_at, location, description, trade, outcome) VALUES (?, ?, ?, ?, ?)'
);
const insertEvent = db.prepare(
  'INSERT INTO events (created_at, name, properties) VALUES (?, ?, ?)'
);
// Case-insensitive on location — real users type "Broward County, Florida"
// and "broward county, florida" for the same place, and an exact-match
// lookup would silently miss the insight for one of them.
const getInsightStmt = db.prepare('SELECT summary, report_count FROM insights WHERE LOWER(location) = LOWER(?) AND trade = ?');

// --- projects + accounts -------------------------------------------------
const insertProject = db.prepare(`
  INSERT INTO projects (id, user_id, location, description, trade, provider, agencies, flags, risks, timeline, timeline_note, narrative, created_at, updated_at)
  VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
const updateProjectOutcomeStmt = db.prepare('UPDATE projects SET outcome_status = ?, outcome_reported_at = ?, updated_at = ? WHERE id = ?');
const linkProjectToUserStmt = db.prepare('UPDATE projects SET user_id = ?, updated_at = ? WHERE id = ?');
const getProjectsByUserStmt = db.prepare(`
  SELECT id, location, description, trade, outcome_status, created_at
  FROM projects WHERE user_id = ? ORDER BY created_at DESC
`);

const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUserStmt = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)');
const insertMagicLinkStmt = db.prepare('INSERT INTO magic_links (token, email, project_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
const getMagicLinkStmt = db.prepare('SELECT * FROM magic_links WHERE token = ?');
const markMagicLinkUsedStmt = db.prepare('UPDATE magic_links SET used_at = ? WHERE token = ?');
const insertSessionStmt = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const getSessionUserStmt = db.prepare(`
  SELECT users.id AS id, users.email AS email, sessions.expires_at AS expires_at
  FROM sessions JOIN users ON users.id = sessions.user_id
  WHERE sessions.token = ?
`);

// Finds or creates the user row for an email — request-link and verify both
// need this, and there's no password to check, just an identity to reuse.
function getOrCreateUser(email) {
  const existing = getUserByEmailStmt.get(email);
  if (existing) return existing;
  insertUserStmt.run(email, new Date().toISOString());
  return getUserByEmailStmt.get(email);
}

// Reads the bearer session token off the request and resolves it to a user,
// or null if missing/expired/unknown — callers just check for null.
function getSessionUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = getSessionUserStmt.get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

function projectRowToJson(row) {
  return {
    id: row.id,
    location: row.location,
    description: row.description,
    trade: row.trade,
    provider: row.provider,
    agencies: JSON.parse(row.agencies),
    flags: JSON.parse(row.flags),
    risks: JSON.parse(row.risks),
    timeline: row.timeline,
    timelineNote: row.timeline_note,
    narrative: row.narrative,
    outcomeStatus: row.outcome_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Simple keyword classification — same categories as the frontend's trade
// chips. Good enough to group outcome reports meaningfully; not meant to be
// a precise taxonomy.
const TRADE_KEYWORDS = {
  pool: ['pool', 'spa', 'hot tub'],
  deck: ['deck'],
  roof: ['roof', 'shingle'],
  solar: ['solar', 'photovoltaic', ' pv '],
  fence: ['fence', 'fencing'],
  addition: ['addition', 'room addition', 'extension'],
  'garage/adu': ['garage', 'adu', 'accessory dwelling']
};
function classifyTrade(description) {
  const d = ` ${description.toLowerCase()} `;
  for (const [trade, keywords] of Object.entries(TRADE_KEYWORDS)) {
    if (keywords.some(k => d.includes(k))) return trade;
  }
  return 'other';
}

const SYSTEM_PROMPT = `You are Setback, an expert permitting analyst for U.S. construction and improvement projects — any trade: pools, decks, additions, roofing, solar, fencing, garages, driveways, and beyond. You understand how local (county/municipal), state, and federal jurisdictions overlap for residential and light-commercial work.

Given a project, return a permitting roadmap. Be specific to the jurisdiction named. If you are not certain a specific local rule applies, say it generally and flag that it must be confirmed locally rather than inventing a precise number. Never fabricate a specific statute citation you are unsure of. Keep specific claims hedged ("agencies that typically apply", "commonly required") while keeping the overall structure clear and decisive — the value of this product is organization and speed, not vague hedging on everything.

The location has already been verified as a real US place before you see it — you don't need to re-check that. Your job is to check whether the project description actually describes a real construction or improvement project. If it doesn't (nonsense, unrelated, or too vague to identify a project type), do not invent a roadmap for it. Respond with ONLY this JSON instead: {"unrecognized": true, "message": "one plain sentence explaining what's unclear and asking for a clearer project description"}

Otherwise, respond with ONLY valid JSON (no markdown, no preamble), in exactly this shape:
{
 "agencies":[{"name":"agency / permit name","detail":"what they review and what's required, 1-2 sentences"}],
 "flags":["jurisdiction-specific rule or gotcha that commonly applies here"],
 "risks":["a specific reason a project like this gets rejected or delayed, and how to avoid it"],
 "timeline":"realistic range e.g. '4-8 weeks before construction'",
 "timelineNote":"one sentence on what drives the range",
 "narrative":"a 120-180 word draft project description / cover narrative the applicant can adapt for the permit application, written professionally in first person"
}
Keep agencies to the 3-6 that actually apply. Keep flags and risks to the 3-5 most relevant each.`;

// --- tiny in-memory rate limiter: 10 requests / minute / IP -----------------
// Fine for a prototype behind low traffic. A real deployment behind a CDN
// (Cloudflare, etc.) should use its edge-level rate limiting instead — this
// resets every time the process restarts and doesn't share state across
// multiple server instances.
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 10;
  const timestamps = (hits.get(ip) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > max;
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractJson(text) {
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s > -1 && e > -1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// Validates the shape the frontend actually renders — catches a malformed
// or unexpected response from either provider before it reaches the client.
function isValidRoadmap(obj) {
  return obj && typeof obj === 'object' &&
    Array.isArray(obj.agencies) &&
    Array.isArray(obj.flags) &&
    Array.isArray(obj.risks) &&
    typeof obj.timeline === 'string' &&
    typeof obj.timelineNote === 'string' &&
    typeof obj.narrative === 'string';
}

async function callAnthropic(userText) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }]
    })
  }, 60_000);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

async function callGemini(userText) {
  // Model id current as of writing — check for a newer Flash model if this starts failing.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }]
    })
  }, 60_000);
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  return extractJson(text);
}

async function generateRoadmap(location, description, trade) {
  // Cheap, synchronous, indexed lookup — no LLM call on this path. If the
  // offline learning job (learn.js) hasn't produced an insight for this
  // location+trade yet (cold start, or just not enough real reports), this
  // is simply undefined and the prompt goes out exactly as it always has.
  const insight = getInsightStmt.get(location, trade);
  const learnedContext = insight
    ? `\n\nReal-world context from ${insight.report_count} outcomes reported by other users for this trade in this area: ${insight.summary} Treat this as one data point among several, not a guarantee.`
    : '';
  const userText = `Project location: ${location}\nProject description: ${description}${learnedContext}`;

  try {
    const result = await callAnthropic(userText);
    if (isValidRoadmap(result) || result.unrecognized) return { ok: true, provider: 'anthropic', result };
    throw new Error('Anthropic response failed schema validation');
  } catch (err) {
    console.error('Anthropic call failed:', err.message);
    if (!GOOGLE_KEY) throw err; // no fallback configured — let it fail through to the caller

    const result = await callGemini(userText);
    if (isValidRoadmap(result) || result.unrecognized) return { ok: true, provider: 'gemini-fallback', result };
    throw new Error('Gemini fallback response also failed schema validation');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const ip = req.socket.remoteAddress || 'unknown';

  // ---- POST /api/roadmap --------------------------------------------
  if (req.method === 'POST' && req.url === '/api/roadmap') {
    if (isRateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' });
    try {
      const { location, description } = JSON.parse((await readBody(req)) || '{}');
      if (!location || !description) return sendJson(res, 400, { error: 'location and description are required' });

      const trade = classifyTrade(description);
      const { provider, result } = await generateRoadmap(location, description, trade);
      insertRoadmap.run(new Date().toISOString(), location, description, trade, provider, result.unrecognized ? 1 : 0);
      sendJson(res, 200, { provider, result });
    } catch (err) {
      console.error('Request failed:', err.message);
      sendJson(res, 502, { error: 'Both providers failed or returned an unusable response.' });
    }
    return;
  }

  // ---- POST /api/outcome — the real fix for the data that used to vanish --
  if (req.method === 'POST' && req.url === '/api/outcome') {
    try {
      const { location, description, outcome } = JSON.parse((await readBody(req)) || '{}');
      const validOutcomes = ['approved', 'comments', 'rejected'];
      if (!location || !description || !validOutcomes.includes(outcome)) {
        return sendJson(res, 400, { error: 'location, description, and a valid outcome are required' });
      }
      insertOutcome.run(new Date().toISOString(), location, description, classifyTrade(description), outcome);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return;
  }

  // ---- POST /api/event — lightweight, best-effort analytics ---------
  if (req.method === 'POST' && req.url === '/api/event') {
    try {
      const { name, properties } = JSON.parse((await readBody(req)) || '{}');
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      insertEvent.run(new Date().toISOString(), name, properties ? JSON.stringify(properties) : null);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return;
  }

  // ---- GET /api/stats — real numbers now, not the removed fake pills ----
  if (req.method === 'GET' && req.url === '/api/stats') {
    const roadmapCount = db.prepare('SELECT COUNT(*) AS n FROM roadmaps WHERE unrecognized = 0').get().n;
    const outcomeCount = db.prepare('SELECT COUNT(*) AS n FROM outcomes').get().n;
    const approvedCount = db.prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE outcome = 'approved'`).get().n;
    sendJson(res, 200, { roadmapsGenerated: roadmapCount, outcomesReported: outcomeCount, approvedAsDrafted: approvedCount });
    return;
  }

  // ---- POST /api/projects — persist a generated roadmap as a Project so it
  // survives a refresh instead of vanishing once the browser tab closes ----
  if (req.method === 'POST' && req.url === '/api/projects') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { location, description, trade, provider, agencies, flags, risks, timeline, timelineNote, narrative } = body;
      if (!location || !description || !trade || !provider || !Array.isArray(agencies) || !Array.isArray(flags) || !Array.isArray(risks) || !timeline || !timelineNote || !narrative) {
        return sendJson(res, 400, { error: 'location, description, trade, provider, agencies, flags, risks, timeline, timelineNote, and narrative are required' });
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      insertProject.run(id, location, description, trade, provider, JSON.stringify(agencies), JSON.stringify(flags), JSON.stringify(risks), timeline, timelineNote, narrative, now, now);
      sendJson(res, 200, { id });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return;
  }

  // ---- POST /api/projects/:id/outcome — same real-outcome question as
  // /api/outcome, but also updates the project's own status so a returning
  // customer sees it, and keeps feeding learn.js exactly as before --------
  if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/outcome$/.test(req.url)) {
    const id = req.url.split('/')[3];
    try {
      const { outcome } = JSON.parse((await readBody(req)) || '{}');
      const validOutcomes = ['approved', 'comments', 'rejected'];
      if (!validOutcomes.includes(outcome)) {
        return sendJson(res, 400, { error: 'a valid outcome is required' });
      }
      const project = getProjectStmt.get(id);
      if (!project) return sendJson(res, 404, { error: 'not found' });

      const now = new Date().toISOString();
      updateProjectOutcomeStmt.run(outcome, now, now, id);
      insertOutcome.run(now, project.location, project.description, project.trade, outcome);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return;
  }

  // ---- GET /api/projects/:id — public by unguessable UUID, same as the
  // rest of this app: no account required to see what you generated -------
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const project = getProjectStmt.get(id);
    if (!project) return sendJson(res, 404, { error: 'not found' });
    sendJson(res, 200, projectRowToJson(project));
    return;
  }

  // ---- POST /api/auth/request-link — passwordless login. No real email
  // sender is wired up yet (that's a cloud dependency this build deliberately
  // hasn't added without sign-off), so the link is handed straight back in
  // the response instead of being emailed. Swap that in later without
  // changing this shape. -----------------------------------------------
  if (req.method === 'POST' && req.url === '/api/auth/request-link') {
    if (isRateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' });
    try {
      const { email, projectId } = JSON.parse((await readBody(req)) || '{}');
      if (typeof email !== 'string' || !email.includes('@')) {
        return sendJson(res, 400, { error: 'a valid email is required' });
      }
      getOrCreateUser(email);
      const token = crypto.randomUUID();
      const now = new Date();
      const expires = new Date(now.getTime() + 15 * 60_000);
      insertMagicLinkStmt.run(token, email, projectId || null, now.toISOString(), expires.toISOString());
      sendJson(res, 200, { devLink: `http://localhost:${PORT}/api/auth/verify?token=${token}` });
    } catch (err) {
      sendJson(res, 400, { error: 'invalid request body' });
    }
    return;
  }

  // ---- GET /api/auth/verify — redeems a magic-link token for a session --
  if (req.method === 'GET' && req.url.startsWith('/api/auth/verify')) {
    const token = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('token');
    const link = token && getMagicLinkStmt.get(token);
    if (!link) return sendJson(res, 400, { error: 'invalid or unknown link' });
    if (link.used_at) return sendJson(res, 400, { error: 'this link has already been used' });
    if (new Date(link.expires_at).getTime() < Date.now()) return sendJson(res, 400, { error: 'this link has expired' });

    markMagicLinkUsedStmt.run(new Date().toISOString(), token);
    const user = getOrCreateUser(link.email);

    if (link.project_id) {
      linkProjectToUserStmt.run(user.id, new Date().toISOString(), link.project_id);
    }

    const sessionToken = crypto.randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    insertSessionStmt.run(sessionToken, user.id, now.toISOString(), expires.toISOString());

    const projects = getProjectsByUserStmt.all(user.id).map(p => ({
      id: p.id, location: p.location, description: p.description, trade: p.trade,
      outcomeStatus: p.outcome_status, createdAt: p.created_at
    }));
    sendJson(res, 200, { sessionToken, projects });
    return;
  }

  // ---- GET /api/me/projects — the list behind "My Projects" -------------
  if (req.method === 'GET' && req.url === '/api/me/projects') {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: 'not authenticated' });
    const projects = getProjectsByUserStmt.all(user.id).map(p => ({
      id: p.id, location: p.location, description: p.description, trade: p.trade,
      outcomeStatus: p.outcome_status, createdAt: p.created_at
    }));
    sendJson(res, 200, { projects });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Setback backend listening on http://localhost:${PORT}`);
});
