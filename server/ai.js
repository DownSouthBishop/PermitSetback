// Shared LLM-call helper for JSON-schema responses — feasibility.js, risk.js,
// cost.js, and documents.js all use this one copy instead of hand-rolling
// their own fetch + JSON-extraction + retry.
//
// Google Gemini Flash is primary (free tier); Anthropic (Claude) is the
// fallback used only when Gemini actually fails (timeout, 5xx, a 429, no
// GOOGLE_API_KEY configured, or two straight schema-validation failures) —
// not raced in parallel, same reasoning as llm.js (roadmap/timeline/advisor),
// which has its own copy of this same primary/fallback shape since its
// needs (streaming-free chat, non-JSON replies) are a level up from this.
import crypto from 'node:crypto';
import { insertApiUsageStmt } from './db.js';
import { estimateCostUsd } from './pricing.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const GEMINI_MODEL = 'gemini-2.5-flash';

// Every real call gets logged — this is what turns "what does this cost us"
// from a guess into a query (see server/kpi-report.js, server/usage-report.js).
// Logging failure is swallowed on purpose: a broken cost log must never
// break the actual feature.
export function logUsage({ projectId, callType, usage, model, provider }) {
  try {
    if (!usage) return;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cost = estimateCostUsd(model, inputTokens, outputTokens);
    insertApiUsageStmt.run(crypto.randomUUID(), projectId || null, callType || 'unknown', provider || 'unknown', model, inputTokens, outputTokens, cost, new Date().toISOString());
  } catch (err) {
    console.error('logUsage failed (non-fatal):', err.message);
  }
}

export async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export function extractJson(text) {
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s > -1 && e > -1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callGeminiOnce({ systemPrompt, userText, timeoutMs, projectId, callType }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }]
    })
  }, timeoutMs);
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  logUsage({
    projectId, callType, provider: 'gemini', model: GEMINI_MODEL,
    usage: data.usageMetadata && { input_tokens: data.usageMetadata.promptTokenCount, output_tokens: data.usageMetadata.candidatesTokenCount }
  });
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  return extractJson(text);
}

async function callAnthropicOnce({ systemPrompt, userText, maxTokens, timeoutMs, projectId, callType }) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }]
    })
  }, timeoutMs);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  logUsage({ projectId, callType, provider: 'anthropic-fallback', model: ANTHROPIC_MODEL, usage: data.usage });
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

// Calls an LLM with a system prompt + user text, extracts JSON from the
// response, and validates it against the caller's shape check. Throws on
// total failure (bad HTTP status, unparseable JSON, failed validation twice
// on whichever provider actually ran) — callers decide how to respond, same
// as before this existed.
//
// Both providers occasionally emit a JSON string value with an unescaped
// quote or similar (a stray inch/foot mark is the usual suspect in this
// domain), which breaks JSON.parse — intermittent, not systemic, so one
// retry with the identical request is the pragmatic fix rather than
// chasing a specific malformed sample.
export async function callLLMJSON({ systemPrompt, userText, maxTokens = 1500, isValid, timeoutMs = 150_000, projectId, callType }) {
  if (GOOGLE_KEY) {
    const args = { systemPrompt, userText, timeoutMs, projectId, callType };
    try {
      const result = await callGeminiOnce(args);
      if (isValid && !isValid(result)) throw new Error('Response failed schema validation');
      return result;
    } catch (err) {
      console.error('callLLMJSON: Gemini attempt failed, retrying once —', err.message);
      try {
        const result = await callGeminiOnce(args);
        if (isValid && !isValid(result)) throw new Error('Response failed schema validation');
        return result;
      } catch (err2) {
        console.error('callLLMJSON: Gemini retry also failed, falling back to Anthropic —', err2.message);
      }
    }
  }

  if (!ANTHROPIC_KEY) throw new Error('No LLM provider available — GOOGLE_API_KEY unset/failed and ANTHROPIC_API_KEY is not set');
  const args = { systemPrompt, userText, maxTokens, timeoutMs, projectId, callType };
  try {
    const result = await callAnthropicOnce(args);
    if (isValid && !isValid(result)) throw new Error('Response failed schema validation');
    return result;
  } catch (err) {
    console.error('callLLMJSON: Anthropic fallback attempt failed, retrying once —', err.message);
    const result = await callAnthropicOnce(args);
    if (isValid && !isValid(result)) throw new Error('Response failed schema validation');
    return result;
  }
}
