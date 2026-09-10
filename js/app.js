import APP_CONFIG from '../app.config.js';
import * as api from './api.js';
import { Grid } from './grid.js';
import {
  $,
  addDays,
  clampDay,
  cssPx,
  currentSlot,
  debounce,
  diffDays,
  el,
  prettyDay,
  slotTime,
  todayKey,
  toast,
} from './util.js';

/* ================================================================= state == */

const SHIFT_DAYS = 7;      // how far the window slides when you reach an edge
const POLL_MS = 20000;     // background refresh while the tab is visible
const PREFETCH_DAYS = 7;   // extra days fetched on each side of the window

const state = {
  cfg: {
    maxUsers: APP_CONFIG.maxUsers,
    rangeStart: APP_CONFIG.rangeStart,
    rangeEnd: APP_CONFIG.rangeEnd,
    slotMinutes: APP_CONFIG.slotMinutes,
    slotsPerDay: Math.round(1440 / APP_CONFIG.slotMinutes),
    greenThreshold: APP_CONFIG.greenThreshold,
    palette: APP_CONFIG.palette.slice(),
  },
  users: [],
  usersById: new Map(),
  me: null,
  seatsUsed: 0,
  seatsLeft: 0,
  availableColors: [],
  /** Map<day, Map<slotIdx, Set<userId>>> */
  marks: new Map(),
  /** Map<day, Set<slotIdx>> - the signed-in person's own marks */
  mine: new Map(),
  winStart: APP_CONFIG.rangeStart,
  winLen: 28,
  lastSync: null,
};

const lastDayOfRange = () => addDays(state.cfg.rangeEnd, -1);

/* ================================================================== dom === */

const dom = {
  scrollMine: $('scroll-mine'),
  scrollAll: $('scroll-all'),
  panels: $('panels'),
  roster: $('roster'),
  seats: $('seats'),
  syncState: $('syncState'),
  rangeLabel: $('rangeLabel'),
  rangeNote: $('rangeNote'),
  legend: $('legend'),
  mineHint: $('mineHint'),
};

const gridMine = new Grid($('grid-mine'), {
  kind: 'mine',
  slotsPerDay: state.cfg.slotsPerDay,
  slotMinutes: state.cfg.slotMinutes,
});
const gridAll = new Grid($('grid-all'), {
  kind: 'all',
  slotsPerDay: state.cfg.slotsPerDay,
  slotMinutes: state.cfg.slotMinutes,
});

/* ========================================================== marks helpers = */

function markSet(day, idx) {
  let perDay = state.marks.get(day);
  if (!perDay) state.marks.set(day, (perDay = new Map()));
  let set = perDay.get(idx);
  if (!set) perDay.set(idx, (set = new Set()));
  return set;
}

function rebuildMine() {
  state.mine = new Map();
  const myId = state.me?.id;
  if (myId == null) return;
  for (const [day, perDay] of state.marks) {
    let own = null;
    for (const [idx, ids] of perDay) {
      if (!ids.has(myId)) continue;
      if (!own) state.mine.set(day, (own = new Set()));
      own.add(idx);
    }
  }
}

function applyLocalRect(days, startIdx, endIdx, mode) {
  const myId = state.me?.id;
  if (myId == null) return;
  for (const day of days) {
    for (let idx = startIdx; idx <= endIdx; idx += 1) {
      if (mode === 'add') {
        markSet(day, idx).add(myId);
      } else {
        state.marks.get(day)?.get(idx)?.delete(myId);
      }
    }
  }
  rebuildMine();
}

/* ============================================================ day window == */

function effectiveLen() {
  const total = diffDays(state.cfg.rangeStart, state.cfg.rangeEnd);
  const colW = cssPx('--col-w') || 84;
  const visible = Math.ceil(Math.max(0, dom.scrollMine.clientWidth - cssPx('--time-w')) / colW);
  // Always keep more columns loaded than fit on screen, otherwise there is
  // nothing to scroll and the sliding window can never advance.
  return Math.max(4, Math.min(total, Math.max(state.winLen, visible + 10)));
}

function windowDays() {
  const len = effectiveLen();
  const days = new Array(len);
  for (let i = 0; i < len; i += 1) days[i] = addDays(state.winStart, i);
  return days;
}

