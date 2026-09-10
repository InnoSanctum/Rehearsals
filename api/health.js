import { db, describeDbFailure, ensureSchema, handler, settings } from './_lib.js';

/**
 * Deployment self-check: open /api/health in a browser to see whether this
 * deployment can actually talk to the database.
 *
 * Reports only whether variables are *present* - never their values.
 */
export default handler(
  async (req, res) => {
    const env = {
      DB_URI: !!(process.env.TURSO_DATABASE_URL || process.env.DB_URI),
      DB_TOKEN: !!(process.env.TURSO_AUTH_TOKEN || process.env.DB_TOKEN),
      MAX_USERS: process.env.MAX_USERS ?? '(unset, using app.config.js)',
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '(unset, defaults to *)',
    };

    const result = { ok: false, env, settings: settings(), database: null };

    if (!env.DB_URI || !env.DB_TOKEN) {
      result.problem =
        'Missing database credentials. In Vercel: Settings -> Environment Variables, ' +
        'add DB_URI and DB_TOKEN, then redeploy.';
      res.status(503).json(result);
      return;
    }

    try {
      await ensureSchema();
      const users = await db().execute('SELECT COUNT(*) AS n FROM users');
      const slots = await db().execute('SELECT COUNT(*) AS n FROM slots');
      result.ok = true;
      result.database = {
        reachable: true,
        users: Number(users.rows[0].n),
        seatsLeft: Math.max(0, settings().maxUsers - Number(users.rows[0].n)),
        markedSlots: Number(slots.rows[0].n),
      };
      res.status(200).json(result);
    } catch (err) {
      console.error(err);
      result.database = { reachable: false };
      result.problem = describeDbFailure(err) || 'The database could not be reached.';
      res.status(503).json(result);
    }
  },
  { schema: false },
);
