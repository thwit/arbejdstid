const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const AXIS_START_HOUR = 6;
const AXIS_END_HOUR = 18;
const ASSUMED_ARRIVAL = '08:00';
const ASSUMED_DEPARTURE = '16:00';

const OVERHEAD_DISTANCE_THRESHOLD_METERS = 15000;
const OVERHEAD_SHORT_SECONDS = 3 * 60;
const OVERHEAD_LONG_SECONDS = 10 * 60;

const LONG_RIDE_DISTANCE_THRESHOLD_METERS = 10000;

const SUMMARY_PERIODS = [
  { label: '2 Weeks', days: 14 },
  { label: '1 Month', days: 30 },
  { label: '3 Months', days: 90 },
  { label: '6 Months', days: 182 },
  { label: '12 Months', days: 365 },
];

const RUNNING_SUM_PERIODS = [
  { label: '2 Weeks', days: 14 },
  { label: '1 Month', days: 30 },
  { label: '3 Months', days: 90 },
];

const HEATMAP_BIN_MINUTES = 5;
const HEATMAP_BIN_COUNT = ((AXIS_END_HOUR - AXIS_START_HOUR) * 60) / HEATMAP_BIN_MINUTES;

// Keep in sync with PBKDF2_ITERATIONS in scripts/encrypt.mjs.
const PBKDF2_ITERATIONS = 250000;
const SESSION_STORAGE_KEY = 'arbejdstidPassword';

let weeksData = null;
let overheadEnabled = localStorage.getItem('overheadEnabled') === 'true';
let runningSumPeriodIndex = Number(localStorage.getItem('runningSumPeriodIndex'));
if (!(runningSumPeriodIndex >= 0 && runningSumPeriodIndex < RUNNING_SUM_PERIODS.length)) {
  runningSumPeriodIndex = 0;
}

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

// Applies the overhead-time adjustment (if enabled) to every biked leg of a
// day: an arrival is pushed later (walking in from the bike rack), a
// departure is pulled earlier (time to head out and start riding).
function applyOverhead(entry) {
  if (!entry) return entry;
  if (!overheadEnabled) return entry;

  const legs = (entry.legs ?? []).map((leg) => {
    if (!leg.biked) return leg;
    const overhead = overheadSecondsFor(leg.distance);
    const time = leg.type === 'arrival' ? shiftTime(leg.time, overhead) : shiftTime(leg.time, -overhead);
    return { ...leg, time };
  });

  return { ...entry, legs };
}

