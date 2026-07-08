import { isRateLimited } from './rate-limit.js';

// Generous for this app's actual payloads (the largest is a roadmap
// narrative, a few KB) — this exists to stop an unbounded request body from
// being buffered into memory in full, not to constrain real usage.
const MAX_BODY_BYTES = 1_000_000;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Was copy-pasted as `if (isRateLimited(ip)) { sendJson(res, 429, {...}); return true; }`
// in 22 places across 13 route files. One shared check: true means the
// caller should stop (response already sent), same return convention every
// route handler already uses.
export function checkRateLimit(res, ip) {
  if (!isRateLimited(ip)) return false;
  sendJson(res, 429, { error: 'Too many requests — wait a minute and try again.' });
  return true;
}

// Stripe (and any other redirect-based flow) needs an absolute URL — derived
// from the request itself (Host header + whether this hop is HTTPS) rather
// than hardcoded, so it's correct in both local dev and behind Railway's
// TLS-terminating edge. Was duplicated identically in routes/billing.js and
// routes/projects.js.
export function originFromRequest(req) {
  const proto = req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

// 402 if a project hasn't been paid for at the full-workspace tier.
// Feasibility, risk, cost, timeline breakdown, documents, the AI advisor,
// and tasks are all Full Workspace content, not part of the $49 roadmap-only
// tier — checking project.paid alone let a roadmap-tier buyer reach every
// one of these endpoints directly and get the $97 content for free, since
// paid is true for both tiers. tier is backfilled to 'full' for every
// project paid before the tier column existed (see db.js), so this is safe
// for legacy data too. Returns true if it sent a response (caller should
// stop), false if the caller should proceed.
export function requirePaid(res, project) {
  if (!project.paid) {
    sendJson(res, 402, { error: "This project hasn't been unlocked yet." });
    return true;
  }
  if (project.tier !== 'full') {
    sendJson(res, 402, { error: 'This is part of the Full Workspace — this project was unlocked at the Roadmap tier.' });
    return true;
  }
  return false;
}
