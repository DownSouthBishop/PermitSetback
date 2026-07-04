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

export function classifyTrade(description) {
  const d = ` ${description.toLowerCase()} `;
  for (const [trade, keywords] of Object.entries(TRADE_KEYWORDS)) {
    if (keywords.some(k => d.includes(k))) return trade;
  }
  return 'other';
}
