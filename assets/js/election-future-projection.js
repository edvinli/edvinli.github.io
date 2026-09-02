(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  var section = document.getElementById("election-timeseries");
  if (!app || !section) return;

  var base = String(app.getAttribute("data-publication-base") || "").replace(/\/$/, "");
  var DAY = 86400000;
  var CHAMBER = 349;
  var projection = null;
  var scheduled = false;

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function dateInfo(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var time = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(time) ? { iso: value, time: time } : null;
  }

  function swedishDate(value) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!parts) return String(value || "");
    var months = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
    return String(Number(parts[3])) + " " + months[Number(parts[2]) - 1] + " " + parts[1];
  }

  function format(value, digits) {
    var parsed = number(value);
    if (parsed === null) return "—";
    return parsed.toFixed(digits === undefined ? 1 : digits).replace(".", ",");
  }

  function grouped(value) {
    var parsed = number(value);
    if (parsed === null) return "—";
    return String(Math.round(parsed)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function svgNode(name, attributes, text) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attributes || {}).forEach(function (key) {
      node.setAttribute(key, attributes[key]);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function validQuantiles(value) {
    var keys = ["p05", "p25", "p50", "p75", "p95"];
    if (!value || !keys.every(function (key) { return number(value[key]) !== null; })) return false;
    return keys.every(function (key, index) {
      return index === 0 || number(value[key]) >= number(value[keys[index - 1]]);
    });
  }

  function validateFuture(raw, history) {
    if (!raw || raw.projection_type !== "conditional_forward_projection") return null;
    var origin = dateInfo(raw.origin_date);
    var election = dateInfo(raw.election_date);
    if (!origin || !election || election.time <= origin.time) return null;
    if (raw.state_cutoff_date !== origin.iso || raw.future_measurements_known !== false) return null;
    if (!raw.anchor || raw.anchor.date !== origin.iso || raw.anchor.provenance !== "current_production") return null;
    var series = Array.isArray(raw.series) ? raw.series : [];
    var expectedCount = Math.round((election.time - origin.time) / DAY);
    if (series.length !== expectedCount) return null;
    var coalitionKeys = Object.keys(history.coalitions || {});
    for (var index = 0; index < series.length; index += 1) {
      var point = series[index];
      var expectedDate = new Date(origin.time + DAY * (index + 1)).toISOString().slice(0, 10);
      if (!point || point.date !== expectedDate || point.remaining_horizon_days !== expectedCount - index - 1) return null;
      if (!Number.isInteger(point.samples) || point.samples <= 0) return null;
      if (!coalitionKeys.every(function (key) {
        var group = point.groups && point.groups[key];
        return group && validQuantiles(group.vote) && validQuantiles(group.seats);
      })) return null;
    }
    if (!series.length || series[series.length - 1].date !== election.iso || series[series.length - 1].remaining_horizon_days !== 0) return null;
    return {
      origin: origin,
      election: election,
      anchor: raw.anchor,
      series: series,
      tooltip: String(raw.tooltip_sv || "Framåtblickande projektion. Antar oförändrat underliggande opinionsläge; framtida mätningar är okända."),
      rendering: raw.rendering || {}
    };
  }

  function visibleCoalitions(svg) {
    return Array.from(svg.querySelectorAll(".election-timeseries__series-group")).map(function (group) {
      return {
        id: group.getAttribute("data-coalition"),
        label: group.getAttribute("data-coalition-label") || group.getAttribute("data-coalition"),
        color: group.getAttribute("data-color") || "#666"
      };
    }).filter(function (item) { return item.id; });
  }

  function metricQuantiles(group, metric) {
    if (!group) return null;
    var raw = group[metric];
    if (!validQuantiles(raw)) return null;
    if (metric !== "seats") return raw;
    return {
      p05: 100 * raw.p05 / CHAMBER,
      p25: 100 * raw.p25 / CHAMBER,
      p50: 100 * raw.p50 / CHAMBER,
      p75: 100 * raw.p75 / CHAMBER,
      p95: 100 * raw.p95 / CHAMBER
    };
  }

  function areaPath(points, coalitionId, metric, xScale, yScale, highKey, lowKey) {
    var high = [];
    var low = [];
    points.forEach(function (point) {
      var values = metricQuantiles(point.groups && point.groups[coalitionId], metric);
      if (!values) return;
      high.push([xScale(point.time), yScale(values[highKey])]);
      low.push([xScale(point.time), yScale(values[lowKey])]);
    });
    if (!high.length) return "";
    return "M" + high.map(function (p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }).join("L") +
      "L" + low.reverse().map(function (p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }).join("L") + "Z";
  }

  function linePath(points, coalitionId, metric, xScale, yScale) {
    var path = "";
    var count = 0;
    points.forEach(function (point) {
      var values = metricQuantiles(point.groups && point.groups[coalitionId], metric);
      if (!values) return;
      path += (count ? "L" : "M") + xScale(point.time).toFixed(2) + "," + yScale(values.p50).toFixed(2);
      count += 1;
    });
    return path;
  }

  function detailHtml(point, coalitions, metric) {
    var rows = coalitions.map(function (coalition) {
      var group = point.groups && point.groups[coalition.id];
      if (!group) return "";
      var raw = group[metric];
      var values = metricQuantiles(group, metric);
      if (!raw || !values) return "";
      var median = metric === "seats" ? grouped(raw.p50) + "\u00a0mandat" : format(values.p50, 1) + "\u00a0%";
      var range50 = metric === "seats"
        ? grouped(raw.p25) + "–" + grouped(raw.p75) + "\u00a0mandat"
        : format(values.p25, 1) + "–" + format(values.p75, 1) + "\u00a0%";
      var range90 = metric === "seats"
        ? grouped(raw.p05) + "–" + grouped(raw.p95) + "\u00a0mandat"
        : format(values.p05, 1) + "–" + format(values.p95, 1) + "\u00a0%";
      return "<section class=\"election-timeseries__detail-group\" data-coalition=\"" + escapeHtml(coalition.id) + "\">" +
        "<h4>" + escapeHtml(coalition.label) + "</h4><dl>" +
        "<dt>Framåtblickande projektion</dt><dd>" + escapeHtml(median) + "</dd>" +
        "<dt>50 % intervall</dt><dd>" + escapeHtml(range50) + "</dd>" +
        "<dt>90 % intervall</dt><dd>" + escapeHtml(range90) + "</dd></dl></section>";
    }).join("");
    return "<h3 class=\"election-timeseries__detail-date\">" + escapeHtml(swedishDate(point.date)) + "</h3>" +
      "<div class=\"election-timeseries__detail-groups\">" + rows + "</div>" +
      "<dl class=\"election-timeseries__detail-meta\">" +
      "<div><dt>Simuleringar</dt><dd>" + escapeHtml(grouped(point.samples)) + "</dd></div>" +
      "<div><dt>Ursprung</dt><dd>Framåtblickande projektion</dd></div>" +
      "<div><dt>Rörelsedel</dt><dd>" + escapeHtml(grouped(point.remaining_horizon_days)) + " dagar kvar</dd></div></dl>" +
      "<p class=\"election-timeseries__note election-muted\">" + escapeHtml(projection.tooltip) + "</p>";
  }

  function showDetail(point, coalitions, metric) {
    var body = document.getElementById("election-timeseries-detail-body");
    var status = document.getElementById("election-timeseries-status");
    if (body) {
      body.innerHTML = detailHtml(point, coalitions, metric);
      body.hidden = false;
    }
    if (status) {
      status.textContent = swedishDate(point.date) + ". " + projection.tooltip;
      status.hidden = true;
    }
  }

  function injectCopy() {
    var key = section.querySelector(".election-timeseries__key");
    if (key && !document.getElementById("election-timeseries-key-projection")) {
      var item = document.createElement("span");
      item.id = "election-timeseries-key-projection";
      item.className = "election-timeseries__key-item";
      item.innerHTML = "<span aria-hidden=\"true\" style=\"display:inline-block;width:1.5rem;border-top:2px dashed currentColor;vertical-align:middle;margin-right:.35rem;opacity:.65\"></span>Framåtblickande projektion";
      key.appendChild(item);
    }
    if (!document.getElementById("election-timeseries-projection-note")) {
      var note = document.createElement("p");
      note.id = "election-timeseries-projection-note";
      note.className = "election-timeseries__note election-muted";
      note.textContent = projection.tooltip;
      var provenance = document.getElementById("election-timeseries-provenance-note");
      if (provenance && provenance.parentNode) provenance.parentNode.insertBefore(note, provenance);
    }
    var intro = document.getElementById("election-timeseries-intro");
    if (intro) {
      intro.textContent = "Historisk prognos till senaste officiella prognosen, följd av en villkorad framåtblickande projektion till valdagen. Välj mått och koalitioner.";
    }
  }

  function decorate() {
    scheduled = false;
    if (!projection) return;
    var svg = document.getElementById("election-timeseries-svg");
    if (!svg || section.hidden || svg.getAttribute("data-future-projection-rendered") === "true") return;
    var viewBox = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
    if (viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return;
    var compact = viewBox[2] <= 650;
    var plot = compact ? { left: 62, right: 520, top: 50, bottom: 415 } : { left: 72, right: 880, top: 40, bottom: 360 };
    var futureRight = compact ? 680 : 1040;
    var newWidth = compact ? 760 : 1120;
    var metric = svg.getAttribute("data-metric") === "seats" ? "seats" : "vote";
    var yMin = number(svg.getAttribute("data-y-min"));
    var yMax = number(svg.getAttribute("data-y-max"));
    if (yMin === null || yMax === null || yMax <= yMin) return;
    var coalitions = visibleCoalitions(svg);
    if (!coalitions.length) return;

    var projectionPoints = [{
      date: projection.origin.iso,
      time: projection.origin.time,
      samples: projection.anchor.samples,
      remaining_horizon_days: Math.round((projection.election.time - projection.origin.time) / DAY),
      groups: projection.anchor.groups
    }].concat(projection.series.map(function (point) {
      return {
        date: point.date,
        time: dateInfo(point.date).time,
        samples: point.samples,
        remaining_horizon_days: point.remaining_horizon_days,
        groups: point.groups
      };
    }));
    var span = projection.election.time - projection.origin.time;
    var xScale = function (time) {
      return plot.right + (time - projection.origin.time) / span * (futureRight - plot.right);
    };
    var yScale = function (value) {
      return plot.bottom - (value - yMin) / (yMax - yMin) * (plot.bottom - plot.top);
    };

    svg.setAttribute("viewBox", "0 0 " + newWidth + " " + viewBox[3]);
    svg.setAttribute("data-future-projection-rendered", "true");
    svg.setAttribute("data-future-projection-origin", projection.origin.iso);
    svg.setAttribute("data-future-projection-election", projection.election.iso);
    svg.setAttribute("data-x-axis-max", projection.election.iso);
    section.setAttribute("data-future-projection", "true");
    section.setAttribute("data-future-projection-point-count", String(projection.series.length));

    var background = svgNode("g", { class: "election-timeseries__future-background", "aria-hidden": "true", "data-future-region": "true" });
    background.appendChild(svgNode("rect", {
      x: plot.right, y: plot.top, width: futureRight - plot.right, height: plot.bottom - plot.top,
      fill: "#777", opacity: "0.055", "data-future-background": "true"
    }));
    background.appendChild(svgNode("line", {
      x1: plot.right, y1: plot.top, x2: plot.right, y2: plot.bottom,
      stroke: "#777", "stroke-width": "1", "stroke-dasharray": "3 4", "data-latest-forecast-boundary": "true"
    }));
    background.appendChild(svgNode("text", {
      x: plot.right + 5, y: plot.top + 14, fill: "#666", "font-size": compact ? "11" : "12",
      "text-anchor": "start", "data-latest-forecast-label": "true"
    }, "Senaste prognos"));
    background.appendChild(svgNode("line", {
      x1: futureRight, y1: plot.top, x2: futureRight, y2: plot.bottom,
      stroke: "#555", "stroke-width": "1.2", "data-election-day-boundary": "true"
    }));
    background.appendChild(svgNode("line", {
      x1: plot.right, y1: plot.bottom, x2: futureRight, y2: plot.bottom,
      stroke: "#777", "stroke-width": "1"
    }));
    background.appendChild(svgNode("text", {
      x: futureRight - 4, y: plot.bottom + 24, fill: "#666", "font-size": compact ? "11" : "12",
      "text-anchor": "end", "data-election-day-label": "true", "data-date": projection.election.iso
    }, "Valdag 13 sep"));
    var baseBackground = svg.querySelector(".election-timeseries__background");
    svg.insertBefore(background, baseBackground || svg.firstChild);

    var layer = svgNode("g", { class: "election-timeseries__future-series", "aria-label": "Framåtblickande projektion", "data-future-series": "true" });
    coalitions.forEach(function (coalition) {
      var group = svgNode("g", {
        class: "election-timeseries__future-series-group",
        "data-coalition": coalition.id,
        "data-projection": "true"
      });
      var ninety = areaPath(projectionPoints, coalition.id, metric, xScale, yScale, "p95", "p05");
      var fifty = areaPath(projectionPoints, coalition.id, metric, xScale, yScale, "p75", "p25");
      var median = linePath(projectionPoints, coalition.id, metric, xScale, yScale);
      if (ninety) group.appendChild(svgNode("path", {
        d: ninety, fill: coalition.color, opacity: "0.06",
        class: "election-timeseries__future-band election-timeseries__future-band--90",
        "data-future-band": "90", "data-coalition": coalition.id
      }));
      if (fifty) group.appendChild(svgNode("path", {
        d: fifty, fill: coalition.color, opacity: "0.15",
        class: "election-timeseries__future-band election-timeseries__future-band--50",
        "data-future-band": "50", "data-coalition": coalition.id
      }));
      if (median) group.appendChild(svgNode("path", {
        d: median, fill: "none", stroke: coalition.color, opacity: "0.68", "stroke-width": "2.2",
        "stroke-dasharray": "7 5", "vector-effect": "non-scaling-stroke",
        class: "election-timeseries__future-median", "data-future-median": "true", "data-coalition": coalition.id
      }));
      projection.series.forEach(function (point) {
        var values = metricQuantiles(point.groups && point.groups[coalition.id], metric);
        var raw = point.groups && point.groups[coalition.id] && point.groups[coalition.id][metric];
        if (!values || !raw) return;
        var circle = svgNode("circle", {
          cx: xScale(dateInfo(point.date).time), cy: yScale(values.p50), r: "3.1",
          fill: coalition.color, opacity: "0.72", tabindex: "0", role: "img",
          class: "election-timeseries__future-point", "data-future-point": "true",
          "data-projection": "true", "data-coalition": coalition.id, "data-date": point.date,
          "data-p05": values.p05, "data-p25": values.p25, "data-p50": values.p50,
          "data-p75": values.p75, "data-p95": values.p95,
          "data-seat-quantiles": metric === "seats" ? JSON.stringify(raw) : "",
          "aria-label": coalition.label + ", framåtblickande projektion " + swedishDate(point.date) +
            ": median " + (metric === "seats" ? grouped(raw.p50) + " mandat" : format(values.p50, 1) + " procent")
        });
        function inspect(event) {
          showDetail(point, coalitions, metric);
          svg.setAttribute("data-selected-date", point.date);
          if (event && event.preventDefault && event.type === "keydown") event.preventDefault();
        }
        circle.addEventListener("mouseenter", inspect);
        circle.addEventListener("focus", inspect);
        circle.addEventListener("click", inspect);
        circle.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") inspect(event);
        });
        group.appendChild(circle);
      });
      layer.appendChild(group);
    });
    var hit = svg.querySelector(".election-timeseries__hit");
    svg.insertBefore(layer, hit || null);
    injectCopy();
  }

  function scheduleDecorate() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(function () {
      var svg = document.getElementById("election-timeseries-svg");
      if (svg) svg.removeAttribute("data-future-projection-rendered");
      decorate();
    }, 0);
  }

  fetch(base + "/history/coalition-timeseries.json").then(function (response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function (history) {
    if (!history || !history.future_projection) return;
    projection = validateFuture(history.future_projection, history);
    if (!projection) {
      section.setAttribute("data-future-projection", "invalid");
      return;
    }
    var attempts = 0;
    function waitForChart() {
      attempts += 1;
      var svg = document.getElementById("election-timeseries-svg");
      if (svg && !section.hidden && svg.querySelector(".election-timeseries__series")) {
        decorate();
        Array.from(section.querySelectorAll("#election-timeseries-vote, #election-timeseries-seats, #election-timeseries-coalitions button")).forEach(function (control) {
          control.addEventListener("click", scheduleDecorate);
        });
        return;
      }
      if (attempts < 100) window.setTimeout(waitForChart, 50);
    }
    waitForChart();
  }).catch(function () {
    // The future projection is additive.  Historical rendering remains the
    // authoritative fallback when the additive field or request is absent.
  });
}());
