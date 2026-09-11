import {
  dayNum,
  el,
  isWeekend,
  mixHex,
  monthName,
  slotTime,
  utc,
  weekdayName,
} from './util.js';

/** Light-green ramp used for 1 .. threshold-1 people. */
function buildScale(threshold) {
  const scale = ['#ffffff'];
  const steps = Math.max(1, threshold - 1);
  for (let n = 1; n <= steps; n += 1) {
    scale.push(mixHex('#eaf7ed', '#8ed6a3', steps === 1 ? 1 : (n - 1) / (steps - 1)));
  }
  return scale;
}

/**
 * One availability grid: sticky month band + day headers across the top,
 * sticky half-hour labels down the left, one cell per (day, slot).
 *
 * The DOM is built once per day-window and then only re-painted, which is what
 * keeps the sliding horizontal scroll cheap.
 */
export class Grid {
  constructor(gridEl, { kind, slotsPerDay, slotMinutes, nightSlots = 0 }) {
    this.root = gridEl;
    this.kind = kind;
    this.slotsPerDay = slotsPerDay;
    this.slotMinutes = slotMinutes;
    this.perHour = Math.max(1, Math.round(60 / slotMinutes));
    this.nightSlots = nightSlots;
    this.days = [];
    this.cells = [];
    this.heads = [];
    this.root.style.setProperty('--rows', String(slotsPerDay));
  }

  /**
   * Hides the first `nightSlots` rows. Purely visual: hidden rows keep their
   * cells, so indexing, painting and saved data are untouched. Removing whole
   * rows lets the remaining ones flow up while columns stay aligned.
   */
  setNightHidden(hidden) {
    this.root.classList.toggle('hide-night', hidden);
    this.root.style.setProperty('--rows', String(this.slotsPerDay - (hidden ? this.nightSlots : 0)));
  }

  /** Underlines the picked week's day headers, and marks where it would be copied. */
  markWeek(source, target) {
    for (const head of this.heads) {
      head.classList.toggle('picked', source.has(head._day));
      head.classList.toggle('pick-target', target.has(head._day));
    }
  }

  get dayCount() {
    return this.days.length;
  }

  cellAt(dayIndex, slotIdx) {
    return this.cells[slotIdx * this.days.length + dayIndex];
  }

  /** Rebuilds the whole grid for a new day window. */
  render(days, { today, nowIdx } = {}) {
    this.days = days.slice();
    this.cells = new Array(days.length * this.slotsPerDay);
    this.heads = [];
    this.root.style.gridTemplateColumns = `var(--time-w) repeat(${days.length}, var(--col-w))`;

    const frag = document.createDocumentFragment();

    // --- row 1: month band -------------------------------------------------
    frag.appendChild(el('div', 'corner c-month'));
    let i = 0;
    while (i < days.length) {
      const start = i;
      const d0 = utc(days[i]);
      const key = `${d0.getUTCFullYear()}-${d0.getUTCMonth()}`;
      while (i < days.length) {
        const d = utc(days[i]);
        if (`${d.getUTCFullYear()}-${d.getUTCMonth()}` !== key) break;
        i += 1;
      }
      const span = i - start;
      const cell = el('div', 'month-cell');
      cell.style.gridColumn = `span ${span}`;
      cell.appendChild(el('span', null, `${monthName(days[start])} ${d0.getUTCFullYear()}`));
      frag.appendChild(cell);
    }

    // --- row 2: day headers ------------------------------------------------
    frag.appendChild(el('div', 'corner c-head', 'time'));
    for (const day of days) {
      const head = el('div', 'day-head');
      if (isWeekend(day)) head.classList.add('weekend');
      if (day === today) head.classList.add('today');
      head.append(el('span', null, weekdayName(day)), el('b', null, String(dayNum(day))));
      head.title = day;
      head._day = day;
      this.heads.push(head);
      frag.appendChild(head);
    }

    // --- body --------------------------------------------------------------
    for (let idx = 0; idx < this.slotsPerDay; idx += 1) {
      const onHour = idx % this.perHour === 0;
      const night = idx < this.nightSlots;
      const label = el('div', `time-label${onHour ? ' hour' : ''}`, slotTime(idx, this.slotMinutes));
      if (night) label.classList.add('night');
      frag.appendChild(label);

      for (let di = 0; di < days.length; di += 1) {
        const day = days[di];
        const cell = el('div', 'cell');
        if (night) cell.classList.add('night');
        if (onHour) cell.classList.add('hour-start');
        if (isWeekend(day)) cell.classList.add('weekend');
        if (day === today) {
          cell.classList.add('today-col');
          if (idx === nowIdx) cell.classList.add('now');
        }
        cell._di = di;
        cell._idx = idx;
        cell._day = day;
        this.cells[idx * days.length + di] = cell;
        frag.appendChild(cell);
      }
    }

    this.root.replaceChildren(frag);
  }

  /** Paints the signed-in person's own marks. `mine` is Map<day, Set<idx>>. */
  paintMine(mine) {
    const n = this.days.length;
    for (let di = 0; di < n; di += 1) {
      const set = mine.get(this.days[di]);
      for (let idx = 0; idx < this.slotsPerDay; idx += 1) {
        const cell = this.cells[idx * n + di];
        const on = !!set && set.has(idx);
        if (cell.classList.contains('on') !== on) cell.classList.toggle('on', on);
      }
    }
  }

  /** Background for a given headcount, below the consensus threshold. */
  scaleColor(count, threshold = this._scaleFor) {
    this._ensureScale(threshold);
    if (!count) return 'var(--surface)';
    if (count >= threshold) return 'var(--consensus)';
    return this._scale[Math.min(count, this._scale.length - 1)];
  }

  _ensureScale(threshold) {
    if (this._scaleFor !== threshold) {
      this._scale = buildScale(threshold);
      this._scaleFor = threshold;
    }
  }

  /**
   * Paints the combined counts. `marks` is Map<day, Map<idx, Set<userId>>>.
   * Cells at or above `threshold` go grass green.
   */
  paintCombined(marks, { threshold, myId }) {
    this._ensureScale(threshold);
    const scale = this._scale;
    const n = this.days.length;

    for (let di = 0; di < n; di += 1) {
      const perDay = marks.get(this.days[di]);
      for (let idx = 0; idx < this.slotsPerDay; idx += 1) {
        const cell = this.cells[idx * n + di];
        const ids = perDay && perDay.get(idx);
        const count = ids ? ids.size : 0;

        if (cell._count !== count) {
          cell._count = count;
          cell.textContent = count ? String(count) : '';
          const consensus = count >= threshold;
          cell.classList.toggle('consensus', consensus);
          cell.style.backgroundColor =
            consensus || !count ? '' : scale[Math.min(count, scale.length - 1)];
        }
        const mineToo = !!ids && myId != null && ids.has(myId);
        if (cell._mineToo !== mineToo) {
          cell._mineToo = mineToo;
          cell.classList.toggle('mine-too', mineToo);
        }
      }
    }
  }
}
