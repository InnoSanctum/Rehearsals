/* Small helpers shared by the app. All date maths runs on 'YYYY-MM-DD'
   strings in UTC so the grid never shifts when the clock crosses DST. */

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

function toKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayKey() {
  return toKey(new Date());
}

export function utc(day) {
  return new Date(day + 'T00:00:00Z');
}

export function addDays(day, n) {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a, b) {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/** Clamps `day` into [lo, hi] inclusive. */
export function clampDay(day, lo, hi) {
  if (day < lo) return lo;
  if (day > hi) return hi;
  return day;
}

function weekday(day) {
  return utc(day).getUTCDay(); // 0 = Sunday
}

export function isWeekend(day) {
  const w = weekday(day);
  return w === 0 || w === 6;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function weekdayName(day) {
  return WEEKDAYS[weekday(day)];
}

export function monthName(day) {
  return MONTHS[utc(day).getUTCMonth()];
}

export function dayNum(day) {
  return utc(day).getUTCDate();
}

/** Monday of the week containing `day` (weeks run Monday..Sunday). */
export function mondayOf(day) {
  return addDays(day, -((weekday(day) + 6) % 7));
}

/** '7–13 Sep', or '31 Aug–6 Sep' when the week crosses a month. */
export function weekLabel(monday) {
  const a = utc(monday);
  const b = utc(addDays(monday, 6));
  const mon = (d) => MONTHS[d.getUTCMonth()].slice(0, 3);
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${mon(b)}`
    : `${a.getUTCDate()} ${mon(a)}–${b.getUTCDate()} ${mon(b)}`;
}

/** '9 Sep 2026' */
export function prettyDay(day) {
  const d = utc(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** Slot index -> 'HH:MM'. */
export function slotTime(idx, slotMinutes) {
  const total = idx * slotMinutes;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** Slot index for the wall-clock time right now. */
export function currentSlot(slotMinutes) {
  const now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / slotMinutes);
}

/* ------------------------------------------------------------------ colour */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function mixHex(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

/* --------------------------------------------------------------------- dom */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function $(id) {
  return document.getElementById(id);
}

export function toast(message, kind = '') {
  const host = $('toasts');
  if (!host) return;
  const node = el('div', `toast ${kind}`.trim(), message);
  host.appendChild(node);
  window.setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3200);
}

/** Reads a px-valued CSS custom property from :root. */
export function cssPx(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return Number.parseFloat(raw) || 0;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}
