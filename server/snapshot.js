// A consistent copy of the data while the app keeps running (scripts/backup.sh, the automatic backups): each SQLite
// database is copied with VACUUM INTO into a folder, the other files (uploads, keys, feedback) are linked there; then
// `tar -h` archives the folder with the same layout as `make backup`, so `make restore` takes it as it is.
//   node server/snapshot.js /tmp/backup
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = path.resolve(process.env.DATA_DIR || 'data');
const out = process.argv[2];
if (!out) {
  console.error('Usage: node server/snapshot.js OUTPUT_DIR');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(DATA)) {
  if (/\.db-(wal|shm|journal)$/.test(name)) continue; // part of the database, already in its copy
  if (name.endsWith('.db')) {
    const db = new DatabaseSync(path.join(DATA, name));
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec(`VACUUM INTO '${path.join(out, name).replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } else {
    fs.symlinkSync(path.join(DATA, name), path.join(out, name));
  }
}
