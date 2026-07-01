const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const AXIS_START_HOUR = 6;
const AXIS_END_HOUR = 18;
const ASSUMED_ARRIVAL = '08:00';
const ASSUMED_DEPARTURE = '16:00';

const OVERHEAD_DISTANCE_THRESHOLD_METERS = 15000;
const OVERHEAD_SHORT_SECONDS = 3 * 60;
const OVERHEAD_LONG_SECONDS = 10 * 60;

const SUMMARY_PERIODS = [
  { label: '2 Weeks', days: 14 },
  { label: '1 Month', days: 30 },
  { label: '3 Months', days: 90 },
  { label: '6 Months', days: 182 },
  { label: '12 Months', days: 365 },
];

const HEATMAP_BIN_MINUTES = 5;
const HEATMAP_BIN_COUNT = ((AXIS_END_HOUR - AXIS_START_HOUR) * 60) / HEATMAP_BIN_MINUTES;

// Keep in sync with PBKDF2_ITERATIONS in scripts/encrypt.mjs.
const PBKDF2_ITERATIONS = 250000;
const SESSION_STORAGE_KEY = 'arbejdstidPassword';

let weeksData = null;
let overheadEnabled = localStorage.getItem('overheadEnabled') === 'true';

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function decryptPayload(payload, password) {
  const passwordBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(payload.salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintextBuffer));
}

function addDays(dateString, n) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fmtRange(weekStart) {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${addDays(weekStart, 4)}T00:00:00Z`);
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString('en-GB', opts)} – ${end.toLocaleDateString('en-GB', opts)}`;
}

function fmtHours(hours) {
  return `${hours.toFixed(1)}h`;
}

// Maps "HH:mm" to a 0..1 fraction of the AXIS_START_HOUR..AXIS_END_HOUR range, clamped.
function timeToFraction(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const minutes = h * 60 + m;
  const axisStart = AXIS_START_HOUR * 60;
  const axisSpan = (AXIS_END_HOUR - AXIS_START_HOUR) * 60;
  return Math.min(1, Math.max(0, (minutes - axisStart) / axisSpan));
}

function overheadSecondsFor(distanceMeters) {
  if (distanceMeters == null) return 0;
  return distanceMeters < OVERHEAD_DISTANCE_THRESHOLD_METERS
    ? OVERHEAD_SHORT_SECONDS
    : OVERHEAD_LONG_SECONDS;
}

function shiftTime(hhmm, deltaSeconds) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = Math.round(h * 60 + m + deltaSeconds / 60);
  total = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Applies the overhead-time adjustment (if enabled) to a commuted day's
// arrival/departure/hours. Non-commuted (assumed) days are untouched.
function applyOverhead(entry) {
  if (!entry || !entry.commuted || !overheadEnabled) return entry;

  const amOverhead = overheadSecondsFor(entry.amDistance);
  const pmOverhead = overheadSecondsFor(entry.pmDistance);
  const totalOverheadHours = (amOverhead + pmOverhead) / 3600;

  return {
    ...entry,
    arrival: shiftTime(entry.arrival, amOverhead),
    departure: shiftTime(entry.departure, -pmOverhead),
    hours: Math.max(0, entry.hours - totalOverheadHours),
  };
}

function levelClass(entry) {
  if (!entry) return 'empty';
  return entry.commuted ? 'commuted' : 'assumed';
}

function fmtDiff(diff) {
  const sign = diff < 0 ? '-' : '';
  return `${sign}${Math.abs(diff).toFixed(1)}h`;
}

function diffClass(diff) {
  return diff < 0 ? 'negative' : 'positive';
}

function dayCell(weekStart, offset, daysByDate) {
  const date = addDays(weekStart, offset);
  const entry = applyOverhead(daysByDate.get(date));

  const arrival = entry ? (entry.commuted ? entry.arrival : ASSUMED_ARRIVAL) : null;
  const departure = entry ? (entry.commuted ? entry.departure : ASSUMED_DEPARTURE) : null;

  const barStyle =
    arrival && departure
      ? `bottom:${timeToFraction(arrival) * 100}%;height:${
          (timeToFraction(departure) - timeToFraction(arrival)) * 100
        }%`
      : '';

  const timeLabels = entry?.commuted
    ? `<span class="bar-time bar-time-top">${departure}</span><span class="bar-time bar-time-bottom">${arrival}</span>`
    : '';

  const diffLabel = entry?.commuted
    ? `<span class="bar-diff ${diffClass(entry.hours - 8)}">${fmtDiff(entry.hours - 8)}</span>`
    : '';

  return `
    <div class="day ${levelClass(entry)}">
      <div class="day-bar-track">
        ${arrival && departure ? `<div class="day-bar" style="${barStyle}">${timeLabels}${diffLabel}</div>` : ''}
      </div>
      <div class="day-label">${DAY_LABELS[offset]} ${entry?.commuted ? '<span class="bike" title="Commuted by bike">🚲</span>' : ''}</div>
      <div class="day-hours">${entry ? fmtHours(entry.hours) : '—'}</div>
    </div>
  `;
}

function weekCard(week) {
  const daysByDate = new Map(week.days.map((d) => [d.date, d]));
  const dayCells = DAY_LABELS.map((_, i) => dayCell(week.weekStart, i, daysByDate)).join('');
  const totalHours = week.days.reduce((s, d) => s + applyOverhead(d).hours, 0);
  const weekDiff = totalHours - week.days.length * 8;

  return `
    <section class="week-card">
      <header>
        <span class="week-range">${fmtRange(week.weekStart)}</span>
        <span class="week-total">
          ${fmtHours(totalHours)}
          <span class="week-diff ${diffClass(weekDiff)}">${fmtDiff(weekDiff)}</span>
        </span>
      </header>
      <div class="days">${dayCells}</div>
    </section>
  `;
}

