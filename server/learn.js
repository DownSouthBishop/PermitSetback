// Setback's learning loop — the piece that was missing entirely before.
//
// Runs two ways:
//   1. Automatically, on an interval, inside the main server process (see
//      index.js) — no external cron needed, matches this app's one-
//      deployable-service shape. This is what makes the data moat real
//      instead of dormant: it only compounds if it actually runs.
//   2. Manually, for inspection: node --env-file=.env learn.js
//
// This is deliberately a single script doing one bounded job, not a
// multi-agent system — per agent-designer's own pattern table, a bounded
// task like this doesn't need a supervisor, a pipeline, or a swarm. It:
//   1. Finds location+trade groups with enough real outcome reports
//   2. Screens out groups that look like a burst from one source, not
//      real distinct signal (the data-poisoning risk flagged early on)
//   3. Uses ONE LLM call per group to turn raw rows into a short, honest
//      sentence — never a bare percentage passed through unexamined
//   4. Writes the result to `insights`, which index.js reads from on the
//      live request path with zero extra latency and zero extra LLM cost
//
// The live serving path (index.js) never calls an LLM for this — that
// separation is the whole point: expensive, occasional synthesis stays
// offline; the hot path stays a single indexed SQL lookup.

import { db } from './db.js';
import { logUsage } from './ai.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Lower than the ~20-report bar the plan sets for a public SEO-page stat —
// this context is hedged and shown only to the model, not published as a
// bold public claim, so a smaller sample is a defensible bar for it.
const MIN_REPORTS = 5;

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// A basic abuse screen, not a perfect one: three or more reports for the
// same location+trade landing within a 60-second window looks like one
// source hammering the endpoint, not three distinct real outcomes. Skip
// the whole group rather than let it poison the insight.
function looksAbusive(rows) {
  const timestamps = rows.map(r => new Date(r.created_at).getTime()).sort((a, b) => a - b);
  for (let i = 0; i + 2 < timestamps.length; i++) {
    if (timestamps[i + 2] - timestamps[i] < 60_000) return true;
  }
  return false;
}

async function synthesize(location, trade, rows) {
  const approved = rows.filter(r => r.outcome === 'approved').length;
  const approvedPct = Math.round((approved / rows.length) * 100);
  const lines = rows.map(r => `- ${r.outcome}: ${r.description}`).join('\n');

  const prompt = `You're summarizing real reported permit outcomes for ${trade} projects in ${location}. Here are ${rows.length} real reports:\n${lines}\n\nWrite ONE short, honest sentence (max 30 words) a contractor would find useful — mention the approval rate and, if a real pattern is visible across the reports, the most common reason for delay or rejection. Do not invent a specific reason that isn't actually reflected in the reports above — if there's no clear pattern, just state the approval rate plainly. Respond with plain text only, no preamble, no quotation marks.`;

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
  }, 30_000);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  logUsage({ callType: 'learn-insight', usage: data.usage });
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { summary: text, approvedPct };
}

// Exported so index.js can run this on a timer inside the long-running
// server process, and so learn.js can still be invoked directly for a
// one-off manual run. Never throws — a failed pass should never take down
// the server or block the next scheduled attempt.
export async function runLearningPass(log = console.log) {
  if (!ANTHROPIC_KEY) {
    log('Learning pass skipped — ANTHROPIC_API_KEY is not set.');
    return;
  }

  try {
    // Group case-insensitively — "Broward County, Florida" and "broward
    // county, florida" are the same place and should accumulate together,
    // not fragment into two groups that each fall short of the threshold.
    const groups = db.prepare(`
      SELECT MIN(location) AS location, trade, COUNT(*) AS n
      FROM outcomes
      GROUP BY LOWER(location), trade
      HAVING n >= ?
    `).all(MIN_REPORTS);

    log(`[learn] Found ${groups.length} location/trade group(s) with >= ${MIN_REPORTS} real reports.`);
    if (groups.length === 0) return;

    const upsert = db.prepare(`
      INSERT INTO insights (location, trade, report_count, approved_pct, summary, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(location, trade) DO UPDATE SET
        report_count = excluded.report_count,
        approved_pct = excluded.approved_pct,
        summary = excluded.summary,
        updated_at = excluded.updated_at
    `);

    for (const g of groups) {
      const rows = db.prepare('SELECT outcome, description, created_at FROM outcomes WHERE LOWER(location) = LOWER(?) AND trade = ?').all(g.location, g.trade);

      if (looksAbusive(rows)) {
        log(`[learn] Skipped ${g.location} / ${g.trade} — reports arrived in a suspicious burst, not treated as real signal.`);
        continue;
      }

      try {
        const { summary, approvedPct } = await synthesize(g.location, g.trade, rows);
        upsert.run(g.location, g.trade, rows.length, approvedPct, summary, new Date().toISOString());
        log(`[learn] Updated insight for ${g.location} / ${g.trade} (${rows.length} reports, ${approvedPct}% approved): "${summary}"`);
      } catch (err) {
        console.error(`[learn] Failed to synthesize ${g.location} / ${g.trade}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[learn] Learning pass failed (non-fatal):', err.message);
  }
}

// Only auto-run when executed directly (node learn.js), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!ANTHROPIC_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — copy server/.env.example to server/.env and fill it in.');
    process.exit(1);
  }
  await runLearningPass();
  console.log('Done.');
}
