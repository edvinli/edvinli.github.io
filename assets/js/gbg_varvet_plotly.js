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

  // --- palette: tuned to the site's warm cream/paper, monospace theme ---
  const PAGE_BG = '#faf9f5';   // must match the site body bg (_variables.scss)
  const INK = '#2c2a25';       // warm near-black text
  const GRID = '#e7e3da';      // faint warm gridlines
  const FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  const MEN_C = '#3a6ea5';     // slate blue
  const WOMEN_C = '#b5532e';   // terracotta
  const ALL_C = '#6a3d9a';     // deep violet
  const USER_C = '#c8791f';    // amber

  // shared layout look — every chart merges its axes into this
  function baseLayout(extra) {
    return Object.assign({
      font: { family: FONT, color: INK, size: 12 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      hoverlabel: { bgcolor: PAGE_BG, bordercolor: INK,
        font: { family: FONT, color: INK, size: 12 } },
    }, extra);
  }
  const axisStyle = { gridcolor: GRID, linecolor: GRID, zerolinecolor: GRID, ticks: '' };

  // canonical start-group order (matches the Python SCHEDULE)
  const ORDER = ['Elit', '1', '2', '3', '4', 'Varvetveteraner', '5', '6', '7',
    '8', '9', '10 Team Guld', '11 Team Silver', '12 Volvo', '13 VGR',
    '14 Team Brons', '15', '16', '17', '18', '19', '20', '21', '22', '23',
    '24', '25', '26', '27'];

  const MIN_KDE = 2;      // need >=2 points for a sample std / KDE (not a display threshold)
  const MIN_BAND = 30;    // min runners to plot an age-band point

  const config = { responsive: true, displayModeBar: false };

  let ALL = [];
  let gender = 'All';
  let userMin = null;
  let pctGroup = 'All';   // start-group filter for the percentile plot only
  let ridgeGender = 'All'; // gender filter for the ridgeline plot only
  let seedGender = 'All';  // gender filter for the seeding plot only

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

  function linspace(lo, hi, n) {
    const out = [], step = (hi - lo) / (n - 1);
    for (let i = 0; i < n; i++) out.push(lo + step * i);
    return out;
  }

  // Gaussian KDE, Silverman bandwidth — mirrors plot_joydivision_startgroups.py
  function gaussianKde(samples, grid) {
    const n = samples.length;
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    let varsum = 0;
    for (const x of samples) varsum += (x - mean) * (x - mean);
    const sd = Math.sqrt(varsum / (n - 1));
    const s = sortNum(samples);
    const iqr = quantile(s, 0.75) - quantile(s, 0.25);
    let spread = iqr > 0 ? Math.min(sd, iqr / 1.349) : sd;
    if (spread <= 0) spread = sd > 0 ? sd : 1;
    const bw = 0.9 * spread * Math.pow(n, -1 / 5);
    const inv = 1 / (n * bw * Math.sqrt(2 * Math.PI));
    return grid.map((g) => {
      let acc = 0;
      for (let i = 0; i < n; i++) { const u = (g - samples[i]) / bw; acc += Math.exp(-0.5 * u * u); }
      return acc * inv;
    });
  }

  // medium -> deep violet gradient (earliest wave lighter, latest deeper);
  // both ends read clearly on the cream page background.
  function ridgeColor(t) {
    const a = [132, 87, 176], b = [74, 32, 120];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  const currentSet = () =>
    gender === 'All' ? ALL : ALL.filter((r) => r.gender === gender);

  // ---------------------------------------------------------------- charts
  function renderHistogram() {
    const lo = 55, hi = quantile(sortNum(ALL.map((r) => r.finish_minutes)), 0.995);
    const tt = timeTicks(lo, hi);
    const SIZE = 1;                                   // 1-minute bins
    const nbins = Math.ceil((hi - lo) / SIZE);
    const centers = [], labels = [];                  // bin centers + H:MM:SS range labels
    for (let i = 0; i < nbins; i++) {
      const e = lo + i * SIZE;
      centers.push(e + SIZE / 2);
      labels.push(`${fmtHMS(e)}–${fmtHMS(e + SIZE)}`);
    }
    const binCounts = (vals) => {
      const c = new Array(nbins).fill(0);
      vals.forEach((v) => { const k = Math.floor((v - lo) / SIZE); if (k >= 0 && k < nbins) c[k]++; });
      return c;
    };
    // manual bars (not type:histogram) so each bar can carry an H:MM:SS hover label
    const mkBar = (vals, who, color, opacity) => ({
      x: centers, y: binCounts(vals), type: 'bar', width: SIZE,
      name: `${who} (${vals.length.toLocaleString()})`,
      marker: { color }, opacity, customdata: labels,
      hovertemplate: `<b>${who}</b><br>%{customdata}<br>%{y:,} runners<extra></extra>`,
    });

    let traces;
    if (gender === 'All') {
      traces = [
        mkBar(ALL.filter((r) => r.gender === 'Men').map((r) => r.finish_minutes), 'Men', MEN_C, 0.6),
        mkBar(ALL.filter((r) => r.gender === 'Women').map((r) => r.finish_minutes), 'Women', WOMEN_C, 0.6),
      ];
    } else {
      traces = [mkBar(currentSet().map((r) => r.finish_minutes), gender,
        gender === 'Men' ? MEN_C : WOMEN_C, 1)];
    }

    const layout = baseLayout({
      barmode: 'overlay', bargap: 0,
      margin: { t: 10, r: 20, b: 50, l: 60 },
      xaxis: { title: 'Finish time (net)', range: [lo, hi], ...tt, ...axisStyle },
      yaxis: { title: 'Runners', ...axisStyle },
      legend: { orientation: 'h', y: 1.12 },
      shapes: [], annotations: [],
    });
    if (userMin !== null) {
      layout.shapes.push({ type: 'line', x0: userMin, x1: userMin, yref: 'paper',
        y0: 0, y1: 1, line: { color: USER_C, width: 2, dash: 'dash' } });
      layout.annotations.push({ x: userMin, yref: 'paper', y: 1.02,
        text: `you ${fmtHMS(userMin)}`, showarrow: false, font: { color: USER_C, size: 11 } });
    }
    Plotly.react('gbg-hist', traces, layout, config);
  }

  function renderPercentile() {
    const base = pctGroup === 'All' ? ALL : ALL.filter((r) => r.start_group === pctGroup);
    const label = pctGroup === 'All' ? '' : ` (group ${pctGroup})`;
    const info = document.getElementById('gbg-rank-info');

    const build = (g) => {
      const s = sortNum(base.filter((r) => r.gender === g).map((r) => r.finish_minutes));
      if (s.length < 2) return null;
      const idx = sample(s.map((_, i) => i), 400);
      return {
        x: idx.map((i) => (i / (s.length - 1)) * 100),
        y: idx.map((i) => s[i]),
        sorted: s,
      };
    };
    const men = build('Men'), women = build('Women');
    const present = [men, women].filter(Boolean);

    const baseLay = (lo, hi) => {
      const tt = timeTicks(lo, hi);
      return baseLayout({
        margin: { t: 10, r: 20, b: 55, l: 60 },
        xaxis: { title: 'Percentile (0% = fastest)', range: [0, 100], ...axisStyle },
        yaxis: { title: 'Finish time', tickvals: tt.tickvals, ticktext: tt.ticktext, ...axisStyle },
        legend: { orientation: 'h', y: 1.12 },
        shapes: [],
      });
    };

    if (!present.length) {
      Plotly.react('gbg-percentile', [], baseLay(60, 180), config);
      if (info) info.textContent = `No data for group ${pctGroup}.`;
      return;
    }

    const ys = present.flatMap((c) => c.y);
    const layout = baseLay(Math.min(...ys), Math.max(...ys));

    const traces = [];
    if (men) traces.push({ x: men.x, y: men.y, mode: 'lines', name: 'Men',
      line: { color: MEN_C, width: 2.5 }, hovertemplate: 'top %{x:.0f}% · %{y:.1f} min<extra>Men</extra>' });
    if (women) traces.push({ x: women.x, y: women.y, mode: 'lines', name: 'Women',
      line: { color: WOMEN_C, width: 2.5 }, hovertemplate: 'top %{x:.0f}% · %{y:.1f} min<extra>Women</extra>' });

    if (userMin !== null) {
      layout.shapes.push({ type: 'line', x0: 0, x1: 100, y0: userMin, y1: userMin,
        line: { color: USER_C, width: 2, dash: 'dash' } });
      const topPct = (s) => {
        let lo2 = 0, hi2 = s.length;
        while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (s[m] < userMin) lo2 = m + 1; else hi2 = m; }
        return (lo2 / s.length) * 100;
      };
      const segs = [];
      if (men) {
        const mp = topPct(men.sorted);
        traces.push({ x: [mp], y: [userMin], mode: 'markers', name: 'you (men)',
          marker: { color: MEN_C, size: 11, line: { color: PAGE_BG, width: 2 } }, showlegend: false });
        segs.push(`top ${mp.toFixed(1)}% among men`);
      }
      if (women) {
        const wp = topPct(women.sorted);
        traces.push({ x: [wp], y: [userMin], mode: 'markers', name: 'you (women)',
          marker: { color: WOMEN_C, size: 11, line: { color: PAGE_BG, width: 2 } }, showlegend: false });
        segs.push(`top ${wp.toFixed(1)}% among women`);
      }
      if (info) info.textContent = `Your time ${fmtHMS(userMin)}${label}: ${segs.join(' · ')}.`;
    } else if (info) {
      info.textContent = `Enter your time above to see where you rank${label}.`;
    }
    Plotly.react('gbg-percentile', traces, layout, config);
  }

  function renderRidgeline() {
    const set = ridgeGender === 'All' ? ALL : ALL.filter((r) => r.gender === ridgeGender);
    const present = ORDER.filter((g) => set.filter((r) => r.start_group === g).length >= MIN_KDE);
    const n = present.length;
    const allTimes = sortNum(set.map((r) => r.finish_minutes));
    const lo = 58;   // fixed left bound so the axis starts at ~0:58 (first tick 1:00)
    const hi = quantile(allTimes, 0.992);
    const grid = linspace(lo, hi, 220);
    const OVERLAP = 2.3;

    const traces = [], tickvals = [], ticktext = [], countAnno = [];
    present.forEach((g, i) => {
      // use every runner in the group — KDE over all points is cheap and keeps
      // the bandwidth (which depends on n) exact; the drawn polygon is still
      // just `grid` points regardless of n, so Plotly's render cost is unchanged.
      const v = set.filter((r) => r.start_group === g).map((r) => r.finish_minutes);
      let d = gaussianKde(v, grid);
      const dmax = Math.max(...d) || 1;
      d = d.map((x) => x / dmax);                 // equal peak height (classic ridgeline)
      const baseline = n - 1 - i;                 // earliest wave at top
      const yTop = d.map((val) => baseline + val * OVERLAP);
      const col = ridgeColor(i / Math.max(1, n - 1));
      // opaque fill first (occludes the ridge drawn behind/above), then the line
      traces.push({
        x: grid.concat(grid.slice().reverse()),
        y: yTop.concat(grid.map(() => baseline)),
        // fill MUST equal the page bg (PAGE_BG) so front ridges occlude those
        // behind without a visible seam — keep in sync with the site body bg.
        type: 'scatter', mode: 'lines', fill: 'toself', fillcolor: PAGE_BG,
        line: { width: 0 }, hoverinfo: 'skip', showlegend: false,
      });
      traces.push({
        x: grid, y: yTop, type: 'scatter', mode: 'lines',
        line: { color: col, width: 1.2 }, hoverinfo: 'skip', showlegend: false,
      });
      tickvals.push(baseline); ticktext.push(g);
      countAnno.push({ xref: 'paper', x: 1.004, y: baseline, yref: 'y',
        xanchor: 'left', yanchor: 'bottom', showarrow: false,
        text: `n=${v.length.toLocaleString()}`,
        font: { family: FONT, size: 9, color: 'rgba(44,42,37,0.5)' } });
    });

    // invisible point grid covering the whole plot: drives the hover x-spike
    // and a single H:MM:SS label that follows the cursor. A full grid (vs a
    // single row) lets 'closest' hovermode fire anywhere — and 'closest' shows
    // no x-axis coordinate box, so only the H:MM:SS label appears.
    const hx = [], hy = [], ht = [];
    const yLevels = linspace(0, (n - 1) + OVERLAP, 14);
    grid.forEach((gx) => {
      const lab = fmtHMS(gx);
      yLevels.forEach((gy) => { hx.push(gx); hy.push(gy); ht.push(lab); });
    });
    traces.push({
      x: hx, y: hy, mode: 'markers', marker: { opacity: 0, size: 1 },
      text: ht, hovertemplate: '%{text}<extra></extra>', showlegend: false,
    });

    const tt = timeTicks(lo, hi);
    const layout = baseLayout({
      margin: { t: 10, r: 64, b: 50, l: 110 },
      hovermode: 'closest', hoverdistance: -1,
      xaxis: { title: 'Finish time (net)', range: [lo, hi], ...axisStyle,
        zeroline: false, tickvals: tt.tickvals, ticktext: tt.ticktext,
        showspikes: true, spikemode: 'across', spikesnap: 'cursor',
        spikethickness: 1.2, spikecolor: USER_C, spikedash: 'solid' },
      yaxis: { title: 'Start group', tickvals, ticktext, showgrid: false,
        zeroline: false, range: [-0.6, (n - 1) + OVERLAP + 0.4] },
      annotations: countAnno,
      showlegend: false,
    });
    Plotly.react('gbg-ridge', traces, layout, config);
  }

  function renderSeeding() {
    const set = seedGender === 'All' ? ALL : ALL.filter((r) => r.gender === seedGender);
    const present = ORDER.filter((g) => set.filter((r) => r.start_group === g).length >= MIN_KDE);
    const med = [], p25 = [], p75 = [];
    present.forEach((g) => {
      const s = sortNum(set.filter((r) => r.start_group === g).map((r) => r.finish_minutes));
      med.push(median(s)); p25.push(quantile(s, 0.25)); p75.push(quantile(s, 0.75));
    });
    const lo = Math.min(...p25), hi = Math.max(...p75);
    const tt = timeTicks(lo - 5, hi + 5, 10);

    const traces = [
      { x: present, y: p75, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip' },
      { x: present, y: p25, mode: 'lines', fill: 'tonexty', fillcolor: 'rgba(106,61,154,0.16)',
        line: { width: 0 }, name: 'IQR (25–75%)', hoverinfo: 'skip' },
      { x: present, y: med, mode: 'lines+markers', name: 'median',
        line: { color: ALL_C, width: 2 }, marker: { size: 6 },
        text: med.map(fmtHMS), hovertemplate: '%{x}<br>median %{text}<extra></extra>' },
    ];
    const layout = baseLayout({
      margin: { t: 10, r: 20, b: 90, l: 60 },
      xaxis: { title: 'Start group', type: 'category', categoryorder: 'array',
        categoryarray: present, tickangle: -55, ...axisStyle },
      yaxis: { title: 'Finish time', tickvals: tt.tickvals, ticktext: tt.ticktext, ...axisStyle },
      legend: { orientation: 'h', y: 1.12 },
    });
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
    const layout = baseLayout({
      margin: { t: 10, r: 20, b: 50, l: 60 },
      xaxis: { title: 'Age band (lower bound of age class)', ...axisStyle },
      yaxis: { title: 'Median finish time', tickvals: tt.tickvals, ticktext: tt.ticktext, ...axisStyle },
      legend: { orientation: 'h', y: 1.12 },
    });
    Plotly.react('gbg-aging', traces, layout, config);
  }

  // ---------------------------------------------------------------- wiring
  function renderAll() {
    renderHistogram();
    renderPercentile();
    renderRidgeline();
    renderSeeding();
    renderAging();
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

    // ridgeline-only gender toggle (independent of the global buttons)
    document.querySelectorAll('.gbg-ridge-btn').forEach((b) =>
      b.addEventListener('click', () => {
        ridgeGender = b.dataset.gender;
        document.querySelectorAll('.gbg-ridge-btn').forEach((x) =>
          x.classList.toggle('gbg-active', x.dataset.gender === ridgeGender));
        renderRidgeline();
      }));

    // seeding-only gender toggle (independent of the global buttons)
    document.querySelectorAll('.gbg-seed-btn').forEach((b) =>
      b.addEventListener('click', () => {
        seedGender = b.dataset.gender;
        document.querySelectorAll('.gbg-seed-btn').forEach((x) =>
          x.classList.toggle('gbg-active', x.dataset.gender === seedGender));
        renderSeeding();
      }));

    // populate the percentile-plot start-group dropdown
    const sel = document.getElementById('gbg-pct-group');
    if (sel) {
      const groups = ORDER.filter((g) => ALL.filter((r) => r.start_group === g).length >= MIN_KDE);
      sel.innerHTML = '<option value="All">All groups</option>'
        + groups.map((g) => `<option value="${g}">${g}</option>`).join('');
      sel.addEventListener('change', () => { pctGroup = sel.value; renderPercentile(); });
    }

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
