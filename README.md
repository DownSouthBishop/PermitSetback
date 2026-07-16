# Setback

Every permit, decoded. A single Node process (no framework, no build step)
that serves both the API and the static frontend from one origin.

## Local development

```
cd server
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
cd ..
npm run dev
```

Open http://localhost:8787/ — that's the whole app: landing page, roadmap
generator, saved-project workspace, everything.

## Deploying

This is one deployable service: a Node HTTP server (`server/index.js`) that
also serves `index.html`, `project.html`, `projects.html`, `modules/*`, and
the legal pages as static files (see `server/static.js`). There is nothing
to point at anything else — every frontend file reads
`BACKEND_ORIGIN = window.location.origin`, so it's correct on whatever host
serves it.

### Railway (recommended — this backend needs a persistent process + a
local file for SQLite, which is exactly what Railway runs)

1. Push this folder to a GitHub repo, connect it in Railway.
2. Railway detects `package.json` at the root and runs `npm start`
   (`node server/index.js`).
3. Set environment variables in Railway's dashboard: `ANTHROPIC_API_KEY`
   (required), `GOOGLE_API_KEY` (optional fallback). Don't set `PORT` —
   Railway injects its own.
4. Attach a persistent volume mounted at `/app/server` if you want
   `data.db` to survive redeploys (otherwise each deploy starts with a
   fresh, empty database).

That's the whole deploy. One push, one URL, done.

### Cloudflare Pages / Vercel — static frontend only

Both platforms run on serverless/edge runtimes, not a persistent Node
process with a local SQLite file — so **the backend can't run there**.
If you want the marketing pages on one of these platforms specifically,
deploy the backend to Railway (or any VPS) first, then:

1. Deploy this folder's static files (`index.html`, `project.html`,
   `projects.html`, `modules/`, `shared.css`, legal pages) to Cloudflare
   Pages / Vercel as a static site.
2. Change the one line in each of `modules/shared.js`, `projects.html`,
   and `index.html` from `window.location.origin` to the Railway
   backend's actual URL (e.g. `https://setback-production.up.railway.app`).
3. CORS is already wide open (`Access-Control-Allow-Origin: *`) on the
   backend, so the cross-origin calls will work.

This is a real tradeoff, not a workaround: same-origin (Railway alone) is
zero-config; split hosting works but costs you that one manual edit.

## What's real

- **Payment.** Stripe Checkout is fully live (`server/stripe.js`,
  `server/routes/checkout.js`, `server/routes/stripe-webhook.js`) — set
  `STRIPE_SECRET_KEY` (and ideally `STRIPE_WEBHOOK_SECRET`) in `.env` and
  real cards are charged.
- **Email.** Magic-link sign-in emails send via Resend
  (`server/email.js`) once `RESEND_API_KEY` is set in `.env`, or
  automatically in any deploy with `NODE_ENV=production`. With neither set,
  the link is returned directly in the API response (`devLink`) instead —
  that's the local-dev fallback, not the production path.

## Backups

`server/backup.js` copies the live SQLite database to a timestamped file
via SQLite's own online backup API — safe to run while the server keeps
writing to it. Uploads the copy if `BACKUP_UPLOAD_URL` is set, otherwise
just writes it to disk next to `data.db` and logs the path. Run it on a
schedule, e.g. daily at 3am:

```
0 3 * * * cd /path/to/setback/server && node --env-file=.env backup.js >> backup.log 2>&1
```
