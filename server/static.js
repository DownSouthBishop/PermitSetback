// Serves the static frontend (index.html, project.html, modules/*, legal
// pages) from the same origin and port as the API. This is what makes the
// frontend's BACKEND_ORIGIN a zero-configuration window.location.origin —
// there is nothing to point at because there is only one deployed service.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

// Baseline hardening headers — applied to EVERY response (see index.js's
// applySecurityHeaders call, the one place all requests pass through), not
// just static files. Originally this only covered static/HTML responses;
// /api/* JSON responses got none of it, which is the wrong split — payment
// and session data flow through those routes too. The CSP allows
// 'unsafe-inline' for script/style because this app is deliberately a single
// inline <script>/<style> per page with no build step — a strict nonce-based
// CSP would need per-request HTML generation, which is a real architecture
// change, not a header tweak. connect-src is just 'self' — geocoding is
// proxied through our own /api/geocode (server/routes/geocode.js) rather
// than called directly from the browser, so there's no third-party origin
// the frontend itself needs to reach.
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"
};

// Static-file-only: a served file can change under a browser's feet at any
// moment (no build step, no hashed filenames) — exactly what happened here:
// a real user kept hitting an old cached copy of index.html with a
// since-fixed timeout baked into its inline script. Never cache the shell;
// always fetch the current file. API JSON responses don't need this (they're
// never cached by a browser the same way, and each route already controls
// its own semantics), so it stays specific to static.js rather than joining
// the global set in index.js.
const STATIC_CACHE_HEADERS = { 'cache-control': 'no-cache, must-revalidate' };

// HSTS only ever makes sense once real HTTPS is actually terminating this
// traffic (Railway's edge, in production) — sending it over plain local
// HTTP is actively harmful: a browser that honors it will try to upgrade
// every future request to this origin to HTTPS, including API fetches,
// and silently fail every one of them since there's no TLS listener here
// at all. This reproduces as a bare "TypeError: Failed to fetch" with no
// other clue, which is exactly what happened during real testing today.
export function isHttpsRequest(req) {
  return req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Returns true if this handled the request (response already sent), false
// if the caller should fall through to a 404. Only ever reached after every
// API route module has already declined the request.
export async function handleStaticRoutes(req, res) {
  if (req.method !== 'GET') return false;
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) return false;

  const relPath = urlPath === '/' ? '/index.html' : urlPath;
  const safePath = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

  try {
    const data = await readFile(filePath);
    // SECURITY_HEADERS and HSTS are already applied globally in index.js
    // before any route handler runs (including this one) — only the
    // static-specific headers belong here.
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', ...STATIC_CACHE_HEADERS });
    res.end(data);
    return true;
  } catch (err) {
    // No matching static file. For a page a visitor might actually land on
    // (not an /api/ 404, which stays JSON), serve a proper 404 page instead
    // of falling through to the bare {"error":"not found"} JSON blob.
    try {
      const notFound = await readFile(join(PUBLIC_DIR, '404.html'));
      res.writeHead(404, { 'content-type': MIME['.html'] });
      res.end(notFound);
      return true;
    } catch (err2) {
      return false;
    }
  }
}