function maxWinStart() {
  return clampDay(
    addDays(state.cfg.rangeEnd, -effectiveLen()),
    state.cfg.rangeStart,
    lastDayOfRange(),
  );
}

function setWinStart(day) {
  const next = clampDay(day, state.cfg.rangeStart, maxWinStart());
  if (next === state.winStart && gridMine.dayCount) return false;
  state.winStart = next;
  return true;
}

function renderWindow() {
  const days = windowDays();
  const today = todayKey();
  const opts = { today, nowIdx: currentSlot(state.cfg.slotMinutes) };
  gridMine.render(days, opts);
  gridAll.render(days, opts);
  repaint();
  updateRangeLabel(days);
  scheduleLoad();
}

function updateRangeLabel(days) {
  dom.rangeLabel.textContent = `${prettyDay(days[0])} – ${prettyDay(days[days.length - 1])}`;
}

/** Moves the window and keeps the viewport visually still. */
function slideWindow(deltaDays, scroller) {
  const before = state.winStart;
  if (!setWinStart(addDays(state.winStart, deltaDays))) return;
  const moved = diffDays(before, state.winStart);
  if (!moved) return;

  const keepLeft = scroller ? scroller.scrollLeft - moved * (cssPx('--col-w') || 84) : null;
  renderWindow();
  if (scroller && keepLeft != null) {
    scroller.scrollLeft = Math.max(0, keepLeft);
    mirrorScroll(scroller);
  }
}

/* ============================================================== scrolling = */

let syncing = false;

function mirrorScroll(src) {
  if (syncing) return;
  syncing = true;
  const other = src === dom.scrollMine ? dom.scrollAll : dom.scrollMine;
  if (other.scrollLeft !== src.scrollLeft) other.scrollLeft = src.scrollLeft;
  if (other.scrollTop !== src.scrollTop) other.scrollTop = src.scrollTop;
  syncing = false;
}

function maybeSlide(scroller) {
  if (drag) return; // day indices must stay stable mid-drag
  const colW = cssPx('--col-w') || 84;
  const maxScroll = scroller.scrollWidth - scroller.clientWidth;
  if (maxScroll < colW) return;

  const days = gridMine.days;
  if (!days.length) return;
  const pad = colW * 2;

  if (scroller.scrollLeft < pad && days[0] > state.cfg.rangeStart) {
    slideWindow(-Math.min(SHIFT_DAYS, diffDays(state.cfg.rangeStart, days[0])), scroller);
  } else if (
    scroller.scrollLeft > maxScroll - pad &&
    days[days.length - 1] < lastDayOfRange()
  ) {
    slideWindow(Math.min(SHIFT_DAYS, diffDays(days[days.length - 1], lastDayOfRange())), scroller);
  }
}

function onScroll(event) {
  const scroller = event.currentTarget;
  mirrorScroll(scroller);
  maybeSlide(scroller);
}

dom.scrollMine.addEventListener('scroll', onScroll, { passive: true });
dom.scrollAll.addEventListener('scroll', onScroll, { passive: true });

/** Puts `day` in view, `offsetCols` columns in from the left edge. */
function focusDay(day, offsetCols = 1) {
  const target = clampDay(day, state.cfg.rangeStart, lastDayOfRange());
  setWinStart(addDays(target, -Math.floor(effectiveLen() / 2)));
  renderWindow();
  const di = gridMine.days.indexOf(target);
  if (di >= 0) {
    dom.scrollMine.scrollLeft = Math.max(0, (di - offsetCols) * (cssPx('--col-w') || 84));
    mirrorScroll(dom.scrollMine);
  }
}

/* ============================================================== painting == */

function repaint() {
  gridMine.paintMine(state.mine);
  gridAll.paintCombined(state.marks, {
    threshold: state.cfg.greenThreshold,
    myId: state.me?.id ?? null,
  });
}

/* ================================================================ loading = */

let inflight = null;
let inflightKey = '';
let pendingWrites = 0;

