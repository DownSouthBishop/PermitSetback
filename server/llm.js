// AI provider layer — Anthropic (Claude) is primary; Google Gemini Flash is
// an optional fallback used only when the Anthropic call actually fails
// (timeout, 5xx, or a 429 rate limit) — not raced in parallel, to avoid
// paying for two calls on every request when one almost always succeeds.
import { getInsightStmt } from './db.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY; // optional — fallback stays off until this is set

export const SYSTEM_PROMPT = `You are Setback, an expert permitting analyst for U.S. construction and improvement projects — any trade: pools, decks, additions, roofing, solar, fencing, garages, driveways, and beyond. You understand how local (county/municipal), state, and federal jurisdictions overlap for residential and light-commercial work.

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
export function isValidRoadmap(obj) {
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

export async function generateRoadmap(location, description, trade) {
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
