# Rehearsals — shared availability board

A small When2Meet-style scheduler for one never-ending event. Everyone with the
link paints the half-hour slots they are free; a second grid shows how many
people overlap, and turns grass green once enough of you agree.

- **Range:** 1 Sep 2026 → 31 Aug 2028, 30-minute slots, 00:00–23:30
- **Axes:** days run horizontally (scroll left/right), times run vertically
- **Storage:** Turso / libSQL — shared by everyone, not per-browser
- **Sign in:** by name, with an optional password
- **Seats:** capped (5 by default) and adjustable by the repo admin

---

## Stack

| Piece      | What it is                                                       |
|------------|------------------------------------------------------------------|
| Front end  | Plain ES modules — no build step, no framework, no bundler        |
| API        | Vercel serverless functions in `api/` (`state`, `auth`, `slots`)  |
| Database   | Turso (libSQL) via `@libsql/client`                               |

No build step is what keeps GitHub Pages viable: the same files that Vercel
serves can be copied straight to Pages.

---

## Quick start

```bash
npm install
cp .env.example .env       # then fill in DB_URI and DB_TOKEN
npm run db:init            # creates the tables
npm run dev                # http://localhost:3000
```

`npm run dev` runs `scripts/dev-server.js`, which serves the static files and
executes the `api/` handlers exactly the way Vercel does — no Vercel CLI needed.
`npm run dev:vercel` uses the real `vercel dev` if you prefer.

---

## Deploying

### Vercel (front end **and** API)

1. Import the repo at [vercel.com/new](https://vercel.com/new). It is a static
   project with serverless functions; no framework preset, no build command.
2. Add the environment variables under **Settings → Environment Variables**:

   | Name              | Value                                      | Required |
   |-------------------|--------------------------------------------|----------|
   | `DB_URI`          | `libsql://…turso.io`                       | yes      |
   | `DB_TOKEN`        | your Turso auth token                      | yes      |
   | `MAX_USERS`       | overrides `app.config.js`                  | no       |
   | `ALLOWED_ORIGINS` | comma-separated; defaults to `*`           | no       |

   `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are accepted as aliases.
3. Deploy. The tables are created automatically on the first request, so
   `npm run db:init` is optional here.

### GitHub Pages (front end only)

Pages serves static files only — it cannot run `api/` and cannot hold your Turso
token. So a Pages deployment is the same front end pointed at your Vercel API.

1. Deploy to Vercel first and note the URL.
2. **Settings → Secrets and variables → Actions → Variables**: add `API_BASE`,
   e.g. `https://rehearsals.vercel.app`.
3. **Settings → Pages → Source**: *GitHub Actions*.
4. Push to `main`. [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
   publishes the site and injects the API base into `index.html`.
5. On Vercel, set `ALLOWED_ORIGINS` to include your Pages origin
   (`https://<user>.github.io`) so the browser's CORS check passes.

You can also point any deployment at a different API without rebuilding:
`https://…/?api=https://your-app.vercel.app` (remembered in localStorage;
`?api=` with an empty value clears it).

---

## Admin settings

Everything a repo admin normally wants to change lives in
[`app.config.js`](app.config.js), which the browser **and** the API both import:

```js
maxUsers: 5,                 // how many distinct people may register
rangeStart: '2026-09-01',    // inclusive
rangeEnd: '2028-09-01',      // exclusive
slotMinutes: 30,
greenThreshold: 5,           // people needed to turn a slot grass green
apiBase: '',                 // '' = same origin
palette: [...]               // colours offered to participants
```

Edit, commit, redeploy. `MAX_USERS` as an environment variable overrides
`maxUsers` if you want to change the cap without a commit.

**Freeing a seat** (someone left, or you want to reset the board):

```bash
npm run db:reset      # drops and recreates every table — destructive
```

For a single person, delete their row; their slots and sessions cascade:

```sql
DELETE FROM users WHERE name_key = 'alex';
```

---

## Using it

| Action                   | How                                                        |
|--------------------------|------------------------------------------------------------|
| Mark availability        | Drag a rectangle across empty cells                        |
| Un-mark                  | Drag starting on a cell that is already marked             |
| Toggle one slot          | Click it (tap on touch devices)                            |
| Move through time        | Scroll sideways, use `«  ‹  ›  »`, or ← / → (Shift = month)|
| Jump                     | *Jump to* date picker, *Today* button or the `T` key       |
| Change colour / password | *Account* button, top right                                |
| Start over               | *Clear all mine*                                           |

The day window slides automatically as you reach either edge of the scroller,
so the whole two-year range is reachable by scrolling. Only the days in view are
held in the DOM, which is what keeps a 730-day range responsive.

Both grids scroll together. *Layout* switches between side-by-side and stacked;
stacked shows roughly twice as many days at once.

### Sign-in rules

- A new name claims a seat, picks a free colour, and may set a password.
- An existing name gets that person's table back. If they set a password, it is
  required; if they didn't, the name is open to anyone who types it — which is
  the original brief, and why setting a password is worth doing.
- Once every seat is taken, new names are refused until the admin raises
  `maxUsers` or deletes someone.

Passwords are hashed with scrypt (random 16-byte salt, 64-byte key). Sessions
are opaque random tokens in the `sessions` table; changing a password signs out
every other device. There is no rate limiting on password attempts — fine for a
private board of five, worth adding if you open it wider.

---

## Data model

```
users     id, name, name_key (unique, lowercased), color, password_hash, created_at
sessions  token (pk), user_id, created_at
slots     user_id, day 'YYYY-MM-DD', idx 0..47      -- primary key on all three
```

One row per marked slot. `api/state` collapses them into
`{ day: { slotIndex: [userId, …] } }` for the range in view.

### API

| Route                       | Purpose                                                |
|-----------------------------|--------------------------------------------------------|
| `GET  /api/state?from&to`   | settings, roster, free colours, you, marks for a range  |
| `POST /api/auth`            | `enter` · `logout` · `set-color` · `set-password`       |
| `POST /api/slots`           | `{mode:'add'\|'remove', days[], startIdx, endIdx}` or `{mode:'clear-all'}` |

Writes need `Authorization: Bearer <token>` from `enter`.

---

## Project layout

```
index.html  styles.css       front end shell
app.config.js                shared settings (browser + API)
js/  app.js                  state, window sliding, drag, sign-in
     grid.js                 grid DOM + painting
     api.js                  fetch wrapper, token handling
     util.js                 date / colour / DOM helpers
api/ state.js auth.js slots.js  _lib.js
scripts/ init-db.js dev-server.js
```