async function load({ quiet = false } = {}) {
  const days = gridMine.days;
  if (!days.length) return;
  const from = clampDay(addDays(days[0], -PREFETCH_DAYS), state.cfg.rangeStart, lastDayOfRange());
  const to = clampDay(
    addDays(days[days.length - 1], PREFETCH_DAYS + 1),
    state.cfg.rangeStart,
    state.cfg.rangeEnd,
  );

  // A request for exactly this range is already running - don't duplicate it.
  const key = `${from}|${to}`;
  if (inflight && inflightKey === key) return;

  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  inflightKey = key;
  if (!quiet) dom.syncState.textContent = 'syncing…';

  try {
    const data = await api.fetchState({ from, to, signal: controller.signal });
    applyServerState(data, from, to);
    state.lastSync = new Date();
    dom.syncState.textContent = `synced ${state.lastSync.toLocaleTimeString()}`;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    dom.syncState.textContent = 'offline';
    if (!quiet) toast(err.message || 'Could not load data.', 'error');
  } finally {
    if (inflight === controller) {
      inflight = null;
      inflightKey = '';
    }
  }
}

const scheduleLoad = debounce(() => load({ quiet: true }), 220);

function applyServerState(data, from, to) {
  if (data.settings) {
    if (data.settings.slotsPerDay !== state.cfg.slotsPerDay) {
      console.warn('Server slot size differs from app.config.js; reload after redeploying.');
    }
    state.cfg = { ...state.cfg, ...data.settings };
  }

  state.users = data.users || [];
  state.usersById = new Map(state.users.map((u) => [u.id, u]));
  state.seatsUsed = data.seatsUsed ?? state.users.length;
  state.seatsLeft = data.seatsLeft ?? Math.max(0, state.cfg.maxUsers - state.users.length);
  state.availableColors = data.availableColors || [];

  const wasSignedIn = !!state.me;
  state.me = data.me || null;
  if (wasSignedIn && !state.me) toast('Your session expired — sign in again.', 'error');

  // Replace every day in the fetched range so removals propagate.
  if (data.range) {
    for (let day = data.range.from; day < data.range.to; day = addDays(day, 1)) {
      state.marks.delete(day);
    }
    for (const [day, perDay] of Object.entries(data.marks || {})) {
      const map = new Map();
      for (const [idx, ids] of Object.entries(perDay)) map.set(Number(idx), new Set(ids));
      state.marks.set(day, map);
    }
  }

  // Drop days far outside the loaded window so memory stays bounded.
  const lo = addDays(from, -60);
  const hi = addDays(to, 60);
  for (const day of state.marks.keys()) {
    if (day < lo || day > hi) state.marks.delete(day);
  }

  rebuildMine();
  repaint();
  renderChrome();
}

/* ================================================================= chrome = */

function renderChrome() {
  // roster chips
  dom.roster.replaceChildren(
    ...state.users.map((u) => {
      const chip = el('span', `chip${state.me && u.id === state.me.id ? ' is-me' : ''}`);
      const sw = el('span', 'swatch');
      sw.style.background = u.color;
      chip.append(sw, el('span', null, u.name));
      if (u.hasPassword) chip.append(el('span', 'lock', '🔒'));
      return chip;
    }),
  );

  dom.seats.textContent = `${state.seatsUsed}/${state.cfg.maxUsers} people`;

  const signedIn = !!state.me;
  $('signInBtn').hidden = signedIn;
  $('accountBtn').hidden = !signedIn;
  $('clearAllBtn').hidden = !signedIn;
  if (signedIn) {
    $('accountBtn').textContent = state.me.name;
    document.documentElement.style.setProperty('--me-color', state.me.color);
    dom.mineHint.textContent = 'Drag to mark · drag over marked cells to erase';
  } else {
    dom.mineHint.textContent = 'Sign in to start marking';
  }
  gridMine.root.classList.toggle('locked', !signedIn);

  // legend
  const threshold = state.cfg.greenThreshold;
  const steps = [...new Set([0, 1, Math.max(1, threshold - 1), threshold])].sort((a, b) => a - b);
  dom.legend.replaceChildren(
    ...steps.map((n) => {
      const span = el('span');
      const box = el('span', 'box');
      box.style.background = gridAll.scaleColor(n, threshold);
      span.append(box, document.createTextNode(n >= threshold ? `${threshold}+` : String(n)));
      return span;
    }),
  );

  dom.rangeNote.textContent =
    `${prettyDay(state.cfg.rangeStart)} – ${prettyDay(lastDayOfRange())} · ` +
    `${state.cfg.slotMinutes}-min slots`;
}

