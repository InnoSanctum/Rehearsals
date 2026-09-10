import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { APP_CONFIG } from '../app.config.js';

/* ------------------------------------------------------------------ config */

export const SLOTS_PER_DAY = Math.round((24 * 60) / APP_CONFIG.slotMinutes);

export function settings() {
  const envMax = Number.parseInt(process.env.MAX_USERS ?? '', 10);
  return {
    maxUsers: Number.isFinite(envMax) && envMax > 0 ? envMax : APP_CONFIG.maxUsers,
    rangeStart: APP_CONFIG.rangeStart,
    rangeEnd: APP_CONFIG.rangeEnd,
    slotMinutes: APP_CONFIG.slotMinutes,
    slotsPerDay: SLOTS_PER_DAY,
    greenThreshold: APP_CONFIG.greenThreshold,
    palette: APP_CONFIG.palette,
  };
}

/* --------------------------------------------------------------- database */

let client = null;

export function db() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL || process.env.DB_URI;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DB_TOKEN;
  if (!url) {
    throw new HttpError(500, 'Database is not configured (set DB_URI / TURSO_DATABASE_URL).');
  }
  client = createClient({ url, authToken });
  return client;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     name          TEXT    NOT NULL,
     name_key      TEXT    NOT NULL UNIQUE,
     color         TEXT    NOT NULL,
     password_hash TEXT,
     created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token      TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS slots (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     day     TEXT    NOT NULL,
     idx     INTEGER NOT NULL,
     PRIMARY KEY (user_id, day, idx)
   )`,
  `CREATE INDEX IF NOT EXISTS slots_day_idx ON slots(day, idx)`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
];

let schemaReady = null;

export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const c = db();
      for (const stmt of SCHEMA) await c.execute(stmt);
    })().catch((err) => {
      schemaReady = null; // let the next request retry instead of caching the failure
      throw err;
    });
  }
  return schemaReady;
}

/* ------------------------------------------------------------------ errors */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------ http helpers */

function allowedOrigin(req) {
  const origin = req.headers.origin;
  const list = (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes('*')) return origin || '*';
  return origin && list.includes(origin) ? origin : list[0] || '';
}

function cors(req, res) {
  const origin = allowedOrigin(req);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body || '{}');
    } catch {
      throw new HttpError(400, 'Malformed JSON body.');
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Malformed JSON body.');
  }
}

/** Wraps a handler with CORS, schema bootstrap and uniform error responses. */
export function handler(fn) {
  return async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    try {
      await ensureSchema();
      await fn(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      res.status(status).json({
        error: status >= 500 ? 'Server error.' : err.message,
        ...(err instanceof HttpError ? err.extra : {}),
      });
    }
  };
}

/* -------------------------------------------------------------- passwords */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return ['scrypt', salt, hash].join('$');
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------------ tokens */

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function bearer(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

export async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const { rows } = await db().execute({
    sql: `SELECT u.id, u.name, u.color, u.password_hash
            FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = ?`,
    args: [token],
  });
  if (!rows.length) return null;
  const r = rows[0];
  return { id: Number(r.id), name: r.name, color: r.color, hasPassword: !!r.password_hash };
}

export async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Session expired - sign in again.');
  return user;
}

/* -------------------------------------------------------------- validation */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value) {
  return (
    typeof value === 'string' &&
    DAY_RE.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00Z'))
  );
}

export function assertDayInRange(day) {
  const { rangeStart, rangeEnd } = settings();
  if (!isDay(day)) throw new HttpError(400, 'Invalid date: ' + day);
  if (day < rangeStart || day >= rangeEnd) {
    throw new HttpError(400, `Date ${day} is outside ${rangeStart} .. ${rangeEnd}.`);
  }
}

export function normalizeName(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'Name is required.');
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2) throw new HttpError(400, 'Name must be at least 2 characters.');
  if (trimmed.length > 40) throw new HttpError(400, 'Name must be 40 characters or fewer.');
  return trimmed;
}

export function nameKey(name) {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function normalizeColor(color) {
  if (typeof color !== 'string') return null;
  const hex = color.trim().toLowerCase();
  const match = settings().palette.find((c) => c.toLowerCase() === hex);
  return match || null;
}

export async function takenColors(excludeUserId = null) {
  const { rows } = await db().execute('SELECT id, color FROM users');
  return new Set(
    rows
      .filter((r) => Number(r.id) !== excludeUserId)
      .map((r) => String(r.color).toLowerCase()),
  );
}

export function pickFreeColor(taken) {
  return settings().palette.find((c) => !taken.has(c.toLowerCase())) || null;
}
