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

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Setback backend listening on http://localhost:${PORT}`);
});
