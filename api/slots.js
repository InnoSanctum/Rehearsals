import {
  HttpError,
  SLOTS_PER_DAY,
  assertDayInRange,
  db,
  handler,
  readBody,
  requireUser,
} from './_lib.js';

/** Keep each statement well under SQLite's bound-parameter ceiling. */
const CHUNK = 400;

function parseRect(body) {
  const days = Array.isArray(body.days) ? body.days : [];
  if (!days.length) throw new HttpError(400, 'No days given.');
  if (days.length > 400) throw new HttpError(400, 'Too many days in one request.');
  for (const day of days) assertDayInRange(day);

  const a = Number(body.startIdx);
  const b = Number(body.endIdx);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new HttpError(400, 'startIdx/endIdx must be integers.');
  const startIdx = Math.min(a, b);
  const endIdx = Math.max(a, b);
  if (startIdx < 0 || endIdx >= SLOTS_PER_DAY) {
    throw new HttpError(400, `Slot index out of range (0..${SLOTS_PER_DAY - 1}).`);
  }
  return { days: [...new Set(days)], startIdx, endIdx };
}

async function addSlots(userId, rect) {
  const rows = [];
  for (const day of rect.days) {
    for (let idx = rect.startIdx; idx <= rect.endIdx; idx += 1) rows.push([userId, day, idx]);
  }
  const c = db();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await c.execute({
      sql:
        'INSERT OR IGNORE INTO slots (user_id, day, idx) VALUES ' +
        chunk.map(() => '(?, ?, ?)').join(', '),
      args: chunk.flat(),
    });
  }
  return rows.length;
}

async function removeSlots(userId, rect) {
  const c = db();
  for (let i = 0; i < rect.days.length; i += CHUNK) {
    const chunk = rect.days.slice(i, i + CHUNK);
    await c.execute({
      sql:
        'DELETE FROM slots WHERE user_id = ? AND idx BETWEEN ? AND ? AND day IN (' +
        chunk.map(() => '?').join(', ') +
        ')',
      args: [userId, rect.startIdx, rect.endIdx, ...chunk],
    });
  }
  return rect.days.length * (rect.endIdx - rect.startIdx + 1);
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const me = await requireUser(req);
  const body = await readBody(req);

  if (body.mode === 'clear-all') {
    await db().execute({ sql: 'DELETE FROM slots WHERE user_id = ?', args: [me.id] });
    res.status(200).json({ ok: true, cleared: true });
    return;
  }

  if (body.mode !== 'add' && body.mode !== 'remove') {
    throw new HttpError(400, 'mode must be "add", "remove" or "clear-all".');
  }

  const rect = parseRect(body);
  const cells = body.mode === 'add' ? await addSlots(me.id, rect) : await removeSlots(me.id, rect);
  res.status(200).json({ ok: true, mode: body.mode, cells });
});
