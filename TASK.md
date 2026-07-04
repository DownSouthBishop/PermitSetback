# Track A — Backend: Project schema, API, auth

You're in a dedicated git worktree (branch `feature/project-backend-api`) so you
can work without colliding with two other Claude Code sessions doing Track B
(frontend funnel) and Track C (dashboard page) in their own worktrees. You own
`server/index.js` only — don't touch other files.

## Context

Setback is an AI permit-roadmap tool. Right now a generated roadmap is shown once
and lost on refresh — no persistence. We're introducing a `Project` as the
durable record a customer can return to, and a lightweight magic-link account
system so it's tied to them, not just a browser tab. `server/.env` has already
been copied into this worktree so `node --env-file=.env index.js` runs as-is.

Read `server/index.js` fully first — it's ~325 lines, single-file, hand-rolled
`http` server (no framework), `node:sqlite`'s `DatabaseSync`, a small route
dispatcher of `if (req.method === X && req.url === Y)` blocks, and helpers you
must reuse: `sendJson(res, status, obj)`, `readBody(req)`, `isRateLimited(ip)`,
`classifyTrade(description)`, `insertOutcome` (prepared statement). Match its
style exactly — terse comments only where something is non-obvious, same
try/catch → sendJson(502/400) error shape as the existing `/api/outcome` handler.

Do not touch: the Anthropic/Gemini call path, the rate limiter definition,
`classifyTrade`, or the existing `roadmaps`/`outcomes`/`insights`/`events` tables
or their endpoints. `learn.js` depends on `outcomes` staying exactly as-is.

## What to build

### 1. New tables — add to the existing `db.exec(...)` block

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  trade TEXT NOT NULL,
  provider TEXT NOT NULL,
  agencies TEXT NOT NULL,
  flags TEXT NOT NULL,
  risks TEXT NOT NULL,
  timeline TEXT NOT NULL,
  timeline_note TEXT NOT NULL,
  narrative TEXT NOT NULL,
  outcome_status TEXT,
  outcome_reported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
`agencies`/`flags`/`risks` are stored as JSON-encoded text (same shape the
frontend already renders — see `isValidRoadmap` for the exact fields).

### 2. Endpoints — add alongside the existing route blocks in the `createServer` callback

- **`POST /api/projects`** — body `{location, description, trade, provider, agencies, flags, risks, timeline, timelineNote, narrative}`. Insert a row with `id = crypto.randomUUID()` (Node's built-in `crypto`, already global — no import needed), `created_at`/`updated_at` = `new Date().toISOString()`. Return `{id}`.

- **`GET /api/projects/:id`** — Node's raw `http` has no path params, so parse `req.url` yourself (e.g. `req.url.match(/^\/api\/projects\/([^/]+)$/)`). Look up by id, return the full row (parse the three JSON columns back into arrays before sending). 404 via `sendJson(res, 404, {error:'not found'})` if missing. No auth — public by unguessable UUID, matching the existing "no account needed" funnel.

- **`POST /api/projects/:id/outcome`** — body `{outcome}`, validate against `['approved','comments','rejected']` same as the existing `/api/outcome` handler. Update the project's `outcome_status`/`outcome_reported_at`/`updated_at`. Also call the existing `insertOutcome.run(...)` using the project's own `location`/`description`/`trade` columns, so `learn.js`'s pipeline keeps getting fed exactly as before. Return `{ok:true}`.

- **`POST /api/auth/request-link`** — body `{email, projectId?}`. Rate-limit via the existing `isRateLimited(ip)`. Validate `email` is a non-empty string with an `@` (don't overbuild real RFC validation). `INSERT OR IGNORE` a user row for that email if new (or a plain `SELECT` then conditional `INSERT`), generate `token = crypto.randomUUID()`, insert into `magic_links` with `expires_at` = now + 15 minutes. Return `{devLink: "http://localhost:8787/api/auth/verify?token=" + token}` — comment clearly that this stands in for a real emailed link until SMTP delivery is deliberately approved later (see plan doc if you want the full reasoning; short version: no cloud dependency should be added silently).

- **`GET /api/auth/verify?token=...`** — parse the query string yourself (`new URL(req.url, 'http://x').searchParams`). Look up the token in `magic_links`; reject (400) if missing, already used (`used_at` set), or past `expires_at`. Mark it used. Look up/create the `users` row for that email (should already exist from request-link). If the magic-link row has a `project_id`, set that project's `user_id` to this user. Create a `sessions` row: `token = crypto.randomUUID()`, `expires_at` = now + 30 days. Return `{sessionToken, projects: [...]}` where `projects` is every project row for that `user_id` (id, location, description, trade, outcome_status, created_at — not the full JSON blobs).

- **`GET /api/me/projects`** — read `Authorization: Bearer <token>` from `req.headers.authorization`. Write a small `getSessionUser(req)` helper: strips the `Bearer ` prefix, looks up `sessions` joined to `users`, checks `expires_at` hasn't passed, returns the user row or `null`. If `null`, `sendJson(res, 401, {error:'not authenticated'})`. Otherwise return the same project list shape as `/api/auth/verify`.

## Verify

1. `node --env-file=.env index.js` starts without error on port 8787.
2. Walk the full sequence with curl (or a scratch script) and confirm each response shape:
   - `POST /api/projects` with a realistic body → get `{id}`
   - `GET /api/projects/<id>` → full row back, JSON fields parsed as arrays
   - `POST /api/projects/<id>/outcome` `{"outcome":"approved"}` → `{ok:true}`, then re-fetch the project and confirm `outcome_status` is set
   - `POST /api/auth/request-link` `{"email":"test@example.com","projectId":"<id>"}` → get `{devLink}`
   - `GET` that `devLink` URL → get `{sessionToken, projects:[...]}` with your project in the list
   - `GET /api/me/projects` with header `Authorization: Bearer <sessionToken>` → same project list
3. Confirm nothing about `/api/roadmap`, `/api/outcome`, `/api/event`, `/api/stats`, or `learn.js` changed behavior.

When done, commit on this branch (`feature/project-backend-api`). Don't merge or
push — that happens after all 3 tracks land.
