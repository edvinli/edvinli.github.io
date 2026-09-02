(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var root = document.getElementById("election-seats");
  var bars = document.getElementById("election-seat-bars");
  if (!root || !bars) return;

  var base = String(app.getAttribute("data-publication-base") || "").replace(/\/$/, "");
  var MAJORITY = 175;
  var partyColors = {
    M: "#3657A7", L: "#4A9AD6", C: "#2B8569", KD: "#5B7C9B",
    S: "#ED1B34", V: "#A81420", MP: "#4C983E", SD: "#A87F00"
  };

  // Keep the DOM order stable for the existing page contract, but present
  // Mandat immediately after Röstandelar. The mandate panel itself has no
  // focusable controls, so this does not reorder keyboard interaction.
  function placeMandatesAfterVotes() {
    var voteSection = document.getElementById("election-headline");
    var children = Array.prototype.slice.call(app.children);
    var voteIndex = children.indexOf(voteSection);
    var seatIndex = children.indexOf(root);
    if (voteIndex < 0 || seatIndex < 0 || seatIndex === voteIndex + 1) return;

    var visualOrder = children.filter(function (child) { return child !== root; });
    voteIndex = visualOrder.indexOf(voteSection);
    visualOrder.splice(voteIndex + 1, 0, root);

    app.style.display = "flex";
    app.style.flexDirection = "column";
    visualOrder.forEach(function (child, index) {
      child.style.order = String(index);
    });
    root.setAttribute("data-visual-order", "after-vote-shares");
  }

  placeMandatesAfterVotes();

  var intro = root.querySelector(".election-panel__head .election-muted");
  if (intro) {
    intro.textContent = "Median mandat med centrala 50- och 90-procentiga prognosintervall. Det är prognosintervall, inte konfidensintervall. Riksdagen har 349 mandat och 175 krävs för majoritet. Medianerna beräknas var för sig och behöver därför inte summera till 349.";
  }

  var style = document.createElement("style");
  style.textContent = [
    // The legend symbol should resemble the deliberately faded poll points,
    // not read as a standalone black observation in the chart.
    ".election-timeseries__key-mark--polls{opacity:.28}",

    // Match the Röstandelar row rhythm immediately. Interval styling only
    // activates after a row has all five published seat quantiles, so a
    // failed secondary fetch can never turn the original party bar gray.
    "#election-seats .election-seat-bars{border-top:1px solid var(--el-rule);margin-top:1.2rem}",
    "#election-seats .es-row{min-height:2.9rem;padding:.35rem .15rem}",
    "#election-seats .es-track{background:var(--el-fill-soft);height:1.15rem}",
    "#election-seats .es-row[data-opacity-bands=\"true\"] .es-track{overflow:hidden}",
    "#election-seats .es-row[data-opacity-bands=\"true\"] .es-bar{opacity:0}",
    "#election-seats .es-row[data-opacity-bands=\"true\"] .es-range{bottom:0;height:auto;top:0;transform:none;background:currentColor;border:0;opacity:.3}",
    "#election-seats .es-row[data-opacity-bands=\"true\"] .es-range.es-range--50{opacity:.95}",
    "#election-seats .es-row[data-opacity-bands=\"true\"] .es-median-mark{background:#fff;bottom:-2px;box-shadow:0 0 0 1px rgba(44,42,37,.75);position:absolute;top:-2px;transform:translateX(-1px);width:2px}",
    "#election-seats .es-row[data-opacity-bands=\"true\"] .es-range,#election-seats .es-median-mark{pointer-events:none}",
    "#election-seats .election-legend-note{margin-top:1rem}",
    "@media (max-width:600px){#election-seats .es-row{padding:.55rem .15rem}}",
    "@media (forced-colors:active){#election-seats .es-range,#election-seats .es-median-mark{forced-color-adjust:none}}"
  ].join("");
  document.head.appendChild(style);

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function loadSeats() {
    return fetch(base + "/current.json").then(function (response) {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Could not load current.json");
      return response.json();
    }).then(function (pointer) {
      var rootPath = pointer && pointer.path ? base + "/" + pointer.path : base;
      return fetch(rootPath + "/seats.json").then(function (response) {
        if (!response.ok) throw new Error("Could not load seats.json");
        return response.json();
      });
    });
  }

  function enhance(seats) {
    var order = seats && Array.isArray(seats.party_order) ? seats.party_order : [];
    var summaries = seats && seats.seat_summary ? seats.seat_summary : {};
    var distributions = seats && seats.seat_distributions ? seats.seat_distributions : {};
    var rows = Array.prototype.slice.call(bars.querySelectorAll(".es-row"));
    if (!rows.length || !order.length) return false;

    rows.forEach(function (row, index) {
      if (row.getAttribute("data-opacity-bands") === "true") return;
      var party = order[index];
      var summary = party && summaries[party];
      var distribution = party && distributions[party];
      var quantiles = distribution && distribution.quantiles ? distribution.quantiles : {};
      var track = row.querySelector(".es-track");
      var bar = row.querySelector(".es-bar");
      var oldRange = row.querySelector(".es-range");
      var abbr = row.querySelector(".es-abbr");
      var medianValue = row.querySelector(".es-median");
      var chart = row.querySelector(".es-chart");
      var majority = row.querySelector(".es-majority");
      if (!summary || !track || !bar || !oldRange || !majority) return;

      // p25/p75 are intentionally published with each discrete seat
      // distribution, while seat_summary contains only median and p05/p95.
      var p05 = number(quantiles.p05);
      var p25 = number(quantiles.p25);
      var medianSeats = number(quantiles.p50);
      var p75 = number(quantiles.p75);
      var p95 = number(quantiles.p95);
      if (p05 === null) p05 = number(summary.p05);
      if (medianSeats === null) medianSeats = number(summary.median);
      if (p95 === null) p95 = number(summary.p95);

      var majorityLeft = number(parseFloat(majority.style.left));
      var scale = majorityLeft !== null && majorityLeft > 0 ? 100 * MAJORITY / majorityLeft : null;
      if ([p05, p25, medianSeats, p75, p95, scale].some(function (value) { return value === null; }) ||
          !(p05 <= p25 && p25 <= medianSeats && medianSeats <= p75 && p75 <= p95) || scale <= 0) return;

      var color = partyColors[party] || bar.style.backgroundColor || "currentColor";

      row.classList.add("ev-row");
      if (abbr) abbr.classList.add("ev-abbr");
      if (medianValue) medianValue.classList.add("ev-median");
      if (chart) chart.classList.add("ev-chart");
      track.classList.add("ev-track");
      majority.classList.add("ev-threshold");

      oldRange.classList.add("es-range--90", "ev-band", "ev-band--90");
      oldRange.style.left = (100 * p05 / scale).toFixed(3) + "%";
      oldRange.style.width = Math.max(0.4, 100 * (p95 - p05) / scale).toFixed(3) + "%";
      oldRange.style.color = color;
      oldRange.style.background = "currentColor";
      oldRange.setAttribute("data-p05", String(p05));
      oldRange.setAttribute("data-p95", String(p95));

      var fifty = document.createElement("span");
      fifty.className = "es-range es-range--50 ev-band ev-band--50";
      fifty.style.left = (100 * p25 / scale).toFixed(3) + "%";
      fifty.style.width = Math.max(0.4, 100 * (p75 - p25) / scale).toFixed(3) + "%";
      fifty.style.color = color;
      fifty.style.background = "currentColor";
      fifty.setAttribute("data-p25", String(p25));
      fifty.setAttribute("data-p75", String(p75));

      var median = document.createElement("span");
      median.className = "es-median-mark ev-median-mark";
      median.style.left = (100 * medianSeats / scale).toFixed(3) + "%";
      median.setAttribute("data-median", String(medianSeats));

      track.appendChild(fifty);
      track.appendChild(median);
      row.setAttribute("data-opacity-bands", "true");
      row.setAttribute("data-interval-display", "90-50-median");
      row.setAttribute("data-party", party);
    });

    var complete = rows.length >= order.length && rows.slice(0, order.length).every(function (row) {
      return row.getAttribute("data-opacity-bands") === "true";
    });

    if (complete && !document.getElementById("election-seat-opacity-legend")) {
      var legend = document.createElement("p");
      legend.id = "election-seat-opacity-legend";
      legend.className = "election-legend-note election-muted";
      legend.setAttribute("aria-label", "Osäkerhet i mandatprognosen");
      legend.innerHTML =
        "<span class=\"election-key\"><span class=\"election-key__mark election-key__mark--median\" aria-hidden=\"true\"></span>median</span>" +
        "<span class=\"election-key\"><span class=\"election-key__mark election-key__mark--p50\" aria-hidden=\"true\"></span>50 % intervall</span>" +
        "<span class=\"election-key\"><span class=\"election-key__mark election-key__mark--p90\" aria-hidden=\"true\"></span>90 % intervall</span>" +
        "<span class=\"election-key\"><span class=\"election-key__mark election-key__mark--threshold\" aria-hidden=\"true\"></span>175 mandat</span>";
      bars.insertAdjacentElement("afterend", legend);
    }
    return complete;
  }

  loadSeats().then(function (seats) {
    var observer = new MutationObserver(function () {
      if (enhance(seats)) observer.disconnect();
    });
    observer.observe(bars, { childList: true, subtree: true });
    if (enhance(seats)) observer.disconnect();
  }).catch(function () {
    // Presentation-only enhancement. If the independent reload fails, the
    // original renderer remains fully visible in its party colours.
  });
})();