function renderWeeks() {
  const container = document.getElementById('weeks');
  if (!weeksData || weeksData.length === 0) {
    container.innerHTML = '<p class="empty-msg">No data yet.</p>';
    return;
  }
  container.innerHTML = weeksData.slice().reverse().map(weekCard).join('');
  renderSummary();
}

function renderSummary() {
  const container = document.getElementById('period-summary');
  if (!weeksData || weeksData.length === 0) {
    container.innerHTML = '';
    return;
  }

  const allDays = weeksData.flatMap((w) => w.days.map((d) => applyOverhead(d)));
  const today = todayDateString();

  container.innerHTML = SUMMARY_PERIODS.map(({ label, days }) => {
    const fromDate = addDays(today, -(days - 1));
    const inRange = allDays.filter((d) => d.date >= fromDate && d.date <= today);
    const diff = inRange.reduce((s, d) => s + (d.hours - 8), 0);

    return `
      <span class="period-badge">
        <span class="period-label">${label}</span>
        <span class="period-diff ${diffClass(diff)}">${fmtDiff(diff)}</span>
      </span>
    `;
  }).join('');
}

// Maps "HH:mm" to a bin index within the 06:00..18:00 axis, clamped.
function timeToBinIndex(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const minutesFromStart = h * 60 + m - AXIS_START_HOUR * 60;
  const idx = Math.floor(minutesFromStart / HEATMAP_BIN_MINUTES);
  return Math.min(HEATMAP_BIN_COUNT - 1, Math.max(0, idx));
}

// day-of-week index 0..4 for Mon..Fri, or -1 for weekends.
function weekdayIndex(dateString) {
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return day >= 1 && day <= 5 ? day - 1 : -1;
}

// Counts, per (hour bin, weekday), how often an arrival or departure fell
// in that bin across all recorded commute days.
function computeHeatmapGrid() {
  const grid = Array.from({ length: HEATMAP_BIN_COUNT }, () => new Array(5).fill(0));
  if (!weeksData) return grid;

  for (const week of weeksData) {
    for (const day of week.days) {
      const entry = applyOverhead(day);
      if (!entry.commuted) continue;
      const dayIdx = weekdayIndex(entry.date);
      if (dayIdx === -1) continue;
      grid[timeToBinIndex(entry.arrival)][dayIdx] += 1;
      grid[timeToBinIndex(entry.departure)][dayIdx] += 1;
    }
  }
  return grid;
}

function heatmapCellColor(count, maxCount) {
  if (count === 0) return '#f1f1f3';
  const alpha = 0.25 + 0.75 * (count / maxCount);
  return `rgba(234, 88, 12, ${alpha.toFixed(2)})`;
}

function renderHeatmap() {
  const panel = document.getElementById('heatmap-panel');
  const container = document.getElementById('heatmap');
  if (!weeksData || weeksData.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const grid = computeHeatmapGrid();
  const maxCount = Math.max(1, ...grid.flat());

  const headerHtml =
    '<div class="heatmap-header"><div></div>' +
    DAY_LABELS.map((d) => `<div class="heatmap-day-label">${d}</div>`).join('') +
    '</div>';

  let bodyHtml = '<div class="heatmap-grid">';
  for (let bin = HEATMAP_BIN_COUNT - 1; bin >= 0; bin--) {
    const minutes = AXIS_START_HOUR * 60 + bin * HEATMAP_BIN_MINUTES;
    const label =
      minutes % 60 === 0 ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:00` : '';
    bodyHtml += `<div class="heatmap-hour-label">${label}</div>`;
    for (let d = 0; d < 5; d++) {
      const count = grid[bin][d];
      bodyHtml += `<div class="heatmap-cell" style="background:${heatmapCellColor(count, maxCount)}" title="${DAY_LABELS[d]} ${label || ''} — ${count} time(s)"></div>`;
    }
  }
  bodyHtml += '</div>';

  container.innerHTML = headerHtml + bodyHtml;
}

function updateToggleButton() {
  const btn = document.getElementById('overhead-toggle');
  btn.setAttribute('aria-pressed', String(overheadEnabled));
  btn.classList.toggle('on', overheadEnabled);
  btn.innerHTML = `Overhead time: <strong>${overheadEnabled ? 'On' : 'Off'}</strong>`;
}

function initToggle() {
  updateToggleButton();
  document.getElementById('overhead-toggle').addEventListener('click', () => {
    overheadEnabled = !overheadEnabled;
    localStorage.setItem('overheadEnabled', String(overheadEnabled));
    updateToggleButton();
    renderWeeks();
    renderHeatmap();
  });
}

async function unlock(payload, password) {
  weeksData = await decryptPayload(payload, password);
  document.getElementById('lock-screen').hidden = true;
  document.getElementById('app-content').hidden = false;
  initToggle();
  renderWeeks();
  renderHeatmap();
}

async function render() {
  const lockScreen = document.getElementById('lock-screen');
  const lockForm = document.getElementById('lock-form');
  const lockError = document.getElementById('lock-error');

  let payload;
  try {
    const res = await fetch('data/weekly-hours.json');
    if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
    payload = await res.json();
  } catch (err) {
    lockScreen.innerHTML = `<p class="empty-msg">Error: ${err.message}</p>`;
    return;
  }

  const cachedPassword = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (cachedPassword) {
    try {
      await unlock(payload, cachedPassword);
      return;
    } catch {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  lockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('lock-password').value;
    lockError.hidden = true;
    try {
      await unlock(payload, password);
      sessionStorage.setItem(SESSION_STORAGE_KEY, password);
    } catch {
      lockError.hidden = false;
    }
  });
}

render();
