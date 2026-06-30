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

let weeksData = null;
let overheadEnabled = localStorage.getItem('overheadEnabled') === 'true';

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
  });
}

async function render() {
  const container = document.getElementById('weeks');
  initToggle();
  try {
    const res = await fetch('data/weekly-hours.json');
    if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
    weeksData = await res.json();
    renderWeeks();
  } catch (err) {
    container.innerHTML = `<p class="empty-msg">Error: ${err.message}</p>`;
  }
}

render();
