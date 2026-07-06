// AI provider layer — Anthropic (Claude) is primary; Google Gemini Flash is
// an optional fallback used only when the Anthropic call actually fails
// (timeout, 5xx, or a 429 rate limit) — not raced in parallel, to avoid
// paying for two calls on every request when one almost always succeeds.
import { getInsightStmt } from './db.js';
import { logUsage } from './ai.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY; // optional — fallback stays off until this is set

export const SYSTEM_PROMPT = `You are Setback, an expert permitting analyst for U.S. construction and improvement projects — any trade: pools, decks, additions, roofing, solar, fencing, garages, driveways, and beyond. You understand how local (county/municipal), state, and federal jurisdictions overlap for residential and light-commercial work.

Given a project, return a permitting roadmap. Be specific to the jurisdiction named. If you are not certain a specific local rule applies, say it generally and flag that it must be confirmed locally rather than inventing a precise number. Never fabricate a specific statute citation you are unsure of. Keep specific claims hedged ("agencies that typically apply", "commonly required") while keeping the overall structure clear and decisive — the value of this product is organization and speed, not vague hedging on everything.

For any project involving a foundation, footing, or other structural work, actively check for climate- and geography-driven structural requirements before finalizing flags and risks — frost-depth footings in cold-winter climates, seismic bracing where relevant, wind/hurricane product requirements in coastal zones — the same way you already check zoning and agency jurisdiction. Don't omit a well-known regional structural requirement just because the project description didn't ask about it.

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
Keep agencies to the 3-6 that actually apply. Keep flags and risks to the 3-6 most relevant each — most projects need only 3-5, but include a 6th only if it's a genuinely distinct, high-value concern rather than padding.`;

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
  }, 150_000);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  // No project row exists yet at this point in the flow (this call is what
  // produces the content that becomes the project) — logged project-less;
  // still counted in the by-call-type cost totals.
  logUsage({ callType: 'roadmap', usage: data.usage });
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

export const TIMELINE_SYSTEM_PROMPT = `You are Setback, an expert permitting analyst for U.S. construction and improvement projects — any trade: pools, decks, additions, roofing, solar, fencing, garages, driveways, and beyond.

Given a project's location, description, and trade, break the project into its realistic phases from start to finish — feasibility/planning, design, engineering (if applicable), permitting, revision cycles, construction, inspections, and completion/closeout. Not every project needs every phase; skip phases that clearly don't apply (e.g. no engineering phase for a simple fence permit) and add a phase if the project genuinely needs one not listed here.

Flag the phase or phases most likely to blow the schedule as the bottleneck — commonly permitting review or a revision cycle, but use judgment for the specific project. Be honest that estimates are ranges, not guarantees.

Respond with ONLY valid JSON (no markdown, no preamble), in exactly this shape:
{"phases":[{"name":"phase name","estimatedDuration":"realistic range e.g. '2-3 weeks'","isBottleneck":true,"note":"one sentence on what happens in this phase and/or why it's flagged"}]}
List phases in chronological order. Keep to the 5-9 phases that actually apply.`;

export function isValidTimelinePhases(obj) {
  return obj && typeof obj === 'object' && Array.isArray(obj.phases) && obj.phases.every(p =>
    p && typeof p === 'object' && typeof p.name === 'string'
  );
}

async function callAnthropicTimeline(userText, projectId) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: TIMELINE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }]
    })
  }, 150_000);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  logUsage({ callType: 'timeline', projectId, usage: data.usage });
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

async function callGeminiTimeline(userText, projectId) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TIMELINE_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }]
    })
  }, 150_000);
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  logUsage({ callType: 'timeline', projectId, provider: 'gemini-fallback', model: 'gemini-2.5-flash', usage: data.usageMetadata && { input_tokens: data.usageMetadata.promptTokenCount, output_tokens: data.usageMetadata.candidatesTokenCount } });
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  return extractJson(text);
}

