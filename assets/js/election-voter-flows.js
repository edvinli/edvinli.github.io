(function () {
  "use strict";

  var root = document.getElementById("election-flows");
  if (!root) return;

  // ---------------------------------------------------------------------
  // Data: net flows 2022 -> 2026, thousands of voters.  SVT/Valu exit poll,
  // raked to the official 2022 and 2026 results.
  // ---------------------------------------------------------------------
  var palette = window.electionPartyPalette || { colors: {}, names: {} };
  var MINUS = "−";

  // Wheel order: the left bloc on the left, C and L at the top, the right
  // bloc on the right and the remaining parties at the bottom.
  var PARTIES = [
    { id: "V", key: "V", net: 112, pe: 1.65 },
    { id: "S", key: "S", net: -156, pe: -2.31 },
    { id: "MP", key: "MP", net: 70, pe: 1.04 },
    { id: "C", key: "C", net: 21, pe: 0.32 },
    { id: "L", key: "L", net: 49, pe: 0.73 },
    { id: "KD", key: "KD", net: 56, pe: 0.83 },
    { id: "M", key: "M", net: 51, pe: 0.75 },
    { id: "SD", key: "SD", net: -207, pe: -3.06 },
    { id: "Övr", key: "REST", net: 3, pe: 0.04 }
  ];
  // [loses, gains, thousands]
  var FLOWS = [
    ["S", "V", 76], ["V", "MP", 13], ["C", "V", 13], ["L", "V", 9], ["KD", "V", 3],
    ["M", "V", 10], ["SD", "V", 9], ["Övr", "V", 5],
    ["S", "MP", 44], ["C", "S", 4], ["L", "S", 14], ["S", "KD", 15], ["S", "M", 53],
    ["SD", "S", 4], ["Övr", "S", 10],
    ["C", "MP", 3], ["L", "MP", 4], ["KD", "MP", 2], ["M", "MP", 2], ["Övr", "MP", 3],
    ["L", "C", 46], ["C", "KD", 4], ["C", "M", 5], ["C", "SD", 1], ["Övr", "C", 5],
    ["KD", "L", 20], ["M", "L", 49], ["SD", "L", 49], ["Övr", "L", 4],
    ["M", "KD", 20], ["SD", "KD", 41], ["Övr", "KD", 2],
    ["SD", "M", 69], ["Övr", "M", 4],
    ["SD", "Övr", 35]
  ].map(function (row) { return { from: row[0], to: row[1], v: row[2] }; });

  var byId = {};
  PARTIES.forEach(function (party) {
    party.name = palette.names[party.key] || party.id;
    party.color = palette.colors[party.key] || "#8A8A8A";
    party.ink = palette.readableInk ? palette.readableInk(party.color) : "#ffffff";
    byId[party.id] = party;
  });

  function thousands(v) {
    return (v * 1000).toLocaleString("sv-SE");
  }
  function signed(v) {
    return (v > 0 ? "+" : v < 0 ? MINUS : "") + Math.abs(v);
  }
  function signedThousands(v) {
    return (v > 0 ? "+" : v < 0 ? MINUS : "") + thousands(Math.abs(v));
  }
  function signedPe(v) {
    return (v > 0 ? "+" : v < 0 ? MINUS : "") + Math.abs(v).toFixed(2).replace(".", ",");
  }
  function netClass(v) {
    return v > 0 ? "is-gain" : v < 0 ? "is-loss" : "is-flat";
  }

  // ---------------------------------------------------------------------
  // The wheel
  // ---------------------------------------------------------------------
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("election-flows-svg");
  var chart = document.getElementById("election-flows-chart");
  var tip = document.getElementById("election-flows-tip");
  var panel = document.getElementById("election-flows-panel");
  var threshold = document.getElementById("election-flows-threshold");
  var thresholdValue = document.getElementById("election-flows-threshold-value");
  var cx = 410;
  var cy = 345;
  var R = 218;
  var r = 27;
  var MAXF = Math.max.apply(null, FLOWS.map(function (f) { return f.v; }));
  var selected = null;
  var hovered = null;

  PARTIES.forEach(function (party, i) {
    var a = (130 + i * 40) * Math.PI / 180;
    party.a = a;
    party.x = cx + R * Math.cos(a);
    party.y = cy + R * Math.sin(a);
  });

  function el(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(node);
    return node;
  }
  function unit(x, y) {
    var d = Math.hypot(x, y) || 1;
    return [x / d, y / d];
  }

  var gFlows = el("g", {}, svg);
  var gLabels = el("g", {}, svg);
  var gNodes = el("g", {}, svg);

  function toggle(id) {
    select(selected === id ? null : id);
  }

  // Thickest first, so the thin arrows are drawn on top and stay clickable.
  FLOWS.slice().sort(function (a, b) { return b.v - a.v; }).forEach(function (f) {
    var A = byId[f.from];
    var B = byId[f.to];
    var dx = B.x - A.x;
    var dy = B.y - A.y;
    var dist = Math.hypot(dx, dy);
    var ux = dx / dist;
    var uy = dy / dist;
    var bend = 0.17;
    var Cx = (A.x + B.x) / 2 - uy * bend * dist;
    var Cy = (A.y + B.y) / 2 + ux * bend * dist;
    var s = unit(Cx - A.x, Cy - A.y);
    var S = [A.x + s[0] * (r + 4), A.y + s[1] * (r + 4)];
    var t0 = unit(Cx - B.x, Cy - B.y);
    var T = [B.x + t0[0] * (r + 5), B.y + t0[1] * (r + 5)];
    var t = unit(T[0] - Cx, T[1] - Cy);
    var w = 1.6 + (f.v / MAXF) * 16;
    var ah = 8 + w * 0.9;
    var aw = w / 2 + 5;
    var E = [T[0] - t[0] * ah * 0.8, T[1] - t[1] * ah * 0.8];
    var base = [T[0] - t[0] * ah, T[1] - t[1] * ah];
    var nx = -t[1];
    var ny = t[0];

    var g = el("g", { class: "evf-flow" }, gFlows);
    el("path", {
      d: "M" + S[0] + "," + S[1] + " Q" + Cx + "," + Cy + " " + E[0] + "," + E[1],
      fill: "none", stroke: A.color, "stroke-width": w
    }, g);
    el("polygon", {
      points: T[0] + "," + T[1] + " " +
        (base[0] + nx * aw) + "," + (base[1] + ny * aw) + " " +
        (base[0] - nx * aw) + "," + (base[1] - ny * aw),
      fill: A.color
    }, g);
    // A wide invisible hit area, so thin arrows can still be hovered.
    el("path", {
      d: "M" + S[0] + "," + S[1] + " Q" + Cx + "," + Cy + " " + T[0] + "," + T[1],
      fill: "none", stroke: "transparent", "stroke-width": Math.max(w, 12)
    }, g);

    var lx = 0.25 * S[0] + 0.5 * Cx + 0.25 * T[0];
    var ly = 0.25 * S[1] + 0.5 * Cy + 0.25 * T[1];
    var label = el("text", { class: "evf-flow-label", x: lx, y: ly + 4, "text-anchor": "middle" }, gLabels);
    label.textContent = f.v;

    f.g = g;
    f.label = label;
    g.addEventListener("mousemove", function (event) {
      showTip(event, A.name + " → " + B.name + ": <b>" + thousands(f.v) + "</b> väljare");
    });
    g.addEventListener("mouseleave", hideTip);
    g.addEventListener("click", function () { toggle(f.to); });
  });

  PARTIES.forEach(function (party) {
    var g = el("g", {
      class: "evf-node", tabindex: 0, role: "button", "aria-pressed": "false",
      "aria-label": party.name + ", netto " + signedThousands(party.net) + " väljare"
    }, gNodes);
    el("circle", { class: "evf-node__ring", cx: party.x, cy: party.y, r: r + 6 }, g);
    el("circle", { class: "evf-node__dot", cx: party.x, cy: party.y, r: r, fill: party.color }, g);
    var abbr = el("text", { class: "evf-node__abbr", x: party.x, y: party.y + 5, "text-anchor": "middle", fill: party.ink }, g);
    abbr.textContent = party.id;

    var lr = R + r + 16;
    var cos = Math.cos(party.a);
    var sin = Math.sin(party.a);
    var lx = cx + lr * cos;
    var ly = cy + lr * sin;
    var anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
    var dy = sin < -0.5 ? -22 : sin > 0.5 ? 14 : -4;
    var name = el("text", { class: "evf-node__name", x: lx, y: ly + dy, "text-anchor": anchor }, g);
    name.textContent = party.name;
    var net = el("text", { class: "evf-node__net " + netClass(party.net), x: lx, y: ly + dy + 17, "text-anchor": anchor }, g);
    net.textContent = signedThousands(party.net);
    el("tspan", { class: "evf-node__unit" }, net).textContent = " väljare";

    party.g = g;
    g.addEventListener("mouseenter", function () { hovered = party.id; update(); });
    g.addEventListener("mouseleave", function () { hovered = null; update(); });
    g.addEventListener("click", function () { toggle(party.id); });
    g.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle(party.id);
      }
    });
  });

  function showTip(event, html) {
    var box = chart.getBoundingClientRect();
    tip.innerHTML = html;
    tip.style.left = (event.clientX - box.left) + "px";
    tip.style.top = (event.clientY - box.top) + "px";
    tip.classList.add("is-visible");
  }
  function hideTip() {
    tip.classList.remove("is-visible");
  }

  threshold.addEventListener("input", function () {
    thresholdValue.textContent = thousands(+threshold.value);
    update();
  });

  function select(id) {
    selected = id;
    update();
  }

  function update() {
    var t = +threshold.value;
    var active = hovered || selected;
    FLOWS.forEach(function (f) {
      var visible = f.v >= t;
      var involved = active && (f.from === active || f.to === active);
      f.g.style.display = visible ? "" : "none";
      f.g.style.opacity = !active ? 0.62 : involved ? 0.95 : 0.06;
      f.label.style.opacity = visible && (active ? involved : f.v >= 40) ? 1 : 0;
    });
    PARTIES.forEach(function (party) {
      var linked = !active || party.id === active || FLOWS.some(function (f) {
        return f.v >= t && ((f.from === active && f.to === party.id) || (f.to === active && f.from === party.id));
      });
      party.g.classList.toggle("is-selected", party.id === selected);
      party.g.setAttribute("aria-pressed", party.id === selected ? "true" : "false");
      party.g.style.opacity = linked ? 1 : 0.35;
    });
    renderPanel(active);
  }

  // ---------------------------------------------------------------------
  // Side panel: the largest flows, or one party's balance sheet.
  // ---------------------------------------------------------------------
  function barRows(list, key, color) {
    if (!list.length) return "<p class=\"election-muted\">Inga</p>";
    var max = Math.max.apply(null, list.map(function (f) { return f.v; }));
    return "<div class=\"evf-rows\">" + list.map(function (f) {
      var other = byId[f[key]];
      return "<div class=\"evf-row\"><span class=\"evf-row__label\">" + other.name + "</span>" +
        "<span class=\"evf-row__track\"><span class=\"evf-row__bar\" style=\"width:" + (f.v / max * 100) +
        "%;background:" + (color || other.color) + "\"></span></span>" +
        "<span class=\"evf-row__value\">" + f.v + "</span></div>";
    }).join("") + "</div>";
  }

  function renderPanel(id) {
    if (!id) {
      var top = FLOWS.slice().sort(function (a, b) { return b.v - a.v; }).slice(0, 7);
      var max = top[0].v;
      panel.innerHTML =
        "<h3 class=\"evf-panel__title\">Största nettoflödena</h3>" +
        "<p class=\"election-muted\">Tusentals väljare, 2022 → 2026</p>" +
        "<div class=\"evf-rows\">" + top.map(function (f) {
          return "<div class=\"evf-row evf-row--pair\"><span class=\"evf-row__label\">" + f.from + " → " + f.to + "</span>" +
            "<span class=\"evf-row__track\"><span class=\"evf-row__bar\" style=\"width:" + (f.v / max * 100) +
            "%;background:" + byId[f.from].color + "\"></span></span>" +
            "<span class=\"evf-row__value\">" + f.v + "</span></div>";
        }).join("") + "</div>" +
        "<h4 class=\"evf-panel__subhead\">Så läser du hjulet</h4>" +
        "<p class=\"election-muted\">Pilarna har färgen hos partiet som tappade väljarna. De två största förlorarna, Sverigedemokraterna och Socialdemokraterna, skickar flöden åt nästan alla håll: SD främst till M, L och KD, och S främst till V, M och MP.</p>";
      return;
    }
    var party = byId[id];
    var gains = FLOWS.filter(function (f) { return f.to === id; }).sort(function (a, b) { return b.v - a.v; });
    var losses = FLOWS.filter(function (f) { return f.from === id; }).sort(function (a, b) { return b.v - a.v; });
    var gained = gains.reduce(function (sum, f) { return sum + f.v; }, 0);
    var lost = losses.reduce(function (sum, f) { return sum + f.v; }, 0);
    panel.innerHTML =
      "<h3 class=\"evf-panel__title\"><span class=\"ev-swatch\" style=\"background:" + party.color + "\" aria-hidden=\"true\"></span>" + party.name + "</h3>" +
      "<p class=\"election-muted\">" + signedPe(party.pe) + " procentenheter sedan 2022</p>" +
      "<div class=\"evf-panel__big " + netClass(party.net) + "\">" + signedThousands(party.net) + "</div>" +
      "<p class=\"election-muted\">väljare netto: " + thousands(gained) + " vunna, " + thousands(lost) + " förlorade</p>" +
      "<h4 class=\"evf-panel__subhead\">Vann från</h4>" + barRows(gains, "from") +
      "<h4 class=\"evf-panel__subhead\">Förlorade till</h4>" + barRows(losses, "to") +
      (selected ? "<button type=\"button\" class=\"election-timeseries__control evf-clear\" id=\"election-flows-clear\">Visa alla partier</button>" : "");
    var clear = document.getElementById("election-flows-clear");
    if (clear) clear.addEventListener("click", function () { select(null); });
  }

  // ---------------------------------------------------------------------
  // Net result per party
  // ---------------------------------------------------------------------
  var netChart = document.getElementById("election-flows-net");
  var maxNet = Math.max.apply(null, PARTIES.map(function (p) { return Math.abs(p.net); }));
  var head = document.createElement("div");
  head.className = "evf-net__row evf-net__row--head";
  head.setAttribute("aria-hidden", "true");
  head.innerHTML = "<span></span><span class=\"evf-net__colhead evf-net__colhead--bars\">Förlust · Vinst</span>" +
    "<span class=\"evf-net__colhead\">Tusen väljare</span><span class=\"evf-net__colhead\">Procent­enheter</span>";
  netChart.appendChild(head);

  PARTIES.slice().sort(function (a, b) { return b.net - a.net; }).forEach(function (party) {
    var row = document.createElement("div");
    var pct = Math.abs(party.net) / maxNet * 100;
    row.className = "evf-net__row";
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    row.setAttribute("aria-label", party.name + ": netto " + signedThousands(party.net) +
      " väljare, " + signedPe(party.pe) + " procentenheter. Visa i hjulet.");
    row.innerHTML =
      "<span class=\"evf-net__name\"><span class=\"ev-swatch\" style=\"background:" + party.color + "\" aria-hidden=\"true\"></span>" +
        "<span class=\"evf-net__full\">" + party.name + "</span><span class=\"evf-net__abbr\">" + party.id + "</span></span>" +
      "<span class=\"evf-net__bars\">" +
        "<span class=\"evf-net__side evf-net__side--loss\">" + (party.net < 0 ? "<span style=\"width:" + pct + "%\"></span>" : "") + "</span>" +
        "<span class=\"evf-net__side evf-net__side--gain\">" + (party.net > 0 ? "<span style=\"width:" + pct + "%\"></span>" : "") + "</span>" +
      "</span>" +
      "<span class=\"evf-net__value " + netClass(party.net) + "\">" + signed(party.net) + "</span>" +
      "<span class=\"evf-net__pe\">" + signedPe(party.pe) + "</span>";
    row.addEventListener("click", function () {
      select(party.id);
      chart.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    row.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        row.click();
      }
    });
    netChart.appendChild(row);
  });

  update();
}());
