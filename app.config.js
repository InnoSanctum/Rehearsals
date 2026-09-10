/**
 * Single source of truth for settings a repo admin can change.
 *
 * Used by BOTH the browser (imported by app.js) and the API
 * (imported by api/_lib.js). Environment variables win over the values here,
 * so you can also tune a deployment without touching the repo:
 *
 *   MAX_USERS   -> maxUsers
 *   API_BASE    -> apiBase (also injectable at deploy time, see the Pages workflow)
 */
export const APP_CONFIG = {
  /**
   * Maximum number of distinct people allowed to register.
   * ADMIN: change this number (or set the MAX_USERS env var) and redeploy.
   */
  maxUsers: 5,

  /** Inclusive first day and exclusive last day of the schedulable range. */
  rangeStart: '2026-09-01',
  rangeEnd: '2028-09-01',

  /** Slot length in minutes. 30 -> 48 slots per day (00:00 .. 23:30). */
  slotMinutes: 30,

  /** Number of people that turns a combined slot "grass green". */
  greenThreshold: 5,

  /**
   * Where the API lives.
   *   ''                          -> same origin (Vercel deployment)
   *   'https://xxx.vercel.app'    -> required for GitHub Pages, which is static-only
   * Can be overridden at runtime with ?api=<url> or localStorage['rh.apiBase'].
   */
  apiBase: 'https://https://rehearsals-cyan.vercel.app',

  /**
   * Colours offered to participants. Deliberately contains no greens (green is
   * reserved for the combined/consensus view) and no white (that is a blank slot).
   */
  palette: [
    '#e6194b', // crimson
    '#4363d8', // blue
    '#f58231', // orange
    '#911eb4', // purple
    '#00b7c2', // cyan
    '#f032e6', // magenta
    '#9a6324', // brown
    '#000075', // navy
    '#e2b100', // gold
    '#800000', // maroon
    '#ff8fab', // pink
    '#5d6d7e', // slate
  ],
};

export default APP_CONFIG;
