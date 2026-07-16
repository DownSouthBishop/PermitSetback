// Tiny in-memory rate limiter, two buckets per IP. One 10/min bucket used to
// cover every route — cheap traffic (a workspace GET, an analytics beacon)
// shared a limit with LLM-triggering and checkout POSTs, so two users behind
// one NAT could 429 each other just loading the app. Tight (10/min) stays on
// LLM-triggering, auth, and checkout POSTs — the requests with real cost or
// account-security weight. Generous (60/min) covers read-only GETs and
// low-risk POSTs (analytics events, task-status toggles, one-time report
// submissions) — high enough that normal use never hits it, low enough to
// still blunt a runaway client.
// Fine for a prototype behind low traffic. A real deployment behind a CDN
// (Cloudflare, etc.) should use its edge-level rate limiting instead — this
// resets every time the process restarts and doesn't share state across
// multiple server instances.
const tightHits = new Map();
const generousHits = new Map();
const WINDOW_MS = 60_000;

function limited(map, ip, max) {
  const now = Date.now();
  const timestamps = (map.get(ip) || []).filter(t => now - t < WINDOW_MS);
  timestamps.push(now);
  map.set(ip, timestamps);
  return timestamps.length > max;
}

export function isRateLimited(ip) {
  return limited(tightHits, ip, 10);
}

export function isGenerouslyRateLimited(ip) {
  return limited(generousHits, ip, 60);
}

// Neither Map ever evicted an IP once its requests aged out of the window —
// harmless at prototype traffic, but unbounded growth over a long-running
// process. Called from index.js's existing 6-hour maintenance timer, not a
// timer of its own (nothing here needs finer-grained sweeping).
export function sweepRateLimitMaps() {
  const now = Date.now();
  for (const map of [tightHits, generousHits]) {
    for (const [ip, timestamps] of map) {
      const fresh = timestamps.filter(t => now - t < WINDOW_MS);
      if (fresh.length === 0) map.delete(ip);
      else map.set(ip, fresh);
    }
  }
}
