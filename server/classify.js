// Simple keyword classification — same categories as the frontend's trade
// chips. Good enough to group outcome reports meaningfully; not meant to be
// a precise taxonomy.
const TRADE_KEYWORDS = {
  pool: ['pool', 'spa', 'hot tub'],
  deck: ['deck'],
  roof: ['roof', 'shingle'],
  solar: ['solar', 'photovoltaic', 'pv'],
  fence: ['fence', 'fencing'],
  addition: ['addition', 'room addition', 'extension'],
  'garage/adu': ['garage', 'adu', 'accessory dwelling']
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matching, not substring — plain .includes() false-positived
// on real descriptions (e.g. "living space" contains "spa", misclassifying
// a garage conversion as a pool project). The ' pv ' entry used to work
// around this same problem for one keyword by hand-padding it with spaces;
// \b fixes it for all of them instead.
function keywordMatches(text, keyword) {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(text);
}

export function classifyTrade(description) {
  for (const [trade, keywords] of Object.entries(TRADE_KEYWORDS)) {
    if (keywords.some(k => keywordMatches(description, k))) return trade;
  }
  return 'other';
}
