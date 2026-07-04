// Tiny in-memory rate limiter: 10 requests / minute / IP.
// Fine for a prototype behind low traffic. A real deployment behind a CDN
// (Cloudflare, etc.) should use its edge-level rate limiting instead — this
// resets every time the process restarts and doesn't share state across
// multiple server instances.
const hits = new Map();

export function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 10;
  const timestamps = (hits.get(ip) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > max;
}
