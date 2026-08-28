(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var base = app.getAttribute("data-publication-base").replace(/\/$/, "");
  var status = document.getElementById("election-app-status");

  // ---------------------------------------------------------------------
  // Canonical party palette.  This object is the single source of truth for
  // party colour in every visualisation on the page; the stylesheet only
  // consumes it through inline custom properties written from here.  Colour
  // is never the sole encoding: every mark is accompanied by a party label.
  // ---------------------------------------------------------------------
  var partyColors = {
    M: "#213A8F", L: "#006AB3", C: "#2B8569", KD: "#01263E",
    S: "#ED1B34", V: "#A81420", MP: "#4C983E", SD: "#A87F00", REST: "#8A8A8A"
  };
  var partyNames = {
    M: "Moderaterna",
    L: "Liberalerna",
    C: "Centerpartiet",
    KD: "Kristdemokraterna",
    S: "Socialdemokraterna",
    V: "V\u00e4nsterpartiet",
    MP: "Milj\u00f6partiet",
    SD: "Sverigedemokraterna",
    REST: "\u00d6vriga partier"
  };
  // Display-only short label.  The payload key REST stays the internal
  // identity; the reader sees a Swedish abbreviation.
  var partyAbbr = { REST: "\u00d6vr." };

  function abbr(name) {
    return partyAbbr[name] || name;
  }
  // Conventional left-to-right Riksdag seating used only to lay out the
  // chamber graphic.  It carries no bloc claim and no published semantics.
  var seatingOrder = ["V", "S", "MP", "C", "L", "KD", "M", "SD"];

  var MAJORITY = 175;
  var CHAMBER = 349;
  var EN_DASH = "\u2013";
  var NBSP = "\u00a0";
  // Abbreviating "procentenheter" has no settled Swedish form, so the unit is
  // written out; a breaking space lets a narrow cell wrap after the number.
  var PP = " procentenheter";
  var MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni",
    "juli", "aug", "sep", "okt", "nov", "dec"];
  var COALITION_PARTY_ORDER = ["M", "L", "C", "KD", "S", "V", "MP", "SD"];
  var COALITION_FIELDS = [
    "mean_seats", "median_seats", "p05_seats", "p10_seats", "p25_seats",
    "p75_seats", "p90_seats", "p95_seats", "prob_majority"
  ];
  var COALITION_ENTRY_FIELDS = ["mask", "parties"].concat(COALITION_FIELDS);
  var COALITION_HISTOGRAM_FIELDS = ["min_seats", "counts"];
  var COALITION_ENTRY_FIELDS_WITH_HISTOGRAM = COALITION_ENTRY_FIELDS.concat(["seat_histogram"]);

  // =====================================================================
  // FROZEN PUBLICATION SUBSYSTEM
  //
  // Everything from here to "END FROZEN" is the release-critical loading
  // and validation contract: pointer-first loading, 404-only legacy
  // fallback, manifest byte hashing, deterministic payload linkage,
  // source_worktree_clean certification and the representative 349-seat
  // allocation rule.  It is carried over unchanged and must not be
  // weakened, duplicated or bypassed by presentation code.
  // =====================================================================

  function getJson(name, root) {
    return fetch((root || base) + "/" + name).then(function (response) {
      if (!response.ok) {
        var error = new Error("Could not load " + name + " (" + response.status + ")");
        error.status = response.status;
        throw error;
      }
      return response.json();
    });
  }

  var publicationFiles = ["forecast.json", "parties.json", "seats.json", "groups.json", "calibration.json", "metadata.json", "manifest.json"];
  var publicationContracts = publicationFiles.slice(0, 6);

  function getText(name, root) {
    return fetch((root || base) + "/" + name).then(function (response) {
      if (!response.ok) {
        var error = new Error("Could not load " + name + " (" + response.status + ")");
        error.status = response.status;
        throw error;
      }
      return response.text();
    });
  }

  function sha256Hex(text) {
    if (typeof crypto === "undefined" || !crypto.subtle || typeof TextEncoder === "undefined") {
      return Promise.reject(new Error("Browser cannot verify the publication manifest hash"));
    }
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buffer) {
      return Array.prototype.map.call(new Uint8Array(buffer), function (value) {
        return value.toString(16).padStart(2, "0");
      }).join("");
    });
  }

  function loadContracts(root, pointer) {
    return Promise.all(publicationContracts.map(function (name) {
      return getJson(name, root);
    })).then(function (files) {
      if (!pointer) {
        return getJson("manifest.json", root).then(function (manifest) {
          return { files: files.concat([manifest]), manifest_sha256: null };
        });
      }
      // Hash the exact manifest bytes addressed by current.json.  Parsing and
      // re-serializing JSON would hide whitespace/content tampering.
      return getText("manifest.json", root).then(function (manifestText) {
        var manifest;
        try {
          manifest = JSON.parse(manifestText);
        } catch (error) {
          throw new Error("Publication manifest is not valid JSON");
        }
        return sha256Hex(manifestText).then(function (manifestHash) {
          return { files: files.concat([manifest]), manifest_sha256: manifestHash };
        });
      });
    });
  }

  function loadPublication() {
    // The pointer is the canonical web contract.  The 404 fallback keeps
    // older static publications readable while they are migrated, but a
    // malformed existing pointer is a hard error and is never bypassed.
    return getJson("current.json").then(function (pointer) {
      if (!pointer || pointer.publication_state !== "COMPLETE" || typeof pointer.publication_generation !== "string" || typeof pointer.manifest_sha256 !== "string" || typeof pointer.path !== "string" || pointer.path !== "versions/" + pointer.publication_generation || !/^versions\/[A-Za-z0-9_-]+$/.test(pointer.path)) {
        throw new Error("Current publication pointer is invalid");
      }
      return loadContracts(base + "/" + pointer.path, pointer).then(function (loaded) {
        loaded.pointer = pointer;
        return loaded;
      });
    }, function (error) {
      if (error.status !== 404) throw error;
      return loadContracts(base, null).then(function (loaded) {
        loaded.pointer = null;
        return loaded;
      });
    });
  }

  function coherentLegacyAllocation(seats, order) {
    // Older publications exposed only marginal medians.  Keep those URLs
    // usable, but normalize their display to a legal 349-seat parliament and
    // label it as a compatibility fallback rather than implying joint
    // uncertainty that the old payload did not contain.
    var allocation = {};
    var total = 0;
    order.forEach(function (name) {
      var row = seats.seat_summary[name];
      var value = row ? Math.max(0, Math.round(Number(row.median) || 0)) : 0;
      allocation[name] = value;
      total += value;
    });
    while (total < 349) {
      var addName = order.reduce(function (best, name) {
        return allocation[name] > allocation[best] ? name : best;
      }, order[0]);
      allocation[addName] += 1;
      total += 1;
    }
    while (total > 349) {
      var removeName = order.reduce(function (best, name) {
        if (allocation[name] <= 0) return best;
        return best === null || allocation[name] > allocation[best] ? name : best;
      }, null);
      if (removeName === null) break;
      allocation[removeName] -= 1;
      total -= 1;
    }
    return { allocation: allocation, source: "legacy_normalized_marginal_medians" };
  }

  function displaySeatAllocation(seats, order, requireRepresentative) {
    var representative = seats.representative_allocation;
    if (representative && representative.seats) {
      var allocation = {};
      var total = 0;
      var valid = order.every(function (name) {
        var value = representative.seats[name];
        if (!Number.isInteger(value) || value < 0) return false;
        allocation[name] = value;
        total += value;
        return true;
      });
      if (valid && total === 349 && representative.total_seats === 349) {
        return { allocation: allocation, source: "representative_joint_simulation_draw" };
      }
    }
    if (requireRepresentative) {
      throw new Error("Published seat contract has no valid representative joint allocation");
    }
    return coherentLegacyAllocation(seats, order);
  }

  function validatePublicationBundle(data, pointer, manifestHash) {
    var manifest = data[6] || {};
    if (manifest.publication_state && manifest.publication_state !== "COMPLETE") {
      throw new Error("Publication is not marked complete");
    }
    if (pointer && manifestHash !== pointer.manifest_sha256) {
      throw new Error("Current publication pointer hash does not match the manifest");
    }
    if (pointer && (manifest.source_worktree_clean !== true || !data[5] || data[5].source_worktree_clean !== true)) {
      throw new Error("Certified publication has dirty or incomplete source provenance");
    }
    var expected = manifest.deterministic_payload_sha256;
    var identities = data.slice(0, 6).map(function (value) {
      return value && value.deterministic_payload_sha256;
    }).filter(function (value) { return value; });
    if (pointer && (!expected || identities.length !== 6 || identities.some(function (value) { return value !== expected; }))) {
      throw new Error("Publication files do not all link the deterministic simulation payload");
    }
    if (!pointer && expected && identities.length > 1 && identities.some(function (value) { return value !== expected; })) {
      throw new Error("Publication files belong to different simulation payloads");
    }
    if (pointer && (manifest.publication_generation !== pointer.publication_generation || manifest.publication_state !== "COMPLETE")) {
      throw new Error("Publication pointer and manifest do not agree");
    }
  }

  function isCertified(metadata, manifest) {
    return metadata.source_worktree_clean === true && manifest && manifest.source_worktree_clean === true;
  }

  // =====================================================================
  // END FROZEN
  // Everything below only renders data that has already been validated.
  // =====================================================================

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var node = byId(id);
    if (node) node.textContent = text;
    return node;
  }

  function setHtml(id, html) {
    var node = byId(id);
    if (node) node.innerHTML = html;
    return node;
  }

  function reveal(id) {
    var node = byId(id);
    if (node) node.hidden = false;
    return node;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Every number the page prints goes through here, so the Swedish decimal
  // comma is applied in exactly one place.
  function format(value, digits) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "\u2014";
    return Number(value).toFixed(digits === undefined ? 1 : digits).replace(".", ",");
  }

  // Swedish typography separates a number from its percent sign.
  function percent(value, digits) {
    return format(value, digits) + NBSP + "%";
  }

  function num(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function grouped(value) {
    var parsed = num(value);
    if (parsed === null) return "\u2014";
    var text = String(Math.round(Math.abs(parsed)));
    var out = "";
    for (var i = 0; i < text.length; i += 1) {
      if (i > 0 && (text.length - i) % 3 === 0) out += NBSP;
      out += text.charAt(i);
    }
    return (parsed < 0 ? "-" : "") + out;
  }

  function interval(party, low, high) {
    return "[" + format(party[low], 1) + EN_DASH + format(party[high], 1) + "]";
  }

  function rangeText(low, high, digits) {
    return format(low, digits) + EN_DASH + format(high, digits);
  }

  function percentRange(low, high, digits) {
    return rangeText(low, high, digits) + NBSP + "%";
  }

  // Hero dates read as Swedish prose; the technical section keeps ISO dates,
  // which are machine-facing.
  function swedishDate(iso) {
    if (typeof iso !== "string") return null;
    var parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!parts) return null;
    var month = MONTHS[Number(parts[2]) - 1];
    if (!month) return null;
    return String(Number(parts[3])) + " " + month + " " + parts[1];
  }

  // Probabilities are empirical frequencies over the published draws.  Show
  // the published value, but never round a strictly interior probability to
  // a flat 0% or 100%.
  function probability(value) {
    var parsed = num(value);
    if (parsed === null) return "\u2014";
    if (parsed === 0) return "0,0" + NBSP + "%";
    if (parsed === 1) return "100,0" + NBSP + "%";
    var pct = parsed * 100;
    if (pct < 0.005) return "<0,01" + NBSP + "%";
    if (pct > 99.995) return ">99,99" + NBSP + "%";
    if (pct < 1 || pct > 99) return percent(pct, 2);
    return percent(pct, 1);
  }

  function niceMax(value, step) {
    var parsed = num(value);
    if (parsed === null || parsed <= 0) return step;
    return Math.ceil(parsed / step) * step;
  }

  function pct(value, scale) {
    var parsed = num(value);
    if (parsed === null) return 0;
    return Math.max(0, Math.min(100, (parsed / scale) * 100));
  }

  function daysBetween(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    var from = Date.parse(fromIso + "T00:00:00Z");
    var to = Date.parse(toIso + "T00:00:00Z");
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return Math.round((to - from) / 86400000);
  }

  // ---------------------------------------------------------------------
  // Cross-view party selection.  Selecting a party highlights it in the vote
  // rows, the seat rows, the chamber graphic and the legend at once.
  // ---------------------------------------------------------------------
  var highlightTargets = [];
  var partyPanels = {};
  var selectedParty = null;

  function track(party, node, baseClass) {
    if (!node) return node;
    node.className = baseClass;
    highlightTargets.push({ party: party, node: node, base: baseClass });
    return node;
  }

  function applySelection() {
    var i;
    for (i = 0; i < highlightTargets.length; i += 1) {
      var target = highlightTargets[i];
      var className = target.base;
      if (selectedParty) {
        className += target.party === selectedParty ? " is-selected" : " is-muted";
      }
      target.node.className = className;
    }
    Object.keys(partyPanels).forEach(function (name) {
      var panel = partyPanels[name];
      var open = name === selectedParty;
      if (panel.detail) panel.detail.hidden = !open;
      if (panel.head) {
        panel.head.setAttribute("aria-expanded", open ? "true" : "false");
      }
    });
    app.className = selectedParty ? "election-app is-focused" : "election-app";
    setText("election-selection-note", selectedParty
      ? partyNames[selectedParty] + " (" + abbr(selectedParty) + ") \u00e4r markerat i diagrammen f\u00f6r r\u00f6standelar, mandat och riksdagen."
      : "");
  }

  function selectParty(name) {
    selectedParty = selectedParty === name ? null : name;
    applySelection();
  }

  if (app.addEventListener) {
    app.addEventListener("keydown", function (event) {
      if (event && event.key === "Escape" && selectedParty) {
        selectedParty = null;
        applySelection();
      }
    });
  }

  // ---------------------------------------------------------------------
  // 1. Forecast header
  // ---------------------------------------------------------------------
  function renderHeader(forecast, metadata, manifest, pointer) {
    reveal("election-hero");
    var asOf = forecast.as_of || metadata.as_of || null;
    var electionDate = forecast.election_date || metadata.election_date || null;
    setText("election-hero-asof", swedishDate(asOf) || asOf || "\u2014");
    setText("election-hero-election", swedishDate(electionDate) || electionDate || "\u2014");

    var remaining = daysBetween(asOf, electionDate);
    var countdown = byId("election-hero-countdown");
    if (countdown) {
      if (remaining === null) {
        countdown.textContent = "\u2014";
      } else if (remaining > 0) {
        countdown.textContent = grouped(remaining) + (remaining === 1 ? " dag" : " dagar");
      } else if (remaining === 0) {
        countdown.textContent = "Valdagen \u00e4r i dag";
      } else {
        countdown.textContent = "Valet \u00e4r genomf\u00f6rt";
      }
    }

    var samples = num(forecast.total_samples);
    var lede = byId("election-hero-lede");
    if (lede) {
      var draws = samples === null
        ? "ett publicerat antal"
        : grouped(samples);
      lede.textContent = "Baserad p\u00e5 " + draws + " simulerade valresultat. " +
        "Intervallen visar os\u00e4kerheten i m\u00f6jliga valutfall.";
    }

    return isCertified(metadata, manifest);
  }

  // ---------------------------------------------------------------------
  // 2. National vote forecast
  // ---------------------------------------------------------------------
  function renderVotes(forecast, parties) {
    reveal("election-headline");
    var host = byId("election-party-cards");
    if (!host) return;
    host.innerHTML = "";

    var order = parties.party_order || Object.keys(forecast.parties);
    var top = 0;
    order.forEach(function (name) {
      var party = forecast.parties[name];
      if (!party) return;
      var high = num(party.vote_share_p95);
      if (high !== null && high > top) top = high;
    });
    var scale = Math.max(10, niceMax(top * 1.04, 5));
    var thresholdLeft = pct(4, scale);

    order.forEach(function (name) {
      var party = forecast.parties[name];
      if (!party) return;
      var color = partyColors[name] || "#777";
      var thresholdValue = forecast.threshold_probabilities_4pct && forecast.threshold_probabilities_4pct[name];
      var thresholdKnown = name !== "REST" && thresholdValue !== undefined;
      var thresholdLabel = thresholdKnown ? probability(thresholdValue) : "g\u00e4ller inte";

      var p05 = pct(party.vote_share_p05, scale);
      var p95 = pct(party.vote_share_p95, scale);
      var p25 = pct(party.vote_share_p25, scale);
      var p75 = pct(party.vote_share_p75, scale);
      var median = pct(party.vote_share_median, scale);
      var detailId = "election-vote-detail-" + name;

      var row = document.createElement("div");
      var fullName = partyNames[name] || name;
      var label = fullName + " (" + abbr(name) + "): median " + format(party.vote_share_median, 1) +
        " procent, 90-procentigt prognosintervall " + format(party.vote_share_p05, 1) + " till " +
        format(party.vote_share_p95, 1) + " procent" +
        (thresholdKnown ? ", sannolikhet att n\u00e5 fyraprocentssp\u00e4rren " + thresholdLabel : "") +
        ". \u00d6ppna f\u00f6r samtliga intervall.";

      row.innerHTML =
        "<button type=\"button\" class=\"ev-head\" aria-expanded=\"false\"" +
        " aria-controls=\"" + detailId + "\" aria-label=\"" + escapeHtml(label) + "\">" +
          "<span class=\"ev-abbr\"><span class=\"ev-swatch\" style=\"background:" + color + "\" aria-hidden=\"true\"></span>" + escapeHtml(abbr(name)) + "</span>" +
          "<span class=\"ev-median\"><span class=\"ev-median__value\">" + format(party.vote_share_median, 1) + "</span><span class=\"ev-unit\">" + NBSP + "%</span></span>" +
          "<span class=\"ev-chart\" aria-hidden=\"true\">" +
            "<span class=\"ev-track\">" +
              "<span class=\"ev-threshold\" style=\"left:" + thresholdLeft.toFixed(3) + "%\"></span>" +
              "<span class=\"ev-band ev-band--90\" style=\"left:" + p05.toFixed(3) + "%;width:" + Math.max(0.4, p95 - p05).toFixed(3) + "%;background:" + color + "\"></span>" +
              "<span class=\"ev-band ev-band--50\" style=\"left:" + p25.toFixed(3) + "%;width:" + Math.max(0.4, p75 - p25).toFixed(3) + "%;background:" + color + "\"></span>" +
              "<span class=\"ev-median-mark\" style=\"left:" + median.toFixed(3) + "%\"></span>" +
            "</span>" +
          "</span>" +
          "<span class=\"ev-threshold-prob" + (thresholdKnown ? "" : " ev-threshold-prob--na") + "\">" + escapeHtml(thresholdLabel) + "</span>" +
        "</button>" +
        "<div class=\"ev-detail\" id=\"" + detailId + "\" hidden>" +
          "<p class=\"ev-detail__name\">" + escapeHtml(fullName) + "</p>" +
          "<dl class=\"ev-detail__grid\">" +
            "<div><dt>Median r\u00f6standel</dt><dd>" + percent(party.vote_share_median, 1) + "</dd></div>" +
            "<div><dt>50\u00a0% prognosintervall</dt><dd>" + percentRange(party.vote_share_p25, party.vote_share_p75, 1) + "</dd></div>" +
            "<div><dt>80\u00a0% prognosintervall</dt><dd>" + percentRange(party.vote_share_p10, party.vote_share_p90, 1) + "</dd></div>" +
            "<div><dt>90\u00a0% prognosintervall</dt><dd>" + percentRange(party.vote_share_p05, party.vote_share_p95, 1) + "</dd></div>" +
            "<div><dt>Sannolikhet att n\u00e5 4\u00a0%</dt><dd>" + escapeHtml(thresholdKnown ? thresholdLabel : "g\u00e4ller inte") + "</dd></div>" +
            "<div><dt>Medianmandat</dt><dd>" + format(party.seats_median, 0) + " (" + rangeText(party.seats_p05, party.seats_p95, 0) + ")</dd></div>" +
          "</dl>" +
          (name === "REST"
            ? "<p class=\"ev-detail__note\">\u201d\u00d6vriga\u201d \u00e4r en samlad kategori f\u00f6r sm\u00e5 partier. Den kan inte n\u00e5 sp\u00e4rren eller f\u00e5 mandat p\u00e5 egen hand.</p>"
            : "") +
        "</div>";

      track(name, row, "ev-row");
      var head = row.querySelector(".ev-head");
      var detail = row.querySelector(".ev-detail");
      partyPanels[name] = { head: head, detail: detail };
      if (head && head.addEventListener) {
        head.addEventListener("click", function () { selectParty(name); });
      }
      host.appendChild(row);
    });

    renderAxis("election-vote-axis", scale, scale > 20 ? 10 : 5, "% av r\u00f6sterna", { value: 4, label: "4\u00a0%-sp\u00e4rr" });
  }

  function axisTick(left, label, emphasised) {
    return "<span class=\"ex-tick" + (emphasised ? " ex-tick--emph" : "") +
      (left > 80 ? " ex-tick--flush" : "") + "\" style=\"left:" + left.toFixed(3) + "%\">" +
      "<span class=\"ex-tick__label\">" + escapeHtml(label) + "</span></span>";
  }

  function renderAxis(id, scale, step, unit, marker) {
    var host = byId(id);
    if (!host) return;
    var ticks = "";
    for (var value = 0; value <= scale + 0.001; value += step) {
      ticks += axisTick(pct(value, scale), String(value), false);
    }
    if (marker) ticks += axisTick(pct(marker.value, scale), marker.label, true);
    host.innerHTML =
      "<span class=\"ex-axis__spacer\" aria-hidden=\"true\"></span>" +
      "<span class=\"ex-axis__track\" aria-hidden=\"true\">" + ticks + "</span>" +
      "<span class=\"ex-axis__unit\" aria-hidden=\"true\">" + escapeHtml(unit) + "</span>";
  }

  // ---------------------------------------------------------------------
  // 3. Seats
  // ---------------------------------------------------------------------
  function renderSeats(seats, requireRepresentative) {
    reveal("election-seats");
    var order = seats.party_order || Object.keys(seats.seat_summary);

    var top = 0;
    order.forEach(function (name) {
      var row = seats.seat_summary[name];
      var high = row ? num(row.p95) : null;
      if (high !== null && high > top) top = high;
    });
    var scale = Math.max(MAJORITY, niceMax(top * 1.04, 25));
    var majorityLeft = pct(MAJORITY, scale);

    var bars = byId("election-seat-bars");
    if (bars) {
      bars.innerHTML = "";
      order.forEach(function (name) {
        var summary = seats.seat_summary[name];
        if (!summary) return;
        var color = partyColors[name] || "#777";
        var median = pct(summary.median, scale);
        var low = pct(summary.p05, scale);
        var high = pct(summary.p95, scale);
        var row = document.createElement("div");
        row.innerHTML =
          "<span class=\"es-abbr\"><span class=\"ev-swatch\" style=\"background:" + color + "\" aria-hidden=\"true\"></span>" + escapeHtml(abbr(name)) + "</span>" +
          "<span class=\"es-median\">" + format(summary.median, 0) + "</span>" +
          "<span class=\"es-chart\" aria-hidden=\"true\">" +
            "<span class=\"es-track\">" +
              "<span class=\"es-majority\" style=\"left:" + majorityLeft.toFixed(3) + "%\"></span>" +
              "<span class=\"es-bar\" style=\"width:" + median.toFixed(3) + "%;background:" + color + "\"></span>" +
              "<span class=\"es-range\" style=\"left:" + low.toFixed(3) + "%;width:" + Math.max(0.4, high - low).toFixed(3) + "%\"></span>" +
            "</span>" +
          "</span>" +
          "<span class=\"es-range-text\">" + rangeText(summary.p05, summary.p95, 0) + "</span>";
        row.setAttribute("role", "listitem");
        row.setAttribute("aria-label", (partyNames[name] || name) + " (" + abbr(name) + "): median " +
          format(summary.median, 0) + " mandat, 90-procentigt prognosintervall " +
          format(summary.p05, 0) + " till " + format(summary.p95, 0) + " mandat.");
        track(name, row, "es-row");
        bars.appendChild(row);
      });
    }

    renderAxis("election-seat-axis", scale, 50, "mandat", { value: MAJORITY, label: MAJORITY + " = majoritet" });

    renderParliament(seats, order, requireRepresentative);
  }

  // Concentric-ring seating geometry for a semicircular chamber.  Ring radii
  // are evenly spaced; seats per ring are proportional to ring radius with a
  // largest-remainder correction so the ring counts sum to the chamber size
  // exactly.  Positions are emitted in left-to-right angular order.
  function parliamentLayout(total, rings, innerFraction) {
    var radii = [];
    var sum = 0;
    var i;
    for (i = 0; i < rings; i += 1) {
      var radius = rings === 1 ? 1 : innerFraction + (1 - innerFraction) * (i / (rings - 1));
      radii.push(radius);
      sum += radius;
    }
    var counts = [];
    var remainders = [];
    var assigned = 0;
    for (i = 0; i < rings; i += 1) {
      var exact = total * radii[i] / sum;
      var whole = Math.floor(exact);
      counts.push(whole);
      assigned += whole;
      remainders.push({ index: i, value: exact - whole });
    }
    remainders.sort(function (a, b) { return b.value - a.value || a.index - b.index; });
    for (i = 0; assigned < total; i += 1) {
      counts[remainders[i % rings].index] += 1;
      assigned += 1;
    }

    var points = [];
    var minArc = Infinity;
    for (i = 0; i < rings; i += 1) {
      var count = counts[i];
      if (count < 1) continue;
      minArc = Math.min(minArc, Math.PI * radii[i] / count);
      for (var j = 0; j < count; j += 1) {
        points.push({ angle: Math.PI * (1 - (j + 0.5) / count), radius: radii[i] });
      }
    }
    points.sort(function (a, b) { return b.angle - a.angle || a.radius - b.radius; });
    var radial = rings > 1 ? (1 - innerFraction) / (rings - 1) : 1;
    return { points: points, spacing: Math.min(radial, minArc) };
  }

  function renderParliament(seats, order, requireRepresentative) {
    var parliament = byId("election-parliament");
    if (!parliament) return;
    parliament.innerHTML = "";

    // Contract call: throws for a certified publication whose representative
    // joint allocation is missing or not a legal 349-seat chamber.
    var display = displaySeatAllocation(seats, order, requireRepresentative);

    var sequence = [];
    seatingOrder.forEach(function (name) {
      if (order.indexOf(name) !== -1) sequence.push(name);
    });
    order.forEach(function (name) {
      if (sequence.indexOf(name) === -1) sequence.push(name);
    });

    var assignment = [];
    var counts = [];
    sequence.forEach(function (name) {
      var count = Math.max(0, Number(display.allocation[name]) || 0);
      if (count > 0) counts.push({ party: name, seats: count });
      for (var i = 0; i < count; i += 1) assignment.push(name);
    });

    var layout = parliamentLayout(CHAMBER, 10, 0.42);
    var maxRadius = 47;
    var centreY = 51;
    var boxHeight = 53;
    var dotSize = (layout.spacing * maxRadius * 0.8).toFixed(3);

    var seatIndex = 0;
    while (seatIndex < CHAMBER) {
      var point = layout.points[seatIndex];
      var party = assignment[seatIndex];
      var seat = document.createElement("span");
      seat.className = party ? "election-seat" : "election-seat election-seat--empty";
      if (party) {
        seat.style.backgroundColor = partyColors[party] || "#777";
        track(party, seat, "election-seat");
      }
      if (point) {
        seat.style.left = (50 + maxRadius * point.radius * Math.cos(point.angle)).toFixed(3) + "%";
        seat.style.top = (((centreY - maxRadius * point.radius * Math.sin(point.angle)) / boxHeight) * 100).toFixed(3) + "%";
      }
      seat.style.width = dotSize + "%";
      seat.setAttribute("aria-hidden", "true");
      parliament.appendChild(seat);
      seatIndex += 1;
    }

    var breakdown = counts.map(function (entry) {
      return entry.party + " " + entry.seats;
    }).join(", ");
    parliament.setAttribute("aria-label", "Riksdagen med 349 mandat; " + display.source.replace(/_/g, " ") +
      " med " + seatIndex + " mandatpositioner" + (breakdown ? ". Mandat: " + breakdown + "." : ""));

    var representative = display.source === "representative_joint_simulation_draw";
    setText("election-parliament-caption", representative
      ? "Ett av de simulerade utfallen med 349 mandat. Det \u00e4r inte skapat genom att summera partiernas medianer."
      : "Den h\u00e4r \u00e4ldre publiceringen inneh\u00e5ller bara medianer f\u00f6r ett parti i taget. Riksdagsbilden nedan \u00e4r de medianerna omr\u00e4knade till en giltig f\u00f6rdelning av 349 mandat \u2013 en kompatibilitetsvisning, inte ett simulerat utfall.");

    var legend = byId("election-parliament-legend");
    if (legend) {
      legend.innerHTML = "";
      counts.forEach(function (entry) {
        var item = document.createElement("li");
        item.innerHTML =
          "<span class=\"ep-legend__swatch\" style=\"background:" + (partyColors[entry.party] || "#777") + "\" aria-hidden=\"true\"></span>" +
          "<span class=\"ep-legend__abbr\">" + escapeHtml(abbr(entry.party)) + "</span>" +
          "<span class=\"ep-legend__seats\">" + entry.seats + "</span>";
        item.setAttribute("aria-label", (partyNames[entry.party] || entry.party) + ": " + entry.seats + " mandat i det h\u00e4r utfallet");
        track(entry.party, item, "ep-legend__item");
        legend.appendChild(item);
      });
    }
  }

  // ---------------------------------------------------------------------
  // 4. Build your own government
  //
  // This view is deliberately lookup-only.  The published coalition_builder
  // contains summaries calculated from the simulator's joint seats_matrix;
  // the browser only resolves a selected bitmask and formats those values.
  // ---------------------------------------------------------------------
  var ZONE_POOL = "pool";
  var ZONE_GOVERNMENT = "government";
  var ZONE_SUPPORT = "support";
  var ZONE_NAMES = {
    pool: "Tillg\u00e4ngliga partier",
    government: "Regering",
    support: "St\u00f6dpartier"
  };
  // The left bar is the government alone; the right one is the government
  // *plus* its selected support parties.  Two independent bars can both sit
  // below 175 while their union clears it, which is the one question the
  // dashed majority rule exists to answer.
  var BAR_NAMES = { government: "Regering", union: "Med st\u00f6d" };
  var ZONE_CLASS = {
    pool: "eg-zone eg-zone--pool",
    government: "eg-zone eg-zone--column",
    support: "eg-zone eg-zone--column"
  };
  // A segment shorter than this share of the 349-seat scale cannot hold its
  // own label legibly at 360px, so the label is dropped there and the party
  // is read from the tile below the bar instead.
  var SEGMENT_LABEL_MIN_SHARE = 7;

  // Party colour is chosen for identity, not for contrast, so label ink
  // inside a segment is picked per party from WCAG relative luminance.
  function readableInk(hex) {
    var value = String(hex === null || hex === undefined ? "" : hex).replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return "#ffffff";
    function channel(offset) {
      var srgb = parseInt(value.substr(offset, 2), 16) / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
    }
    var luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#111111" : "#ffffff";
  }

  function histogramValueAtOrderIndex(minSeats, counts, index) {
    var remaining = index;
    for (var offset = 0; offset < counts.length; offset += 1) {
      if (remaining < counts[offset]) return minSeats + offset;
      remaining -= counts[offset];
    }
    return null;
  }

  function histogramQuantile(minSeats, counts, quantile, total) {
    var position = (total - 1) * quantile;
    var lowerIndex = Math.floor(position);
    var upperIndex = Math.ceil(position);
    var lower = histogramValueAtOrderIndex(minSeats, counts, lowerIndex);
    var upper = histogramValueAtOrderIndex(minSeats, counts, upperIndex);
    if (lower === null || upper === null) return null;
    // Existing group summaries use NumPy's default linear percentile and then
    // truncate to integer seats. Match NumPy's _lerp branch at the halfway
    // point before truncating; the two algebraically equivalent forms can land
    // on opposite sides of an integer in floating-point arithmetic.
    var gamma = position - lowerIndex;
    var difference = upper - lower;
    var interpolated = gamma < 0.5
      ? lower + difference * gamma
      : upper - difference * (1 - gamma);
    return Math.floor(interpolated);
  }

  function validCoalitionHistogram(histogram, expectedTotal, entry, mask) {
    if (!histogram || typeof histogram !== "object" || Array.isArray(histogram)) return false;
    var histogramKeys = Object.keys(histogram);
    if (histogramKeys.length !== COALITION_HISTOGRAM_FIELDS.length ||
        !COALITION_HISTOGRAM_FIELDS.every(function (field, index) {
          return histogramKeys[index] === field;
        })) return false;

    var minSeats = histogram.min_seats;
    var counts = histogram.counts;
    if (!Number.isInteger(minSeats) || minSeats < 0 || minSeats > CHAMBER ||
        !Array.isArray(counts) || counts.length < 1 ||
        minSeats + counts.length - 1 > CHAMBER) return false;

    var total = 0;
    for (var index = 0; index < counts.length; index += 1) {
      var count = counts[index];
      if (!Number.isInteger(count) || count < 0) return false;
      total += count;
    }
    if (!Number.isSafeInteger(total) || total <= 0 ||
        (expectedTotal !== null && total !== expectedTotal)) return false;

    // The histogram is a contiguous support encoding.  A zero-count edge is
    // not wrong mathematically, but accepting one would let a malformed
    // min_seats silently disagree with the first observed seat value.  The
    // empty/full invariants below additionally make their support explicit.
    if (counts.length > 1 && (counts[0] === 0 || counts[counts.length - 1] === 0)) return false;
    if (mask === 0 && (minSeats !== 0 || counts.length !== 1 || counts[0] !== total)) return false;
    if (mask === 255 && (minSeats !== CHAMBER || counts.length !== 1 || counts[0] !== total)) return false;

    var weightedSeats = counts.reduce(function (sum, count, index) {
      return sum + (minSeats + index) * count;
    }, 0);
    var meanValue = num(entry && entry.mean_seats);
    if (meanValue === null || Math.abs((weightedSeats / total) - meanValue) > 1e-12) return false;
    var quantileFields = [
      ["p05_seats", 0.05], ["p10_seats", 0.10], ["p25_seats", 0.25],
      ["median_seats", 0.50], ["p75_seats", 0.75], ["p90_seats", 0.90],
      ["p95_seats", 0.95]
    ];
    for (var quantileIndex = 0; quantileIndex < quantileFields.length; quantileIndex += 1) {
      var quantileField = quantileFields[quantileIndex];
      var expectedQuantile = histogramQuantile(minSeats, counts, quantileField[1], total);
      if (expectedQuantile === null || entry[quantileField[0]] !== expectedQuantile) return false;
    }

    var majorityCount = 0;
    for (var seatIndex = Math.max(0, MAJORITY - minSeats); seatIndex < counts.length; seatIndex += 1) {
      majorityCount += counts[seatIndex];
    }
    var probabilityValue = num(entry && entry.prob_majority);
    if (probabilityValue === null || Math.abs((majorityCount / total) - probabilityValue) > 1e-12) return false;
    return total;
  }

  function validCoalitionBuilder(builder, histogramRequired, expectedTotal) {
    var builderFields = ["party_order", "encoding", "majority_threshold", "coalitions"];
    if (!builder || typeof builder !== "object" ||
        Object.keys(builder).length !== builderFields.length ||
        !builderFields.every(function (field, index) {
          return Object.keys(builder)[index] === field;
        }) ||
        builder.encoding !== "bitmask" ||
        builder.majority_threshold !== MAJORITY || !Array.isArray(builder.party_order) ||
        builder.party_order.length !== COALITION_PARTY_ORDER.length ||
        !builder.party_order.every(function (party, index) {
          return party === COALITION_PARTY_ORDER[index];
        })) {
      return false;
    }

    var coalitions = builder.coalitions;
    if (!coalitions || typeof coalitions !== "object" || Array.isArray(coalitions) ||
        Object.keys(coalitions).length !== 256 ||
        !Object.keys(coalitions).every(function (key, index) {
          return key === String(index);
        })) {
      return false;
    }

    var entryFields = histogramRequired
      ? COALITION_ENTRY_FIELDS_WITH_HISTOGRAM
      : COALITION_ENTRY_FIELDS;
    var commonTotal = expectedTotal === undefined || expectedTotal === null ? null : num(expectedTotal);
    if (commonTotal !== null && (!Number.isInteger(commonTotal) || commonTotal <= 0)) return false;
    if (histogramRequired && (typeof expectedTotal !== "number" ||
        !Number.isInteger(expectedTotal) || expectedTotal <= 0)) return false;
    var histogramTotal = commonTotal;
    var validatedHistograms = {};

    for (var mask = 0; mask < 256; mask += 1) {
      var entry = coalitions[String(mask)];
      if (!entry || typeof entry !== "object" || entry.mask !== mask ||
          !Array.isArray(entry.parties) ||
          Object.keys(entry).length !== entryFields.length ||
          !entryFields.every(function (field, index) {
            return Object.keys(entry)[index] === field;
          })) {
        return false;
      }
      var expectedParties = builder.party_order.filter(function (party, index) {
        return (mask & (1 << index)) !== 0;
      });
      if (entry.parties.length !== expectedParties.length ||
          !entry.parties.every(function (party, index) {
            return party === expectedParties[index];
          })) {
        return false;
      }
      for (var fieldIndex = 0; fieldIndex < COALITION_FIELDS.length; fieldIndex += 1) {
        var field = COALITION_FIELDS[fieldIndex];
        var value = num(entry[field]);
        var validNumber = field === "prob_majority" || field === "mean_seats"
          ? typeof entry[field] === "number" && Number.isFinite(entry[field])
          : Number.isInteger(entry[field]);
        if (!validNumber || value === null || (field === "prob_majority"
          ? value < 0 || value > 1
          : value < 0 || value > CHAMBER)) {
          return false;
        }
      }
      var quantiles = [entry.p05_seats, entry.p10_seats, entry.p25_seats,
        entry.median_seats, entry.p75_seats, entry.p90_seats, entry.p95_seats];
      if (!quantiles.every(function (value, index) {
        return index === 0 || value >= quantiles[index - 1];
      })) {
        return false;
      }
      if (mask === 0 && (entry.mean_seats !== 0 || entry.median_seats !== 0 ||
          entry.p05_seats !== 0 || entry.p10_seats !== 0 || entry.p25_seats !== 0 ||
          entry.p75_seats !== 0 || entry.p90_seats !== 0 || entry.p95_seats !== 0 ||
          entry.prob_majority !== 0)) {
        return false;
      }
      if (mask === 255 && (entry.mean_seats !== CHAMBER || entry.median_seats !== CHAMBER ||
          entry.p05_seats !== CHAMBER || entry.p10_seats !== CHAMBER || entry.p25_seats !== CHAMBER ||
          entry.p75_seats !== CHAMBER || entry.p90_seats !== CHAMBER || entry.p95_seats !== CHAMBER ||
          entry.prob_majority !== 1)) {
        return false;
      }
      if (histogramRequired) {
        var validatedTotal = validCoalitionHistogram(entry.seat_histogram, commonTotal, entry, mask);
        if (!validatedTotal || (histogramTotal !== null && validatedTotal !== histogramTotal)) return false;
        histogramTotal = validatedTotal;
        validatedHistograms[mask] = entry.seat_histogram;
      }
    }
    if (histogramRequired) {
      var fullMask = 255;
      for (var coalitionMask = 0; coalitionMask <= fullMask; coalitionMask += 1) {
        var complementMask = fullMask ^ coalitionMask;
        if (coalitionMask > complementMask) continue;
        var histogram = validatedHistograms[coalitionMask];
        var complementHistogram = validatedHistograms[complementMask];
        for (var seats = 0; seats <= CHAMBER; seats += 1) {
          var offset = seats - histogram.min_seats;
          var complementSeats = CHAMBER - seats;
          var complementOffset = complementSeats - complementHistogram.min_seats;
          var count = offset >= 0 && offset < histogram.counts.length ? histogram.counts[offset] : 0;
          var complementCount = complementOffset >= 0 && complementOffset < complementHistogram.counts.length
            ? complementHistogram.counts[complementOffset] : 0;
          if (count !== complementCount) return false;
        }
      }
    }
    return true;
  }

  function coalitionLookup(builder, mask) {
    return builder.coalitions[String(mask)];
  }

  function coalitionParties(builder, mask) {
    return builder.party_order.filter(function (party, index) {
      return (mask & (1 << index)) !== 0;
    });
  }

  function summaryRow(metric, term, value) {
    return "<div data-metric=\"" + metric + "\">" +
      "<dt>" + escapeHtml(term) + "</dt>" +
      "<dd>" + escapeHtml(value) + "</dd>" +
      "</div>";
  }

  function svgNode(name, attributes, text) {
    var node = typeof document.createElementNS === "function"
      ? document.createElementNS("http://www.w3.org/2000/svg", name)
      : document.createElement(name);
    Object.keys(attributes || {}).forEach(function (attribute) {
      node.setAttribute(attribute, attributes[attribute]);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function histogramBinLabel(seat, count, total, reachesMajority) {
    var share = total > 0 ? (count / total) * 100 : 0;
    return seat + " mandat \u00b7 " + grouped(count) + " simuleringar \u00b7 " + percent(share, 2) +
      (reachesMajority ? " \u00b7 175 mandat eller fler" : " \u00b7 under 175 mandat");
  }

  function renderCoalitionHistogram(host, entry, builder, mask, totalSamples) {
    if (!host) return;
    var svg = byId("election-government-histogram-svg");
    var context = byId("election-government-histogram-context");
    var textAlternative = byId("election-government-histogram-text");
    var status = byId("election-government-histogram-status");

    function clear() {
      host.hidden = true;
      host.setAttribute("data-coalition-mask", "");
      host.setAttribute("data-total-count", "0");
      host.setAttribute("data-sample-count", "0");
      host.setAttribute("data-min-seats", "");
      host.setAttribute("data-max-seats", "");
      if (context) context.textContent = "";
      if (textAlternative) textAlternative.textContent = "";
      if (status) {
        status.textContent = "";
        status.hidden = true;
      }
      if (svg) svg.innerHTML = "";
    }

    if (!entry || !entry.seat_histogram || !builder || !Array.isArray(builder.party_order)) {
      clear();
      return;
    }

    var histogram = entry.seat_histogram;
    var minSeats = histogram.min_seats;
    var counts = histogram.counts;
    if (!Number.isInteger(minSeats) || !Array.isArray(counts) || !counts.length) {
      clear();
      return;
    }
    var total = counts.reduce(function (sum, count) { return sum + count; }, 0);
    var expectedTotal = totalSamples === undefined || totalSamples === null ? null : num(totalSamples);
    if (!Number.isSafeInteger(total) || total <= 0 ||
        (expectedTotal !== null && total !== expectedTotal) || !svg) {
      clear();
      return;
    }

    var maxSeats = minSeats + counts.length - 1;
    var parties = coalitionParties(builder, mask);
    var partyLabel = parties.length ? parties.join(" + ") : "Inga partier";
    var majorityCount = counts.reduce(function (sum, count, index) {
      return sum + (minSeats + index >= MAJORITY ? count : 0);
    }, 0);
    var majorityShare = total > 0 ? majorityCount / total : 0;
    var patternId = "egh-majority-hatch-" + String(mask);
    // A compact coordinate system keeps axis labels legible when the SVG is
    // squeezed to a 360px viewport; CSS caps its width so preserveAspectRatio
    // can keep the typography and bars undistorted on wide screens.
    var plot = { left: 66, top: 30, width: 338, height: 224 };
    plot.right = plot.left + plot.width;
    plot.bottom = plot.top + plot.height;
    var domainStart = Math.min(minSeats, MAJORITY);
    var domainEnd = Math.max(maxSeats, MAJORITY);
    var domainSpan = Math.max(1, domainEnd - domainStart + 1);
    var binWidth = plot.width / domainSpan;
    var thresholdX = plot.left + (MAJORITY - domainStart) * binWidth;
    var peak = counts.reduce(function (highest, count) {
      return Math.max(highest, count);
    }, 0);

    host.hidden = false;
    host.setAttribute("data-coalition-mask", String(mask));
    host.setAttribute("data-total-count", String(total));
    host.setAttribute("data-sample-count", String(total));
    host.setAttribute("data-min-seats", String(minSeats));
    host.setAttribute("data-max-seats", String(maxSeats));
    if (context) {
      context.textContent = partyLabel + ". Fördelningen visar mandat för regering och stödpartier tillsammans i " +
        grouped(total) + " simulerade utfall.";
    }
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }

    svg.innerHTML = "";
    // Keep the SVG as a named group so focusable bins remain visible to
    // assistive technology; a root role=img would flatten those descendants
    // in several browser accessibility trees.
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-labelledby", "election-government-histogram-title election-government-histogram-description");
    svg.setAttribute("aria-label", "Mandatfördelning för " + partyLabel + " med majoritetsgränsen vid " + MAJORITY + " mandat");
    svg.setAttribute("data-coalition-mask", String(mask));
    svg.appendChild(svgNode("title", { id: "election-government-histogram-title" },
      "Mandatfördelning för " + partyLabel));
    var description = "Mandatfördelning för " + partyLabel + " från " + minSeats + " till " + maxSeats +
      " mandat. " + grouped(majorityCount) + " av " + grouped(total) +
      " simuleringar, " + percent(majorityShare * 100, 2) + ", når minst " + MAJORITY + " mandat.";
    svg.appendChild(svgNode("desc", { id: "election-government-histogram-description" }, description));

    var defs = svgNode("defs", {});
    var pattern = svgNode("pattern", {
      id: patternId,
      patternUnits: "userSpaceOnUse",
      width: "8",
      height: "8"
    });
    pattern.appendChild(svgNode("path", {
      d: "M-2,2 L2,-2 M0,8 L8,0 M6,10 L10,6",
      class: "egh-hatch"
    }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    var grid = svgNode("g", { class: "egh-grid", "aria-hidden": "true" });
    var yTicks = [0, 0.5, 1];
    yTicks.forEach(function (fraction) {
      var y = plot.bottom - plot.height * fraction;
      var label = format((peak > 0 ? (peak * fraction / total) * 100 : 0), 1) + NBSP + "%";
      grid.appendChild(svgNode("line", {
        x1: plot.left, y1: y, x2: plot.right, y2: y, class: "egh-grid__line"
      }));
      grid.appendChild(svgNode("text", {
        x: plot.left - 8, y: y + 4, class: "egh-axis__tick", "text-anchor": "end"
      }, label));
    });
    svg.appendChild(grid);

    var majorityWidth = Math.max(0, plot.right - thresholdX);
    if (majorityWidth > 0) {
      svg.appendChild(svgNode("rect", {
        x: thresholdX, y: plot.top, width: majorityWidth, height: plot.height,
        class: "egh-majority-region", fill: "url(#" + patternId + ")", "aria-hidden": "true"
      }));
    }
    if (thresholdX > plot.left) {
      svg.appendChild(svgNode("rect", {
        x: plot.left, y: plot.top, width: thresholdX - plot.left, height: plot.height,
        class: "egh-below-region", "aria-hidden": "true"
      }));
    }

    var bins = svgNode("g", { class: "egh-bins" });
    counts.forEach(function (count, index) {
      var seat = minSeats + index;
      var reachesMajority = seat >= MAJORITY;
      var height = peak > 0 ? (count / peak) * plot.height : 0;
      var x = plot.left + (seat - domainStart) * binWidth;
      var gap = Math.min(0.35, binWidth * 0.12);
      var bin = svgNode("g", {
        class: "egh-bin " + (reachesMajority ? "egh-bin--majority" : "egh-bin--below"),
        tabindex: "0",
        role: "img",
        "data-seat": String(seat),
        "data-count": String(count),
        "data-share": (count / total).toFixed(8),
        "data-majority": reachesMajority ? "majority" : "below",
        "data-coalition-mask": String(mask),
        "aria-label": histogramBinLabel(seat, count, total, reachesMajority)
      });
      bin.appendChild(svgNode("rect", {
        x: x + gap,
        y: plot.bottom - height,
        width: Math.max(0.2, binWidth - gap * 2),
        height: height,
        class: "egh-bin__bar",
        fill: reachesMajority ? "url(#" + patternId + ")" : "currentColor",
        "aria-hidden": "true"
      }));
      // A zero-frequency bin still needs a visible focus/tap target.  The
      // transparent hit area fills the bin's lane without changing the bar's
      // exact height or its frequency meaning.
      bin.appendChild(svgNode("rect", {
        x: x + gap,
        y: plot.top,
        width: Math.max(0.2, binWidth - gap * 2),
        height: plot.height,
        class: "egh-bin__hit",
        fill: "transparent",
        "aria-hidden": "true"
      }));
      function showBin() {
        if (!status) return;
        status.textContent = histogramBinLabel(seat, count, total, reachesMajority);
        status.hidden = false;
      }
      if (bin.addEventListener) {
        bin.addEventListener("mouseenter", showBin);
        bin.addEventListener("focus", showBin);
        bin.addEventListener("click", showBin);
        bin.addEventListener("keydown", function (event) {
          if (event && (event.key === "Enter" || event.key === " ")) {
            if (event.preventDefault) event.preventDefault();
            showBin();
          }
        });
      }
      bins.appendChild(bin);
    });
    svg.appendChild(bins);

    svg.appendChild(svgNode("line", {
      x1: plot.left, y1: plot.bottom, x2: plot.right, y2: plot.bottom,
      class: "egh-axis__line", "aria-hidden": "true"
    }));
    [domainStart, MAJORITY, domainEnd].filter(function (value, index, values) {
      return values.indexOf(value) === index;
    }).forEach(function (value) {
      var x = plot.left + (value - domainStart) * binWidth;
      svg.appendChild(svgNode("line", {
        x1: x, y1: plot.bottom, x2: x, y2: plot.bottom + 6,
        class: "egh-axis__mark", "aria-hidden": "true"
      }));
      svg.appendChild(svgNode("text", {
        x: x, y: plot.bottom + 21, class: "egh-axis__label",
        "text-anchor": value === domainStart ? "start" : (value === domainEnd ? "end" : "middle")
      }, String(value)));
    });
    svg.appendChild(svgNode("text", {
      x: plot.left + plot.width / 2, y: 309, class: "egh-x-axis-label", "text-anchor": "middle"
    }, "Mandat tillsammans"));
    svg.appendChild(svgNode("text", {
      x: plot.left, y: plot.top - 10, class: "egh-y-axis-label", "text-anchor": "start"
    }, "Andel simuleringar"));

    svg.appendChild(svgNode("line", {
      x1: thresholdX, y1: plot.top, x2: thresholdX, y2: plot.bottom,
      class: "egh-threshold", "stroke-dasharray": "6 5", "data-seat": String(MAJORITY),
      "aria-label": "Majoritetsgräns: 175 mandat"
    }));
    svg.appendChild(svgNode("text", {
      // Centering the label over the plot keeps the full Swedish annotation
      // inside the SVG for both narrow and wide coalition seat ranges.
      x: plot.left + plot.width / 2,
      y: plot.top + 13,
      class: "egh-threshold__label",
      "text-anchor": "middle"
    }, "Majoritetsgräns: 175 mandat"));

    if (textAlternative) {
      textAlternative.textContent = description + " Staplar med " + MAJORITY + " mandat eller fler är skrafferade; övriga staplar ligger under gränsen. Fokusera på en stapel för detaljer.";
    }
  }

  function renderGovernmentBuilder(groups, totalSamples) {
    var section = byId("election-government-builder");
    var histogramRequired = groups && groups.schema_version === "1.3";
    if (!section || !groups || (groups.schema_version !== "1.2" && groups.schema_version !== "1.3") ||
        !validCoalitionBuilder(groups.coalition_builder, histogramRequired, totalSamples)) {
      return;
    }

    var builder = groups.coalition_builder;
    var zones = {
      pool: byId("election-available-parties"),
      government: byId("election-government-parties"),
      support: byId("election-support-parties")
    };
    var bars = {
      government: byId("election-government-bar"),
      union: byId("election-union-bar")
    };
    var heads = {
      government: byId("election-government-column"),
      union: byId("election-union-column")
    };
    var totalIds = {
      government: "election-government-total",
      union: "election-union-total"
    };
    var poolEmpty = byId("election-pool-empty");
    var empty = byId("election-government-empty");
    var summary = byId("election-government-results");
    var note = byId("election-government-note");
    var histogram = byId("election-government-histogram");

    // The two column masks are disjoint by construction; the union mask is
    // what every published number in the summary is looked up with.
    var masks = { government: 0, support: 0 };
    var dragging = null;

    // Tiles under a bar are listed in the bar's own top-to-bottom order, so
    // the list and the stack can be read against each other.  The stack
    // itself follows the chamber's left-to-right seating order.
    var stackOrder = seatingOrder.filter(function (party) {
      return builder.party_order.indexOf(party) !== -1;
    });
    var columnOrder = stackOrder.slice().reverse();

    function bitOf(party) {
      var index = builder.party_order.indexOf(party);
      return index === -1 ? 0 : 1 << index;
    }

    // A single party's median is the lookup for its own one-bit mask: still
    // the published table, never a browser-side recomputation.
    function partyMedian(party) {
      var entry = coalitionLookup(builder, bitOf(party));
      var value = entry ? num(entry.median_seats) : null;
      return value === null ? 0 : Math.max(0, value);
    }

    function medianOf(mask) {
      var entry = coalitionLookup(builder, mask);
      var value = entry ? num(entry.median_seats) : null;
      return value === null ? 0 : Math.max(0, value);
    }

    function zoneOf(party) {
      var bit = bitOf(party);
      if ((masks.government & bit) !== 0) return ZONE_GOVERNMENT;
      if ((masks.support & bit) !== 0) return ZONE_SUPPORT;
      return ZONE_POOL;
    }

    function partiesIn(zone, order) {
      return order.filter(function (party) {
        return zoneOf(party) === zone;
      });
    }

    // The only mutation of the two masks.  Clearing both bits before setting
    // one is what makes double membership unrepresentable rather than merely
    // guarded against.
    function move(party, zone, focusAfter) {
      var bit = bitOf(party);
      if (bit === 0) return;
      masks.government &= ~bit;
      masks.support &= ~bit;
      if (zone === ZONE_GOVERNMENT) masks.government |= bit;
      if (zone === ZONE_SUPPORT) masks.support |= bit;
      render(focusAfter === false ? null : party);
    }

    function actionButton(party, zone, label, description, modifier) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "eg-party__btn" + (modifier ? " " + modifier : "");
      button.setAttribute("data-party", party);
      button.setAttribute("data-action", zone);
      button.setAttribute("aria-label", description);
      button.setAttribute("title", description);
      button.textContent = label;
      if (button.addEventListener) {
        button.addEventListener("click", function () { move(party, zone); });
      }
      return button;
    }

    function tileActions(party, zone) {
      var full = (partyNames[party] || party) + " (" + abbr(party) + ")";
      var actions = document.createElement("span");
      actions.className = "eg-party__actions";
      if (zone !== ZONE_GOVERNMENT) {
        actions.appendChild(actionButton(party, ZONE_GOVERNMENT,
          "Regering", "Flytta " + full + " till Regering"));
      }
      if (zone !== ZONE_SUPPORT) {
        actions.appendChild(actionButton(party, ZONE_SUPPORT,
          "St\u00f6d", "Flytta " + full + " till St\u00f6dpartier"));
      }
      if (zone !== ZONE_POOL) {
        actions.appendChild(actionButton(party, ZONE_POOL,
          "\u2715", "Ta bort " + full + " fr\u00e5n " + ZONE_NAMES[zone],
          "eg-party__btn--remove"));
      }
      return actions;
    }

    function buildTile(party, zone) {
      var tile = document.createElement("div");
      tile.className = "eg-party";
      tile.setAttribute("data-party", party);
      tile.setAttribute("data-zone", zone);
      tile.setAttribute("draggable", "true");
      tile.innerHTML =
        "<span class=\"eg-party__swatch\" style=\"background:" + (partyColors[party] || "#777") + "\" aria-hidden=\"true\"></span>" +
        "<span class=\"eg-party__abbr\">" + escapeHtml(abbr(party)) + "</span>" +
        "<span class=\"eg-party__seats\">" + format(partyMedian(party), 0) +
        "<span class=\"visually-hidden\"> mandat i median</span></span>";
      tile.appendChild(tileActions(party, zone));
      if (tile.addEventListener) {
        // Drag and drop is an addition on top of the buttons, never a
        // replacement: every move stays reachable by keyboard and by tap.
        tile.addEventListener("dragstart", function (event) {
          dragging = party;
          tile.className = "eg-party is-dragging";
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            try { event.dataTransfer.setData("text/plain", party); } catch (error) { /* IE-style stores */ }
          }
        });
        tile.addEventListener("dragend", function () {
          dragging = null;
          tile.className = "eg-party";
        });
      }
      return tile;
    }

    function renderZone(zone, order) {
      var host = zones[zone];
      if (!host) return [];
      var parties = partiesIn(zone, order);
      host.innerHTML = "";
      parties.forEach(function (party) {
        host.appendChild(buildTile(party, zone));
      });
      if (!parties.length && zone !== ZONE_POOL) {
        var hint = document.createElement("p");
        hint.className = "eg-zone__hint";
        hint.textContent = "Inga partier valda.";
        host.appendChild(hint);
      }
      return parties;
    }

    // `key` names the bar, not a zone: "government" draws the government mask
    // alone, "union" draws government | support so the majority rule can be
    // read against the coalition that would actually be counted.
    function renderBar(key, mask) {
      var host = bars[key];
      var total = medianOf(mask);
      var members = stackOrder.filter(function (party) {
        return (mask & bitOf(party)) !== 0;
      });
      setText(totalIds[key], format(total, 0));
      if (heads[key]) heads[key].setAttribute("data-coalition-mask", String(mask));
      if (!host) return;
      host.innerHTML = "";

      var sum = members.reduce(function (carry, party) {
        return carry + partyMedian(party);
      }, 0);
      // Published medians are per combination, so a coalition's median is not
      // the sum of its parties' medians (they differ by a few seats).  The
      // segments keep the party mix but are scaled to the combination median
      // the panel prints, so the bar top and the printed number cannot
      // disagree on screen.
      var scale = sum > 0 ? total / sum : 0;
      var described = [];
      members.forEach(function (party) {
        var seats = partyMedian(party);
        var share = pct(seats * scale, CHAMBER);
        var supporting = key === "union" && (masks.support & bitOf(party)) !== 0;
        var segment = document.createElement("span");
        segment.className = "eg-bar__segment" + (supporting ? " eg-bar__segment--support" : "");
        segment.style.height = share.toFixed(3) + "%";
        segment.style.backgroundColor = partyColors[party] || "#777";
        segment.style.color = readableInk(partyColors[party]);
        segment.setAttribute("data-party", party);
        segment.setAttribute("aria-hidden", "true");
        if (share >= SEGMENT_LABEL_MIN_SHARE) {
          segment.innerHTML = "<span class=\"eg-bar__segment-label\">" + escapeHtml(abbr(party)) + "</span>";
        }
        host.appendChild(segment);
        described.push(abbr(party) + " " + format(seats, 0) + (supporting ? " (st\u00f6d)" : ""));
      });
      // Segments are appended bottom-first (the track is column-reverse), but
      // the description is read top-down so it matches the tile list below.
      host.setAttribute("aria-label", members.length
        ? BAR_NAMES[key] + ": " + described.reverse().join(", ") + ". Median tillsammans " +
          format(total, 0) + " av " + CHAMBER + " mandat."
        : BAR_NAMES[key] + ": inga partier valda.");
    }

    function renderSummary() {
      var unionMask = masks.government | masks.support;
      var unionEntry = coalitionLookup(builder, unionMask);
      var chosen = masks.government !== 0;
      if (empty) empty.hidden = chosen;
      if (note) note.hidden = !chosen;
      if (!summary) {
        renderCoalitionHistogram(histogram, chosen ? unionEntry : null, builder, unionMask, totalSamples);
        return;
      }
      summary.hidden = !chosen;
      summary.setAttribute("data-government-mask", chosen ? String(masks.government) : "");
      summary.setAttribute("data-support-mask", chosen ? String(masks.support) : "");
      summary.setAttribute("data-coalition-mask", chosen ? String(unionMask) : "");
      if (!chosen || !unionEntry) {
        summary.innerHTML = "";
        renderCoalitionHistogram(histogram, null, builder, unionMask, totalSamples);
        setText("election-government-announcement",
          "V\u00e4lj minst ett regeringsparti.");
        return;
      }

      var governmentSeats = format(medianOf(masks.government), 0) + " mandat";
      var supportSeats = format(medianOf(masks.support), 0) + " mandat";
      var unionSeats = format(unionEntry.median_seats, 0) + " mandat";
      var unionRange = rangeText(unionEntry.p05_seats, unionEntry.p95_seats, 0) + " mandat";
      var unionProbability = probability(unionEntry.prob_majority);
      summary.innerHTML =
        summaryRow("government", ZONE_NAMES.government, governmentSeats) +
        summaryRow("support", ZONE_NAMES.support, supportSeats) +
        summaryRow("union", "Tillsammans", unionSeats) +
        summaryRow("interval", "90\u00a0% prognosintervall", unionRange) +
        summaryRow("probability", "Sannolikhet f\u00f6r minst " + MAJORITY + " mandat", unionProbability);
      renderCoalitionHistogram(histogram, unionEntry, builder, unionMask, totalSamples);

      var supportParties = coalitionParties(builder, masks.support);
      setText("election-government-announcement",
        "Regering " + coalitionParties(builder, masks.government).join(" + ") + ", " +
        governmentSeats + ". " +
        (supportParties.length
          ? "St\u00f6dpartier " + supportParties.join(" + ") + ", " + supportSeats + ". "
          : "Inga st\u00f6dpartier. ") +
        "Tillsammans " + unionSeats + "; 90-procentigt prognosintervall " + unionRange +
        "; sannolikhet f\u00f6r minst " + MAJORITY + " mandat " + unionProbability + ".");
    }

    function restoreFocus(party) {
      var host = zones[zoneOf(party)];
      if (!host || typeof host.querySelector !== "function") return;
      var button = host.querySelector(".eg-party[data-party=\"" + party + "\"] .eg-party__btn");
      if (button && typeof button.focus === "function") button.focus();
    }

    function render(focusParty) {
      var available = renderZone(ZONE_POOL, builder.party_order);
      renderZone(ZONE_GOVERNMENT, columnOrder);
      renderZone(ZONE_SUPPORT, columnOrder);
      if (poolEmpty) poolEmpty.hidden = available.length !== 0;
      renderBar("government", masks.government);
      renderBar("union", masks.government | masks.support);
      renderSummary();
      if (focusParty) restoreFocus(focusParty);
    }

    Object.keys(zones).forEach(function (zone) {
      var host = zones[zone];
      if (!host || !host.addEventListener) return;
      function reset() { host.className = ZONE_CLASS[zone]; }
      host.addEventListener("dragover", function (event) {
        if (!dragging) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        host.className = ZONE_CLASS[zone] + " is-dragover";
      });
      host.addEventListener("dragleave", function (event) {
        var next = event.relatedTarget;
        if (next && typeof host.contains === "function" && host.contains(next)) return;
        reset();
      });
      host.addEventListener("drop", function (event) {
        event.preventDefault();
        reset();
        var party = dragging;
        if (!party && event.dataTransfer) {
          try { party = event.dataTransfer.getData("text/plain"); } catch (error) { party = null; }
        }
        dragging = null;
        if (party) move(party, zone, false);
      });
    });

    // Render before revealing: if a future render throws, the section stays
    // hidden instead of exposing an empty shell.
    render();
    section.hidden = false;
  }

  // ---------------------------------------------------------------------
  // 5. Government / bloc probabilities
  // ---------------------------------------------------------------------
  function renderGroups(groups) {
    reveal("election-groups");
    var names = Object.keys(groups.groups || {});
    var pills = byId("election-group-pills");
    var result = byId("election-group-result");
    if (!names.length) {
      if (result) result.textContent = "Inga partikombinationer \u00e4r publicerade i den h\u00e4r versionen.";
      return;
    }

    var buttons = {};
    var active = names[0];

    function update() {
      var group = groups.groups[active];
      if (!group) return;
      names.forEach(function (name) {
        var button = buttons[name];
        if (!button) return;
        button.className = "eg-pill" + (name === active ? " is-active" : "");
        button.setAttribute("aria-pressed", name === active ? "true" : "false");
      });
      var threshold = num(group.majority_threshold) === null ? MAJORITY : num(group.majority_threshold);
      if (result) {
        result.innerHTML =
          "<p class=\"eg-result__lead\"><span class=\"eg-result__value\">" + escapeHtml(probability(group.prob_majority)) + "</span>" +
          "<span class=\"eg-result__text\">sannolikhet att " + escapeHtml((group.parties || []).join(" + ")) +
          " tillsammans f\u00e5r minst " + threshold + " mandat</span></p>" +
          "<dl class=\"eg-result__grid\">" +
            "<div><dt>Medianmandat</dt><dd>" + format(group.median_seats, 0) + "</dd></div>" +
            "<div><dt>50\u00a0% prognosintervall</dt><dd>" + rangeText(group.p25_seats, group.p75_seats, 0) + "</dd></div>" +
            "<div><dt>80\u00a0% prognosintervall</dt><dd>" + rangeText(group.p10_seats, group.p90_seats, 0) + "</dd></div>" +
            "<div><dt>90\u00a0% prognosintervall</dt><dd>" + rangeText(group.p05_seats, group.p95_seats, 0) + "</dd></div>" +
          "</dl>";
      }
      renderGroupHistogram(group, threshold);
    }

    if (pills) {
      pills.innerHTML = "";
      names.forEach(function (name) {
        var group = groups.groups[name];
        var button = document.createElement("button");
        button.className = "eg-pill";
        button.setAttribute("type", "button");
        button.setAttribute("aria-pressed", "false");
        var swatches = (group.parties || []).map(function (party) {
          return "<span class=\"eg-pill__swatch\" style=\"background:" + (partyColors[party] || "#777") + "\" aria-hidden=\"true\"></span>";
        }).join("");
        button.innerHTML =
          "<span class=\"eg-pill__parties\">" + swatches + "<span>" + escapeHtml((group.parties || []).join(" + ")) + "</span></span>" +
          "<span class=\"eg-pill__prob\">" + escapeHtml(probability(group.prob_majority)) + "</span>" +
          "<span class=\"eg-pill__seats\">median " + format(group.median_seats, 0) + " mandat</span>";
        button.setAttribute("aria-label", (group.parties || []).join(" plus ") +
          ": sannolikhet f\u00f6r majoritet " + probability(group.prob_majority) +
          ", median " + format(group.median_seats, 0) + " mandat.");
        if (button.addEventListener) {
          button.addEventListener("click", function () { active = name; update(); });
        }
        buttons[name] = button;
        pills.appendChild(button);
      });
    }

    update();
  }

  function renderGroupHistogram(group, threshold) {
    var host = byId("election-group-histogram");
    if (!host) return;
    var histogram = group.seat_histogram;
    if (!histogram) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    var keys = Object.keys(histogram).map(Number).filter(function (value) {
      return Number.isFinite(value);
    }).sort(function (a, b) { return a - b; });
    if (!keys.length) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    host.hidden = false;
    var low = keys[0];
    var high = keys[keys.length - 1];
    var span = Math.max(1, high - low);
    var peak = 0;
    keys.forEach(function (key) {
      var value = num(histogram[String(key)]) || 0;
      if (value > peak) peak = value;
    });
    var bars = keys.map(function (key) {
      var value = num(histogram[String(key)]) || 0;
      var height = peak > 0 ? (value / peak) * 100 : 0;
      var reaches = key >= threshold;
      return "<span class=\"eh-bar" + (reaches ? " eh-bar--majority" : "") + "\" style=\"left:" +
        (((key - low) / (span + 1)) * 100).toFixed(3) + "%;width:" + (100 / (span + 1)).toFixed(3) +
        "%;height:" + height.toFixed(2) + "%\"></span>";
    }).join("");
    var markerLeft = (((threshold - low) / (span + 1)) * 100);
    var marker = markerLeft >= 0 && markerLeft <= 100
      ? "<span class=\"eh-marker\" style=\"left:" + markerLeft.toFixed(3) + "%\"><span class=\"eh-marker__label\">" + threshold + "</span></span>"
      : "";
    host.innerHTML =
      "<div class=\"eh-plot\" role=\"img\" aria-label=\"F\u00f6rdelning av antalet mandat tillsammans i de simulerade utfallen, fr\u00e5n " +
      low + " till " + high + " mandat, med majoritetsgr\u00e4nsen vid " + threshold + " mandat markerad.\">" + bars + marker + "</div>" +
      "<div class=\"eh-scale\" aria-hidden=\"true\"><span>" + low + "</span><span>mandat tillsammans</span><span>" + high + "</span></div>";
  }

  // ---------------------------------------------------------------------
  // 5. Change since prior forecast
  // ---------------------------------------------------------------------
  function renderChanges(forecast, parties) {
    reveal("election-changes");
    var change = forecast.change_since_prior || {};
    if (change.status !== "AVAILABLE") {
      setText("election-changes-status", "Det finns ingen tidigare prognos att j\u00e4mf\u00f6ra med.");
      setHtml("election-changes-content", "");
      return;
    }
    setText("election-changes-status", "Skillnad mellan medianerna j\u00e4mf\u00f6rt med f\u00f6reg\u00e5ende prognos. " +
      "Sm\u00e5 skillnader beh\u00f6ver inte betyda en verklig f\u00f6r\u00e4ndring.");

    var vote = change.vote_share_median_change_pp || {};
    var seats = change.seat_median_change || {};
    var hasSeats = Object.keys(seats).length > 0;
    var order = parties.party_order || Object.keys(vote);

    var rows = order.map(function (name) {
      if (name === "REST") return "";
      var voteValue = vote[name];
      var seatValue = seats[name];
      return "<tr>" +
        "<th scope=\"row\"><span class=\"ev-swatch\" style=\"background:" + (partyColors[name] || "#777") + "\" aria-hidden=\"true\"></span>" + escapeHtml(abbr(name)) + "</th>" +
        "<td>" + deltaCell(voteValue, 2, PP, 0.05) + "</td>" +
        (hasSeats ? "<td>" + deltaCell(seatValue, 0, "", 0.5) + "</td>" : "") +
        "</tr>";
    }).join("");

    setHtml("election-changes-content",
      "<table class=\"ec-table\"><caption class=\"visually-hidden\">F\u00f6r\u00e4ndring i median r\u00f6standel" +
      (hasSeats ? " och medianmandat" : "") + " sedan f\u00f6reg\u00e5ende publicerade prognos</caption>" +
      "<thead><tr><th scope=\"col\">Parti</th><th scope=\"col\">R\u00f6standel</th>" +
      (hasSeats ? "<th scope=\"col\">Mandat</th>" : "") + "</tr></thead><tbody>" + rows + "</tbody></table>");
  }

  function deltaCell(value, digits, suffix, noiseFloor) {
    var parsed = num(value);
    if (parsed === null) return "<span class=\"ec-delta ec-delta--none\">\u2014</span>";
    var direction = Math.abs(parsed) < noiseFloor ? "flat" : (parsed > 0 ? "up" : "down");
    var glyph = direction === "up" ? "\u2191" : direction === "down" ? "\u2193" : "\u00b7";
    var word = direction === "up" ? "upp" : direction === "down" ? "ner" : "ingen tydlig f\u00f6r\u00e4ndring";
    var sign = parsed > 0 ? "+" : "";
    return "<span class=\"ec-delta ec-delta--" + direction + "\">" +
      "<span class=\"ec-delta__glyph\" aria-hidden=\"true\">" + glyph + "</span>" +
      "<span class=\"ec-delta__value\">" + sign + format(parsed, digits) + suffix + "</span>" +
      "<span class=\"visually-hidden\"> (" + word + ")</span></span>";
  }

  // ---------------------------------------------------------------------
  // 6. Validation and model information
  // ---------------------------------------------------------------------
  function renderValidation(calibration) {
    reveal("election-validation");
    var sources = calibration.source_files || {};

    var blocks = [];
    blocks.push("<p>Modellen utg\u00e5r fr\u00e5n det aktuella opinionsl\u00e4get och simulerar tre typer av " +
      "os\u00e4kerhet: os\u00e4kerhet i l\u00e4get i dag, f\u00f6r\u00e4ndringar fram till valdagen och historiska " +
      "skillnader mellan slutm\u00e4tningar och valresultat. Partierna simuleras gemensamt. Varje utfall " +
      "f\u00f6rdelas \u00f6ver de 29 valkretsarna och r\u00e4knas om till mandat enligt svenska valregler.</p>");
    blocks.push("<p>De historiska testerna \u00e4r gjorda i efterhand och \u00e4r inte ett oberoende test " +
      "p\u00e5 nya data.</p>");

    var coverage = coverageRow(sources.vote_share_hindcast);
    if (coverage) {
      blocks.push("<h3 class=\"election-subhead\">Historisk tr\u00e4ffs\u00e4kerhet f\u00f6r prognosintervall</h3>" +
        "<p>Tabellen visar hur ofta valresultatet l\u00e5g inom modellens intervall i " +
        "efterhandsutv\u00e4rderingen av valen 2018 och 2022. Det \u00e4r ingen garanti f\u00f6r 2026.</p>" +
        "<table class=\"ev-validation-table\"><thead><tr>" +
        "<th scope=\"col\">Intervall</th><th scope=\"col\">Utfall inom intervallet</th><th scope=\"col\">Genomsnittlig bredd</th>" +
        "</tr></thead><tbody>" +
        coverage.map(function (row) {
          return "<tr><th scope=\"row\">" + row.nominal + NBSP + "%</th><td>" + percent(row.coverage * 100, 1) + "</td><td>" +
            (row.width === null ? "\u2014" : format(row.width, 2) + PP) + "</td></tr>";
        }).join("") +
        "</tbody></table>");
    }

    // The published metadata prose is English and technical; the page states
    // the same two semantics in its own words instead of echoing it.
    blocks.push("<p>Intervallen \u00e4r prognosintervall, inte konfidensintervall. " +
      "\u201d\u00d6vriga\u201d \u00e4r en samlad kategori och kan inte f\u00e5 mandat.</p>");

    setHtml("election-validation-content", blocks.join(""));
  }

  function coverageRow(hindcast) {
    var summary = hindcast && hindcast.summary ? hindcast.summary.summary : null;
    if (!summary) return null;
    var rows = Array.isArray(summary) ? summary : [summary];
    var chosen = null;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].model === "base") { chosen = rows[i]; break; }
    }
    if (!chosen) chosen = rows[0];
    if (!chosen) return null;
    var out = [50, 80, 90].map(function (level) {
      return {
        nominal: level,
        coverage: num(chosen["coverage_" + level]),
        width: num(chosen["mean_width_" + level])
      };
    }).filter(function (row) { return row.coverage !== null; });
    return out.length === 3 ? out : null;
  }

  function renderMetadata(metadata, manifest) {
    reveal("election-meta");
    var certified = isCertified(metadata, manifest);
    var rows = [
      ["Senast genererad", metadata.generated_at_utc || "\u2014"],
      ["Opinionsl\u00e4ge", metadata.as_of || "\u2014"],
      ["Valdag", metadata.election_date || "\u2014"],
      ["Modell", (metadata.model && metadata.model.version) || "\u2014"],
      ["K\u00e4llkodsversion", metadata.source_git_commit || "\u2014"],
      ["Prognos-hash", metadata.deterministic_payload_sha256 || (manifest && manifest.deterministic_payload_sha256) || "\u2014"],
      ["K\u00e4llkodsl\u00e4ge", metadata.source_worktree_clean === true
        ? "committad version, inga lokala \u00e4ndringar"
        : "lokala eller oregistrerade \u00e4ndringar i k\u00e4llkoden"]
    ];
    var hashes = metadata.input_hashes || {};
    Object.keys(hashes).forEach(function (key) {
      rows.push([key.replace(/_/g, " "), hashes[key]]);
    });
    setHtml("election-meta-list", rows.map(function (row) {
      return "<div><dt>" + escapeHtml(row[0]) + "</dt><dd><code>" + escapeHtml(row[1]) + "</code></dd></div>";
    }).join(""));
    return certified;
  }

  loadPublication()
    .then(function (publication) {
      var data = publication.files;
      validatePublicationBundle(data, publication.pointer, publication.manifest_sha256);
      renderHeader(data[0], data[5], data[6], publication.pointer);
      renderVotes(data[0], data[1]);
      renderSeats(data[2], Boolean(publication.pointer));
      renderGovernmentBuilder(data[3], data[0] && data[0].total_samples);
      renderGroups(data[3]);
      renderChanges(data[0], data[1]);
      renderValidation(data[4]);
      var certified = renderMetadata(data[5], data[6]);
      // The status strings stay in the DOM as the published load contract,
      // but a successful load has no news for the reader, so it is hidden.
      status.textContent = certified ? "Certified forecast loaded." : "Forecast loaded, but it is not certified.";
      status.hidden = true;
    })
    .catch(function (error) {
      status.hidden = false;
      status.className += " election-status--error";
      status.textContent = "Forecast unavailable: " + error.message;
    });
}());
