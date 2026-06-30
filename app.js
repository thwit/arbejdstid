function fmtHours(hours) {
  return `${hours.toFixed(1)}h`;
}

async function render() {
  const tbody = document.getElementById('weeks-body');
  try {
    const res = await fetch('data/weekly-hours.json');
    if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
    const weeks = await res.json();

    if (weeks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2">No data yet.</td></tr>';
      return;
    }

    tbody.innerHTML = weeks
      .slice()
      .reverse()
      .map((w) => `<tr><td>${w.weekStart}</td><td>${fmtHours(w.hours)}</td></tr>`)
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2">Error: ${err.message}</td></tr>`;
  }
}

render();
