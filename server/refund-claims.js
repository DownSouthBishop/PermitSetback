// Lists open guarantee/refund claims for manual review — the founder reads
// each one, checks it against the actual project, and processes the refund
// by hand (there's no real payment processor wired up yet to automate
// against). Same manual-script pattern as learn.js and create-access-code.js.
//
//   node --env-file=.env refund-claims.js
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(process.env.SETBACK_DB_PATH || join(__dirname, 'data.db'));

const claims = db.prepare("SELECT * FROM refund_claims WHERE status = 'open' ORDER BY created_at ASC").all();

if (claims.length === 0) {
  console.log('No open refund/guarantee claims.');
  process.exit(0);
}

console.log(`${claims.length} open claim(s):\n`);
for (const c of claims) {
  const project = db.prepare('SELECT location, description, trade, paid, outcome_status FROM projects WHERE id = ?').get(c.project_id);
  console.log(`--- ${c.id} (filed ${c.created_at}) ---`);
  console.log(`Project: ${c.project_id}${project ? ` — ${project.trade} in ${project.location}, paid=${project.paid}` : ' (not found)'}`);
  console.log(`Outcome: ${c.outcome}`);
  console.log(`Contact: ${c.contact_email || '(none given)'}`);
  console.log(`Details: ${c.details}`);
  console.log('');
}
console.log("To mark one resolved: node -e \"import('./db.js').then(({db}) => db.prepare(\\\"UPDATE refund_claims SET status = 'resolved' WHERE id = ?\\\").run('CLAIM_ID'))\"");
