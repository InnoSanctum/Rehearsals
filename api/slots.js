import {
  HttpError,
  SLOTS_PER_DAY,
  addDaysKey,
  assertDayInRange,
  db,
  handler,
  isDay,
  isInRange,
  mondayOf,
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

/**
 * Makes the week after `body.week` an exact copy of that week (Mon..Sun) for
 * one person: slots missing next week are added, slots next week that are not
 * in this week's pattern are removed. Days whose source or target falls
 * outside the schedule range are skipped.
 *
 * With `dryRun` nothing is written; the counts let the client warn before it
 * removes anything.
 */
async function copyWeek(userId, body) {
  if (!isDay(body.week)) throw new HttpError(400, 'week must be a YYYY-MM-DD date.');
  const source = mondayOf(body.week);
  const target = addDaysKey(source, 7);

  const pairs = [];
  for (let i = 0; i < 7; i += 1) {
    const from = addDaysKey(source, i);
    const to = addDaysKey(source, i + 7);
    if (isInRange(from) && isInRange(to)) pairs.push([from, to]);
  }
  if (!pairs.length) {
    throw new HttpError(400, 'That week cannot be copied: it or the following week is outside the schedule.');
  }

  const shift = new Map(pairs);
  const targets = pairs.map(([, to]) => to);
  const placeholders = (n) => new Array(n).fill('?').join(', ');

  const tx = await db().transaction(body.dryRun ? 'read' : 'write');
  try {
    const { rows } = await tx.execute({
      sql: `SELECT day, idx FROM slots WHERE user_id = ? AND day IN (${placeholders(pairs.length * 2)})`,
      args: [userId, ...pairs.flat()],
    });

    const wanted = new Set(); // next week's slots after the copy
    const existing = new Set(); // next week's slots right now
    for (const row of rows) {
      const day = String(row.day);
      const idx = Number(row.idx);
      if (shift.has(day)) wanted.add(`${shift.get(day)}|${idx}`);
      else existing.add(`${day}|${idx}`);
    }
    const added = [...wanted].filter((key) => !existing.has(key)).length;
    const removed = [...existing].filter((key) => !wanted.has(key)).length;

    if (!body.dryRun && (added || removed)) {
      await tx.execute({
        sql: `DELETE FROM slots WHERE user_id = ? AND day IN (${placeholders(targets.length)})`,
        args: [userId, ...targets],
      });
      const inserts = [...wanted].map((key) => {
        const [day, idx] = key.split('|');
        return [userId, day, Number(idx)];
      });
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const chunk = inserts.slice(i, i + CHUNK);
        await tx.execute({
          sql: 'INSERT INTO slots (user_id, day, idx) VALUES ' + chunk.map(() => '(?, ?, ?)').join(', '),
          args: chunk.flat(),
        });
      }
    }
    await tx.commit();

    return {
      ok: true,
      dryRun: !!body.dryRun,
      source,
      target,
      days: pairs.length,
      sourceSlots: wanted.size,
      targetSlots: existing.size,
      added,
      removed,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* transaction already closed */
    }
    throw err;
  }
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

  if (body.mode === 'copy-week') {
    res.status(200).json(await copyWeek(me.id, body));
    return;
  }

  if (body.mode !== 'add' && body.mode !== 'remove') {
    throw new HttpError(400, 'mode must be "add", "remove", "copy-week" or "clear-all".');
  }

  const rect = parseRect(body);
  const cells = body.mode === 'add' ? await addSlots(me.id, rect) : await removeSlots(me.id, rect);
  res.status(200).json({ ok: true, mode: body.mode, cells });
});
