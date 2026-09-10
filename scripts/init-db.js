/**
 * Creates (or resets) the Turso/libSQL schema and prints a short summary.
 *
 *   npm run db:init     # create tables if missing
 *   npm run db:reset    # DROP everything first, then recreate  (destructive!)
 *
 * Credentials come from .env (DB_URI / DB_TOKEN) or the environment
 * (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the script has no hard dependency on dotenv.
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

const { db, ensureSchema, settings } = await import('../api/_lib.js');

const reset = process.argv.includes('--reset');
const c = db();

if (reset) {
  console.log('Dropping existing tables...');
  for (const table of ['slots', 'sessions', 'users']) {
    await c.execute(`DROP TABLE IF EXISTS ${table}`);
  }
}

await ensureSchema();

const tables = await c.execute(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const users = await c.execute('SELECT COUNT(*) AS n FROM users');
const slots = await c.execute('SELECT COUNT(*) AS n FROM slots');

const cfg = settings();
console.log('\nSchema ready.');
console.log('  tables      :', tables.rows.map((r) => r.name).join(', '));
console.log('  users       :', Number(users.rows[0].n), '/', cfg.maxUsers, 'seats');
console.log('  marked slots:', Number(slots.rows[0].n));
console.log('  range       :', cfg.rangeStart, '->', cfg.rangeEnd);
console.log('  slots/day   :', cfg.slotsPerDay, `(${cfg.slotMinutes} min)`);
