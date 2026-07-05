# Parallel track brief — Setback platform modules

Foundation is landed on `main`: DB schema for every remaining module, the
Project Workspace shell (`project.html`), and two working reference modules
(`modules/overview.js`, `modules/permits.js`). This doc assigns the next five
modules to five parallel tracks/worktrees so they can be built at the same
time without stepping on each other's files.

Queued for a later round (not assigned yet): **Task Center**, **Documents**.

## Shared backend — do not run your own server

All five tracks test against **one shared backend**, already running from
the main `WAKE` checkout (not any of the `WAKE-track-*` worktrees) on
`http://localhost:8787`. That's the only copy of `server/data.db`, so it's
the only place a project you create will actually show up for the other
tracks (and for `agent-browser`/manual testing) to see.

**Do not run `node --env-file=.env index.js` from your own worktree** — a
second instance will either fail with `EADDRINUSE` (if the shared one is up)
or silently create a second, divergent `data.db` in your own worktree (if it
picks a different port). Just point `curl` and your browser tests at
`http://localhost:8787`; the frontend's `BACKEND_ORIGIN` already does.

If the shared backend isn't running, start it from the **main `WAKE` folder
only** (`cd` there first): `node --env-file=.env index.js`.

## The pattern (read this first — copy `modules/permits.js`)

**Frontend module contract.** Each module is `modules/<key>.js` exporting:

```js
export async function render(container, project) { /* mutate container.innerHTML, wire up listeners */ }
```

`project` is the JSON from `GET /api/projects/:id` (id, name, status,
confidenceScore, riskScore, location, description, trade, agencies, flags,
risks, timeline, timelineNote, narrative, outcomeStatus, createdAt,
updatedAt). If your module needs more than that, fetch it yourself from your
own route — don't extend the core `GET /api/projects/:id` response.

**`project.html`'s tab registry already lists all nine modules** (Overview,
Feasibility, Permits, Cost, Timeline, Risk, AI Advisor, Tasks, Documents) —
you do not need to touch `project.html` at all. Just create your
`modules/<key>.js` file; the shell dynamically imports it when the tab is
clicked, and shows "isn't built yet" until the file exists.

**Backend route contract.** Each module is `routes/<key>.js` exporting:

```js
export async function handle<Key>Routes(req, res) {
  // return true if you handled the request (response already sent), else false
}
```

Wire it into `server/index.js` — this is the **one file every track touches**,
so expect a trivial merge conflict here (a two-line addition: one import,
one `if (await handle...)` call, same shape as the three already there). Keep
your addition self-contained; resolving the conflict is just "keep both
sides' added lines."

**DB.** Your table already exists in `server/db.js` with an insert + a
list-by-project prepared statement ready to use. Add more prepared
statements at the bottom of `db.js` if you need them — that's an append, so
it merges cleanly too. Don't touch the `CREATE TABLE` block.

**Before you're done:** `node --check` every file you touched, boot the
server (`node --env-file=.env index.js`), and hit your new route with `curl`.
If you can, load `project.html?id=<a-real-project-id>` and click your tab —
`agent-browser` (`npm i -g agent-browser && agent-browser install`) is a
headless-Chromium CLI that works well for this; see its `skills get core`.

---

## Track 1 — Feasibility Intelligence

- Frontend: `modules/feasibility.js`
- Backend: `routes/feasibility.js`
- DB: `project_findings` table, filter `category = 'feasibility'`.
  Statements ready: `insertFindingStmt`, `getFindingsByProjectStmt(projectId, 'feasibility')`.
- Scope (from SETBACK VISION 1.0): flood zones, wetlands, HOA, historic
  district, lot restrictions, utilities, environmental concerns, zoning
  concerns — findings the user should see *before* permits are discussed.
- API shape suggestion: `POST /api/projects/:id/feasibility` (generate via
  LLM, same pattern as `llm.js` + `routes/legacy.js`'s `/api/roadmap`),
  `GET /api/projects/:id/feasibility` (list).

## Track 2 — Cost Intelligence

- Frontend: `modules/cost.js`
- Backend: `routes/cost.js`
- DB: `project_costs` table. Statements ready: `insertCostStmt`, `getCostsByProjectStmt`.
- Scope: permit costs, engineering, survey, impact fees, inspection fees,
  construction estimates, contractor pricing, contingency. **Display ranges,
  not fake precision** (low_estimate/high_estimate columns exist for this).

## Track 3 — Timeline Intelligence

- Frontend: `modules/timeline.js`
- Backend: `routes/timeline.js`
- DB: `project_timeline_phases` table. Statements ready:
  `insertTimelinePhaseStmt`, `getTimelinePhasesByProjectStmt` (already
  ordered by `sort_order`).
- Scope: feasibility → design → engineering → permitting → revision cycles →
  construction → inspections → completion. Use `is_bottleneck` to flag the
  phase(s) most likely to blow the schedule.
- Note: this supersedes the flat `timeline`/`timelineNote` strings already on
  `projects` — leave those alone (Permits module still reads them), this is
  the richer replacement other modules (Overview) can adopt later.

## Track 4 — Risk Intelligence

- Frontend: `modules/risk.js`
- Backend: `routes/risk.js`
- DB: `project_findings` table, filter `category = 'risk'`.
  Statements ready: `insertFindingStmt`, `getFindingsByProjectStmt(projectId, 'risk')`.
- Scope: every risk gets likelihood, impact, priority, mitigation,
  confidence — all columns already exist on `project_findings`.
- Note: shares a table with Track 1 (Feasibility) by design — the
  `category` column keeps your rows apart, no coordination needed beyond
  that.

## Track 5 — AI Advisor

- Frontend: `modules/advisor.js`
- Backend: `routes/advisor.js`
- DB: `project_conversations` table. Statements ready:
  `insertConversationMessageStmt`, `getConversationByProjectStmt`.
- Scope: persistent chat scoped to one project. Load prior messages via
  `getConversationByProjectStmt`, pass them as context to the LLM call (see
  `server/llm.js` for the existing Anthropic/Google provider pattern), append
  both the user's message and the reply as new rows. This is the one module
  where "never regenerate identical work" is the actual point — lean on the
  conversation history, don't re-run permit/cost/etc. generation from
  scratch on every message.

---

## Ground rules (from the WIG / CLAUDE.md protocol)

- No paid APIs beyond what's already wired (Anthropic call in `llm.js`
  exists; don't add new paid services without sign-off).
- Don't touch Stripe/checkout — it's explicitly out of scope until told
  otherwise.
- Match the existing minimal/quiet design system (`shared.css` variables,
  `.card`/`.section`/`.countbox` classes already in `project.html`) — don't
  introduce a new visual language for your module.
- Keep your module's scope to what's listed above — no speculative fields,
  no placeholder UI for capabilities that don't exist yet.
