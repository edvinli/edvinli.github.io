/*
 * Göteborgsvarvet 2026 results explorer — interactive Plotly dashboard.
 *
 * Reads an anonymized per-runner JSON (gender / age_band / start_group /
 * finish_minutes; no names or bibs) and renders six aggregate views. All
 * aggregation happens in the browser; nothing identifying is present in the
 * data or shown on screen.
 */
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('gbg-root');
  if (!root) return;
  const DATA_URL = root.dataset.jsonPath;

  const MEN_C = '#2b6cb0';
  const WOMEN_C = '#c53030';
  const ALL_C = '#6b46c1';
  const USER_C = '#dd6b20';

  // canonical start-group order (matches the Python SCHEDULE)
  const ORDER = ['Elit', '1', '2', '3', '4', 'Varvetveteraner', '5', '6', '7',
    '8', '9', '10 Team Guld', '11 Team Silver', '12 Volvo', '13 VGR',
    '14 Team Brons', '15', '16', '17', '18', '19', '20', '21', '22', '23',
    '24', '25', '26', '27'];

  const MIN_GROUP = 25;   // min runners to show a start group
  const MIN_BAND = 30;    // min runners to plot an age-band point

  const config = { responsive: true, displayModeBar: false };

  let ALL = [];
  let gender = 'All';
  let userMin = null;

  // ---------------------------------------------------------------- helpers
  const sortNum = (a) => a.slice().sort((x, y) => x - y);

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  const median = (sorted) => quantile(sorted, 0.5);

  function fmtHM(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  function fmtHMS(min) {
    const tot = Math.round(min * 60);
    const h = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60), s = tot % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // accept "1:45:30", "1:45" (h:mm) — short input allowed
  function parseTime(str) {
    if (!str) return null;
    const m = String(str).trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return null;
    const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
    if (mi > 59 || s > 59) return null;
    return h * 60 + mi + s / 60;
  }

  function timeTicks(lo, hi, step = 15) {
    const vals = [], text = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
      vals.push(t); text.push(fmtHM(t));
    }
    return { tickvals: vals, ticktext: text };
  }

  function sample(arr, cap) {
    if (arr.length <= cap) return arr;
    const stride = arr.length / cap, out = [];
    for (let i = 0; i < arr.length; i += stride) out.push(arr[Math.floor(i)]);
    return out;
  }

  const currentSet = () =>
    gender === 'All' ? ALL : ALL.filter((r) => r.gender === gender);

  // ---------------------------------------------------------------- charts
  function renderHistogram() {
    const lo = 55, hi = quantile(sortNum(ALL.map((r) => r.finish_minutes)), 0.995);
    const tt = timeTicks(lo, hi);
    const xbins = { start: lo, end: hi, size: 5 };

    let traces;
    if (gender === 'All') {
      const men = ALL.filter((r) => r.gender === 'Men').map((r) => r.finish_minutes);
      const women = ALL.filter((r) => r.gender === 'Women').map((r) => r.finish_minutes);
      traces = [
        { x: men, type: 'histogram', name: `Men (${men.length.toLocaleString()})`,
          marker: { color: MEN_C }, opacity: 0.6, xbins,
          hovertemplate: '%{y} runners<extra>Men</extra>' },
        { x: women, type: 'histogram', name: `Women (${women.length.toLocaleString()})`,
          marker: { color: WOMEN_C }, opacity: 0.6, xbins,
          hovertemplate: '%{y} runners<extra>Women</extra>' },
      ];
    } else {
      const v = currentSet().map((r) => r.finish_minutes);
      traces = [{ x: v, type: 'histogram',
        name: `${gender} (${v.length.toLocaleString()})`,
        marker: { color: gender === 'Men' ? MEN_C : WOMEN_C }, xbins,
        hovertemplate: '%{y} runners<extra></extra>' }];
    }

    const layout = {
      barmode: 'overlay',
      margin: { t: 10, r: 20, b: 50, l: 60 },
      xaxis: { title: 'Finish time (net)', range: [lo, hi], ...tt },
      yaxis: { title: 'Runners' },
      legend: { orientation: 'h', y: 1.12 },
      shapes: [], annotations: [],
    };
    if (userMin !== null) {
      layout.shapes.push({ type: 'line', x0: userMin, x1: userMin, yref: 'paper',
        y0: 0, y1: 1, line: { color: USER_C, width: 2, dash: 'dash' } });
      layout.annotations.push({ x: userMin, yref: 'paper', y: 1.02,
        text: `you ${fmtHMS(userMin)}`, showarrow: false, font: { color: USER_C, size: 11 } });
    }
    Plotly.react('gbg-hist', traces, layout, config);
  }

  function renderPercentile() {
    const build = (g) => {
      const s = sortNum(ALL.filter((r) => r.gender === g).map((r) => r.finish_minutes));
      const idx = sample(s.map((_, i) => i), 400);
      return {
        x: idx.map((i) => (i / (s.length - 1)) * 100),
        y: idx.map((i) => s[i]),
        sorted: s,
      };
    };
    const men = build('Men'), women = build('Women');
    const lo = Math.min(men.y[0], women.y[0]);
    const hi = Math.max(men.y[men.y.length - 1], women.y[women.y.length - 1]);
    const tt = timeTicks(lo, hi);

    const traces = [
      { x: men.x, y: men.y, mode: 'lines', name: 'Men', line: { color: MEN_C, width: 2.5 },
        hovertemplate: 'top %{x:.0f}% · %{y:.1f} min<extra>Men</extra>' },
      { x: women.x, y: women.y, mode: 'lines', name: 'Women', line: { color: WOMEN_C, width: 2.5 },
        hovertemplate: 'top %{x:.0f}% · %{y:.1f} min<extra>Women</extra>' },
    ];

    const layout = {
      margin: { t: 10, r: 20, b: 55, l: 60 },
      xaxis: { title: 'Percentile (0% = fastest)', range: [0, 100] },
      yaxis: { title: 'Finish time', tickvals: tt.tickvals, ticktext: tt.ticktext },
      legend: { orientation: 'h', y: 1.12 },
      shapes: [],
    };

    const info = document.getElementById('gbg-rank-info');
    if (userMin !== null) {
      layout.shapes.push({ type: 'line', x0: 0, x1: 100, y0: userMin, y1: userMin,
        line: { color: USER_C, width: 2, dash: 'dash' } });
      const topPct = (s) => {
        let lo2 = 0, hi2 = s.length;
        while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (s[m] < userMin) lo2 = m + 1; else hi2 = m; }
        return (lo2 / s.length) * 100;
      };
      const mp = topPct(men.sorted), wp = topPct(women.sorted);
      traces.push({ x: [mp], y: [userMin], mode: 'markers', name: 'you (men)',
        marker: { color: MEN_C, size: 11, line: { color: '#fff', width: 2 } }, showlegend: false });
      traces.push({ x: [wp], y: [userMin], mode: 'markers', name: 'you (women)',
        marker: { color: WOMEN_C, size: 11, line: { color: '#fff', width: 2 } }, showlegend: false });
      if (info) info.textContent =
        `Your time ${fmtHMS(userMin)}: top ${mp.toFixed(1)}% among men · top ${wp.toFixed(1)}% among women.`;
    } else if (info) {
      info.textContent = 'Enter your time above to see where you rank.';
    }
    Plotly.react('gbg-percentile', traces, layout, config);
  }

  function renderRidgeline() {
    const set = currentSet();
    const present = ORDER.filter((g) => set.filter((r) => r.start_group === g).length >= MIN_GROUP);
    const xs = [], ys = [];
    present.forEach((g) => {
      const v = sample(set.filter((r) => r.start_group === g).map((r) => r.finish_minutes), 800);
      v.forEach((t) => { xs.push(t); ys.push(g); });
    });
    const lo = quantile(sortNum(xs), 0.002), hi = quantile(sortNum(xs), 0.998);
    const tt = timeTicks(lo, hi);

    const trace = {
      type: 'violin', x: xs, y: ys, orientation: 'h', side: 'positive',
      points: false, spanmode: 'soft', width: 2.2,
      line: { color: ALL_C, width: 1 }, fillcolor: 'rgba(107,70,193,0.35)',
      hoverinfo: 'skip',
    };
    const layout = {
      margin: { t: 10, r: 20, b: 50, l: 95 },
      xaxis: { title: 'Finish time (net)', range: [lo, hi], ...tt },
      yaxis: { categoryorder: 'array', categoryarray: [...present].reverse(),
        title: 'Start group' },
      showlegend: false,
    };
    Plotly.react('gbg-ridge', [trace], layout, config);
  }

  function renderSeeding() {
    const set = currentSet();
    const present = ORDER.filter((g) => set.filter((r) => r.start_group === g).length >= MIN_GROUP);
    const med = [], p25 = [], p75 = [];
    present.forEach((g) => {
      const s = sortNum(set.filter((r) => r.start_group === g).map((r) => r.finish_minutes));
      med.push(median(s)); p25.push(quantile(s, 0.25)); p75.push(quantile(s, 0.75));
    });
    const lo = Math.min(...p25), hi = Math.max(...p75);
    const tt = timeTicks(lo - 5, hi + 5, 10);

    const traces = [
      { x: present, y: p75, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip' },
      { x: present, y: p25, mode: 'lines', fill: 'tonexty', fillcolor: 'rgba(107,70,193,0.18)',
        line: { width: 0 }, name: 'IQR (25–75%)', hoverinfo: 'skip' },
      { x: present, y: med, mode: 'lines+markers', name: 'median',
        line: { color: ALL_C, width: 2 }, marker: { size: 6 },
        text: med.map(fmtHMS), hovertemplate: '%{x}<br>median %{text}<extra></extra>' },
    ];
    const layout = {
      margin: { t: 10, r: 20, b: 90, l: 60 },
      xaxis: { title: 'Start group', type: 'category', categoryorder: 'array',
        categoryarray: present, tickangle: -55 },
      yaxis: { title: 'Finish time', tickvals: tt.tickvals, ticktext: tt.ticktext },
      legend: { orientation: 'h', y: 1.12 },
    };
    Plotly.react('gbg-seeding', traces, layout, config);
  }

  function renderAging() {
    const build = (g) => {
      const byBand = {};
      ALL.filter((r) => r.gender === g && r.age_band != null)
        .forEach((r) => { (byBand[r.age_band] ||= []).push(r.finish_minutes); });
      const bands = Object.keys(byBand).map(Number).sort((a, b) => a - b)
        .filter((b) => byBand[b].length >= MIN_BAND);
      return { x: bands, y: bands.map((b) => median(sortNum(byBand[b]))) };
    };
    const men = build('Men'), women = build('Women');
    const all = men.y.concat(women.y);
    const tt = timeTicks(Math.min(...all) - 5, Math.max(...all) + 5, 5);

    const traces = [
      { x: men.x, y: men.y, mode: 'lines+markers', name: 'Men', line: { color: MEN_C },
        text: men.y.map(fmtHMS), hovertemplate: 'age %{x}+<br>median %{text}<extra>Men</extra>' },
      { x: women.x, y: women.y, mode: 'lines+markers', name: 'Women', line: { color: WOMEN_C },
        text: women.y.map(fmtHMS), hovertemplate: 'age %{x}+<br>median %{text}<extra>Women</extra>' },
    ];
    const layout = {
      margin: { t: 10, r: 20, b: 50, l: 60 },
      xaxis: { title: 'Age band (lower bound of age class)' },
      yaxis: { title: 'Median finish time', tickvals: tt.tickvals, ticktext: tt.ticktext },
      legend: { orientation: 'h', y: 1.12 },
    };
    Plotly.react('gbg-aging', traces, layout, config);
  }

  function renderMilestones() {
    const set = currentSet();
    const v = set.map((r) => r.finish_minutes);
    const lo = 60, hi = quantile(sortNum(v), 0.99);
    const tt = timeTicks(lo, hi);
    const ms = [90, 120, 150, 180];

    const trace = { x: v, type: 'histogram', xbins: { start: lo, end: hi, size: 1 },
      marker: { color: ALL_C }, hovertemplate: '%{x} · %{y} runners<extra></extra>' };
    const layout = {
      margin: { t: 10, r: 20, b: 50, l: 60 },
      xaxis: { title: 'Finish time (net) — 1-minute bins', range: [lo, hi], ...tt },
      yaxis: { title: 'Runners' },
      shapes: ms.map((m) => ({ type: 'line', x0: m, x1: m, yref: 'paper', y0: 0, y1: 1,
        line: { color: WOMEN_C, width: 1.2 } })),
      annotations: ms.map((m) => ({ x: m, yref: 'paper', y: 1.02, text: fmtHM(m),
        showarrow: false, font: { color: WOMEN_C, size: 10 } })),
    };
    Plotly.react('gbg-milestones', [trace], layout, config);
  }

  // ---------------------------------------------------------------- wiring
  function renderAll() {
    renderHistogram();
    renderPercentile();
    renderRidgeline();
    renderSeeding();
    renderAging();
    renderMilestones();
  }

  function setGender(g) {
    gender = g;
    document.querySelectorAll('.gbg-gender-btn').forEach((b) =>
      b.classList.toggle('gbg-active', b.dataset.gender === g));
    renderAll();
  }

  function initControls() {
    document.querySelectorAll('.gbg-gender-btn').forEach((b) =>
      b.addEventListener('click', () => setGender(b.dataset.gender)));
    const input = document.getElementById('gbg-time-input');
    const apply = () => {
      const t = parseTime(input.value);
      userMin = t;
      if (t !== null) input.value = fmtHMS(t);
      renderHistogram();
      renderPercentile();
    };
    document.getElementById('gbg-time-btn').addEventListener('click', apply);
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    setGender('All');
  }

  function showError(msg) {
    root.querySelectorAll('.gbg-plot').forEach((d) => {
      d.innerHTML = `<p style="color:#c53030">Could not load race data: ${msg}</p>`;
    });
  }

  if (typeof Plotly === 'undefined') {
    showError('charting library failed to load.');
    return;
  }
  fetch(DATA_URL)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data) => {
      ALL = data.filter((r) => typeof r.finish_minutes === 'number' && !isNaN(r.finish_minutes));
      initControls();
    })
    .catch((err) => showError(err.message));
});
