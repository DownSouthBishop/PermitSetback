// Proxies location verification to Nominatim (OpenStreetMap) server-side.
// This used to be called directly from the browser, but browsers refuse to
// let JS set a custom User-Agent header (it's a forbidden header name) — so
// every request went out anonymous, which Nominatim's usage policy asks
// callers not to do. Routing it through here lets the server identify
// itself properly, on behalf of whichever visitor triggered the check.
import { sendJson } from '../http-utils.js';
import { isRateLimited } from '../rate-limit.js';

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Returns true if this handled the request (response already sent), false
// if the caller should try the next route module.
export async function handleGeocodeRoutes(req, res, ip) {
  if (req.method !== 'GET' || !req.url.startsWith('/api/geocode')) return false;
  if (isRateLimited(ip)) { sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' }); return true; }

  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) { sendJson(res, 400, { error: 'q is required' }); return true; }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', USA')}&format=json&limit=1&countrycodes=us`;
    const nomRes = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Setback/0.1 (permit-roadmap tool; contact: skyforgeai.studio@gmail.com)' }
    }, 8000);
    if (!nomRes.ok) { sendJson(res, 200, { found: true, skipped: true }); return true; }
    const data = await nomRes.json();
    sendJson(res, 200, { found: Array.isArray(data) && data.length > 0 });
  } catch (err) {
    // A third-party outage shouldn't block the core funnel — fail open.
    sendJson(res, 200, { found: true, skipped: true });
  }
  return true;
}
