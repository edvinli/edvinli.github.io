(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // "Demografisk analys": how groups of voters voted, from SVT/Valu's exit
  // poll (pages 20-34 of the 2026 seminar).  Three analyses share one panel:
  // party choice per group in 2026, the groups' party choice since 1991, and
  // pocketbook voting.  Every number is read from 2026-demografi.json; the
  // reference lines are Valmyndigheten's final result.
  // ---------------------------------------------------------------------
  var root = document.getElementById("election-demographics");
  var view = document.getElementById("edm-view");
  if (!root || !view) return;

  var palette = window.electionPartyPalette || { colors: {}, names: {} };
  var NBSP = " ";
  var PARTY_KEY = { "Övr": "REST" };
  // The forecast chart's coalition palette, in its fixed order: a group keeps
  // its colour whichever groups are shown.
  var GROUP_COLORS = ["#bd3348", "#315fa8", "#35866f", "#7b5b9d", "#a26a1f", "#278597"];
  var ANALYSES = ["groups", "trends", "wallet"];
  // End-of-line labels in the trend chart, where a full title would not fit.
  var SHORT_GROUP = { kvinnor: "Kvinnor", man: "Män", forstagangsvaljare: "Förstag.", "65-plus": "65+", lo: "LO", foretagare: "Företagare" };

  var data = null;
  var result = null;
  var state = { analysis: "groups", table: 0, focus: "", trendMode: "parties", trendGroup: 0, trendParty: "S", hidden: {} };
  var chartObserver = null;

  function partyColor(party) { return palette.colors[PARTY_KEY[party] || party] || "#8A8A8A"; }
  function partyName(party) { return party === "Övr" ? "Övriga partier" : (palette.names[party] || party); }
  function readableInk(hex) { return palette.readableInk ? palette.readableInk(hex) : "#ffffff"; }
  function percent(value, decimals) {
    return value.toFixed(decimals || 0).replace(".", ",") + NBSP + "%";
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function getJson(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error("Could not load " + url + " (" + response.status + ")");
      return response.json();
    });
  }
  function isShare(value) { return typeof value === "number" && isFinite(value) && value >= 0 && value <= 100; }

  // Fail-closed: a file that does not have the published shape shows an
  // error, never a partial dashboard.
  function validate(payload) {
    if (!payload || payload.schema_version !== "1.0" || payload.role !== "valu_demographics") return null;
    var parties = payload.parties;
    if (!Array.isArray(parties) || parties.length !== 9) return null;
    var tables = payload.cross_sections;
    if (!Array.isArray(tables) || !tables.length) return null;
    var tablesOk = tables.every(function (table) {
      return table.title && Array.isArray(table.sections) && table.sections.every(function (section) {
        return Array.isArray(section.groups) && section.groups.every(function (group) {
          return group.label && Array.isArray(group.shares) && group.shares.length === parties.length &&
            group.shares.every(isShare);
        });
      });
    });
    var trends = payload.trends;
    var trendsOk = trends && Array.isArray(trends.years) && Array.isArray(trends.groups) && trends.groups.every(function (group) {
      return group.title && parties.every(function (party) {
        var series = group.series[party];
        return Array.isArray(series) && series.length === trends.years.length &&
          series.every(function (value) { return value === null || isShare(value); });
      });
    });
    var wallet = payload.wallet_voting;
    var walletOk = wallet && isShare(wallet.overall) && wallet.parties && Array.isArray(wallet.sections);
    return tablesOk && trendsOk && walletOk ? payload : null;
  }

  function resultShare(party) {
    if (!result) return null;
    if (party === "Övr") return result.other_parties && isShare(result.other_parties.vote_share_pct) ? result.other_parties.vote_share_pct : null;
    var entry = result.parties && result.parties[party];
    return entry && isShare(entry.vote_share_pct) ? entry.vote_share_pct : null;
  }

  // --- Shared pieces ----------------------------------------------------

  var tip = null;
  function showTip(html, anchor) {
    if (!tip) return;
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.transform = "";
    if (!anchor) return;
    var box = view.getBoundingClientRect();
    var rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    var x = rect.left + rect.width / 2 - box.left;
    var half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half, Math.min(box.width - half, x)) + "px";
    var above = rect.top - box.top - tip.offsetHeight - 8;
    tip.style.top = (above >= 0 ? above : rect.bottom - box.top + 8) + "px";
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function select(id, label, options, value) {
    return "<label class=\"ep-filter\"><span class=\"ep-filter__label\">" + escapeHtml(label) + "</span>" +
      "<select class=\"ep-filter__select\" id=\"" + id + "\">" + options.map(function (option) {
        return "<option value=\"" + escapeHtml(option[0]) + "\"" + (String(option[0]) === String(value) ? " selected" : "") + ">" +
          escapeHtml(option[1]) + "</option>";
      }).join("") + "</select></label>";
  }

  function segmented(id, label, options, value) {
    return "<div class=\"ep-filter\"><span class=\"ep-filter__label\" id=\"" + id + "-label\">" + escapeHtml(label) + "</span>" +
      "<div class=\"ep-filter__segments\" role=\"group\" aria-labelledby=\"" + id + "-label\" id=\"" + id + "\">" +
      options.map(function (option) {
        return "<button type=\"button\" class=\"election-timeseries__control\" data-value=\"" + escapeHtml(option[0]) + "\" aria-pressed=\"" +
          (option[0] === value ? "true" : "false") + "\">" + escapeHtml(option[1]) + "</button>";
      }).join("") + "</div></div>";
  }

  function table(caption, head, rows) {
    return "<details class=\"edm-table\"><summary>Visa som tabell</summary><div class=\"edm-table__scroll\"><table>" +
      "<caption>" + escapeHtml(caption) + "</caption><thead><tr>" + head.map(function (cell, index) {
        return "<th scope=\"col\"" + (index ? " class=\"edm-num\"" : "") + ">" + escapeHtml(cell) + "</th>";
      }).join("") + "</tr></thead><tbody>" + rows.map(function (row) {
        return "<tr>" + row.map(function (cell, index) {
          return index ? "<td class=\"edm-num\">" + escapeHtml(cell) + "</td>" : "<th scope=\"row\">" + escapeHtml(cell) + "</th>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div></details>";
  }

  function niceMax(values) {
    var max = Math.max.apply(null, values.filter(function (v) { return v !== null; }));
    return Math.max(10, Math.ceil((max + 2) / 10) * 10);
  }

  // One row per group: label, a bar on a shared scale, the value; a
  // reference line drawn in every track keeps it aligned with the bars.
  function barRows(rows, scale, reference) {
    return rows.map(function (row) {
      var refLeft = reference !== null ? (reference / scale * 100).toFixed(3) : null;
      return "<div class=\"edm-bar-row\" data-tip=\"" + escapeHtml(row.tip) + "\" tabindex=\"0\" aria-label=\"" + escapeHtml(row.tip) + "\">" +
        "<span class=\"edm-label\">" + escapeHtml(row.label) + (row.note ? "<small>" + escapeHtml(row.note) + "</small>" : "") + "</span>" +
        "<span class=\"edm-track\" aria-hidden=\"true\"><span class=\"edm-bar\" style=\"width:" + (row.value / scale * 100).toFixed(3) +
          "%;background:" + row.color + "\"></span>" +
          (refLeft !== null ? "<span class=\"edm-ref\" style=\"left:" + refLeft + "%\"></span>" : "") + "</span>" +
        "<span class=\"edm-value\" aria-hidden=\"true\">" + percent(row.value) + "</span></div>";
    }).join("");
  }

  function referenceKey(scale, reference, label) {
    if (reference === null) return "";
    return "<div class=\"edm-bar-row edm-bar-row--key\" aria-hidden=\"true\"><span></span><span class=\"edm-track edm-track--key\">" +
      "<span class=\"edm-ref-label\" style=\"left:" + (reference / scale * 100).toFixed(3) + "%\">" + escapeHtml(label) + "</span></span><span></span></div>";
  }

  // --- 1. Partival per grupp ---------------------------------------------

  function renderGroups() {
    var tables = data.cross_sections;
    var current = tables[state.table] || tables[0];
    var parties = data.parties;
    var focus = state.focus;
    var controls = "<div class=\"edm-controls\">" +
      select("edm-table-select", "Grupp", tables.map(function (t, i) { return [i, t.title]; }), state.table) +
      select("edm-focus-select", "Visa", [["", "Alla partier"]].concat(parties.map(function (p) { return [p, partyName(p)]; })), focus) +
      "</div>";
    var head = "<div class=\"election-panel__head\"><h3 class=\"edm-title\">" + escapeHtml(current.title) +
      (focus ? ": " + escapeHtml(partyName(focus)) : "") + "</h3>" +
      "<p class=\"election-muted\">" + (current.question ? "Fråga: ”" + escapeHtml(current.question) + "” " : "") +
      (focus ? "Andel som röstade på " + escapeHtml(partyName(focus)) + " i varje grupp, jämfört med partiets valresultat."
        : "Partival i riksdagsvalet 2026, procent av gruppens röster. Klicka på ett parti för att jämföra det mellan grupperna.") +
      " SVT/Valu, sidan " + current.page + ".</p></div>";
    var body;
    if (!focus) {
      body = "<ul class=\"edm-legend\" aria-label=\"Partier\">" + parties.map(function (party) {
        return "<li><button type=\"button\" class=\"edm-legend__item\" data-party=\"" + escapeHtml(party) + "\" title=\"Visa bara " + escapeHtml(partyName(party)) + "\">" +
          "<span class=\"ev-swatch\" style=\"background:" + partyColor(party) + "\" aria-hidden=\"true\"></span>" + escapeHtml(party) + "</button></li>";
      }).join("") + "</ul>" + current.sections.map(function (section) {
        return (current.sections.length > 1 || section.title !== current.title ? "<h4 class=\"edm-section\">" + escapeHtml(section.title) + "</h4>" : "") +
          section.groups.map(function (group) {
            var total = group.shares.reduce(function (sum, v) { return sum + v; }, 0);
            var spoken = group.label + ": " + parties.map(function (p, i) { return p + " " + group.shares[i] + " procent"; }).join(", ");
            return "<div class=\"edm-stack-row\"><span class=\"edm-label\">" + escapeHtml(group.label) +
              (group.respondents ? "<small>" + group.respondents.toLocaleString("sv-SE") + " svar</small>" : "") + "</span>" +
              "<span class=\"edm-stack\" role=\"img\" aria-label=\"" + escapeHtml(spoken) + "\">" + parties.map(function (party, i) {
                var value = group.shares[i];
                if (!value) return "";
                var color = partyColor(party);
                return "<span class=\"edm-seg\" style=\"width:" + (value / total * 100).toFixed(3) + "%;background:" + color + ";color:" + readableInk(color) + "\"" +
                  " data-tip=\"" + escapeHtml(group.label + " · " + partyName(party) + " " + percent(value)) + "\">" +
                  (value >= 6 ? "<span class=\"edm-seg__value\">" + value + "</span>" : "") + "</span>";
              }).join("") + "</span></div>";
          }).join("");
      }).join("");
    } else {
      var index = parties.indexOf(focus);
      var reference = resultShare(focus);
      var all = [];
      current.sections.forEach(function (section) { section.groups.forEach(function (g) { all.push(g.shares[index]); }); });
      var scale = niceMax(all.concat(reference !== null ? [reference] : []));
      body = "<div class=\"edm-bars\">" + referenceKey(scale, reference, "Valresultat " + (reference !== null ? percent(reference, 1) : "")) +
        current.sections.map(function (section) {
          return (current.sections.length > 1 ? "<h4 class=\"edm-section\">" + escapeHtml(section.title) + "</h4>" : "") +
            barRows(section.groups.map(function (group) {
              var value = group.shares[index];
              return {
                label: group.label, value: value, color: partyColor(focus),
                note: group.respondents ? group.respondents.toLocaleString("sv-SE") + " svar" : null,
                tip: group.label + " · " + partyName(focus) + " " + percent(value) +
                  (reference !== null ? " (valresultat " + percent(reference, 1) + ")" : "")
              };
            }), scale, reference);
        }).join("") + "</div>" +
        "<button type=\"button\" class=\"edm-back\" id=\"edm-focus-clear\">Visa alla partier</button>";
    }
    var rows = [];
    current.sections.forEach(function (section) {
      section.groups.forEach(function (group) { rows.push([group.label].concat(group.shares.map(String))); });
    });
    return controls + head + body + table(current.title + ", procent", ["Grupp"].concat(parties), rows);
  }

  // --- 2. Utveckling 1991-2026 -------------------------------------------

  function trendSeries() {
    var trends = data.trends;
    if (state.trendMode === "parties") {
      var group = trends.groups[state.trendGroup] || trends.groups[0];
      return {
        title: group.title, page: group.page,
        series: data.parties.map(function (party) {
          return { id: party, label: party, name: partyName(party), color: partyColor(party), values: group.series[party] };
        })
      };
    }
    var party = state.trendParty;
    return {
      title: partyName(party), page: null,
      series: trends.groups.map(function (group, i) {
        return { id: group.id, label: group.title, short: SHORT_GROUP[group.id] || group.title, name: group.title, color: GROUP_COLORS[i % GROUP_COLORS.length], values: group.series[party] };
      })
    };
  }

  function renderTrends() {
    var trends = data.trends;
    var spec = trendSeries();
    var byParty = state.trendMode === "group";
    var controls = "<div class=\"edm-controls\">" +
      segmented("edm-trend-mode", "Jämför", [["parties", "Partier i en grupp"], ["group", "Ett parti i alla grupper"]], state.trendMode) +
      (byParty
        ? select("edm-trend-party", "Parti", data.parties.map(function (p) { return [p, partyName(p)]; }), state.trendParty)
        : select("edm-trend-group", "Grupp", trends.groups.map(function (g, i) { return [i, g.title]; }), state.trendGroup)) +
      "</div>";
    var head = "<div class=\"election-panel__head\"><h3 class=\"edm-title\">" +
      (byParty ? escapeHtml(spec.title) + " i olika väljargrupper 1991–2026" : escapeHtml(spec.title) + ": partival 1991–2026") +
      "</h3><p class=\"election-muted\">" +
      (byParty ? "Andel av varje grupps röster som gick till " + escapeHtml(spec.title) + "."
        : "Partival i varje riksdagsval, procent av gruppens röster. SVT/Valu, sidan " + spec.page + ".") +
      " Peka i diagrammet för värdena ett visst år; klicka på en serie nedan för att dölja eller visa den. " +
      escapeHtml(trends.note) + "</p></div>";
    var legend = "<ul class=\"edm-legend\" aria-label=\"Serier\">" + spec.series.map(function (series) {
      var shown = !state.hidden[series.id];
      return "<li><button type=\"button\" class=\"edm-legend__item edm-legend__toggle\" data-series=\"" + escapeHtml(series.id) + "\" aria-pressed=\"" + shown + "\">" +
        "<span class=\"ev-swatch\" style=\"background:" + series.color + "\" aria-hidden=\"true\"></span>" + escapeHtml(series.label) + "</button></li>";
    }).join("") + "</ul>";
    var chart = "<div class=\"edm-line\" id=\"edm-line\"></div>" +
      "<p class=\"visually-hidden\" id=\"edm-line-status\" role=\"status\" aria-live=\"polite\"></p>";
    var rows = spec.series.map(function (series) {
      return [series.name].concat(series.values.map(function (v) { return v === null ? "–" : String(v); }));
    });
    return controls + head + legend + chart + table(spec.title + " 1991–2026, procent", [byParty ? "Grupp" : "Parti"].concat(trends.years.map(String)), rows);
  }

  function drawLine() {
    var host = document.getElementById("edm-line");
    if (!host) return;
    var width = host.clientWidth;
    if (!width) return;
    var years = data.trends.years;
    var spec = trendSeries();
    var visible = spec.series.filter(function (series) { return !state.hidden[series.id]; });
    var compact = width < 560;
    var height = compact ? 280 : 360;
    var margin = { top: 14, right: 96, bottom: 28, left: 34 };
    var plotW = width - margin.left - margin.right;
    var plotH = height - margin.top - margin.bottom;
    var all = [];
    visible.forEach(function (series) { all = all.concat(series.values); });
    var max = all.length ? niceMax(all) : 50;
    var first = years[0];
    var last = years[years.length - 1];
    var x = function (year) { return margin.left + (year - first) / (last - first) * plotW; };
    var y = function (value) { return margin.top + plotH - value / max * plotH; };
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("class", "edm-line__svg");
    svg.setAttribute("tabindex", "0");
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "Linjediagram " + years[0] + "–" + last + ". Använd vänster- och högerpil för att gå mellan valen.");
    var parts = [];
    for (var tick = 0; tick <= max; tick += 10) {
      parts.push("<line class=\"edm-grid\" x1=\"" + margin.left + "\" x2=\"" + (margin.left + plotW) + "\" y1=\"" + y(tick) + "\" y2=\"" + y(tick) + "\"></line>" +
        "<text class=\"edm-axis\" x=\"" + (margin.left - 6) + "\" y=\"" + (y(tick) + 4) + "\" text-anchor=\"end\">" + tick + "</text>");
    }
    years.forEach(function (year, i) {
      // On a narrow chart every third election, ending on the latest.
      if (compact && (years.length - 1 - i) % 3 !== 0) return;
      parts.push("<text class=\"edm-axis\" x=\"" + x(year) + "\" y=\"" + (height - 8) + "\" text-anchor=\"middle\">" + year + "</text>");
    });
    visible.forEach(function (series) {
      var d = "";
      var pen = false;
      series.values.forEach(function (value, i) {
        if (value === null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(years[i]).toFixed(1) + "," + y(value).toFixed(1);
        pen = true;
      });
      parts.push("<path class=\"edm-series\" d=\"" + d + "\" stroke=\"" + series.color + "\"></path>");
      series.values.forEach(function (value, i) {
        if (value === null) return;
        parts.push("<circle class=\"edm-point\" data-year=\"" + i + "\" cx=\"" + x(years[i]).toFixed(1) + "\" cy=\"" + y(value).toFixed(1) + "\" r=\"3\" fill=\"" + series.color + "\"></circle>");
      });
    });
    // End labels in ink, nudged apart so none overlap.
    var ends = visible.map(function (series) {
      var value = series.values[series.values.length - 1];
      return value === null ? null : { series: series, value: value, y: y(value) };
    }).filter(Boolean).sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < ends.length; i += 1) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
    var overflow = ends.length ? ends[ends.length - 1].y - (margin.top + plotH) : 0;
    if (overflow > 0) ends.forEach(function (end) { end.y -= overflow; });
    ends.forEach(function (end) {
      parts.push("<text class=\"edm-end\" x=\"" + (x(last) + 8) + "\" y=\"" + (end.y + 4) + "\">" +
        escapeHtml(end.series.short || end.series.label) + " " + end.value + "</text>");
    });
    parts.push("<line class=\"edm-cross\" id=\"edm-cross\" y1=\"" + margin.top + "\" y2=\"" + (margin.top + plotH) + "\" visibility=\"hidden\"></line>");
    parts.push("<rect class=\"edm-hit\" x=\"" + margin.left + "\" y=\"" + margin.top + "\" width=\"" + plotW + "\" height=\"" + plotH + "\"></rect>");
    svg.innerHTML = parts.join("");
    host.innerHTML = "";
    host.appendChild(svg);

    var cross = svg.querySelector("#edm-cross");
    var status = document.getElementById("edm-line-status");
    var at = -1;
    function point(index, announce) {
      at = Math.max(0, Math.min(years.length - 1, index));
      var cx = x(years[at]);
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      Array.prototype.forEach.call(svg.querySelectorAll(".edm-point"), function (dot) {
        dot.setAttribute("r", Number(dot.getAttribute("data-year")) === at ? "5" : "3");
      });
      var values = visible.map(function (series) { return { series: series, value: series.values[at] }; })
        .filter(function (entry) { return entry.value !== null; })
        .sort(function (a, b) { return b.value - a.value; });
      showTip("<span class=\"ep-tip__name\">" + years[at] + "</span>" + values.map(function (entry) {
        return "<span class=\"edm-tip__row\"><span class=\"ev-swatch\" style=\"background:" + entry.series.color + "\" aria-hidden=\"true\"></span>" +
          escapeHtml(entry.series.name) + "<b>" + percent(entry.value) + "</b></span>";
      }).join(""), null);
      // Beside the crosshair, inside the plot: right of it in the left half,
      // left of it in the right half, so it never covers the text above.
      var box = view.getBoundingClientRect();
      var svgBox = svg.getBoundingClientRect();
      var scaleX = svgBox.width / width;
      var lineX = svgBox.left - box.left + cx * scaleX;
      var leftSide = cx > margin.left + plotW / 2;
      var left = leftSide ? lineX - tip.offsetWidth - 12 : lineX + 12;
      tip.style.transform = "none";
      tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, left)) + "px";
      tip.style.top = (svgBox.top - box.top + margin.top * scaleX) + "px";
      if (announce && status) {
        status.textContent = years[at] + ": " + values.map(function (entry) { return entry.series.name + " " + entry.value + " procent"; }).join(", ") + ".";
      }
    }
    function clear() {
      at = -1;
      cross.setAttribute("visibility", "hidden");
      Array.prototype.forEach.call(svg.querySelectorAll(".edm-point"), function (dot) { dot.setAttribute("r", "3"); });
      hideTip();
    }
    function nearest(event) {
      var box = svg.getBoundingClientRect();
      var px = (event.clientX - box.left) / box.width * width;
      var best = 0;
      years.forEach(function (year, i) { if (Math.abs(x(year) - px) < Math.abs(x(years[best]) - px)) best = i; });
      return best;
    }
    svg.addEventListener("mousemove", function (event) { point(nearest(event), false); });
    svg.addEventListener("mouseleave", function () { if (document.activeElement !== svg) clear(); });
    svg.addEventListener("click", function (event) { point(nearest(event), true); });
    svg.addEventListener("focus", function () { point(at >= 0 ? at : years.length - 1, true); });
    svg.addEventListener("blur", clear);
    svg.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") point(at - 1, true);
      else if (event.key === "ArrowRight") point(at + 1, true);
      else if (event.key === "Home") point(0, true);
      else if (event.key === "End") point(years.length - 1, true);
      else if (event.key === "Escape") { clear(); return; }
      else return;
      event.preventDefault();
    });
  }

  // --- 3. Plånboksröstning -----------------------------------------------

  function renderWallet() {
    var wallet = data.wallet_voting;
    var overall = wallet.overall;
    var partyRows = Object.keys(wallet.parties).map(function (party) {
      var value = wallet.parties[party];
      return { label: partyName(party), value: value, color: partyColor(party), tip: partyName(party) + " · " + percent(value) };
    });
    var groupValues = [];
    wallet.sections.forEach(function (section) { section.groups.forEach(function (g) { groupValues.push(g[1]); }); });
    var scale = niceMax(partyRows.map(function (r) { return r.value; }).concat(groupValues, [overall]));
    var keyLabel = "Samtliga " + percent(overall);
    var head = "<div class=\"election-panel__head\"><h3 class=\"edm-title\">Plånboksröstning 2026</h3>" +
      "<p class=\"election-muted\">" + escapeHtml(wallet.question) + " Linjen visar samtliga väljare, " + percent(overall) + ". SVT/Valu, sidan " + wallet.page + ".</p></div>";
    var byParty = "<div class=\"edm-wallet__block\"><h4 class=\"edm-section\">Efter partival</h4><div class=\"edm-bars\">" +
      referenceKey(scale, overall, keyLabel) + barRows(partyRows, scale, overall) + "</div></div>";
    var byGroup = "<div class=\"edm-wallet__block\"><h4 class=\"edm-section\">Efter grupp</h4><div class=\"edm-bars\">" +
      referenceKey(scale, overall, keyLabel) + wallet.sections.map(function (section) {
        return "<div class=\"edm-subsection\">" + escapeHtml(section.title) + "</div>" + barRows(section.groups.map(function (g) {
          return { label: g[0], value: g[1], color: "var(--el-ink-soft)", tip: g[0] + " · " + percent(g[1]) };
        }), scale, overall);
      }).join("") + "</div></div>";
    var rows = partyRows.map(function (r) { return [r.label, String(r.value)]; });
    wallet.sections.forEach(function (section) { section.groups.forEach(function (g) { rows.push([g[0], String(g[1])]); }); });
    rows.unshift(["Samtliga", String(overall)]);
    return head + "<div class=\"edm-wallet\">" + byParty + byGroup + "</div>" +
      table("Den egna ekonomin av mycket stor betydelse, procent", ["Grupp", "Procent"], rows);
  }

  // --- Wiring -------------------------------------------------------------

  function render() {
    hideTip();
    if (chartObserver) { chartObserver.disconnect(); chartObserver = null; }
    var html = state.analysis === "trends" ? renderTrends() : state.analysis === "wallet" ? renderWallet() : renderGroups();
    view.innerHTML = html + "<div class=\"ep-tip edm-tip\" role=\"tooltip\" hidden></div>";
    tip = view.querySelector(".edm-tip");
    Array.prototype.forEach.call(root.querySelectorAll(".edm-nav [data-analysis]"), function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-analysis") === state.analysis ? "true" : "false");
    });
    if (state.analysis === "trends") {
      var host = document.getElementById("edm-line");
      drawLine();
      if (window.ResizeObserver && host) {
        var lastWidth = host.clientWidth;
        chartObserver = new ResizeObserver(function () {
          if (host.clientWidth && Math.abs(host.clientWidth - lastWidth) > 1) { lastWidth = host.clientWidth; drawLine(); }
        });
        chartObserver.observe(host);
      }
    }
  }

  view.addEventListener("change", function (event) {
    var target = event.target;
    if (target.id === "edm-table-select") { state.table = Number(target.value); render(); }
    else if (target.id === "edm-focus-select") { state.focus = target.value; render(); }
    else if (target.id === "edm-trend-group") { state.trendGroup = Number(target.value); state.hidden = {}; render(); }
    else if (target.id === "edm-trend-party") { state.trendParty = target.value; render(); }
  });
  view.addEventListener("click", function (event) {
    var target = event.target.closest ? event.target.closest("button") : null;
    if (!target || !view.contains(target)) return;
    if (target.id === "edm-focus-clear") { state.focus = ""; render(); return; }
    if (target.hasAttribute("data-party") && state.analysis === "groups") { state.focus = target.getAttribute("data-party"); render(); return; }
    if (target.parentNode && target.parentNode.id === "edm-trend-mode") {
      state.trendMode = target.getAttribute("data-value");
      state.hidden = {};
      render();
      return;
    }
    if (target.hasAttribute("data-series")) {
      var id = target.getAttribute("data-series");
      state.hidden[id] = !state.hidden[id];
      target.setAttribute("aria-pressed", state.hidden[id] ? "false" : "true");
      drawLine();
    }
  });
  // Hover and focus cards for bars and segments.
  function tipFor(event) {
    var node = event.target.closest ? event.target.closest("[data-tip]") : null;
    return node && view.contains(node) ? node : null;
  }
  view.addEventListener("mouseover", function (event) {
    var node = tipFor(event);
    if (node) showTip("<span class=\"ep-tip__line\">" + escapeHtml(node.getAttribute("data-tip")) + "</span>", node);
  });
  view.addEventListener("mouseout", function (event) {
    if (tipFor(event) && !(event.relatedTarget && tipFor({ target: event.relatedTarget }))) hideTip();
  });
  view.addEventListener("focusin", function (event) {
    var node = tipFor(event);
    if (node) showTip("<span class=\"ep-tip__line\">" + escapeHtml(node.getAttribute("data-tip")) + "</span>", node);
  });
  view.addEventListener("focusout", function (event) { if (tipFor(event)) hideTip(); });

  Array.prototype.forEach.call(root.querySelectorAll(".edm-nav [data-analysis]"), function (button) {
    button.addEventListener("click", function () {
      var analysis = button.getAttribute("data-analysis");
      if (ANALYSES.indexOf(analysis) < 0 || !data) return;
      state.analysis = analysis;
      render();
    });
  });
  // The line chart measures its width, which is zero while the tab is hidden.
  document.addEventListener("election-tab-change", function (event) {
    if (data && event.detail && event.detail.panel === root.id && state.analysis === "trends") drawLine();
  });

  Promise.all([
    getJson(root.getAttribute("data-source")),
    getJson(root.getAttribute("data-result")).catch(function () { return null; })
  ]).then(function (payloads) {
    data = validate(payloads[0]);
    result = payloads[1];
    if (!data) throw new Error("invalid demographics file");
    render();
  }).catch(function (error) {
    console.warn("Den demografiska analysen kunde inte visas.", error);
    var status = document.getElementById("edm-status");
    if (status) {
      status.textContent = "Underlaget kunde inte läsas in.";
      status.className = "election-status election-status--error";
    }
  });
}());