/* =================================================== combined-cell tooltip */

gridAll.root.addEventListener('pointerover', (event) => {
  const cell = event.target.closest?.('.cell');
  if (!cell || !gridAll.root.contains(cell)) return;
  const ids = state.marks.get(cell._day)?.get(cell._idx);
  const names = ids ? [...ids].map((id) => state.usersById.get(id)?.name || `#${id}`) : [];
  const when = `${prettyDay(cell._day)} ${slotTime(cell._idx, state.cfg.slotMinutes)}`;
  cell.title = names.length ? `${when}\n${names.join(', ')}` : `${when}\nnobody yet`;
});

/* ================================================================= drag === */

let drag = null;

function cellFromPoint(x, y) {
  const node = document.elementFromPoint(x, y);
  const cell = node?.closest?.('.cell');
  return cell && gridMine.root.contains(cell) ? cell : null;
}

function clearPreview() {
  if (!drag) return;
  for (const cell of drag.preview) cell.classList.remove('preview-add', 'preview-remove');
  drag.preview.length = 0;
}

function rectOf(d) {
  const a = gridMine.days.indexOf(d.anchorDay);
  const b = gridMine.days.indexOf(d.curDay);
  if (a < 0 || b < 0) return null;
  return {
    d0: Math.min(a, b),
    d1: Math.max(a, b),
    i0: Math.min(d.anchorIdx, d.curIdx),
    i1: Math.max(d.anchorIdx, d.curIdx),
  };
}

function updatePreview() {
  clearPreview();
  const rect = rectOf(drag);
  if (!rect) return;
  const cls = drag.mode === 'add' ? 'preview-add' : 'preview-remove';
  for (let di = rect.d0; di <= rect.d1; di += 1) {
    for (let idx = rect.i0; idx <= rect.i1; idx += 1) {
      const cell = gridMine.cellAt(di, idx);
      if (!cell) continue;
      cell.classList.add(cls);
      drag.preview.push(cell);
    }
  }
}

function beginDrag(cell, pointerId) {
  const marked = !!state.mine.get(cell._day)?.has(cell._idx);
  drag = {
    anchorDay: cell._day,
    anchorIdx: cell._idx,
    curDay: cell._day,
    curIdx: cell._idx,
    mode: marked ? 'remove' : 'add',
    pointerId,
    preview: [],
  };
  updatePreview();
}

