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

// Baseline hardening headers, sent on every static response. The CSP allows
// 'unsafe-inline' for script/style because this app is deliberately a single
// inline <script>/<style> per page with no build step — a strict nonce-based
// CSP would need per-request HTML generation, which is a real architecture
// change, not a header tweak. connect-src is just 'self' — geocoding is
// proxied through our own /api/geocode (server/routes/geocode.js) rather
// than called directly from the browser, so there's no third-party origin
// the frontend itself needs to reach.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"
};

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
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(data);
    return true;
  } catch (err) {
    // No matching static file. For a page a visitor might actually land on
    // (not an /api/ 404, which stays JSON), serve a proper 404 page instead
    // of falling through to the bare {"error":"not found"} JSON blob.
    try {
      const notFound = await readFile(join(PUBLIC_DIR, '404.html'));
      res.writeHead(404, { 'content-type': MIME['.html'], ...SECURITY_HEADERS });
      res.end(notFound);
      return true;
    } catch (err2) {
      return false;
    }
  }
}
