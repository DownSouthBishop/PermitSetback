// Claude API pricing — fetched live from platform.claude.com/docs on
// 2026-07-06, NOT from training data (model prices change; never trust a
// remembered number for a real financial decision). Re-verify against
// https://claude.com/pricing before relying on this for anything beyond a
// rough internal estimate — Anthropic can and does change these rates.
const PRICING_PER_MTOK = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'gemini-2.5-flash': { input: null, output: null } // fallback provider; not costed here (rarely used — Anthropic-primary)
};

export function estimateCostUsd(model, inputTokens, outputTokens) {
  const rates = PRICING_PER_MTOK[model];
  if (!rates || rates.input == null) return null;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}