async function commitDrag() {
  if (!drag) return;
  const rect = rectOf(drag);
  const mode = drag.mode;
  clearPreview();
  drag = null;
  if (!rect || !state.me) return;

  const days = gridMine.days.slice(rect.d0, rect.d1 + 1);
  applyLocalRect(days, rect.i0, rect.i1, mode);
  repaint();

  pendingWrites += 1;
  try {
    await api.writeSlots({ mode, days, startIdx: rect.i0, endIdx: rect.i1 });
    dom.syncState.textContent = `saved ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    toast(err.message || 'Could not save that change.', 'error');
    pendingWrites -= 1;
    await load(); // server is the source of truth - pull the real picture back
    return;
  }
  pendingWrites -= 1;
}

let tap = null; // touch taps toggle a single cell; touch drags scroll the grid

dom.scrollMine.addEventListener('pointerdown', (event) => {
  const cell = cellFromPoint(event.clientX, event.clientY);
  if (!cell) return;
  if (!state.me) {
    openSignIn();
    return;
  }
  if (event.pointerType === 'touch') {
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, cell };
    return;
  }
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  beginDrag(cell, event.pointerId);
  dom.scrollMine.setPointerCapture(event.pointerId);
});

dom.scrollMine.addEventListener('pointermove', (event) => {
  if (tap && event.pointerId === tap.id) {
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) tap = null;
    return;
  }
  if (!drag || event.pointerId !== drag.pointerId) return;
  autoScrollFromPointer(event.clientX);
  const cell = cellFromPoint(event.clientX, event.clientY);
  if (!cell || (cell._day === drag.curDay && cell._idx === drag.curIdx)) return;
  drag.curDay = cell._day;
  drag.curIdx = cell._idx;
  updatePreview();
});

function toggleSingle(cell) {
  const mode = state.mine.get(cell._day)?.has(cell._idx) ? 'remove' : 'add';
  drag = {
    anchorDay: cell._day,
    anchorIdx: cell._idx,
    curDay: cell._day,
    curIdx: cell._idx,
    mode,
    preview: [],
  };
  commitDrag();
}

function endDrag(event) {
  if (tap && event && event.pointerId === tap.id) {
    const { cell } = tap;
    tap = null;
    if (event.type === 'pointerup') toggleSingle(cell);
    return;
  }
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  stopAutoScroll();
  try {
    dom.scrollMine.releasePointerCapture(drag.pointerId);
  } catch {
    /* pointer already released */
  }
  commitDrag();
}

dom.scrollMine.addEventListener('pointerup', endDrag);
dom.scrollMine.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => {
  tap = null;
  if (drag) {
    clearPreview();
    drag = null;
    stopAutoScroll();
  }
});

// Keep the browser context menu from leaving a half-finished drag behind.
dom.scrollMine.addEventListener('contextmenu', () => {
  if (drag) {
    clearPreview();
    drag = null;
    stopAutoScroll();
  }
});

/* --- edge auto-scroll while dragging --- */

let autoScrollDx = 0;
let autoScrollRaf = 0;

function autoScrollFromPointer(clientX) {
  const box = dom.scrollMine.getBoundingClientRect();
  const zone = 48;
  if (clientX < box.left + zone) autoScrollDx = -Math.ceil((box.left + zone - clientX) / 4);
  else if (clientX > box.right - zone) autoScrollDx = Math.ceil((clientX - (box.right - zone)) / 4);
  else autoScrollDx = 0;

  if (autoScrollDx && !autoScrollRaf) {
    const step = () => {
      if (!drag || !autoScrollDx) {
        autoScrollRaf = 0;
        return;
      }
      dom.scrollMine.scrollLeft += autoScrollDx;
      mirrorScroll(dom.scrollMine);
      autoScrollRaf = requestAnimationFrame(step);
    };
    autoScrollRaf = requestAnimationFrame(step);
  }
}

function stopAutoScroll() {
  autoScrollDx = 0;
  if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
  autoScrollRaf = 0;
}

/* ============================================================== toolbar === */

/** The day currently sitting against the left edge of the viewport. */
function leftmostDay() {
  const colW = cssPx('--col-w') || 84;
  const di = Math.round(dom.scrollMine.scrollLeft / colW);
  return gridMine.days[Math.min(Math.max(di, 0), gridMine.days.length - 1)] || state.winStart;
}

for (const button of document.querySelectorAll('[data-nav]')) {
  button.addEventListener('click', () => {
    focusDay(addDays(leftmostDay(), Number(button.dataset.nav)), 0);
  });
}

$('todayBtn').addEventListener('click', () => focusDay(todayKey()));

// Keyboard: arrows walk the day axis, Shift+arrow jumps a month, T = today.
window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const overlayOpen = !$('signInOverlay').hidden || !$('accountOverlay').hidden;
  if (event.key === 'Escape') {
    $('signInOverlay').hidden = true;
    $('accountOverlay').hidden = true;
    return;
  }
  if (overlayOpen) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const step = event.shiftKey ? 28 : 7;
  if (event.key === 'ArrowRight') focusDay(addDays(leftmostDay(), step), 0);
  else if (event.key === 'ArrowLeft') focusDay(addDays(leftmostDay(), -step), 0);
  else if (event.key === 't' || event.key === 'T') focusDay(todayKey());
  else return;
  event.preventDefault();
});

$('jumpDate').addEventListener('change', (event) => {
  if (event.target.value) focusDay(event.target.value);
});

$('windowLen').addEventListener('change', (event) => {
  const anchor = leftmostDay();
  state.winLen = Number(event.target.value);
  localStorage.setItem('rh.winLen', String(state.winLen));
  focusDay(anchor, 0);
});

$('layoutSel').addEventListener('change', (event) => {
  applyLayout(event.target.value);
  localStorage.setItem('rh.layout', event.target.value);
});

function applyLayout(mode) {
  const anchor = leftmostDay();
  dom.panels.classList.toggle('split', mode === 'split');
  dom.panels.classList.toggle('stacked', mode === 'stacked');
  requestAnimationFrame(() => focusDay(anchor, 0));
}

$('clearAllBtn').addEventListener('click', async () => {
  if (!state.me) return;
  if (!confirm(`Remove every slot you marked, ${state.me.name}?`)) return;
  try {
    await api.clearAllSlots();
    toast('All your slots were cleared.');
    await load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ============================================================== sign in === */

let pendingColor = null;

function openSignIn() {
  pendingColor = null;
  $('signInError').hidden = true;
  $('passwordInput').value = '';
  $('signInOverlay').hidden = false;
  updateSignInForm();
  $('nameInput').focus();
}

function closeSignIn() {
  $('signInOverlay').hidden = true;
}

function knownUser(name) {
  const key = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!key) return null;
  return state.users.find((u) => u.name.toLocaleLowerCase() === key) || null;
}

function updateSignInForm() {
  const name = $('nameInput').value;
  const existing = knownUser(name);
  const info = $('signInInfo');

  $('knownNames').replaceChildren(
    ...state.users.map((u) => {
      const opt = document.createElement('option');
      opt.value = u.name;
      return opt;
    }),
  );

  if (existing) {
    $('passwordField').hidden = !existing.hasPassword;
    $('passwordInput').autocomplete = 'current-password';
    $('passwordHelp').textContent = 'Enter the password you set for this name.';
    $('colorField').hidden = true;
    info.hidden = false;
    info.textContent = existing.hasPassword
      ? `Welcome back, ${existing.name}. This name is password protected.`
      : `Welcome back, ${existing.name}. You'll get your existing table.`;
  } else if (name.trim().length >= 2) {
    const full = state.seatsLeft <= 0;
    $('passwordField').hidden = full;
    $('passwordInput').autocomplete = 'new-password';
    $('passwordHelp').textContent = 'Optional — set one to stop others using your name.';
    $('colorField').hidden = full;
    info.hidden = false;
    info.textContent = full
      ? `This board is full (${state.cfg.maxUsers} people). Use one of the existing names, or ask the admin to raise the limit.`
      : `New here — ${state.seatsLeft} of ${state.cfg.maxUsers} seat${state.seatsLeft === 1 ? '' : 's'} left.`;
    renderSwatches($('colorSwatches'), {
      selected: pendingColor || state.availableColors[0] || null,
      taken: new Set(state.users.map((u) => u.color.toLowerCase())),
      onPick: (color) => {
        pendingColor = color;
        updateSignInForm();
      },
    });
  } else {
    $('passwordField').hidden = true;
    $('colorField').hidden = true;
    info.hidden = true;
  }

  $('signInSubmit').disabled = !existing && state.seatsLeft <= 0 && name.trim().length >= 2;
}

