// SQLite backup CLI. Uses node:sqlite's own online backup() (SQLite's
// backup API under the hood) so it's safe to run against a database the
// live server is still writing to — no need to stop anything first. Writes
// a timestamped copy locally, then uploads it via fetch if BACKUP_UPLOAD_URL
// is set (no SDK — matches every other external call in this app). Before
// this, "send us the rejection notice, we'll refund it" had a real
// destination (refund_claims), but the database itself had no restore path
// at all if the volume were ever lost.
//
//   node --env-file=.env backup.js
//
// Cron (daily at 3am, adjust the path):
//   0 3 * * * cd /path/to/setback/server && node --env-file=.env backup.js >> backup.log 2>&1
import { backup as sqliteBackup } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, DB_PATH } from './db.js';

const BACKUP_DIR = process.env.BACKUP_DIR || dirname(DB_PATH);

async function run() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = join(BACKUP_DIR, `data-backup-${timestamp}.db`);

  await sqliteBackup(db, destPath);
  console.log(`Backup written to ${destPath}`);

  if (!process.env.BACKUP_UPLOAD_URL) {
    console.log('BACKUP_UPLOAD_URL not set — backup left on local disk only.');
    return;
  }

  const fileBuffer = await readFile(destPath);
  const res = await fetch(process.env.BACKUP_UPLOAD_URL, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      ...(process.env.BACKUP_UPLOAD_AUTH ? { authorization: process.env.BACKUP_UPLOAD_AUTH } : {})
    },
    body: fileBuffer
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
  console.log(`Backup uploaded to ${process.env.BACKUP_UPLOAD_URL}`);
}

run().catch(err => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
