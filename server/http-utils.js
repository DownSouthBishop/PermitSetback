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

// 402 if a project hasn't been paid for yet. Feasibility, risk, cost,
// timeline, documents, the AI advisor, and tasks are all part of what the
// paid unlock covers, same as the base roadmap content — none of it should
// be reachable by calling these endpoints directly for an unpaid project,
// even though the client (project.html) already blocks that path in the UI.
// Returns true if it sent a response (caller should stop), false if the
// caller should proceed.
export function requirePaid(res, project) {
  if (project.paid) return false;
  sendJson(res, 402, { error: "This project hasn't been unlocked yet." });
  return true;
}
