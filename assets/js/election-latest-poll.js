(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var timeseries = document.getElementById("election-timeseries");
  var sourceAttribution = document.getElementById("election-timeseries-source-attribution");
  if (!timeseries || !sourceAttribution) return;

  ["election-timeseries-provenance-note", "election-timeseries-dynamics-note"].forEach(function (id) {
    var node = document.getElementById(id);
    if (node) node.hidden = true;
  });

  var host = document.getElementById("election-latest-poll");
  if (!host) {
    host = document.createElement("section");
    host.id = "election-latest-poll";
    host.className = "election-latest-poll";
    host.hidden = true;
    host.setAttribute("aria-labelledby", "election-latest-poll-title");
    sourceAttribution.insertAdjacentElement("afterend", host);
  }

  var style = document.createElement("style");
  style.textContent = [
    ".election-latest-poll{border-top:1px solid var(--el-rule);margin-top:.6rem;padding-top:.8rem}",
    ".election-latest-poll__title{font-family:var(--el-mono);font-size:.92rem;margin:0 0 .5rem}",
    ".election-latest-poll__table-wrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}",
    ".election-latest-poll__table{border-collapse:collapse;font-size:.76rem;min-width:58rem;width:100%}",
    ".election-latest-poll__table th,.election-latest-poll__table td{border-bottom:1px solid var(--el-rule);font-variant-numeric:tabular-nums;padding:.38rem .42rem;text-align:right;vertical-align:top;white-space:nowrap}",
    ".election-latest-poll__table thead th{font-family:var(--el-mono);font-size:.72rem;font-weight:700}",
    ".election-latest-poll__table th:first-child,.election-latest-poll__table td:first-child,.election-latest-poll__table th:nth-child(2),.election-latest-poll__table td:nth-child(2),.election-latest-poll__table th:nth-child(3),.election-latest-poll__table td:nth-child(3){text-align:left}",
    ".election-latest-poll__institute{font-weight:700}",
    ".election-latest-poll__note{margin:.45rem 0 0}"
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

  function pollCompany(poll) {
    return String(poll.company || poll.house || poll.pollster || poll.institute || "Okänt institut");
  }

  function fieldwork(poll) {
    var start = isoDate(poll.fieldwork_start || poll.fieldworkStart || poll.start_date);
    var end = isoDate(poll.fieldwork_end || poll.fieldworkEnd || poll.end_date);
    if (start && end) return swedishDate(start) + "–" + swedishDate(end);
    if (end) return "till " + swedishDate(end);
    if (start) return "från " + swedishDate(start);
    return "–";
  }

  function sampleSize(poll) {
    var n = numeric(poll.n || poll.sample_size || poll.samplesize);
    return n !== null && n > 0 ? Math.round(n).toLocaleString("sv-SE") : "–";
  }

  function renderPollRow(poll, date, index) {
    var parties = pollParties(poll);
    if (!parties) return "";
    var company = pollCompany(poll);
    var partyCells = PARTY_ORDER.map(function (party) {
      return "<td data-party=\"" + party + "\" data-value=\"" + parties[party].toFixed(6) + "\">" + escapeHtml(percent(parties[party])) + "</td>";
    }).join("");
    return "<tr data-latest-poll-item=\"true\" data-poll-index=\"" + index + "\" data-poll-date=\"" + date +
      "\" data-poll-company=\"" + escapeHtml(company) + "\"><th scope=\"row\" class=\"election-latest-poll__institute\">" + escapeHtml(company) +
      "</th><td>" + escapeHtml(swedishDate(date)) + "</td><td>" + escapeHtml(fieldwork(poll)) + "</td><td>" + escapeHtml(sampleSize(poll)) + "</td>" + partyCells + "</tr>";
  }

  function render(history) {
    var polls = history && Array.isArray(history.polls) ? history.polls : [];
    var dated = polls.map(function (poll, index) {
      return { poll: poll, date: pollDate(poll), sourceIndex: index };
    }).filter(function (item) {
      return item.date && pollParties(item.poll);
    });
    if (!dated.length) return;

    dated.sort(function (left, right) {
      if (left.date !== right.date) return left.date < right.date ? 1 : -1;
      return right.sourceIndex - left.sourceIndex;
    });
    var latest = dated.slice(0, 3);
    var rows = latest.map(function (item, index) { return renderPollRow(item.poll, item.date, index); }).filter(Boolean).join("");
    if (!rows) return;

    var partyHeaders = PARTY_ORDER.map(function (party) { return "<th scope=\"col\">" + party + "</th>"; }).join("");
    host.setAttribute("data-latest-poll-date", latest[0].date);
    host.setAttribute("data-latest-poll-count", String(latest.length));
    host.innerHTML = "<h3 id=\"election-latest-poll-title\" class=\"election-latest-poll__title\">Senaste mätningarna</h3>" +
      "<div class=\"election-latest-poll__table-wrap\"><table class=\"election-latest-poll__table\">" +
      "<caption class=\"visually-hidden\">De tre senast publicerade opinionsmätningarna</caption>" +
      "<thead><tr><th scope=\"col\">Institut</th><th scope=\"col\">Publicerad</th><th scope=\"col\">Fältperiod</th><th scope=\"col\">n</th>" + partyHeaders + "</tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>" +
      "<p class=\"election-latest-poll__note election-muted\">De tre senast publicerade enskilda opinionsmätningarna, inte modellens prognos.</p>";
    host.hidden = false;
  }

  fetch(base + "/history/coalition-timeseries.json").then(function (response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function (history) {
    if (history) render(history);
  }).catch(function () {});
})();
