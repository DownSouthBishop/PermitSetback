// Shared Anthropic-call helper. feasibility.js, risk.js, and cost.js used to
// each hand-roll their own fetchWithTimeout + JSON-extraction + raw fetch to
// Anthropic — three copies of the same twenty lines. This is the one copy.
//
// llm.js (roadmap/timeline/advisor) predates this and has its own
// Gemini-fallback-aware implementation for those three — it could migrate
// onto this helper later, but isn't required to; its needs (provider
// fallback) are a level up from what this covers.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

async function callOnce({ systemPrompt, userText, maxTokens, timeoutMs }) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }]
    })
  }, timeoutMs);
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

// Calls Claude with a system prompt + user text, extracts JSON from the
// response, and validates it against the caller's shape check. Throws on any
// failure (bad HTTP status, unparseable JSON, failed validation) — callers
// decide how to respond, same as before this existed.
//
// Claude occasionally emits a JSON string value with an unescaped quote or
// similar (a stray inch/foot mark is the usual suspect in this domain),
// which breaks JSON.parse — intermittent, not systemic, so one retry with
// the identical request is the pragmatic fix rather than chasing a specific
// malformed sample.
export async function callAnthropicJSON({ systemPrompt, userText, maxTokens = 1500, isValid, timeoutMs = 60_000 }) {
  const args = { systemPrompt, userText, maxTokens, timeoutMs };
  try {
    const result = await callOnce(args);
    if (isValid && !isValid(result)) throw new Error('Response failed schema validation');
    return result;
  } catch (err) {
    console.error('callAnthropicJSON: first attempt failed, retrying once —', err.message);
    const result = await callOnce(args);
    if (isValid && !isValid(result)) throw new Error('Response failed schema validation');
    return result;
  }
}
