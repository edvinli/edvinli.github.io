(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var root = document.getElementById("election-seats");
  var bars = document.getElementById("election-seat-bars");
  if (!root || !bars) return;

  var base = String(app.getAttribute("data-publication-base") || "").replace(/\/$/, "");

  var style = document.createElement("style");
  style.textContent = [
    ".es-track{overflow:hidden}",
    ".es-bar{opacity:.2}",
    ".es-range{height:100%;top:0;transform:none;background:currentColor;opacity:.22}",
    ".es-range.es-range--50{opacity:.5}",
    ".es-median-mark{position:absolute;top:-2px;bottom:-2px;width:3px;transform:translateX(-1.5px);background:currentColor;box-shadow:0 0 0 1px rgba(255,255,255,.9)}",
    ".es-range,.es-median-mark{pointer-events:none}",
    ".election-seat-legend{display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin-top:1rem}",
    ".election-seat-legend__item{display:inline-flex;align-items:center;gap:.35rem;color:var(--el-muted);font-size:.76rem}",
    ".election-seat-legend__mark{display:inline-block;width:1.5rem;height:.7rem;background:var(--el-ink)}",
    ".election-seat-legend__mark--90{opacity:.22}",
    ".election-seat-legend__mark--50{opacity:.5}",
    ".election-seat-legend__mark--median{width:3px;height:.95rem;opacity:1}",
    "@media (forced-colors:active){.es-range,.es-median-mark,.election-seat-legend__mark{forced-color-adjust:none}}"
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
    var rows = Array.prototype.slice.call(bars.querySelectorAll(".es-row"));
    if (!rows.length || !order.length) return false;

    rows.forEach(function (row, index) {
      if (row.getAttribute("data-opacity-bands") === "true") return;
      var party = order[index];
      var summary = party && summaries[party];
      var track = row.querySelector(".es-track");
      var bar = row.querySelector(".es-bar");
      var oldRange = row.querySelector(".es-range");
      if (!summary || !track || !bar || !oldRange) return;

      var p05 = number(summary.p05);
      var p25 = number(summary.p25);
      var medianSeats = number(summary.median);
      var p75 = number(summary.p75);
      var p95 = number(summary.p95);
      var width90 = number(parseFloat(oldRange.style.width));
      if ([p05, p25, medianSeats, p75, p95, width90].some(function (value) { return value === null; }) ||
          !(p05 <= p25 && p25 <= medianSeats && medianSeats <= p75 && p75 <= p95) || width90 <= 0 || p95 <= p05) return;

      var scale = 100 * (p95 - p05) / width90;
      if (!Number.isFinite(scale) || scale <= 0) return;

      var color = bar.style.backgroundColor || "currentColor";
      oldRange.classList.add("es-range--90");
      oldRange.style.color = color;
      oldRange.style.background = "currentColor";

      var fifty = document.createElement("span");
      fifty.className = "es-range es-range--50";
      fifty.style.left = (100 * p25 / scale).toFixed(3) + "%";
      fifty.style.width = Math.max(0.4, 100 * (p75 - p25) / scale).toFixed(3) + "%";
      fifty.style.color = color;
      fifty.style.background = "currentColor";
      fifty.setAttribute("data-p25", String(p25));
      fifty.setAttribute("data-p75", String(p75));

      var median = document.createElement("span");
      median.className = "es-median-mark";
      median.style.left = (100 * medianSeats / scale).toFixed(3) + "%";
      median.style.color = color;
      median.style.background = "currentColor";
      median.setAttribute("data-median", String(medianSeats));

      track.appendChild(fifty);
      track.appendChild(median);
      row.setAttribute("data-opacity-bands", "true");
      row.setAttribute("data-interval-display", "90-50-median");
      row.setAttribute("data-party", party);
    });

    if (!document.getElementById("election-seat-opacity-legend")) {
      var legend = document.createElement("p");
      legend.id = "election-seat-opacity-legend";
      legend.className = "election-seat-legend";
      legend.setAttribute("aria-label", "Osäkerhet i mandatprognosen");
      legend.innerHTML =
        "<span class=\"election-seat-legend__item\"><span class=\"election-seat-legend__mark election-seat-legend__mark--median\" aria-hidden=\"true\"></span>median</span>" +
        "<span class=\"election-seat-legend__item\"><span class=\"election-seat-legend__mark election-seat-legend__mark--50\" aria-hidden=\"true\"></span>centrala 50 %</span>" +
        "<span class=\"election-seat-legend__item\"><span class=\"election-seat-legend__mark election-seat-legend__mark--90\" aria-hidden=\"true\"></span>centrala 90 %</span>";
      bars.insertAdjacentElement("afterend", legend);
    }
    return true;
  }

  loadSeats().then(function (seats) {
    var observer = new MutationObserver(function () {
      if (enhance(seats)) observer.disconnect();
    });
    observer.observe(bars, { childList: true, subtree: true });
    if (enhance(seats)) observer.disconnect();
  }).catch(function () {
    // Presentation-only enhancement. Leave the original mandate bars intact
    // if the publication data cannot be loaded independently.
  });
})();