function renderSwatches(host, { selected, taken, onPick, allow }) {
  host.replaceChildren(
    ...state.cfg.palette.map((color) => {
      const button = el('button', 'swatch-btn');
      button.type = 'button';
      button.style.background = color;
      button.title = color;
      const isTaken = taken.has(color.toLowerCase()) && color.toLowerCase() !== (allow || '').toLowerCase();
      button.disabled = isTaken;
      button.setAttribute('aria-pressed', String(color.toLowerCase() === (selected || '').toLowerCase()));
      button.addEventListener('click', () => onPick(color));
      return button;
    }),
  );
}

$('nameInput').addEventListener('input', updateSignInForm);
$('signInBtn').addEventListener('click', openSignIn);
$('signInCancel').addEventListener('click', closeSignIn);
$('signInOverlay').addEventListener('mousedown', (event) => {
  if (event.target === $('signInOverlay')) closeSignIn();
});

$('signInForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('signInSubmit');
  const error = $('signInError');
  error.hidden = true;
  submit.disabled = true;
  try {
    await api.enter({
      name: $('nameInput').value,
      password: $('passwordInput').value,
      color: pendingColor || state.availableColors[0],
    });
    closeSignIn();
    await load();
    focusDay(todayKey());
    toast(`Signed in as ${state.me?.name || $('nameInput').value}.`);
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
    if (err.data?.needPassword) {
      $('passwordField').hidden = false;
      $('passwordInput').focus();
    }
    if (err.status === 401 || err.status === 403 || err.status === 409) await load({ quiet: true });
  } finally {
    submit.disabled = false;
  }
});

