import {
  HttpError,
  db,
  handler,
  hashPassword,
  nameKey,
  newToken,
  normalizeColor,
  normalizeName,
  pickFreeColor,
  readBody,
  requireUser,
  settings,
  takenColors,
  verifyPassword,
  bearer,
} from './_lib.js';

const MIN_PASSWORD = 4;

function publicUser(row) {
  return {
    id: Number(row.id),
    name: row.name,
    color: row.color,
    hasPassword: !!row.password_hash,
  };
}

async function findByName(name) {
  const { rows } = await db().execute({
    sql: 'SELECT id, name, color, password_hash FROM users WHERE name_key = ?',
    args: [nameKey(name)],
  });
  return rows[0] || null;
}

async function issueToken(userId) {
  const token = newToken();
  await db().execute({
    sql: 'INSERT INTO sessions (token, user_id) VALUES (?, ?)',
    args: [token, userId],
  });
  // Opportunistic cleanup so the table cannot grow without bound.
  await db().execute("DELETE FROM sessions WHERE created_at < datetime('now', '-180 days')");
  return token;
}

function checkPassword(password, { required }) {
  if (password == null || password === '') {
    if (required) throw new HttpError(401, 'This name is password protected.', { needPassword: true });
    return null;
  }
  if (typeof password !== 'string') throw new HttpError(400, 'Password must be text.');
  if (password.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');
  return password;
}

/* ------------------------------------------------------------------ enter */

async function enter(body) {
  const name = normalizeName(body.name);
  const existing = await findByName(name);

  if (existing) {
    if (existing.password_hash) {
      const password = checkPassword(body.password, { required: true });
      if (!verifyPassword(password, existing.password_hash)) {
        throw new HttpError(401, 'Wrong password.', { needPassword: true });
      }
    }
    const token = await issueToken(Number(existing.id));
    return { token, user: publicUser(existing), created: false };
  }

  // New participant - subject to the seat limit.
  const password = checkPassword(body.password, { required: false });
  const { maxUsers } = settings();

  const tx = await db().transaction('write');
  try {
    const countRes = await tx.execute('SELECT COUNT(*) AS n FROM users');
    const count = Number(countRes.rows[0].n);
    if (count >= maxUsers) {
      throw new HttpError(
        403,
        `This board is full (${maxUsers} of ${maxUsers} people). Ask the admin to raise the limit, or sign in with an existing name.`,
        { full: true },
      );
    }

    const taken = new Set(
      (await tx.execute('SELECT color FROM users')).rows.map((r) => String(r.color).toLowerCase()),
    );
    const requested = normalizeColor(body.color);
    const color = requested && !taken.has(requested.toLowerCase()) ? requested : pickFreeColor(taken);
    if (!color) throw new HttpError(409, 'No colours left. Ask the admin to extend the palette.');

    const insert = await tx.execute({
      sql: 'INSERT INTO users (name, name_key, color, password_hash) VALUES (?, ?, ?, ?) RETURNING id',
      args: [name, nameKey(name), color, password ? hashPassword(password) : null],
    });
    await tx.commit();

    const id = Number(insert.rows[0].id);
    const token = await issueToken(id);
    return {
      token,
      user: { id, name, color, hasPassword: !!password },
      created: true,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* transaction already closed */
    }
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(err?.code || err?.message || ''))) {
      throw new HttpError(409, 'That name was just taken. Try entering again.');
    }
    throw err;
  }
}

/* ------------------------------------------------------------- account ops */

async function logout(req) {
  const token = bearer(req);
  if (token) await db().execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
  return { ok: true };
}

async function setColor(req, body) {
  const me = await requireUser(req);
  const color = normalizeColor(body.color);
  if (!color) throw new HttpError(400, 'Pick a colour from the palette.');
  const taken = await takenColors(me.id);
  if (taken.has(color.toLowerCase())) throw new HttpError(409, 'Someone else already uses that colour.');
  await db().execute({ sql: 'UPDATE users SET color = ? WHERE id = ?', args: [color, me.id] });
  return { user: { ...me, color } };
}

async function setPassword(req, body) {
  const me = await requireUser(req);
  const { rows } = await db().execute({
    sql: 'SELECT password_hash FROM users WHERE id = ?',
    args: [me.id],
  });
  const stored = rows[0]?.password_hash || null;
  if (stored && !verifyPassword(String(body.currentPassword ?? ''), stored)) {
    throw new HttpError(403, 'Current password is wrong.');
  }

  const remove = body.password === null || body.password === '';
  const next = remove ? null : hashPassword(checkPassword(body.password, { required: true }));
  await db().execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [next, me.id] });

  // Changing credentials invalidates other devices.
  await db().execute({
    sql: 'DELETE FROM sessions WHERE user_id = ? AND token <> ?',
    args: [me.id, bearer(req) || ''],
  });
  return { user: { ...me, hasPassword: !remove } };
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const body = await readBody(req);

  switch (body.action) {
    case 'enter':
      res.status(200).json(await enter(body));
      return;
    case 'logout':
      res.status(200).json(await logout(req));
      return;
    case 'set-color':
      res.status(200).json(await setColor(req, body));
      return;
    case 'set-password':
      res.status(200).json(await setPassword(req, body));
      return;
    default:
      throw new HttpError(400, `Unknown action: ${body.action}`);
  }
});
