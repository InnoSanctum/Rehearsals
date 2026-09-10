import { HttpError, currentUser, db, handler, isDay, settings } from './_lib.js';

const MAX_SPAN_DAYS = 400;


function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export default handler(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Use GET.');

  const cfg = settings();
  const url = new URL(req.url, 'http://localhost');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const [usersRes, me] = await Promise.all([
    db().execute('SELECT id, name, color, password_hash, created_at FROM users ORDER BY id'),
    currentUser(req),
  ]);

  const users = usersRes.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    color: r.color,
    hasPassword: !!r.password_hash,
  }));

  const taken = new Set(users.map((u) => u.color.toLowerCase()));
  const payload = {
    settings: cfg,
    users,
    seatsUsed: users.length,
    seatsLeft: Math.max(0, cfg.maxUsers - users.length),
    availableColors: cfg.palette.filter((c) => !taken.has(c.toLowerCase())),
    me,
    marks: {},
    range: null,
    serverTime: new Date().toISOString(),
  };

  if (from || to) {
    if (!isDay(from) || !isDay(to)) throw new HttpError(400, 'from and to must be YYYY-MM-DD.');
    const span = daysBetween(from, to);
    if (span <= 0) throw new HttpError(400, '"to" must be after "from".');
    if (span > MAX_SPAN_DAYS) throw new HttpError(400, `Range too wide (max ${MAX_SPAN_DAYS} days).`);

    // Clamp to the configured window so out-of-range requests stay cheap.
    const lo = from < cfg.rangeStart ? cfg.rangeStart : from;
    const hi = to > cfg.rangeEnd ? cfg.rangeEnd : to;
    payload.range = { from: lo, to: hi };

    if (lo < hi) {
      const { rows } = await db().execute({
        sql: 'SELECT user_id, day, idx FROM slots WHERE day >= ? AND day < ?',
        args: [lo, hi],
      });
      const marks = payload.marks;
      for (const row of rows) {
        const day = String(row.day);
        const bucket = marks[day] || (marks[day] = {});
        const idx = String(Number(row.idx));
        (bucket[idx] || (bucket[idx] = [])).push(Number(row.user_id));
      }
    }
  }

  res.status(200).json(payload);
});

