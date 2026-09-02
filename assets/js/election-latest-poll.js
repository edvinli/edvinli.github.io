(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var timeseries = document.getElementById("election-timeseries");
  var frame = document.getElementById("election-timeseries-frame");
  if (!timeseries || !frame) return;

  ["election-timeseries-provenance-note", "election-timeseries-dynamics-note"].forEach(function (id) {
    var node = document.getElementById(id);
    if (node) node.remove();
  });

  var host = document.getElementById("election-latest-poll");
  if (!host) {
    host = document.createElement("section");
    host.id = "election-latest-poll";
    host.className = "election-latest-poll";
    host.hidden = true;
    host.setAttribute("aria-labelledby", "election-latest-poll-title");
    frame.insertAdjacentElement("afterend", host);
  }

  var style = document.createElement("style");
  style.textContent = [
    ".election-latest-poll{border-top:1px solid var(--el-rule);margin-top:.75rem;padding-top:.85rem}",
    ".election-latest-poll__title{font-family:var(--el-mono);font-size:.92rem;margin:0 0 .45rem}",
    ".election-latest-poll__items{display:grid;gap:.75rem}",
    ".election-latest-poll__item{min-width:0}",
    ".election-latest-poll__meta{color:var(--el-muted);font-size:.78rem;margin:0 0 .45rem}",
    ".election-latest-poll__parties{display:grid;gap:.3rem .85rem;grid-template-columns:repeat(8,minmax(0,1fr));margin:0}",
    ".election-latest-poll__party{border-top:1px solid var(--el-rule);display:flex;justify-content:space-between;gap:.35rem;padding-top:.25rem;min-width:0}",
    ".election-latest-poll__party dt{font-family:var(--el-mono);font-size:.75rem;font-weight:700;margin:0}",
    ".election-latest-poll__party dd{font-family:var(--el-mono);font-size:.75rem;font-variant-numeric:tabular-nums;margin:0;white-space:nowrap}",
    ".election-latest-poll__note{margin:.45rem 0 0}",
    "@media(max-width:46em){.election-latest-poll__parties{grid-template-columns:repeat(4,minmax(0,1fr))}}",
    "@media(max-width:26em){.election-latest-poll__parties{grid-template-columns:repeat(2,minmax(0,1fr))}}"
  ].join("");
  document.head.appendChild(style);

  var base = String(app.getAttribute("data-publication-base") || "").replace(/\/$/, "");
  var PARTY_ORDER = ["M", "L", "C", "KD", "S", "V", "MP", "SD"];
  var MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function isoDate(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    return match ? match[1] + "-" + match[2] + "-" + match[3] : null;
  }

  function swedishDate(value) {
    var iso = isoDate(value);
    if (!iso) return "";
    var parts = iso.split("-");
    return Number(parts[2]) + " " + MONTHS[Number(parts[1]) - 1] + " " + parts[0];
  }

  function numeric(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    var parsed = Number(value.trim().replace(/\u00a0/g, "").replace(/\s/g, "").replace(/%$/, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function pollDate(poll) {
    return isoDate(poll && (poll.publication_date || poll.date || poll.published || poll.publicationDate));
  }

  function pollParties(poll) {
    var source = poll && (poll.parties || poll.values || poll.party_values);
    if (!source || typeof source !== "object") return null;
    var parties = {};
    var total = 0;
    for (var index = 0; index < PARTY_ORDER.length; index += 1) {
      var party = PARTY_ORDER[index];
      var value = numeric(source[party]);
      if (value === null || value < 0) return null;
      parties[party] = value;
      total += value;
    }
    if (total <= 0) return null;
    var scale = total <= 2 ? 100 : 1;
    PARTY_ORDER.forEach(function (party) { parties[party] *= scale; });
    return parties;
  }

  function percent(value) {
    return Number(value).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " %";
  }

  function metadata(poll, date) {
    var pieces = [];
    pieces.push(String(poll.company || poll.house || poll.pollster || poll.institute || "Okänt institut"));
    if (date) pieces.push(swedishDate(date));
    var start = isoDate(poll.fieldwork_start || poll.fieldworkStart || poll.start_date);
    var end = isoDate(poll.fieldwork_end || poll.fieldworkEnd || poll.end_date);
    if (start && end) pieces.push("fältperiod " + swedishDate(start) + "–" + swedishDate(end));
    else if (end) pieces.push("fältarbete till " + swedishDate(end));
    else if (start) pieces.push("fältarbete från " + swedishDate(start));
    var n = numeric(poll.n || poll.sample_size || poll.samplesize);
    if (n !== null && n > 0) pieces.push("n = " + Math.round(n).toLocaleString("sv-SE"));
    return pieces.join(" · ");
  }

  function renderPoll(poll, date, index) {
    var parties = pollParties(poll);
    if (!parties) return "";
    var company = String(poll.company || poll.house || poll.pollster || poll.institute || "Okänt institut");
    var rows = PARTY_ORDER.map(function (party) {
      return "<div class=\"election-latest-poll__party\" data-party=\"" + party + "\" data-value=\"" + parties[party].toFixed(6) +
        "\"><dt>" + party + "</dt><dd>" + escapeHtml(percent(parties[party])) + "</dd></div>";
    }).join("");
    return "<article class=\"election-latest-poll__item\" data-latest-poll-item=\"true\" data-poll-index=\"" + index +
      "\" data-poll-company=\"" + escapeHtml(company) + "\"><p class=\"election-latest-poll__meta\">" +
      escapeHtml(metadata(poll, date)) + "</p><dl class=\"election-latest-poll__parties\">" + rows + "</dl></article>";
  }

  function render(history) {
    var polls = history && Array.isArray(history.polls) ? history.polls : [];
    var dated = polls.map(function (poll) { return { poll: poll, date: pollDate(poll) }; }).filter(function (item) {
      return item.date && pollParties(item.poll);
    });
    if (!dated.length) return;
    var latestDate = dated.reduce(function (latest, item) { return !latest || item.date > latest ? item.date : latest; }, null);
    var latest = dated.filter(function (item) { return item.date === latestDate; });
    var items = latest.map(function (item, index) { return renderPoll(item.poll, item.date, index); }).filter(Boolean).join("");
    if (!items) return;
    host.setAttribute("data-latest-poll-date", latestDate);
    host.setAttribute("data-latest-poll-count", String(latest.length));
    host.innerHTML = "<h3 id=\"election-latest-poll-title\" class=\"election-latest-poll__title\">" +
      (latest.length === 1 ? "Senaste mätningen" : "Senaste mätningarna") + "</h3><div class=\"election-latest-poll__items\">" +
      items + "</div><p class=\"election-latest-poll__note election-muted\">" +
      (latest.length === 1 ? "En enskild opinionsmätning, inte modellens prognos." : "Enskilda opinionsmätningar, inte modellens prognos.") +
      "</p>";
    host.hidden = false;
  }

  fetch(base + "/history/coalition-timeseries.json").then(function (response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function (history) {
    if (history) render(history);
  }).catch(function () {});
})();