function levelClass(entry) {
  if (!entry) return 'empty';
  return entry.commuted ? 'commuted' : 'assumed';
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function nowTimeString() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Pairs up alternating arrival/departure legs into complete work intervals,
// same algorithm as scripts/build-data.mjs. A trailing unmatched arrival
// (still at work / away and not yet back) is returned separately as
// `dangling` so the caller can resolve it into a live or assumed interval.
function pairLegs(legs) {
  const pairs = [];
  let openArrival = null;
  for (const leg of legs) {
    if (leg.type === 'arrival') {
      if (openArrival == null) openArrival = leg;
    } else if (openArrival != null) {
      pairs.push({ arrival: openArrival, departure: leg });
      openArrival = null;
    }
  }
  // A trailing open arrival is always resolvable. A lone departure (no
  // arrival ever logged that day) is only resolvable when it's the day's
  // only leg — a departure showing up after some complete pairs is instead
  // treated as unexplained noise and dropped.
  const dangling = openArrival ?? (pairs.length === 0 && legs.length === 1 ? legs[0] : null);
  return { pairs, dangling };
}

function pairsHours(pairs) {
  return pairs.reduce(
    (sum, { arrival, departure }) =>
      sum + (timeToMinutes(departure.time) - timeToMinutes(arrival.time)) / 60,
    0
  );
}

// Resolves a day's raw legs into complete pairs for rendering. A trailing
// unmatched leg (biked/logged only one way that day) gets a synthetic
// counterpart: today's open arrival is shown as hours-logged-so-far (live,
// recomputed on every render); a past day's lone leg is assumed to anchor
// an 8h day.
function resolveLegs(entry, today) {
  if (!entry) return null;
  const legs = entry.legs ?? [];
  if (legs.length === 0) return { ...entry, pairs: [], commuted: false };

  const { pairs, dangling } = pairLegs(legs);
  if (!dangling) return { ...entry, pairs, commuted: pairs.length > 0 };

  if (dangling.type === 'arrival') {
    if (entry.date === today) {
      const departure = { type: 'departure', time: nowTimeString(), biked: false, manual: false, live: true };
      return { ...entry, pairs: [...pairs, { arrival: dangling, departure, live: true }], commuted: true };
    }
    const departure = {
      type: 'departure',
      time: shiftTime(dangling.time, 8 * 3600),
      biked: false,
      manual: false,
      synthetic: true,
    };
    return { ...entry, pairs: [...pairs, { arrival: dangling, departure }], commuted: true };
  }

  // Lone departure with no matching arrival logged.
  const arrival = {
    type: 'arrival',
    time: shiftTime(dangling.time, -8 * 3600),
    biked: false,
    manual: false,
    synthetic: true,
  };
  return { ...entry, pairs: [...pairs, { arrival, departure: dangling }], commuted: true };
}

// Full per-day resolution pipeline: overhead adjustment, leg pairing/
// resolution, and total hours derived from the resolved pairs.
function resolvedDay(raw, today) {
  const entry = resolveLegs(applyOverhead(raw), today);
  if (!entry) return null;
  const hours = entry.pairs.length > 0 ? pairsHours(entry.pairs) : entry.hours;
  return { ...entry, hours };
}

function fmtDiff(diff) {
  const sign = diff < 0 ? '-' : '';
  return `${sign}${Math.abs(diff).toFixed(1)}h`;
}

function diffClass(diff) {
  return diff < 0 ? 'negative' : 'positive';
}

// Returns the icon for one leg (arrival/departure) of a day: a linked bike
// emoji for Strava-tracked rides (plus a wind emoji for rides over 10km),
// a train emoji for times logged via the iPhone Shortcut, or nothing for
// assumed/inferred times.
function legIcon(leg) {
  if (leg.biked) {
    const isLong = leg.distance != null && leg.distance > LONG_RIDE_DISTANCE_THRESHOLD_METERS;
    const label = isLong ? '🚲💨' : '🚲';
    const title = isLong ? 'Long ride (>10km) — view on Strava' : 'View on Strava';
    return `<a class="bike" href="https://www.strava.com/activities/${leg.activityId}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`;
  }
  if (leg.manual) {
    return '<span class="bike" title="Logged via iPhone Shortcut">🚄</span>';
  }
  return '';
}

// Renders one arrival/departure pair as a bar within the day's track.
function barHtml(pair) {
  const { arrival, departure } = pair;
  const startFrac = timeToFraction(arrival.time);
  const endFrac = timeToFraction(departure.time);
  const style = `bottom:${startFrac * 100}%;height:${(endFrac - startFrac) * 100}%`;
  const cls = pair.live ? 'live' : 'commuted';

  const arrivalLabel = arrival.synthetic ? `~${arrival.time}` : arrival.time;
  const departureLabel = departure.live ? 'now' : departure.synthetic ? `~${departure.time}` : departure.time;
  const arrivalIcon = legIcon(arrival);
  const departureIcon = departure.live ? '' : legIcon(departure);

  return `<div class="day-bar ${cls}" style="${style}">
    <span class="bar-time bar-time-top">${departureLabel}${departureIcon}</span>
    <span class="bar-time bar-time-bottom">${arrivalLabel}${arrivalIcon}</span>
  </div>`;
}

function assumedBarHtml() {
  const startFrac = timeToFraction(ASSUMED_ARRIVAL);
  const endFrac = timeToFraction(ASSUMED_DEPARTURE);
  const style = `bottom:${startFrac * 100}%;height:${(endFrac - startFrac) * 100}%`;
  return `<div class="day-bar assumed" style="${style}"></div>`;
}

function dayCell(weekStart, offset, daysByDate, today) {
  const date = addDays(weekStart, offset);
  const raw = daysByDate.get(date);
  const entry = raw ? resolvedDay(raw, today) : null;

  const bars = entry ? (entry.pairs.length > 0 ? entry.pairs.map(barHtml).join('') : assumedBarHtml()) : '';
  const isLive = entry?.pairs.some((p) => p.live) ?? false;
  const diff = entry?.commuted ? entry.hours - 8 : null;

  return `
    <div class="day ${levelClass(entry)}${isLive ? ' live' : ''}">
      <div class="day-bar-track">${bars}</div>
      <div class="day-label">${DAY_LABELS[offset]}</div>
      <div class="day-hours">${entry ? fmtHours(entry.hours) : '—'}${
    diff != null ? `<span class="day-diff ${diffClass(diff)}">${fmtDiff(diff)}</span>` : ''
  }</div>
    </div>
  `;
}

function weekCard(week, today) {
  const daysByDate = new Map(week.days.map((d) => [d.date, d]));
  const dayCells = DAY_LABELS.map((_, i) => dayCell(week.weekStart, i, daysByDate, today)).join('');
  const totalHours = week.days.reduce((s, d) => s + resolvedDay(d, today).hours, 0);
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
  const today = todayDateString();
  container.innerHTML = weeksData.slice().reverse().map((w) => weekCard(w, today)).join('');
  renderSummary();
}

function renderSummary() {
  const container = document.getElementById('period-summary');
  if (!weeksData || weeksData.length === 0) {
    container.innerHTML = '';
    return;
  }

  const today = todayDateString();
  const allDays = weeksData.flatMap((w) => w.days.map((d) => resolvedDay(d, today)));

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

function fmtShortDate(dateString) {
  const d = new Date(`${dateString}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}

// Builds the all-time cumulative surplus/deficit series (each day
// contributes hours - 8 to a running total that never resets), then slices
// it down to the requested display window. The window only controls how
// much of the curve is shown — the cumulative values themselves reflect
// the full history up to that point.
function computeRunningSum(days, today, allDaysSorted) {
  let cum = 0;
  const allPoints = allDaysSorted.map((d) => {
    cum += d.hours - 8;
    return { date: d.date, cum };
  });

  const fromDate = addDays(today, -(days - 1));
  const points = allPoints.filter((p) => p.date >= fromDate && p.date <= today);
  return { points, fromDate };
}

function runningSumSvg(points, fromDate, today) {
  if (points.length === 0) return '<p class="empty-msg">No data yet.</p>';

  const width = 600;
  const height = 180;
  const padding = { top: 16, right: 16, bottom: 8, left: 8 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const minVal = Math.min(0, ...points.map((p) => p.cum));
  const maxVal = Math.max(0, ...points.map((p) => p.cum));
  const span = maxVal - minVal || 1;

  const fromMs = new Date(`${fromDate}T00:00:00Z`).getTime();
  const toMs = new Date(`${today}T00:00:00Z`).getTime();
  const totalMs = toMs - fromMs || 1;

  const xFor = (dateStr) => {
    const ms = new Date(`${dateStr}T00:00:00Z`).getTime();
    return padding.left + ((ms - fromMs) / totalMs) * plotW;
  };
  const yFor = (val) => padding.top + (1 - (val - minVal) / span) * plotH;

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(p.date).toFixed(1)},${yFor(p.cum).toFixed(1)}`)
    .join(' ');

  const zeroY = yFor(0);
  const last = points[points.length - 1];
  const lastColor = last.cum < 0 ? '#dc2626' : '#16a34a';

  return `
    <svg viewBox="0 0 ${width} ${height}" class="running-sum-svg" preserveAspectRatio="none">
      <line x1="${padding.left}" y1="${zeroY.toFixed(1)}" x2="${width - padding.right}" y2="${zeroY.toFixed(1)}" class="running-sum-zero" />
      <path d="${pathD}" class="running-sum-line" style="stroke:${lastColor}" fill="none" />
      <circle cx="${xFor(last.date).toFixed(1)}" cy="${yFor(last.cum).toFixed(1)}" r="3" fill="${lastColor}" />
    </svg>
    <div class="running-sum-labels">
      <span>${fmtShortDate(fromDate)}</span>
      <span class="running-sum-current ${diffClass(last.cum)}">${fmtDiff(last.cum)}</span>
      <span>${fmtShortDate(today)}</span>
    </div>
  `;
}

function renderRunningSum() {
  const container = document.getElementById('running-sum-chart');
  if (!weeksData || weeksData.length === 0) {
    container.innerHTML = '';
    return;
  }

  const today = todayDateString();
  const allDaysSorted = weeksData
    .flatMap((w) => w.days.map((d) => resolvedDay(d, today)))
    .sort((a, b) => a.date.localeCompare(b.date));

  const period = RUNNING_SUM_PERIODS[runningSumPeriodIndex];
  const { points, fromDate } = computeRunningSum(period.days, today, allDaysSorted);
  container.innerHTML = runningSumSvg(points, fromDate, today);
}

function renderRunningSumToggle() {
  const container = document.getElementById('running-sum-toggle');
  container.innerHTML = RUNNING_SUM_PERIODS.map(
    (p, i) =>
      `<button type="button" class="segmented-btn${i === runningSumPeriodIndex ? ' active' : ''}" data-index="${i}">${p.label}</button>`
  ).join('');

  container.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      runningSumPeriodIndex = Number(btn.dataset.index);
      localStorage.setItem('runningSumPeriodIndex', String(runningSumPeriodIndex));
      renderRunningSumToggle();
      renderRunningSum();
    });
  });
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
// in that bin across all recorded commute days (every leg of every pair).
function computeHeatmapGrid() {
  const grid = Array.from({ length: HEATMAP_BIN_COUNT }, () => new Array(5).fill(0));
  if (!weeksData) return grid;

  const today = todayDateString();
  for (const week of weeksData) {
    for (const day of week.days) {
      const entry = resolvedDay(day, today);
      if (!entry.commuted) continue;
      const dayIdx = weekdayIndex(entry.date);
      if (dayIdx === -1) continue;
      for (const { arrival, departure } of entry.pairs) {
        grid[timeToBinIndex(arrival.time)][dayIdx] += 1;
        grid[timeToBinIndex(departure.time)][dayIdx] += 1;
      }
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
    renderRunningSum();
  });
}

async function unlock(payload, password) {
  weeksData = await decryptPayload(payload, password);
  document.getElementById('lock-screen').hidden = true;
  document.getElementById('app-content').hidden = false;
  initToggle();
  renderWeeks();
  renderHeatmap();
  renderRunningSumToggle();
  renderRunningSum();
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