/* ============================================================== account === */

function openAccount() {
  if (!state.me) return;
  $('accountError').hidden = true;
  $('accountInfo').hidden = true;
  $('accountName').textContent = state.me.name;
  $('currentPwField').hidden = !state.me.hasPassword;
  $('currentPw').value = '';
  $('newPw').value = '';
  $('removePwBtn').hidden = !state.me.hasPassword;
  renderSwatches($('accountSwatches'), {
    selected: state.me.color,
    taken: new Set(state.users.map((u) => u.color.toLowerCase())),
    allow: state.me.color,
    onPick: async (color) => {
      try {
        await api.setColor(color);
        await load();
        openAccount();
        toast('Colour updated.');
      } catch (err) {
        $('accountError').hidden = false;
        $('accountError').textContent = err.message;
      }
    },
  });
  $('accountOverlay').hidden = false;
}

$('accountBtn').addEventListener('click', openAccount);
$('accountClose').addEventListener('click', () => ($('accountOverlay').hidden = true));
$('accountOverlay').addEventListener('mousedown', (event) => {
  if (event.target === $('accountOverlay')) $('accountOverlay').hidden = true;
});

$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await savePassword($('newPw').value);
});

$('removePwBtn').addEventListener('click', () => savePassword(''));

async function savePassword(password) {
  const error = $('accountError');
  const info = $('accountInfo');
  error.hidden = true;
  info.hidden = true;
  try {
    await api.setPassword({ password, currentPassword: $('currentPw').value });
    await load();
    info.hidden = false;
    info.textContent = password ? 'Password saved. Other devices were signed out.' : 'Password removed.';
    $('currentPw').value = '';
    $('newPw').value = '';
    $('currentPwField').hidden = !state.me?.hasPassword;
    $('removePwBtn').hidden = !state.me?.hasPassword;
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
  }
}

$('signOutBtn').addEventListener('click', async () => {
  await api.logout();
  state.me = null;
  rebuildMine();
  repaint();
  renderChrome();
  $('accountOverlay').hidden = true;
  toast('Signed out.');
});

/* ================================================================= boot === */

function restorePrefs() {
  const len = Number(localStorage.getItem('rh.winLen'));
  if (len) {
    state.winLen = len;
    $('windowLen').value = String(len);
  }
  const layout = localStorage.getItem('rh.layout') || 'split';
  $('layoutSel').value = layout;
  dom.panels.classList.toggle('split', layout === 'split');
  dom.panels.classList.toggle('stacked', layout === 'stacked');

  const jump = $('jumpDate');
  jump.min = state.cfg.rangeStart;
  jump.max = lastDayOfRange();
}

function showApiBanner() {
  if (!api.needsRemoteApi) return;
  const banner = el('div', 'alert');
  banner.style.margin = '10px 16px 0';
  banner.textContent =
    'No API configured. GitHub Pages can only serve the page — set apiBase in app.config.js ' +
    'to your Vercel URL, or open this page with ?api=https://your-app.vercel.app';
  document.querySelector('main').prepend(banner);
}

function boot() {
  restorePrefs();
  showApiBanner();

  const today = todayKey();
  setWinStart(addDays(today, -Math.floor(effectiveLen() / 2)));
  renderWindow();
  renderChrome();

  // Land on today, a little after midnight rows so 08:00 is in view.
  focusDay(today);
  const rowH = cssPx('--row-h') || 22;
  dom.scrollMine.scrollTop = 15 * rowH;
  mirrorScroll(dom.scrollMine);

  load();

  const canPoll = () => document.visibilityState === 'visible' && !drag && pendingWrites === 0;
  window.setInterval(() => {
    if (canPoll()) load({ quiet: true });
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (canPoll()) load({ quiet: true });
  });

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', debounce(() => {
    if (Math.abs(window.innerWidth - lastWidth) < 40) return;
    lastWidth = window.innerWidth;
    renderWindow();
  }, 250));
}

boot();