// Generates the ordered phase breakdown for the Timeline module. Mirrors
// generateRoadmap's Anthropic-primary, Gemini-fallback shape.
export async function generateTimelinePhases(location, description, trade, projectId) {
  const userText = `Project location: ${location}\nProject description: ${description}\nTrade: ${trade}`;

  try {
    const result = await callAnthropicTimeline(userText, projectId);
    if (isValidTimelinePhases(result)) return { ok: true, provider: 'anthropic', phases: result.phases };
    throw new Error('Anthropic response failed schema validation');
  } catch (err) {
    console.error('Anthropic timeline call failed:', err.message);
    if (!GOOGLE_KEY) throw err;

    const result = await callGeminiTimeline(userText, projectId);
    if (isValidTimelinePhases(result)) return { ok: true, provider: 'gemini-fallback', phases: result.phases };
    throw new Error('Gemini fallback response also failed schema validation');
  }
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
  }, 150_000);
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  logUsage({ callType: 'roadmap', provider: 'gemini-fallback', model: 'gemini-2.5-flash', usage: data.usageMetadata && { input_tokens: data.usageMetadata.promptTokenCount, output_tokens: data.usageMetadata.candidatesTokenCount } });
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  return extractJson(text);
}

// --- AI Advisor: persistent, multi-turn chat scoped to one project --------
// Unlike generateRoadmap, this never regenerates the roadmap from scratch —
// it answers one question at a time against the project's existing context
// plus whatever's already been said, so the conversation actually
// accumulates instead of repeating itself.

function advisorSystemPrompt(project) {
  return `You are Setback's AI Advisor for one specific construction/permitting project. A permit roadmap has already been generated for this project — it's given below as context. Do not regenerate or restate the roadmap wholesale; answer the contractor's specific question, referencing the existing roadmap only where directly relevant. Be concise, practical, and specific to this project. If a question changes something material (e.g. "what if I move the pool"), reason about how it would change the agencies, flags, risks, timeline, or narrative already on file, without inventing certainty you don't have — hedge appropriately, same as the original roadmap.

Project context:
Location: ${project.location}
Description: ${project.description}
Trade: ${project.trade}
Agencies: ${JSON.stringify(project.agencies)}
Flags: ${JSON.stringify(project.flags)}
Risks: ${JSON.stringify(project.risks)}
Timeline: ${project.timeline} — ${project.timelineNote}
Narrative on file: ${project.narrative}

Reply in plain prose, not JSON, and do not use markdown formatting (no **bold**, no #headers, no bullet lists with - or *) — this is displayed as plain text, so write it the way you'd write a plain-text message. Use short paragraphs and line breaks for structure instead.`;
}

async function callAnthropicChat(systemPrompt, messages, projectId) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    })
  }, 150_000);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  logUsage({ callType: 'advisor', projectId, usage: data.usage });
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function callGeminiChat(systemPrompt, messages, projectId) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents })
  }, 150_000);
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  logUsage({ callType: 'advisor', projectId, provider: 'gemini-fallback', model: 'gemini-2.5-flash', usage: data.usageMetadata && { input_tokens: data.usageMetadata.promptTokenCount, output_tokens: data.usageMetadata.candidatesTokenCount } });
  return (data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '').trim();
}

// project: plain object with location/description/trade/agencies/flags/risks/timeline/timelineNote/narrative
// history: prior messages as [{role: 'user'|'assistant', content}], oldest first
// userMessage: the new message to answer, not yet in history
export async function askAdvisor(project, history, userMessage) {
  const messages = [...history, { role: 'user', content: userMessage }];
  const systemPrompt = advisorSystemPrompt(project);
  try {
    const reply = await callAnthropicChat(systemPrompt, messages, project.id);
    if (!reply) throw new Error('Anthropic returned an empty reply');
    return { ok: true, provider: 'anthropic', reply };
  } catch (err) {
    console.error('Anthropic advisor call failed:', err.message);
    if (!GOOGLE_KEY) throw err;
    const reply = await callGeminiChat(systemPrompt, messages, project.id);
    if (!reply) throw new Error('Gemini fallback returned an empty reply');
    return { ok: true, provider: 'gemini-fallback', reply };
  }
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
