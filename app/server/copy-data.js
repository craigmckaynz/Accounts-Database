// Copies the accounts database to a new place as one clean file, and checks the copy.
//   node server/copy-data.js <from.sqlite> <to.sqlite>
// Used when the accounts are first put in the shared folder. The copy is made by SQLite itself (VACUUM INTO),
// so nothing half-written comes across, and it is set up for use on a network folder. It will not overwrite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [from, to] = process.argv.slice(2);
if (!from || !to || !fs.existsSync(from)) { console.error('Usage: node server/copy-data.js <from.sqlite> <to.sqlite>'); process.exit(1); }
if (fs.existsSync(to)) { console.error(`There is already a file at ${to}. It was left alone.`); process.exit(1); }
fs.mkdirSync(path.dirname(to), { recursive: true });

const source = new DatabaseSync(from);
source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
source.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
const copy = new DatabaseSync(to);
copy.exec('PRAGMA journal_mode = DELETE');

const sum = db => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total, COALESCE(SUM(gst_cents), 0) AS gst FROM transactions').get();
const a = sum(source), b = sum(copy);
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => `${t.name}:${db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n}`).join(' ');
if (a.n !== b.n || a.total !== b.total || a.gst !== b.gst || tables(source) !== tables(copy)) { console.error('The copy does not match the original.'); process.exit(1); }
source.close();
copy.close();
console.log(`  ${b.n} transactions copied and checked (every table has the same number of rows).`);
