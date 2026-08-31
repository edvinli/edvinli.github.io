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
    M: "#3657A7", L: "#4A9AD6", C: "#2B8569", KD: "#5B7C9B",
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
  // The six government alternatives the page offers, written as party names
  // and resolved against the publication's own party_order every time.  No
  // mask integer is spelled out here, so a publication that reordered its
  // parties would still resolve these to the same combinations.  The same
  // six drive the preset buttons in the builder and the comparison rows in
  // "Regeringsalternativ".
  var GOVERNMENT_PRESETS = [
    ["S", "V", "MP"],
    ["S", "C", "MP"],
    ["S", "C", "MP", "V"],
    ["S", "KD", "C", "MP"],
    ["SD", "L", "M", "KD"],
    ["S", "M", "C"]
  ];
  var COALITION_FIELDS = [
    "mean_seats", "median_seats", "p05_seats", "p10_seats", "p25_seats",
    "p75_seats", "p90_seats", "p95_seats", "prob_majority"
  ];
  var COALITION_ENTRY_FIELDS = ["mask", "parties"].concat(COALITION_FIELDS);
  // Schema 1.3 adds one exact one-seat-bin histogram per combination.  It is
  // a contiguous support: min_seats plus a count for every seat value from
  // there up, so there is nothing to interpolate and nothing to smooth.
  var COALITION_HISTOGRAM_FIELDS = ["min_seats", "counts"];
  var COALITION_ENTRY_FIELDS_WITH_HISTOGRAM =
    COALITION_ENTRY_FIELDS.concat(["seat_histogram"]);

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

  // Histogram framing keeps two decimal places so the reader can reconcile
  // the displayed percentage with the exact published draw count (for
  // example, 2.216% is shown as 2,22%).  The existing probability formatter
  // remains unchanged everywhere else on the page.
  function histogramProbability(value) {
    var parsed = num(value);
    return parsed === null ? "\u2014" : percent(parsed * 100, 2);
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
  var clearTimeseriesSelection = function () {};

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
      if (event && event.key === "Escape") {
        if (selectedParty) {
          selectedParty = null;
          applySelection();
        }
        clearTimeseriesSelection();
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
  // Historical coalition forecast
  //
  // This is a separate, lookup-only publication.  The historical JSON is
  // generated by the simulator; the browser only selects already-published
  // quantiles and calculates the visible SwedishPolls dots from the eight
  // parliamentary party values.  It never polls, simulates or allocates
  // seats.
  // ---------------------------------------------------------------------
  var HISTORY_PARTIES = ["M", "L", "C", "KD", "S", "V", "MP", "SD"];
  var HISTORY_DYNAMICS_CUTOFF = "2026-05-24";
  var HISTORY_DYNAMICS_CAP = 112;
  var HISTORY_COALITIONS = [
    { id: "red_green_center", label: "V + MP + S + C", parties: ["V", "MP", "S", "C"], color: "#bd3348", defaultOn: true },
    { id: "tido", label: "L + KD + M + SD", parties: ["L", "KD", "M", "SD"], color: "#315fa8", defaultOn: true },
    { id: "s_m", label: "S + M", parties: ["S", "M"], color: "#7b5b9d", defaultOn: false },
    { id: "v_s_mp", label: "V + S + MP", parties: ["V", "S", "MP"], color: "#35866f", defaultOn: false },
    { id: "s_mp_c", label: "S + MP + C", parties: ["S", "MP", "C"], color: "#a26a1f", defaultOn: false },
    { id: "c_kd_l_m", label: "C + KD + L + M", parties: ["C", "KD", "L", "M"], color: "#278597", defaultOn: false },
    { id: "s_mp_c_kd", label: "S + MP + C + KD", parties: ["S", "MP", "C", "KD"], color: "#c2672d", defaultOn: false }
  ];
  function historyNumber(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, "value")) return historyNumber(value.value);
      if (Object.prototype.hasOwnProperty.call(value, "estimate")) return historyNumber(value.estimate);
      return null;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (!text || /^(uncertain|unknown|na|n\/a|—|-+)$/i.test(text)) return null;
    text = text.replace(/\u00a0/g, "").replace(/\s/g, "").replace(/%$/, "").replace(",", ".");
    var parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function historyDate(value) {
    if (typeof value !== "string") return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return null;
    var time = Date.parse(match[1] + "-" + match[2] + "-" + match[3] + "T00:00:00Z");
    return Number.isFinite(time) ? {
      iso: match[1] + "-" + match[2] + "-" + match[3],
      time: time
    } : null;
  }

  function historyFirst(source, names) {
    if (!source || typeof source !== "object") return null;
    for (var index = 0; index < names.length; index += 1) {
      if (Object.prototype.hasOwnProperty.call(source, names[index])) {
        var value = historyNumber(source[names[index]]);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function historyQuantiles(source) {
    if (!source || typeof source !== "object") return null;
    var values = {
      p05: historyFirst(source, ["p05", "q05", "lower_90", "p05_share", "p05_seats"]),
      p25: historyFirst(source, ["p25", "q25", "lower_50", "p25_share", "p25_seats"]),
      p50: historyFirst(source, ["p50", "median", "q50", "median_share", "median_seats"]),
      p75: historyFirst(source, ["p75", "q75", "upper_50", "p75_share", "p75_seats"]),
      p95: historyFirst(source, ["p95", "q95", "upper_90", "p95_share", "p95_seats"])
    };
    var keys = ["p05", "p25", "p50", "p75", "p95"];
    if (!keys.every(function (key) { return values[key] !== null; })) return null;
    if (!keys.every(function (key, index) {
      return index === 0 || values[key] >= values[keys[index - 1]];
    })) return null;
    return values;
  }

  function historyMetric(group, metric) {
    if (!group || typeof group !== "object") return null;
    var names = metric === "vote"
      ? ["vote", "vote_share", "vote_shares", "vote_percent", "vote_share_percent"]
      : ["seats", "seat", "mandates", "mandat", "seat_share", "seat_percent"];
    for (var index = 0; index < names.length; index += 1) {
      var value = group[names[index]];
      if (value && typeof value === "object") {
        var quantiles = historyQuantiles(value);
        if (quantiles) return quantiles;
      }
    }
    // A compact producer may put one metric's p05..p95 directly on the group.
    return historyQuantiles(group);
  }

  function historyDefinitions(payload) {
    var configured = payload && payload.coalitions;
    return HISTORY_COALITIONS.map(function (definition) {
      var parties = configured && Array.isArray(configured[definition.id])
        ? configured[definition.id].filter(function (party) {
          return HISTORY_PARTIES.indexOf(party) !== -1;
        })
        : definition.parties.slice();
      // A malformed configured list must not turn a known coalition into an
      // empty one.  The requested definitions remain the safe fallback.
      if (!parties.length) parties = definition.parties.slice();
      return {
        id: definition.id,
        label: definition.label,
        parties: parties,
        color: definition.color,
        defaultOn: definition.defaultOn
      };
    });
  }

  function historyPoint(raw, electionDate, definitions) {
    if (!raw || typeof raw !== "object") return null;
    var dateInfo = historyDate(raw.date || raw.as_of || raw.forecast_date || raw.observation_date);
    if (!dateInfo) return null;
    var actual = historyNumber(raw.horizon_days);
    if (actual === null) actual = daysBetween(dateInfo.iso, electionDate);
    var dynamics = historyNumber(raw.dynamics_horizon_days);
    if (dynamics === null && actual !== null) dynamics = Math.min(Math.max(0, actual), HISTORY_DYNAMICS_CAP);
    var samples = historyNumber(raw.samples);
    if (samples === null) samples = historyNumber(raw.draws);
    if (samples === null) samples = historyNumber(raw.total_samples);
    var groups = raw.groups || raw.coalitions || {};
    var normalizedGroups = {};
    definitions.forEach(function (definition) {
      var group = groups && groups[definition.id];
      if (!group) return;
      var vote = historyMetric(group, "vote");
      var seats = historyMetric(group, "seats");
      if (vote || seats) normalizedGroups[definition.id] = { vote: vote, seats: seats };
    });
    if (!Object.keys(normalizedGroups).length) return null;
    return {
      date: dateInfo.iso,
      time: dateInfo.time,
      samples: samples,
      horizonDays: actual,
      dynamicsHorizonDays: dynamics,
      provenance: String(raw.provenance || raw.source || "reconstructed_current_model"),
      groups: normalizedGroups
    };
  }

  function historyPopPoint(raw, definitions) {
    if (!raw || typeof raw !== "object") return null;
    var dateInfo = historyDate(raw.date || raw.publication_date);
    if (!dateInfo) return null;
    var source = raw.parties || raw.values || {};
    var parties = {};
    var denominator = 0;
    var complete = true;
    HISTORY_PARTIES.forEach(function (party) {
      var value = historyNumber(source[party]);
      if (value === null) {
        complete = false;
        return;
      }
      parties[party] = value;
      denominator += value;
    });
    if (!complete || denominator <= 0) return null;
    var values = {};
    definitions.forEach(function (definition) {
      var total = definition.parties.reduce(function (sum, party) {
        return sum + (parties[party] || 0);
      }, 0);
      values[definition.id] = 100 * total / denominator;
    });
    return {
      date: dateInfo.iso,
      time: dateInfo.time,
      parties: parties,
      values: values
    };
  }

  function historyPoll(raw, definitions) {
    if (!raw || typeof raw !== "object") return null;
    var dateInfo = historyDate(raw.publication_date || raw.date || raw.published || raw.publicationDate);
    if (!dateInfo) return null;
    var source = raw.parties || raw.values || raw.party_values || {};
    var parties = {};
    var denominator = 0;
    var complete = true;
    HISTORY_PARTIES.forEach(function (party) {
      var value = historyNumber(source[party]);
      if (value === null) {
        complete = false;
        return;
      }
      parties[party] = value;
      denominator += value;
    });
    // In particular, an `Uncertain` field is not a ninth party and is never
    // put in the denominator.  A poll with a missing parliamentary value is
    // omitted instead of treating missing support as zero.
    if (!complete || denominator <= 0) return null;
    var values = {};
    definitions.forEach(function (definition) {
      var total = definition.parties.reduce(function (sum, party) {
        return sum + parties[party];
      }, 0);
      values[definition.id] = 100 * total / denominator;
    });
    return {
      date: dateInfo.iso,
      time: dateInfo.time,
      company: String(raw.company || raw.house || raw.pollster || raw.institute || "Okänt institut"),
      fieldworkStart: String(raw.fieldwork_start || raw.fieldworkStart || raw.start_date || ""),
      fieldworkEnd: String(raw.fieldwork_end || raw.fieldworkEnd || raw.end_date || ""),
      n: historyNumber(raw.n || raw.sample_size || raw.samplesize),
      parties: parties,
      values: values
    };
  }

  function normalizeHistoryPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    var electionDate = historyDate(payload.election_date || payload.electionDate);
    if (!electionDate) return null;
    var definitions = historyDefinitions(payload);
    var rawSeries = Array.isArray(payload.series) ? payload.series
      : (Array.isArray(payload.forecasts) ? payload.forecasts : []);
    var points = rawSeries.map(function (point) {
      return historyPoint(point, electionDate.iso, definitions);
    }).filter(function (point) { return point !== null; });
    var byDate = {};
    points.forEach(function (point) {
      // A date may legitimately carry both a reconstructed point and a
      // genuinely prospective archived point.  Keep both so their provenance
      // remains visible instead of collapsing the distinction by date alone.
      var key = point.date + "|" + point.provenance;
      if (!byDate[key]) byDate[key] = point;
    });
    points = Object.keys(byDate).map(function (date) { return byDate[date]; }).sort(function (a, b) {
      return a.time - b.time;
    });
    if (!points.length) return null;
    var rawPop = Array.isArray(payload.poll_of_polls) ? payload.poll_of_polls
      : (Array.isArray(payload.pollofpolls) ? payload.pollofpolls : []);
    var pop = rawPop.map(function (item) {
      return historyPopPoint(item, definitions);
    }).filter(function (item) { return item !== null; }).sort(function (a, b) {
      return a.time - b.time;
    });
    var rawPolls = Array.isArray(payload.polls) ? payload.polls
      : (Array.isArray(payload.poll_points) ? payload.poll_points : []);
    var polls = rawPolls.map(function (poll) {
      return historyPoll(poll, definitions);
    }).filter(function (poll) { return poll !== null; }).sort(function (a, b) {
      return a.time - b.time;
    });
    return {
      schemaVersion: String(payload.schema_version || "1.1"),
      electionDate: electionDate.iso,
      modelCommit: payload.model_commit || payload.model_revision || null,
      pollSourceSha256: payload.poll_source_sha256 || null,
      definitions: definitions,
      points: points,
      pop: pop,
      polls: polls
    };
  }

  function historyProvenanceLabel(value) {
    if (value === "current_production") {
      return "Officiell aktuell valprognos (current_production)";
    }
    if (value === "prospective_archived") {
      return "Prospektiv arkiverad prognos (prospective_archived)";
    }
    if (value === "reconstructed_current_model") {
      return "Rekonstruerad med dagens modell (reconstructed_current_model)";
    }
    return value.replace(/_/g, " ");
  }

  function historyDaysText(value) {
    var parsed = historyNumber(value);
    return parsed === null ? "—" : grouped(parsed);
  }

  function historyMetricLabel(metric) {
    return metric === "seats" ? "mandatandel" : "röstandel";
  }

  function historyMetricValue(group, metric, key) {
    var values = group && group[metric];
    if (!values) return null;
    var value = historyNumber(values[key]);
    // Seat quantiles are published as raw joint seat draws.  The chart's
    // second mode is a share of the 349-seat chamber, so convert only at the
    // rendering boundary and keep the raw values on the normalized group for
    // the tooltip's exact seat count.
    return value === null ? null : (metric === "seats" ? 100 * value / CHAMBER : value);
  }

  function historyDisplayQuantiles(group, metric) {
    if (!group || !group[metric]) return null;
    return {
      p05: historyMetricValue(group, metric, "p05"),
      p25: historyMetricValue(group, metric, "p25"),
      p50: historyMetricValue(group, metric, "p50"),
      p75: historyMetricValue(group, metric, "p75"),
      p95: historyMetricValue(group, metric, "p95")
    };
  }

  function historyPopLinePath(popPoints, definitionId, xScale, yScale) {
    var path = "";
    var count = 0;
    popPoints.forEach(function (point) {
      var val = point.values && point.values[definitionId];
      if (val === null || val === undefined || !Number.isFinite(val)) return;
      var x = xScale(point.time);
      var y = yScale(val);
      path += (count ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2);
      count += 1;
    });
    return path;
  }

  function historyLinePath(points, metric, key, xScale, yScale) {
    var path = "";
    var count = 0;
    points.forEach(function (point) {
      var value = historyMetricValue(point.groups && point.groups[point._definitionId], metric, key);
      if (value === null) return;
      var x = xScale(point.time);
      var y = yScale(value);
      path += (count ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2);
      count += 1;
    });
    return path;
  }

  function historyAreaPath(points, metric, definitionId, xScale, yScale, upperKey, lowerKey) {
    var upper = [];
    var lower = [];
    points.forEach(function (point) {
      var group = point.groups && point.groups[definitionId];
      var high = historyMetricValue(group, metric, upperKey);
      var low = historyMetricValue(group, metric, lowerKey);
      if (high === null || low === null) return;
      upper.push([xScale(point.time), yScale(high)]);
      lower.push([xScale(point.time), yScale(low)]);
    });
    if (!upper.length) return "";
    var path = "M" + upper.map(function (point) {
      return point[0].toFixed(2) + "," + point[1].toFixed(2);
    }).join("L");
    path += "L" + lower.reverse().map(function (point) {
      return point[0].toFixed(2) + "," + point[1].toFixed(2);
    }).join("L") + "Z";
    return path;
  }

  function historyAxisTicks(minTime, maxTime) {
    var count = 6;
    var ticks = [];
    for (var index = 0; index < count; index += 1) {
      var time = minTime + (maxTime - minTime) * index / (count - 1);
      var date = new Date(time);
      var iso = date.toISOString().slice(0, 10);
      ticks.push({ time: time, iso: iso, label: date.getUTCFullYear() === new Date(minTime).getUTCFullYear() &&
        date.getUTCFullYear() === new Date(maxTime).getUTCFullYear()
        ? swedishDate(iso) : String(date.getUTCFullYear()) });
    }
    return ticks.filter(function (tick, index, values) {
      return index === 0 || Math.abs(tick.time - values[index - 1].time) > 86400000 * 20;
    });
  }

  function historyTooltipPosition(tooltip, frame, xPercent) {
    if (!tooltip || !frame) return;
    var width = frame.clientWidth || 0;
    var left = width * Math.max(0.18, Math.min(0.82, xPercent));
    tooltip.style.left = left.toFixed(1) + "px";
    tooltip.style.top = "0.5rem";
  }

  function renderForecastHistory(payload) {
    var section = byId("election-timeseries");
    var svg = byId("election-timeseries-svg");
    if (!section || !svg) return false;
    var history = normalizeHistoryPayload(payload);
    if (!history) return false;

    var frame = byId("election-timeseries-frame");
    var tooltip = byId("election-timeseries-tooltip");
    var liveStatus = byId("election-timeseries-status");
    var seatNote = byId("election-timeseries-seat-note");
    var modeVote = byId("election-timeseries-vote");
    var modeSeats = byId("election-timeseries-seats");
    var coalitionHost = byId("election-timeseries-coalitions");
    var selectedMetric = "vote";
    var selected = {};
    var selectedDate = null;
    var selectedPoint = null;
    var selectedPoll = null;
    var width = 960;
    var height = 430;
    var plot = { left: 62, right: 932, top: 28, bottom: 365 };
    plot.width = plot.right - plot.left;
    plot.height = plot.bottom - plot.top;
    var chartMinTime = history.points[0].time;
    var chartMaxTime = history.points[history.points.length - 1].time;
    history.definitions.forEach(function (definition) {
      selected[definition.id] = Boolean(definition.defaultOn);
    });

    function activeDefinitions() {
      return history.definitions.filter(function (definition) {
        return selected[definition.id];
      });
    }

    function setModeButtons() {
      if (modeVote) modeVote.setAttribute("aria-pressed", selectedMetric === "vote" ? "true" : "false");
      if (modeSeats) modeSeats.setAttribute("aria-pressed", selectedMetric === "seats" ? "true" : "false");
      if (seatNote) seatNote.hidden = selectedMetric !== "seats";
      var popKey = byId("election-timeseries-key-pop");
      if (popKey) popKey.hidden = selectedMetric !== "vote";
    }

    function dateForEvent(event) {
      if (!event || !svg || !svg.getBoundingClientRect) return null;
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return null;
      // SVG coordinates include the left plot margin.  Mapping the entire
      // element would make a pointer on the first plotted date resolve several
      // percent into the series.
      var svgX = (event.clientX - rect.left) * width / rect.width;
      var ratio = Math.max(0, Math.min(1, (svgX - plot.left) / plot.width));
      return chartMinTime + (chartMaxTime - chartMinTime) * ratio;
    }

    function nearestPoint(time, direction) {
      var candidates = history.points.filter(function (point) {
        return activeDefinitions().some(function (definition) {
          return point.groups && point.groups[definition.id] && point.groups[definition.id][selectedMetric];
        });
      });
      if (!candidates.length) return null;
      if (direction) {
        var ordered = candidates.slice().sort(function (a, b) { return a.time - b.time; });
        var current = selectedDate === null ? (direction > 0 ? -Infinity : Infinity) : selectedDate;
        var possible = ordered.filter(function (point) {
          return direction > 0 ? point.time > current : point.time < current;
        });
        return possible.length ? (direction > 0 ? possible[0] : possible[possible.length - 1])
          : (direction > 0 ? ordered[ordered.length - 1] : ordered[0]);
      }
      return candidates.reduce(function (best, point) {
        return !best || Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best;
      }, null);
    }

    function nearestDefinition(point) {
      var definitions = activeDefinitions();
      return definitions.filter(function (definition) {
        return point && point.groups && point.groups[definition.id] && point.groups[definition.id][selectedMetric];
      })[0] || null;
    }

    function findPopForDate(targetDate) {
      if (!history.pop || !history.pop.length) return null;
      for (var i = 0; i < history.pop.length; i++) {
        if (history.pop[i].date === targetDate) return history.pop[i];
      }
      var targetInfo = historyDate(targetDate);
      if (!targetInfo) return null;
      var best = null;
      for (var j = 0; j < history.pop.length; j++) {
        if (!best || Math.abs(history.pop[j].time - targetInfo.time) < Math.abs(best.time - targetInfo.time)) {
          best = history.pop[j];
        }
      }
      return best;
    }

    function rangeTextFor(values, low, high) {
      return values && values[low] !== null && values[high] !== null
        ? percentRange(values[low], values[high], 1) : "—";
    }

    function forecastTooltip(point) {
      if (!point) return "";
      var popPoint = selectedMetric === "vote" ? findPopForDate(point.date) : null;
      var rows = activeDefinitions().map(function (definition) {
        var group = point.groups && point.groups[definition.id];
        var values = historyDisplayQuantiles(group, selectedMetric);
        if (!values) return "";
        var rawSeats = group.seats ? historyNumber(group.seats.p50) : null;
        var popValue = popPoint && popPoint.values && popPoint.values[definition.id] !== undefined
          ? popPoint.values[definition.id] : null;
        var popDateLabel = popPoint && popPoint.date !== point.date
          ? "Poll of Polls (" + (swedishDate(popPoint.date) || popPoint.date) + ")"
          : "Poll of Polls";

        return "<div class=\"election-timeseries__tooltip-group\"><b>" +
          escapeHtml(definition.label) + "</b><dl>" +
          (selectedMetric === "vote" && popValue !== null
            ? "<dt>" + escapeHtml(popDateLabel) + "</dt><dd>" + escapeHtml(percent(popValue, 1)) + "</dd>" : "") +
          "<dt>Valprognos</dt><dd>" + escapeHtml(selectedMetric === "seats" && rawSeats !== null
            ? grouped(rawSeats) + " mandat (" + percent(values.p50, 1) + ")"
            : percent(values.p50, 1)) + "</dd>" +
          "<dt>50 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats" && group.seats
            ? group.seats.p25 + "–" + group.seats.p75 + " mandat"
            : rangeTextFor(values, "p25", "p75")) + "</dd>" +
          "<dt>90 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats" && group.seats
            ? group.seats.p05 + "–" + group.seats.p95 + " mandat"
            : rangeTextFor(values, "p05", "p95")) + "</dd>" +
          "</dl></div>";
      }).filter(function (row) { return row; }).join("");
      return "<strong>" + escapeHtml(swedishDate(point.date) || point.date) + "</strong>" + rows +
        "<dl class=\"election-timeseries__tooltip-meta\">" +
        "<dt>Simuleringar</dt><dd>" + escapeHtml(historyDaysText(point.samples)) + " simuleringar</dd>" +
        "<dt>Ursprung</dt><dd>" + escapeHtml(historyProvenanceLabel(point.provenance)) + "</dd>" +
        "<dt>Horisont</dt><dd>Faktisk tid till valet: " + escapeHtml(historyDaysText(point.horizonDays)) +
        " dagar · rörelsedel: " + escapeHtml(historyDaysText(point.dynamicsHorizonDays)) + " dagar</dd>" +
        "</dl>";
    }

    function forecastStatus(point) {
      if (!point) return "Välj en punkt i diagrammet för detaljer.";
      var first = nearestDefinition(point);
      var group = first && point.groups[first.id];
      var values = historyDisplayQuantiles(group, selectedMetric);
      var popPoint = selectedMetric === "vote" ? findPopForDate(point.date) : null;
      var popValue = popPoint && first && popPoint.values && popPoint.values[first.id] !== undefined
        ? popPoint.values[first.id] : null;
      var summary = first && values
        ? first.label + ": " + (popValue !== null ? "PoP " + percent(popValue, 1) + ", " : "") +
          "valprognos median " + percent(values.p50, 1) + ", 50 % intervall " +
          rangeTextFor(values, "p25", "p75") + ", 90 % intervall " + rangeTextFor(values, "p05", "p95")
        : "Ingen prognosfördelning för valt mått.";
      return (swedishDate(point.date) || point.date) + " · " + summary + ". " +
        historyProvenanceLabel(point.provenance) + ".";
    }

    function pollTooltip(poll, definition) {
      return "<strong>" + escapeHtml(definition.label) + " · " + escapeHtml(poll.company) + "</strong><dl>" +
        "<dt>Publicerad</dt><dd>" + escapeHtml(swedishDate(poll.date) || poll.date) + "</dd>" +
        "<dt>Fältperiod</dt><dd>" + escapeHtml((poll.fieldworkStart || "—") + "–" + (poll.fieldworkEnd || "—")) + "</dd>" +
        "<dt>Urval</dt><dd>" + escapeHtml(poll.n === null ? "—" : grouped(poll.n)) + "</dd>" +
        "<dt>Koalitionens röstandel</dt><dd>" + escapeHtml(percent(poll.values[definition.id], 1)) + "</dd>" +
        "</dl>";
    }

    function pollStatus(poll, definition) {
      return (swedishDate(poll.date) || poll.date) + " · " + poll.company + " · " + definition.label +
        ": " + percent(poll.values[definition.id], 1) + ". Fältperiod " +
        (poll.fieldworkStart || "—") + "–" + (poll.fieldworkEnd || "—") + ".";
    }

    function showTooltip(html, statusText, xPercent, persistent) {
      if (tooltip) {
        tooltip.innerHTML = html;
        tooltip.hidden = false;
        historyTooltipPosition(tooltip, frame, xPercent);
      }
      if (liveStatus && statusText) liveStatus.textContent = statusText;
      if (persistent) svg.setAttribute("data-selected-date", selectedDate === null ? "" :
        new Date(selectedDate).toISOString().slice(0, 10));
    }

    function hideTooltip() {
      if (selectedDate !== null) {
        var point = selectedPoint || nearestPoint(selectedDate);
        if (point) {
          showTooltip(forecastTooltip(point), forecastStatus(point),
            (point.time - history.points[0].time) /
              Math.max(1, history.points[history.points.length - 1].time - history.points[0].time), false);
          return;
        }
      }
      if (selectedPoll) {
        showTooltip(pollTooltip(selectedPoll.poll, selectedPoll.definition),
          pollStatus(selectedPoll.poll, selectedPoll.definition),
          (selectedPoll.poll.time - history.points[0].time) /
            Math.max(1, history.points[history.points.length - 1].time - history.points[0].time), false);
        return;
      }
      if (tooltip) tooltip.hidden = true;
      if (liveStatus) liveStatus.textContent = "Välj en punkt i diagrammet för detaljer.";
    }

    function chooseForecast(point, persistent, event) {
      if (!point) return;
      if (persistent) {
        selectedPoll = null;
        selectedDate = point.time;
        selectedPoint = point;
      }
      var xPercent = (point.time - history.points[0].time) /
        Math.max(1, history.points[history.points.length - 1].time - history.points[0].time);
      showTooltip(forecastTooltip(point), forecastStatus(point), xPercent, persistent);
      if (event && event.preventDefault && persistent) event.preventDefault();
    }

    function choosePoll(poll, definition, persistent, event) {
      if (persistent) {
        selectedDate = null;
        selectedPoint = null;
        selectedPoll = { poll: poll, definition: definition };
      }
      var xPercent = (poll.time - history.points[0].time) /
        Math.max(1, history.points[history.points.length - 1].time - history.points[0].time);
      showTooltip(pollTooltip(poll, definition), pollStatus(poll, definition), xPercent, persistent);
      if (event && event.stopPropagation) event.stopPropagation();
      if (event && event.preventDefault && persistent) event.preventDefault();
    }

    function clearSelection() {
      selectedDate = null;
      selectedPoint = null;
      selectedPoll = null;
      svg.removeAttribute("data-selected-date");
      if (tooltip) tooltip.hidden = true;
      if (liveStatus) liveStatus.textContent = "Välj en punkt i diagrammet för detaljer.";
    }

    clearTimeseriesSelection = clearSelection;

    function renderChart() {
      // Redrawing changes the metric/visible series; an old selection would
      // otherwise leave a tooltip describing marks that no longer exist.
      selectedDate = null;
      selectedPoint = null;
      selectedPoll = null;
      if (tooltip) tooltip.hidden = true;
      if (liveStatus) liveStatus.textContent = "Välj en punkt i diagrammet för detaljer.";
      var definitions = activeDefinitions();
      var allTimes = history.points.map(function (point) { return point.time; });
      if (history.pop && history.pop.length) {
        history.pop.forEach(function (item) { allTimes.push(item.time); });
      }
      var minTime = Math.min.apply(Math, allTimes);
      var maxTime = Math.max.apply(Math, allTimes);
      if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) return;
      if (maxTime <= minTime) maxTime = minTime + 86400000;
      chartMinTime = minTime;
      chartMaxTime = maxTime;
      var span = maxTime - minTime;
      var xScale = function (time) {
        return plot.left + (time - minTime) / span * plot.width;
      };
      var maxValue = selectedMetric === "seats" ? 100 : 0;
      definitions.forEach(function (definition) {
        history.points.forEach(function (point) {
          var values = point.groups && point.groups[definition.id] && point.groups[definition.id][selectedMetric];
          var upper = historyMetricValue(point.groups && point.groups[definition.id], selectedMetric, "p95");
          if (values && upper !== null) maxValue = Math.max(maxValue, upper);
        });
      });
      if (selectedMetric === "vote" && history.pop && history.pop.length) {
        history.pop.forEach(function (item) {
          definitions.forEach(function (definition) {
            var val = item.values && item.values[definition.id];
            if (val !== undefined && val !== null) maxValue = Math.max(maxValue, val);
          });
        });
        maxValue = Math.max(60, niceMax(maxValue * 1.12, 5));
      }
      maxValue = Math.max(1, maxValue);
      var yScale = function (value) {
        var parsed = historyNumber(value);
        if (parsed === null) return plot.bottom;
        return plot.bottom - Math.max(0, Math.min(maxValue, parsed)) / maxValue * plot.height;
      };

      svg.innerHTML = "";
      svg.setAttribute("data-metric", selectedMetric);
      svg.setAttribute("data-y-min", "0");
      svg.setAttribute("data-y-max", String(maxValue));
      svg.setAttribute("data-dynamics-cutoff", HISTORY_DYNAMICS_CUTOFF);
      svg.setAttribute("data-dynamics-horizon-cap", String(HISTORY_DYNAMICS_CAP));
      svg.setAttribute("data-majority-rule", String(MAJORITY));
      svg.appendChild(svgNode("title", { id: "election-timeseries-title" },
        "Prognos över tid, " + historyMetricLabel(selectedMetric)));
      svg.appendChild(svgNode("desc", { id: "election-timeseries-description" },
        "Median och 50- samt 90-procentiga prognosintervall från " +
        (swedishDate(history.points[0].date) || history.points[0].date) + " till " +
        (swedishDate(history.points[history.points.length - 1].date) || history.points[history.points.length - 1].date) +
        ". I röstandelsläget visas även Poll of Polls."));

      var background = svgNode("g", { class: "election-timeseries__background", "aria-hidden": "true" });
      var yStep = selectedMetric === "seats" ? 25 : (maxValue <= 35 ? 5 : 10);
      for (var yValue = 0; yValue <= maxValue + 0.001; yValue += yStep) {
        var y = yScale(yValue);
        background.appendChild(svgNode("line", {
          x1: plot.left, y1: y, x2: plot.right, y2: y,
          class: "election-timeseries__grid-line"
        }));
        background.appendChild(svgNode("text", {
          x: plot.left - 8, y: y + 5, "text-anchor": "end", class: "election-timeseries__axis-label"
        }, format(yValue, 0) + "%"));
      }
      background.appendChild(svgNode("line", {
        x1: plot.left, y1: plot.bottom, x2: plot.right, y2: plot.bottom,
        class: "election-timeseries__axis-line"
      }));
      if (selectedMetric === "seats") {
        var majorityShare = 100 * MAJORITY / CHAMBER;
        var majorityY = yScale(majorityShare);
        background.appendChild(svgNode("line", {
          x1: plot.left, y1: majorityY, x2: plot.right, y2: majorityY,
          class: "election-timeseries__majority", "data-majority": String(MAJORITY),
          "data-majority-percent": majorityShare.toFixed(4)
        }));
        background.appendChild(svgNode("text", {
          x: plot.right - 4, y: majorityY - 6, "text-anchor": "end",
          class: "election-timeseries__majority-label"
        }, "175 mandat"));
      }
      var cutoffInfo = historyDate(HISTORY_DYNAMICS_CUTOFF);
      var cutoffX = cutoffInfo ? xScale(Math.max(minTime, Math.min(maxTime, cutoffInfo.time))) : null;
      if (cutoffX !== null) {
        if (cutoffInfo.time > minTime) {
          background.appendChild(svgNode("rect", {
            x: plot.left, y: plot.top, width: Math.max(0, cutoffX - plot.left), height: plot.height,
            class: "election-timeseries__precap", "data-region": "pre-112-days"
          }));
        }
        background.appendChild(svgNode("line", {
          x1: cutoffX, y1: plot.top, x2: cutoffX, y2: plot.bottom,
          class: "election-timeseries__dynamics-marker election-timeseries__marker", "data-date": HISTORY_DYNAMICS_CUTOFF,
          "data-dynamics-marker": "true", "data-dynamics-horizon-days": String(HISTORY_DYNAMICS_CAP)
        }));
        background.appendChild(svgNode("text", {
          x: Math.min(plot.right - 4, Math.max(plot.left + 4, cutoffX + 6)), y: plot.top - 9,
          class: "election-timeseries__dynamics-label",
          "text-anchor": cutoffX > plot.right - 100 ? "end" : "start"
        }, "24 maj 2026 · 112 dagar"));
      }
      var dateTicks = historyAxisTicks(minTime, maxTime);
      dateTicks.forEach(function (tick, tickIndex) {
        var x = xScale(tick.time);
        background.appendChild(svgNode("line", {
          x1: x, y1: plot.bottom, x2: x, y2: plot.bottom + 6,
          class: "election-timeseries__axis-line"
        }));
        background.appendChild(svgNode("text", {
          x: x, y: plot.bottom + 24, "text-anchor": tickIndex === 0 ? "start" :
            (tickIndex === dateTicks.length - 1 ? "end" : "middle"),
          class: "election-timeseries__axis-label", "data-date": tick.iso
        }, tick.label));
      });
      background.appendChild(svgNode("text", {
        x: plot.right, y: height - 8, "text-anchor": "end", class: "election-timeseries__axis-label"
      }, historyMetricLabel(selectedMetric)));
      svg.appendChild(background);

      var seriesLayer = svgNode("g", { class: "election-timeseries__series", "aria-label": "Prognosserier" });
      definitions.forEach(function (definition) {
        var validPoints = history.points.filter(function (point) {
          return point.groups && point.groups[definition.id] && point.groups[definition.id][selectedMetric];
        });
        if (!validPoints.length) return;
        validPoints.forEach(function (point) { point._definitionId = definition.id; });
        var group = svgNode("g", {
          class: "election-timeseries__series-group" + (definition.defaultOn ? " is-primary" : ""),
          "data-coalition": definition.id,
          "data-coalition-label": definition.label,
          "data-color": definition.color,
          "data-provenance": validPoints[validPoints.length - 1].provenance
        });
        var ninety = historyAreaPath(validPoints, selectedMetric, definition.id, xScale, yScale, "p95", "p05");
        var fifty = historyAreaPath(validPoints, selectedMetric, definition.id, xScale, yScale, "p75", "p25");
        if (ninety) group.appendChild(svgNode("path", {
          class: "election-timeseries__band election-timeseries__band--90 election-timeseries__band-p90",
          d: ninety, fill: definition.color, "data-coalition": definition.id, "data-quantile": "p05-p95",
          "data-timeseries-band": "90", "data-interval": "90"
        }));
        if (fifty) group.appendChild(svgNode("path", {
          class: "election-timeseries__band election-timeseries__band--50 election-timeseries__band-p50",
          d: fifty, fill: definition.color, "data-coalition": definition.id, "data-quantile": "p25-p75",
          "data-timeseries-band": "50", "data-interval": "50"
        }));
        if (selectedMetric === "vote" && history.pop && history.pop.length) {
          var popPath = historyPopLinePath(history.pop, definition.id, xScale, yScale);
          if (popPath) group.appendChild(svgNode("path", {
            class: "election-timeseries__line election-timeseries__pop-line", d: popPath, stroke: definition.color,
            "data-coalition": definition.id, "data-series": "poll_of_polls"
          }));
        }
        var medianPath = historyAreaPath(validPoints, selectedMetric, definition.id, xScale, yScale, "p50", "p50");
        if (medianPath) group.appendChild(svgNode("path", {
          class: "election-timeseries__line election-timeseries__median", d: medianPath, stroke: definition.color,
          "data-coalition": definition.id, "data-quantile": "p50"
        }));
        var latest = validPoints[validPoints.length - 1];
        validPoints.forEach(function (point) {
          var rawPointValues = point.groups[definition.id][selectedMetric];
          var pointValues = historyDisplayQuantiles(point.groups[definition.id], selectedMetric);
          var current = point === latest;
          var pointCircle = svgNode("circle", {
            class: "election-timeseries__forecast-point" + (current ? " election-timeseries__current" : ""),
            cx: xScale(point.time), cy: yScale(pointValues.p50), r: current ? 5 : 2.7,
            fill: definition.color, "data-coalition": definition.id, "data-date": point.date,
            "data-provenance": point.provenance,
            "data-metric": selectedMetric, "data-p05": pointValues.p05,
            "data-p25": pointValues.p25, "data-p50": pointValues.p50,
            "data-p75": pointValues.p75, "data-p95": pointValues.p95,
            "data-quantiles": JSON.stringify(pointValues),
            "data-seat-quantiles": selectedMetric === "seats" ? JSON.stringify(rawPointValues) : "",
            "data-raw-p05": selectedMetric === "seats" ? rawPointValues.p05 : "",
            "data-raw-p25": selectedMetric === "seats" ? rawPointValues.p25 : "",
            "data-raw-p50": selectedMetric === "seats" ? rawPointValues.p50 : "",
            "data-raw-p75": selectedMetric === "seats" ? rawPointValues.p75 : "",
            "data-raw-p95": selectedMetric === "seats" ? rawPointValues.p95 : "",
            "data-current": current ? "true" : "false", tabindex: "0", role: "img",
            "aria-label": definition.label + ", " + (swedishDate(point.date) || point.date) +
              ": median " + percent(pointValues.p50, 1)
          });
          if (pointCircle.addEventListener) {
            pointCircle.addEventListener("mouseenter", function (event) { chooseForecast(point, false, event); });
            pointCircle.addEventListener("focus", function (event) { chooseForecast(point, false, event); });
            pointCircle.addEventListener("mouseleave", hideTooltip);
            pointCircle.addEventListener("click", function (event) { chooseForecast(point, true, event); });
            pointCircle.addEventListener("keydown", function (event) {
              if (event && (event.key === "Enter" || event.key === " ")) {
                if (event.preventDefault) event.preventDefault();
                chooseForecast(point, true, event);
              }
            });
          }
          group.appendChild(pointCircle);
        });
        seriesLayer.appendChild(group);
      });
      svg.appendChild(seriesLayer);

      var hit = svgNode("rect", {
        class: "election-timeseries__hit", x: plot.left, y: plot.top,
        width: plot.width, height: plot.height, tabindex: "0", role: "button",
        "aria-label": "Välj datum i prognosdiagrammet"
      });
      function chooseByEvent(event, persistent) {
        var time = dateForEvent(event);
        var point = nearestPoint(time === null ? maxTime : time);
        chooseForecast(point, persistent, event);
      }
      if (hit.addEventListener) {
        hit.addEventListener("mouseenter", function (event) { chooseByEvent(event, false); });
        hit.addEventListener("mousemove", function (event) { chooseByEvent(event, false); });
        hit.addEventListener("mouseleave", hideTooltip);
        hit.addEventListener("click", function (event) { chooseByEvent(event, true); });
        hit.addEventListener("keydown", function (event) {
          if (event && (event.key === "Enter" || event.key === " ")) {
            if (event.preventDefault) event.preventDefault();
            chooseForecast(nearestPoint(maxTime), true, event);
          } else if (event && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            if (event.preventDefault) event.preventDefault();
            chooseForecast(nearestPoint(selectedDate === null ? maxTime : selectedDate,
              event.key === "ArrowRight" ? 1 : -1), true, event);
          }
        });
      }
      svg.appendChild(hit);
      setModeButtons();
    }

    if (coalitionHost) {
      coalitionHost.innerHTML = "";
      history.definitions.forEach(function (definition) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "election-timeseries__coalition election-timeseries__coalition-button";
        button.setAttribute("data-coalition", definition.id);
        button.setAttribute("aria-pressed", selected[definition.id] ? "true" : "false");
        button.setAttribute("aria-label", (selected[definition.id] ? "Dölj " : "Visa ") + definition.label);
        button.innerHTML = "<span class=\"election-timeseries__coalition-swatch\" style=\"background:" +
          definition.color + "\" aria-hidden=\"true\"></span><span class=\"election-timeseries__coalition-label\">" +
          escapeHtml(definition.label) + "</span>";
        button.addEventListener("click", function () {
          selected[definition.id] = !selected[definition.id];
          button.setAttribute("aria-pressed", selected[definition.id] ? "true" : "false");
          button.setAttribute("aria-label", (selected[definition.id] ? "Dölj " : "Visa ") + definition.label);
          renderChart();
        });
        coalitionHost.appendChild(button);
      });
    }
    if (modeVote) modeVote.addEventListener("click", function () {
      selectedMetric = "vote";
      renderChart();
    });
    if (modeSeats) modeSeats.addEventListener("click", function () {
      selectedMetric = "seats";
      renderChart();
    });
    section.setAttribute("data-history-schema-version", history.schemaVersion);
    section.setAttribute("data-history-point-count", String(history.points.length));
    section.setAttribute("data-history-poll-count", String(history.polls.length));
    var firstDate = history.points[0].date;
    var lastDate = history.points[history.points.length - 1].date;
    setText("election-timeseries-intro", "Historiska prognosfördelningar från " +
      (swedishDate(firstDate) || firstDate) + " till " + (swedishDate(lastDate) || lastDate) +
      ". Byt mellan röstandel och mandatandel och välj vilka koalitioner som ska visas.");
    renderChart();
    section.hidden = false;
    return true;
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
  // Nothing here samples, recombines or assumes independence between
  // parties: a number the panel prints is a number the publication contains.
  // ---------------------------------------------------------------------
  // Two states, never three.  Every party is either in the government or in
  // the opposition, so only the government mask is stored and the opposition
  // is its exact complement.  A party that belongs to neither side, or to
  // both, is not representable rather than merely guarded against.
  var ZONE_GOVERNMENT = "government";
  var ZONE_OPPOSITION = "opposition";
  var ZONE_SEQUENCE = [ZONE_GOVERNMENT, ZONE_OPPOSITION];
  var ZONE_NAMES = {
    government: "Regering",
    opposition: "Opposition"
  };
  // Printed in place of the summary while the government is empty, so the
  // panel says what to do instead of reading as a dead pair of bars.
  var ZONE_HINTS = {
    government: "Dra mandatblock till Regering f\u00f6r att bygga en regering."
  };
  var ZONE_CLASS = "eg-bar";
  // Each side is drawn from its own mask.  Neither bar is cumulative and the
  // two are never added together: only the government mask is evaluated for
  // a majority.
  var BAR_NAMES = { government: "Regering", opposition: "Opposition" };
  // Pointer travel, in CSS pixels, before a press is treated as a drag.
  // Below it the gesture stays a press, so tapping a block never moves it.
  var DRAG_THRESHOLD = 5;
  // Touch only.  A finger that has stayed inside HOLD_SLOP pixels for
  // HOLD_MS is holding the block, not starting to scroll, so the drag begins
  // where the finger already is.
  var HOLD_MS = 320;
  var HOLD_SLOP = 8;
  // A segment shorter than this share of the 349-seat scale cannot hold its
  // own label legibly at 360px, so the label is dropped there.  The blocks
  // are now the only place a party is named -- there is no card list under
  // the chart to fall back on -- so the bar is tall enough that every
  // non-zero party clears this, and a zero-seat party carries its own tab.
  var SEGMENT_LABEL_MIN_SHARE = 6;

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

  // The seat value of the nth draw in sorted order, read straight out of the
  // counts.  The histogram is the sorted sample, so no sample list is needed.
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
    // The published summaries use NumPy's default linear percentile and then
    // truncate to integer seats.  Match NumPy's _lerp branch at the halfway
    // point before truncating; the two algebraically equivalent forms can land
    // on opposite sides of an integer in floating-point arithmetic.
    var gamma = position - lowerIndex;
    var difference = upper - lower;
    var interpolated = gamma < 0.5
      ? lower + difference * gamma
      : upper - difference * (1 - gamma);
    return Math.floor(interpolated);
  }

  // A histogram is accepted only if it reproduces the summary fields the
  // publication already prints: the mean, all seven quantiles and the
  // majority probability.  So the chart cannot drift from the numbers beside
  // it -- one of them would have to be wrong for both to be accepted.
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

    // Schema 1.2 entries carry summaries only; 1.3 appends one histogram to
    // every entry, and a 1.3 publication that is missing even one is not
    // partially rendered -- the whole builder stays hidden.
    var entryFields = histogramRequired
      ? COALITION_ENTRY_FIELDS_WITH_HISTOGRAM
      : COALITION_ENTRY_FIELDS;
    var commonTotal = expectedTotal === undefined || expectedTotal === null
      ? null : num(expectedTotal);
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
    // Every draw seats all 349, so a combination winning s seats is the same
    // draw as its complement winning 349 - s.  Checking that the two
    // histograms are exact mirrors catches a table assembled from different
    // runs, or from anything but one joint simulation.
    if (histogramRequired) {
      var fullMask = 255;
      for (var coalitionMask = 0; coalitionMask <= fullMask; coalitionMask += 1) {
        var complementMask = fullMask ^ coalitionMask;
        if (coalitionMask > complementMask) continue;
        var histogram = validatedHistograms[coalitionMask];
        var complementHistogram = validatedHistograms[complementMask];
        for (var seats = 0; seats <= CHAMBER; seats += 1) {
          var offset = seats - histogram.min_seats;
          var complementOffset = (CHAMBER - seats) - complementHistogram.min_seats;
          var count = offset >= 0 && offset < histogram.counts.length
            ? histogram.counts[offset] : 0;
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

  // A combination is named by its parties; the bitmask is derived from the
  // published party_order.  A name the publication does not carry yields
  // null rather than a silently wrong mask.
  function maskForParties(builder, parties) {
    var mask = 0;
    for (var index = 0; index < parties.length; index += 1) {
      var position = builder.party_order.indexOf(parties[index]);
      if (position === -1) return null;
      mask |= 1 << position;
    }
    return mask;
  }

  function coalitionParties(builder, mask) {
    return builder.party_order.filter(function (party, index) {
      return (mask & (1 << index)) !== 0;
    });
  }

  // The chart takes its colour from the coalition it is drawing: the member
  // with the largest one-party median, so a government reads as the party
  // that dominates it.  Ties fall to the earlier party in the published
  // party_order, which makes the choice stable across renders.
  function coalitionAccentParty(builder, mask) {
    var parties = coalitionParties(builder, mask);
    if (!parties.length) return null;
    var bestParty = parties[0];
    var bestMedian = -Infinity;
    parties.forEach(function (party) {
      var index = builder.party_order.indexOf(party);
      if (index === -1) return;
      var entry = coalitionLookup(builder, 1 << index);
      var median = entry && typeof entry.median_seats === "number" ? entry.median_seats : 0;
      if (median > bestMedian) {
        bestMedian = median;
        bestParty = party;
      }
    });
    return bestParty;
  }

  function hexToRgb(hex) {
    var value = String(hex === null || hex === undefined ? "" : hex).replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return [120, 120, 120];
    return [
      parseInt(value.substr(0, 2), 16),
      parseInt(value.substr(2, 2), 16),
      parseInt(value.substr(4, 2), 16)
    ];
  }

  function rgbToHex(r, g, b) {
    function clamp(value) {
      return Math.max(0, Math.min(255, Math.round(value)));
    }
    return "#" + [clamp(r), clamp(g), clamp(b)].map(function (value) {
      var text = value.toString(16);
      return text.length === 1 ? "0" + text : text;
    }).join("");
  }

  function mixColors(color1, color2, weight1) {
    var rgb1 = hexToRgb(color1);
    var rgb2 = hexToRgb(color2);
    var w1 = typeof weight1 === "number" ? weight1 : 0.5;
    var w2 = 1 - w1;
    return rgbToHex(
      rgb1[0] * w1 + rgb2[0] * w2,
      rgb1[1] * w1 + rgb2[1] * w2,
      rgb1[2] * w1 + rgb2[2] * w2
    );
  }

  // One accent, mixed down into a restrained set of fills and strokes.  The
  // party colour is never used at full strength behind text.
  function deriveCoalitionTheme(accentHex) {
    var hex = accentHex || "#355f8b";
    return {
      accent: hex,
      belowFill: mixColors(hex, "#f4f5f7", 0.18),
      belowStroke: mixColors(hex, "#768390", 0.45),
      majorityFill: mixColors(hex, "#ffffff", 0.58),
      majorityHatch: mixColors(hex, "#000000", 0.72),
      majorityRegion: mixColors(hex, "#ffffff", 0.08)
    };
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

  function histogramBinLabel(seat, count, total) {
    var share = total > 0 ? (count / total) * 100 : 0;
    return "Exakt " + seat + " mandat: " + grouped(count) +
      " simuleringar (" + percent(share, 2) + ")";
  }

  function summaryRow(metric, term, value) {
    return "<div data-metric=\"" + metric + "\">" +
      "<dt>" + escapeHtml(term) + "</dt>" +
      "<dd>" + escapeHtml(value) + "</dd>" +
      "</div>";
  }

  /** Walk up to the bar containing `node`, if any.  The two bars are the
      drop targets: the mandate blocks inside them are what a pointer grabs,
      so a drop lands on whichever bar sits under the pointer. */
  function zoneHostOf(node) {
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute("data-zone") &&
          String(node.className).indexOf("eg-bar") !== -1 &&
          String(node.className).indexOf("eg-bar__") === -1) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Exact seat histogram (schema 1.3)
  //
  // The chart is a lookup, like everything else in this panel: one bar per
  // seat value, each bar's height the count the publication contains.  There
  // is no binning choice, no kernel and no smoothing -- the bins are the
  // integers the simulation can produce.  The histogram drawn is always the
  // government's own combination; the opposition is never unioned into it.
  // ---------------------------------------------------------------------
  function renderCoalitionHistogram(host, entry, builder, mask, totalSamples) {
    if (!host) return;
    var heading = byId("election-government-histogram-heading");
    var svg = byId("election-government-histogram-svg");
    var context = byId("election-government-histogram-context");
    var majorityResult = byId("election-government-histogram-majority");
    var majorityShareText = byId("election-government-histogram-majority-share");
    var majorityDetailText = byId("election-government-histogram-majority-detail");
    var stats = byId("election-government-histogram-stats");
    var textAlternative = byId("election-government-histogram-text");
    var status = byId("election-government-histogram-status");

    function clear() {
      host.hidden = true;
      host.setAttribute("data-coalition-mask", "");
      host.removeAttribute("data-coalition-accent");
      host.removeAttribute("data-coalition-accent-color");
      host.setAttribute("data-total-count", "0");
      host.setAttribute("data-min-seats", "");
      host.setAttribute("data-max-seats", "");
      if (host.style) {
        if (typeof host.style.removeProperty === "function") {
          host.style.removeProperty("--egh-accent");
          host.style.removeProperty("--egh-below-fill");
          host.style.removeProperty("--egh-below-stroke");
          host.style.removeProperty("--egh-majority-fill");
          host.style.removeProperty("--egh-majority-hatch");
          host.style.removeProperty("--egh-majority-region");
        } else {
          delete host.style["--egh-accent"];
          delete host.style["--egh-below-fill"];
          delete host.style["--egh-below-stroke"];
          delete host.style["--egh-majority-fill"];
          delete host.style["--egh-majority-hatch"];
          delete host.style["--egh-majority-region"];
        }
      }
      if (context) context.textContent = "";
      if (majorityResult) majorityResult.hidden = true;
      if (majorityShareText) majorityShareText.textContent = "";
      if (majorityDetailText) majorityDetailText.textContent = "";
      if (stats) {
        stats.hidden = true;
        stats.innerHTML = "";
      }
      if (textAlternative) textAlternative.textContent = "";
      if (status) {
        status.textContent = "";
        status.hidden = true;
      }
      if (svg) svg.innerHTML = "";
    }

    // No histogram in the publication (schema 1.2) and no government chosen
    // both land here: the figure is removed rather than drawn empty.
    if (!entry || !entry.seat_histogram) {
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
    var accentParty = coalitionAccentParty(builder, mask);
    var accentColor = (accentParty && partyColors[accentParty]) || "#355f8b";
    var theme = deriveCoalitionTheme(accentColor);

    var majorityCount = counts.reduce(function (sum, count, index) {
      return sum + (minSeats + index >= MAJORITY ? count : 0);
    }, 0);
    var majorityShare = total > 0 ? majorityCount / total : 0;
    var patternId = "egh-majority-hatch-" + String(mask);
    // The chart uses a broad publication-style coordinate system.  Text is
    // deliberately sized in SVG units so it remains readable when the same
    // figure scales down to a 360px viewport.
    var plot = { left: 108, top: 60, width: 614, height: 230 };
    plot.right = plot.left + plot.width;
    plot.bottom = plot.top + plot.height;
    var supportSpan = Math.max(1, maxSeats - minSeats + 1);
    var padding = Math.max(2, Math.ceil(supportSpan * 0.06));
    var domainStart = Math.max(0, Math.min(minSeats, MAJORITY) - padding);
    var domainEnd = Math.min(CHAMBER, Math.max(maxSeats, MAJORITY) + padding);
    var domainSpan = Math.max(1, domainEnd - domainStart);
    var binWidth = plot.width / domainSpan;
    var thresholdX = plot.left + (MAJORITY - domainStart) * binWidth;
    var peak = counts.reduce(function (highest, count) {
      return Math.max(highest, count);
    }, 0);

    host.hidden = false;
    host.setAttribute("data-coalition-mask", String(mask));
    if (accentParty) {
      host.setAttribute("data-coalition-accent", accentParty);
      host.setAttribute("data-coalition-accent-color", accentColor);
    } else {
      host.removeAttribute("data-coalition-accent");
      host.removeAttribute("data-coalition-accent-color");
    }
    host.setAttribute("data-total-count", String(total));
    host.setAttribute("data-min-seats", String(minSeats));
    host.setAttribute("data-max-seats", String(maxSeats));
    if (host.style) {
      if (typeof host.style.setProperty === "function") {
        host.style.setProperty("--egh-accent", theme.accent);
        host.style.setProperty("--egh-below-fill", theme.belowFill);
        host.style.setProperty("--egh-below-stroke", theme.belowStroke);
        host.style.setProperty("--egh-majority-fill", theme.majorityFill);
        host.style.setProperty("--egh-majority-hatch", theme.majorityHatch);
        host.style.setProperty("--egh-majority-region", theme.majorityRegion);
      } else {
        host.style["--egh-accent"] = theme.accent;
        host.style["--egh-below-fill"] = theme.belowFill;
        host.style["--egh-below-stroke"] = theme.belowStroke;
        host.style["--egh-majority-fill"] = theme.majorityFill;
        host.style["--egh-majority-hatch"] = theme.majorityHatch;
        host.style["--egh-majority-region"] = theme.majorityRegion;
      }
    }

    // Keep the heading short; the validated sample count is explained once
    // in the context sentence and reused in the result block below.
    if (heading) {
      heading.textContent = "Mandatf\u00f6rdelning";
    }
    if (context) {
      var chipsHtml = parties.map(function (party) {
        return "<span class=\"egh-histogram__party-chip\" style=\"background:" +
          (partyColors[party] || "#777") + "\" aria-hidden=\"true\"></span>";
      }).join("");
      context.innerHTML =
        "<span class=\"egh-histogram__party-chips\" aria-hidden=\"true\">" + chipsHtml + "</span>" +
        "<span class=\"egh-histogram__party-label\">" + escapeHtml(partyLabel) + "</span>" +
        ". Varje stapel visar hur ofta regeringen fick ett visst antal mandat i modellens " +
        grouped(total) + " simuleringar.";
    }
    if (majorityResult) {
      majorityResult.hidden = false;
      if (majorityShareText) majorityShareText.textContent = histogramProbability(entry.prob_majority);
      if (majorityDetailText) {
        majorityDetailText.textContent = grouped(majorityCount) + " av " + grouped(total) +
          " simuleringar gav minst " + MAJORITY + " mandat.";
      }
    }
    // The four summaries the publication already carries for this exact
    // combination, printed beside the chart they describe.  Every value is a
    // lookup on the same entry the histogram was drawn from: nothing here is
    // recomputed from the counts, so the grid and the bars cannot disagree.
    if (stats) {
      stats.hidden = false;
      stats.innerHTML =
        summaryRow("median", "Medianmandat", format(entry.median_seats, 0)) +
        summaryRow("p50", "50\u00a0% prognosintervall", rangeText(entry.p25_seats, entry.p75_seats, 0)) +
        summaryRow("p80", "80\u00a0% prognosintervall", rangeText(entry.p10_seats, entry.p90_seats, 0)) +
        summaryRow("p90", "90\u00a0% prognosintervall", rangeText(entry.p05_seats, entry.p95_seats, 0));
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
    svg.setAttribute("aria-label", "Mandatf\u00f6rdelning f\u00f6r " + partyLabel + " med majoritetsgr\u00e4nsen vid " + MAJORITY + " mandat");
    svg.setAttribute("data-coalition-mask", String(mask));
    svg.appendChild(svgNode("title", { id: "election-government-histogram-title" },
      "Mandatf\u00f6rdelning f\u00f6r " + partyLabel));
    var description = "Mandatf\u00f6rdelning f\u00f6r " + partyLabel + " fr\u00e5n " + minSeats + " till " + maxSeats +
      " mandat. " + grouped(majorityCount) + " av " + grouped(total) +
      " simuleringar, " + percent(majorityShare * 100, 2) + ", n\u00e5r minst " + MAJORITY + " mandat.";
    svg.appendChild(svgNode("desc", { id: "election-government-histogram-description" }, description));

    var defs = svgNode("defs", {});
    var pattern = svgNode("pattern", {
      id: patternId,
      patternUnits: "userSpaceOnUse",
      width: "8",
      height: "8"
    });
    pattern.appendChild(svgNode("rect", {
      width: "8",
      height: "8",
      fill: theme.majorityFill,
      opacity: "0.82"
    }));
    pattern.appendChild(svgNode("path", {
      d: "M-2,2 L2,-2 M0,8 L8,0 M6,10 L10,6",
      class: "egh-hatch",
      stroke: theme.majorityHatch
    }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    var grid = svgNode("g", { class: "egh-grid", "aria-hidden": "true" });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (fraction) {
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
        class: "egh-majority-region", fill: theme.majorityRegion, "aria-hidden": "true"
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
        "aria-label": histogramBinLabel(seat, count, total)
      });
      bin.appendChild(svgNode("rect", {
        x: x + gap,
        y: plot.bottom - height,
        width: Math.max(0.2, binWidth - gap * 2),
        height: height,
        class: "egh-bin__bar",
        fill: reachesMajority ? "url(#" + patternId + ")" : theme.belowFill,
        stroke: reachesMajority ? theme.majorityHatch : theme.belowStroke,
        "stroke-width": "0.7",
        "aria-hidden": "true"
      }));
      // A low-frequency bin still needs a usable focus and hover target.  The
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
        status.textContent = histogramBinLabel(seat, count, total);
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
    var tickStart = Math.ceil(domainStart / 5) * 5;
    var tickEnd = Math.floor(domainEnd / 5) * 5;
    var axisValues = [];
    for (var tick = tickStart; tick <= tickEnd; tick += 5) axisValues.push(tick);
    axisValues.push(MAJORITY);
    // The padded domain gives the bars breathing room.  Only add an edge
    // label when it is not within five seats of a regular five-seat tick;
    // this prevents 162/165-style collisions on a phone-width SVG.
    if (!axisValues.some(function (value) { return Math.abs(value - domainStart) <= 5; })) {
      axisValues.push(domainStart);
    }
    if (!axisValues.some(function (value) { return Math.abs(value - domainEnd) <= 5; })) {
      axisValues.push(domainEnd);
    }
    axisValues.sort(function (a, b) { return a - b; });
    axisValues.filter(function (value, index, values) {
      return values.indexOf(value) === index;
    }).forEach(function (value) {
      var x = plot.left + (value - domainStart) * binWidth;
      svg.appendChild(svgNode("line", {
        x1: x, y1: plot.bottom, x2: x, y2: plot.bottom + 6,
        class: "egh-axis__mark", "aria-hidden": "true"
      }));
      svg.appendChild(svgNode("text", {
        x: x, y: plot.bottom + 24, class: "egh-axis__label",
        "text-anchor": value === domainStart ? "start" : (value === domainEnd ? "end" : "middle")
      }, String(value)));
    });
    svg.appendChild(svgNode("text", {
      x: plot.left + plot.width / 2, y: 345, class: "egh-x-axis-label", "text-anchor": "middle"
    }, "Mandat tillsammans"));
    svg.appendChild(svgNode("text", {
      x: plot.left, y: plot.top - 38, class: "egh-y-axis-label", "text-anchor": "start"
    }, "Andel simuleringar"));

    // The majority rule is the one mark that stays neutral: it is a property
    // of the Riksdag, not of the coalition being drawn, so it is never tinted
    // with the accent.
    svg.appendChild(svgNode("line", {
      x1: thresholdX, y1: plot.top, x2: thresholdX, y2: plot.bottom,
      class: "egh-threshold", "stroke-dasharray": "6 5", "data-seat": String(MAJORITY),
      "aria-label": "Majoritetsgr\u00e4ns: 175 mandat"
    }));
    var thresholdText = svgNode("text", {
      x: thresholdX,
      y: plot.top - 17,
      class: "egh-threshold__label",
      "text-anchor": "middle",
      "data-seat": String(MAJORITY)
    }, "Majoritetsgr\u00e4ns: 175 mandat");
    svg.appendChild(thresholdText);

    var textWidth = 0;
    try {
      if (thresholdText.getComputedTextLength) {
        textWidth = thresholdText.getComputedTextLength();
      }
    } catch (_) {}

    var padX = 14;
    var isLargeFont = textWidth > 320;
    var boxWidth = Math.round(textWidth > 30 ? textWidth + padX * 2 : 216);
    var boxHeight = isLargeFont ? 38 : 27;
    var boxY = isLargeFont ? plot.top - 44 : plot.top - 34;
    var halfBox = boxWidth / 2;
    var thresholdLabelX = Math.round(Math.min(plot.right - halfBox, Math.max(plot.left + halfBox, thresholdX + 108)));

    thresholdText.setAttribute("x", String(thresholdLabelX));

    var thresholdBg = svgNode("rect", {
      x: thresholdLabelX - halfBox,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      rx: 4,
      class: "egh-threshold__label-bg",
      "aria-hidden": "true"
    });
    svg.insertBefore(thresholdBg, thresholdText);

    if (textAlternative) {
      textAlternative.textContent = partyLabel + " fick majoritet i " +
        histogramProbability(entry.prob_majority) + " av simuleringarna." +
        " Utfallet varierade mellan " + minSeats + " och " + maxSeats + " mandat.";
    }
  }

  // The one gate both coalition views pass through.  1.2 publishes the
  // summaries they need; 1.3 additionally requires the exact histograms on
  // every entry.  Anything else -- 1.1 included -- yields null, and every
  // panel built on the coalition table stays hidden.  Validating once and
  // sharing the result keeps the two views on provably the same payload.
  function validatedCoalitionBuilder(groups, totalSamples) {
    if (!groups || (groups.schema_version !== "1.2" && groups.schema_version !== "1.3")) {
      return null;
    }
    var histogramRequired = groups.schema_version === "1.3";
    if (!validCoalitionBuilder(groups.coalition_builder, histogramRequired, totalSamples)) {
      return null;
    }
    return groups.coalition_builder;
  }

  function renderGovernmentBuilder(builder, totalSamples) {
    var section = byId("election-government-builder");
    if (!section || !builder) return;

    // The bars are both the picture and the interaction: the mandate blocks
    // inside them are what a pointer grabs, and the bar a block is dropped
    // on is the side it moves to.  There is no second set of controls.
    var bars = {
      government: byId("election-government-bar"),
      opposition: byId("election-opposition-bar")
    };
    var heads = {
      government: byId("election-government-column"),
      opposition: byId("election-opposition-column")
    };
    var totalIds = {
      government: "election-government-total",
      opposition: "election-opposition-total"
    };
    var summary = byId("election-government-results");
    var histogram = byId("election-government-histogram");
    var resetButton = byId("election-builder-reset");

    // Every party in the published order, as a single bitmask.  The two sides
    // partition it: government | opposition is always this, and
    // government & opposition is always 0.
    var FULL_MASK = (1 << builder.party_order.length) - 1;
    // The one piece of state in the panel.  Everything else about the
    // partition is derived from it, so the two sides cannot drift apart.
    var governmentMask = 0;
    var drag = null;

    // The stack follows the chamber's left-to-right seating order.
    var stackOrder = seatingOrder.filter(function (party) {
      return builder.party_order.indexOf(party) !== -1;
    });

    // The preset governments, resolved to masks from the published
    // party_order.  A preset naming a party the publication does not carry is
    // dropped rather than guessed at.
    var presets = GOVERNMENT_PRESETS.map(function (parties) {
      var mask = maskForParties(builder, parties);
      return mask === null ? null : { parties: parties, mask: mask };
    }).filter(function (preset) {
      return preset !== null;
    });
    var presetButtons = [];

    function oppositionMask() {
      return FULL_MASK ^ governmentMask;
    }

    function maskOf(zone) {
      return zone === ZONE_GOVERNMENT ? governmentMask : oppositionMask();
    }

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
      return (governmentMask & bitOf(party)) !== 0 ? ZONE_GOVERNMENT : ZONE_OPPOSITION;
    }

    function otherZone(zone) {
      return zone === ZONE_GOVERNMENT ? ZONE_OPPOSITION : ZONE_GOVERNMENT;
    }

    function fullName(party) {
      return (partyNames[party] || party) + " (" + abbr(party) + ")";
    }

    // The only mutation of the state.  Setting or clearing the one bit is the
    // whole move: the opposition follows because it is derived, so the two
    // sides can never disagree about where a party is.
    function move(party, zone) {
      var bit = bitOf(party);
      if (bit === 0) return;
      if (zone === ZONE_GOVERNMENT) governmentMask |= bit;
      else governmentMask &= ~bit;
      render(fullName(party) + " flyttades till " + ZONE_NAMES[zone] + ".");
    }

    function blockLabel(party, zone) {
      return fullName(party) + ", " + format(partyMedian(party), 0) +
        " mandat i median, i " + ZONE_NAMES[zone] + ". Dra till " +
        ZONE_NAMES[otherZone(zone)] + ".";
    }

    // --- Pointer dragging ------------------------------------------------
    // One pointer code path covers mouse, pen and touch, so the primary
    // interaction behaves the same everywhere instead of relying on the
    // HTML5 drag events, which never fire on a touchscreen.

    function paintZones() {
      ZONE_SEQUENCE.forEach(function (zone) {
        var host = bars[zone];
        if (!host) return;
        var cls = ZONE_CLASS;
        if (drag && drag.active) {
          // There is exactly one legal target -- the side the block is not
          // already in -- and it says so for as long as the block is in
          // flight.
          if (zone !== drag.from) cls += " is-droppable";
          if (zone === drag.over) cls += " is-dragover";
        }
        host.className = cls;
      });
    }

    // The ghost is anchored at the viewport origin by the stylesheet and moved
    // with a transform, so a pointer move costs a compositor commit rather
    // than a layout of a fixed-position element on the main thread.  The grab
    // offset is carried through unchanged: the pixel the reader grabbed stays
    // under the pointer for the whole drag.
    function positionGhost(x, y) {
      if (!drag || !drag.ghost) return;
      drag.ghost.style.transform =
        "translate3d(" + (x - drag.offsetX) + "px, " + (y - drag.offsetY) + "px, 0)";
    }

    // Pointer events arrive faster than the screen refreshes.  Each one only
    // records where the pointer now is; the work -- moving the ghost, hit
    // testing for the bar underneath, repainting the zones -- happens once per
    // frame, against the newest position.  Nothing is interpolated: the ghost
    // jumps straight to the latest pointer position every frame.
    function trackPointer() {
      if (!drag || !drag.active) return;
      positionGhost(drag.lastX, drag.lastY);
      var host = document.elementFromPoint
        ? zoneHostOf(document.elementFromPoint(drag.lastX, drag.lastY))
        : null;
      var over = host ? host.getAttribute("data-zone") : null;
      // Rewriting the bar classes restyles both bars, so it only happens when
      // the destination actually changed.
      if (over !== drag.over) {
        drag.over = over;
        paintZones();
      }
    }

    function scheduleTrack() {
      if (!drag || !drag.active || drag.frame !== null) return;
      if (typeof requestAnimationFrame !== "function") {
        trackPointer();
        return;
      }
      drag.frame = requestAnimationFrame(function () {
        if (!drag) return;
        drag.frame = null;
        trackPointer();
      });
    }

    function cancelTrack() {
      if (!drag || drag.frame === null) return;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(drag.frame);
      drag.frame = null;
    }

    function cancelHold() {
      if (drag && drag.holdTimer !== null) {
        clearTimeout(drag.holdTimer);
        drag.holdTimer = null;
      }
    }

    function activateDrag(x, y) {
      cancelHold();
      var rect = drag.tile.getBoundingClientRect();
      // The ghost is decoration: it is invisible to hit testing, so
      // elementFromPoint still finds the bar underneath, and it is out of the
      // accessibility tree so nothing can reach a copy.  The block's own
      // height is a share of its bar, so the copy is pinned to the pixels the
      // original occupies rather than inheriting a percentage of the body.
      var ghost = drag.tile.cloneNode(true);
      ghost.className = drag.baseClass + " eg-bar__segment--ghost";
      ghost.removeAttribute("data-zone");
      ghost.setAttribute("aria-hidden", "true");
      ghost.removeAttribute("aria-label");
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.active = true;
      drag.tile.className = drag.baseClass + " is-dragging";
      positionGhost(x, y);
    }

    function endDrag(commit) {
      if (!drag) return;
      cancelHold();
      cancelTrack();
      var party = drag.party;
      var target = commit && drag.active ? drag.over : null;
      if (drag.ghost && drag.ghost.parentNode) {
        drag.ghost.parentNode.removeChild(drag.ghost);
      }
      if (drag.tile) {
        drag.tile.className = drag.baseClass;
        if (drag.pointerId !== null && drag.tile.releasePointerCapture) {
          try {
            drag.tile.releasePointerCapture(drag.pointerId);
          } catch (error) { /* the capture was already lost */ }
        }
      }
      drag = null;
      paintZones();
      // Dropping onto the side a block already occupies is a no-op rather
      // than a move, so the reader cannot create a duplicate by wobbling.
      if (target && target !== zoneOf(party)) move(party, target);
    }

    function attachDrag(tile, party, zone) {
      if (!tile.addEventListener) return;

      tile.addEventListener("pointerdown", function (event) {
        if (event.button !== undefined && event.button !== 0) return;
        var rect = tile.getBoundingClientRect();
        drag = {
          party: party, tile: tile, from: zone, over: null, active: false,
          baseClass: tile.className,
          touch: event.pointerType === "touch",
          startX: event.clientX, startY: event.clientY,
          lastX: event.clientX, lastY: event.clientY,
          offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
          ghost: null, holdTimer: null, frame: null,
          pointerId: event.pointerId === undefined ? null : event.pointerId
        };
        if (drag.pointerId !== null && tile.setPointerCapture) {
          try {
            tile.setPointerCapture(drag.pointerId);
          } catch (error) { /* capture unsupported; the keyboard still works */ }
        }
        // A finger that holds still is not scrolling.  The browser has not
        // committed to a pan while the touch is inside its own slop, so the
        // preventDefault on the first move after the hold is what keeps the
        // page still under the drag.
        if (drag.touch) {
          drag.holdTimer = setTimeout(function () {
            if (!drag || drag.active) return;
            drag.holdTimer = null;
            activateDrag(drag.lastX, drag.lastY);
            paintZones();
          }, HOLD_MS);
        }
      });

      tile.addEventListener("pointermove", function (event) {
        if (!drag || drag.tile !== tile) return;
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        if (!drag.active) {
          if (drag.touch) {
            // Once the finger leaves the hold radius it is either scrolling
            // or dragging, and the two are told apart by direction.  The block
            // travels sideways to the other bar, so sideways starts a drag;
            // anything more vertical than horizontal is left to the browser,
            // which pans the page and cancels the pointer as it goes.
            if (Math.abs(dx) > HOLD_SLOP || Math.abs(dy) > HOLD_SLOP) cancelHold();
            if (Math.abs(dx) < DRAG_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
          } else if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
            return;
          }
          activateDrag(event.clientX, event.clientY);
          paintZones();
        }
        if (event.cancelable) event.preventDefault();
        scheduleTrack();
      });

      tile.addEventListener("pointerup", function () { endDrag(true); });
      // The browser takes the gesture over when it decides the page is being
      // scrolled.  That is a scroll, not a drag, and it ends here.
      tile.addEventListener("pointercancel", function () { endDrag(false); });
    }

    // --- Rendering -------------------------------------------------------

    // The preset row is built once.  Clicking a preset is the same single
    // state change a drag makes -- it sets the government mask, and the
    // opposition follows because it is derived -- so the two sides cannot
    // drift apart and no scrolling is triggered.
    function buildPresets() {
      var host = byId("election-builder-presets");
      if (!host) return;
      host.innerHTML = "";
      presets.forEach(function (preset) {
        var button = document.createElement("button");
        button.className = "eg-preset";
        button.setAttribute("type", "button");
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("data-coalition-mask", String(preset.mask));
        var swatches = preset.parties.map(function (party) {
          return "<span class=\"eg-preset__swatch\" style=\"background:" +
            (partyColors[party] || "#777") + "\" aria-hidden=\"true\"></span>";
        }).join("");
        button.innerHTML =
          "<span class=\"eg-preset__swatches\" aria-hidden=\"true\">" + swatches + "</span>" +
          "<span class=\"eg-preset__label\">" + escapeHtml(preset.parties.join(" + ")) + "</span>";
        button.setAttribute("aria-label", "S\u00e4tt regeringen till " +
          preset.parties.join(" plus ") + ".");
        if (button.addEventListener) {
          button.addEventListener("click", function () {
            governmentMask = preset.mask;
            render("Regeringen sattes till " + preset.parties.join(" + ") + ".");
          });
        }
        presetButtons.push({ preset: preset, button: button });
        host.appendChild(button);
      });
    }

    // A preset is pressed exactly when the government is that combination and
    // nothing else.  Because the test is against the one piece of state,
    // dragging a party in or out of a preset clears it with no bookkeeping.
    function paintPresets() {
      presetButtons.forEach(function (item) {
        var active = item.preset.mask === governmentMask;
        item.button.className = "eg-preset" + (active ? " is-active" : "");
        item.button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    // One mandate block.  The coloured block is the whole control: it is what
    // a pointer grabs and what a drop moves, so nothing else on the page has
    // to carry a duplicate of it.
    function buildSegment(party, zone, share) {
      var segment = document.createElement("span");
      // A party with a median of zero has no height to give, so it is drawn
      // as a small tab sitting on the bar's baseline instead.  The tab is
      // taken out of the flow (see the stylesheet), so it adds nothing to the
      // 0-349 scale -- it is a marker, not a segment.
      var zero = share <= 0;
      segment.className = "eg-bar__segment" + (zero ? " eg-bar__segment--zero" : "");
      if (!zero) segment.style.height = share.toFixed(3) + "%";
      segment.style.backgroundColor = partyColors[party] || "#777";
      segment.style.color = readableInk(partyColors[party]);
      segment.setAttribute("data-party", party);
      segment.setAttribute("data-side", zone);
      segment.setAttribute("aria-label", blockLabel(party, zone));
      // Native HTML5 dragging is switched off deliberately: it cannot reach
      // a touchscreen and would race the pointer handlers on a desktop.
      segment.setAttribute("draggable", "false");
      if (zero) {
        segment.innerHTML = "<span class=\"eg-bar__segment-label\">" +
          escapeHtml(abbr(party)) + "\u00a0\u00b7\u00a00</span>";
      } else if (share >= SEGMENT_LABEL_MIN_SHARE) {
        segment.innerHTML = "<span class=\"eg-bar__segment-label\">" + escapeHtml(abbr(party)) + "</span>";
      }
      attachDrag(segment, party, zone);
      return segment;
    }

    // Each side is drawn from its own mask on the shared 0-349 scale, so the
    // dashed rule can be read against either bar independently.
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
        host.appendChild(buildSegment(party, key, share));
        described.push(abbr(party) + " " + format(seats, 0));
      });
      // Segments are appended bottom-first (the track is column-reverse), but
      // the description is read top-down, the way the stack is seen.
      host.setAttribute("aria-label", members.length
        ? BAR_NAMES[key] + ": " + described.reverse().join(", ") + ". Median tillsammans " +
          format(total, 0) + " av " + CHAMBER + " mandat."
        : BAR_NAMES[key] + ": inga partier valda.");
    }

    // Draws the summary and returns the sentence the live region should
    // carry for the resulting state; the caller prefixes whatever just
    // happened, so a move and its consequence are announced together.
    function renderSummary() {
      var opposition = oppositionMask();
      var entry = coalitionLookup(builder, governmentMask);
      var chosen = governmentMask !== 0;
      if (!summary) return "";
      summary.hidden = !chosen;
      summary.setAttribute("data-government-mask", chosen ? String(governmentMask) : "");
      summary.setAttribute("data-opposition-mask", chosen ? String(opposition) : "");
      // The evaluated coalition is the government and nothing else.
      summary.setAttribute("data-coalition-mask", chosen ? String(governmentMask) : "");
      // The histogram is the government's own combination and nothing else:
      // the same mask the summary is looked up with, never a union with the
      // opposition.  An empty government and a 1.2 publication both clear it.
      renderCoalitionHistogram(histogram, chosen ? entry : null, builder,
        governmentMask, totalSamples);
      if (!chosen || !entry) {
        summary.innerHTML = "";
        return ZONE_HINTS.government;
      }

      var governmentSeats = format(entry.median_seats, 0) + " mandat";
      var oppositionSeats = format(medianOf(opposition), 0) + " mandat";
      var range = rangeText(entry.p05_seats, entry.p95_seats, 0) + " mandat";
      var chance = probability(entry.prob_majority);
      // A schema-1.2 entry has no exact histogram to reveal.  Keep its
      // compatibility summary intact, but do not leave a dead link behind.
      var discoverability = entry.seat_histogram && histogram && !histogram.hidden
        ? "<div class=\"eg-summary__discoverability\">" +
            "<span>Median: " + escapeHtml(format(entry.median_seats, 0)) +
            " mandat \u00b7 Majoritet: " + escapeHtml(histogramProbability(entry.prob_majority)) + " \u00b7 </span>" +
            "<a class=\"eg-summary__histogram-link\" href=\"#election-government-histogram\">" +
              "Visa mandatf\u00f6rdelningen \u2193" +
            "</a>" +
          "</div>"
        : "";
      // The opposition row is its own coalition's median, looked up on its
      // own mask.  It is a contrast, not a second majority claim, so no
      // probability is printed for it.
      summary.innerHTML =
        summaryRow("government", ZONE_NAMES.government, governmentSeats) +
        summaryRow("opposition", ZONE_NAMES.opposition, oppositionSeats) +
        summaryRow("interval", "90\u00a0% prognosintervall", range) +
        summaryRow("probability", "Sannolikhet f\u00f6r minst " + MAJORITY + " mandat", chance) +
        discoverability;

      var histogramLink = discoverability
        ? summary.querySelector(".eg-summary__histogram-link") : null;
      if (histogramLink && histogram && histogram.addEventListener) {
        histogramLink.addEventListener("click", function (event) {
          // The href remains a normal anchor fallback for older browsers.  If
          // smooth scrolling is available, use it only after an explicit
          // click; rendering and dragging never move the page.
          if (!histogram.scrollIntoView || typeof histogram.scrollIntoView !== "function") return;
          if (event && event.preventDefault) event.preventDefault();
          try {
            histogram.scrollIntoView({ behavior: "smooth", block: "start" });
          } catch (error) {
            histogram.scrollIntoView();
          }
        });
      }

      var oppositionParties = coalitionParties(builder, opposition);
      return "Regering " + coalitionParties(builder, governmentMask).join(" + ") + ", " +
        governmentSeats + "; 90-procentigt prognosintervall " + range +
        "; sannolikhet f\u00f6r minst " + MAJORITY + " mandat " + chance + ". " +
        (oppositionParties.length
          ? "Opposition " + oppositionParties.join(" + ") + ", " + oppositionSeats + "."
          : "Inga partier i opposition.");
    }

    function render(moved) {
      ZONE_SEQUENCE.forEach(function (zone) {
        renderBar(zone, maskOf(zone));
      });
      var state = renderSummary();
      setText("election-government-announcement",
        moved ? moved + " " + state : state);
      paintZones();
      paintPresets();
    }

    if (resetButton && resetButton.addEventListener) {
      resetButton.addEventListener("click", function () {
        governmentMask = 0;
        render();
        // After render, so the reset message is not immediately overwritten
        // by the empty-government prompt.
        setText("election-government-announcement",
          "Alla \u00e5tta partier ligger i Opposition igen.");
        if (typeof resetButton.focus === "function") resetButton.focus();
      });
    }

    // Render before revealing: if a future render throws, the section stays
    // hidden instead of exposing an empty shell.
    buildPresets();
    render();
    section.hidden = false;
  }

  // ---------------------------------------------------------------------
  // 5. Government alternatives
  //
  // The same six combinations the builder offers as presets, drawn as six
  // rows on one shared seat scale.  Every row is a lookup in the published
  // coalition_builder: a combination's median, its intervals and its
  // majority probability are joint quantities of the simulation, so nothing
  // here is assembled from party medians and no party-coloured seat segments
  // are stacked.  The bands are neutral; the swatches carry party identity.
  // ---------------------------------------------------------------------
  function renderAlternatives(builder) {
    var section = byId("election-alternatives");
    var host = byId("election-alternatives-rows");
    if (!section || !host || !builder) return;

    var rows = [];
    GOVERNMENT_PRESETS.forEach(function (parties) {
      var mask = maskForParties(builder, parties);
      if (mask === null) return;
      var entry = coalitionLookup(builder, mask);
      if (!entry) return;
      rows.push({ parties: parties, mask: mask, entry: entry });
    });
    if (rows.length !== GOVERNMENT_PRESETS.length) return;

    // One domain for all six rows.  It is read off the published 90 %
    // intervals, padded a little, snapped to five-seat marks and always
    // widened to contain the majority rule, so every row is read against the
    // same scale and against the same vertical line at 175.
    var low = MAJORITY;
    var high = MAJORITY;
    rows.forEach(function (row) {
      var p05 = num(row.entry.p05_seats);
      var p95 = num(row.entry.p95_seats);
      if (p05 !== null && p05 < low) low = p05;
      if (p95 !== null && p95 > high) high = p95;
    });
    var pad = Math.max(2, Math.round((high - low) * 0.05));
    var domainStart = Math.max(0, Math.floor((low - pad) / 5) * 5);
    var domainEnd = Math.min(CHAMBER, Math.ceil((high + pad) / 5) * 5);
    if (domainEnd <= domainStart) domainEnd = Math.min(CHAMBER, domainStart + 5);
    var span = Math.max(1, domainEnd - domainStart);

    function place(value) {
      var parsed = num(value);
      if (parsed === null) return 0;
      return Math.max(0, Math.min(100, ((parsed - domainStart) / span) * 100));
    }

    var thresholdLeft = place(MAJORITY);

    host.innerHTML = "";
    rows.forEach(function (row) {
      var entry = row.entry;
      var p05 = place(entry.p05_seats);
      var p95 = place(entry.p95_seats);
      var p25 = place(entry.p25_seats);
      var p75 = place(entry.p75_seats);
      var median = place(entry.median_seats);
      var name = row.parties.join(" + ");
      var swatches = row.parties.map(function (party) {
        return "<span class=\"ev-swatch\" style=\"background:" +
          (partyColors[party] || "#777") + "\" aria-hidden=\"true\"></span>";
      }).join("");
      // Two decimals, the same convention the exact histogram prints, so a
      // reader can reconcile a row with the chart above it.
      var chance = histogramProbability(entry.prob_majority);
      var node = document.createElement("div");
      node.className = "ea-row";
      node.setAttribute("role", "listitem");
      node.setAttribute("data-coalition-mask", String(row.mask));
      node.setAttribute("data-median-seats", String(entry.median_seats));
      node.innerHTML =
        "<span class=\"ea-name\">" +
          "<span class=\"ea-name__swatches\" aria-hidden=\"true\">" + swatches + "</span>" +
          "<span class=\"ea-name__text\">" + escapeHtml(name) + "</span>" +
        "</span>" +
        "<span class=\"ea-chart\" aria-hidden=\"true\">" +
          "<span class=\"ea-track\">" +
            "<span class=\"ea-threshold\" style=\"left:" + thresholdLeft.toFixed(3) + "%\"></span>" +
            "<span class=\"ea-band ea-band--90\" style=\"left:" + p05.toFixed(3) +
              "%;width:" + Math.max(0.4, p95 - p05).toFixed(3) + "%\"></span>" +
            "<span class=\"ea-band ea-band--50\" style=\"left:" + p25.toFixed(3) +
              "%;width:" + Math.max(0.4, p75 - p25).toFixed(3) + "%\"></span>" +
            "<span class=\"ea-median-mark\" style=\"left:" + median.toFixed(3) + "%\"></span>" +
          "</span>" +
        "</span>" +
        "<span class=\"ea-prob\"><span class=\"ea-prob__value\">" + escapeHtml(chance) +
          "</span><span class=\"ea-prob__word\">majoritet</span></span>";
      node.setAttribute("aria-label", row.parties.join(" plus ") + ": median " +
        format(entry.median_seats, 0) + " mandat, centralt 50-procentigt prognosintervall " +
        rangeText(entry.p25_seats, entry.p75_seats, 0) +
        " mandat, centralt 90-procentigt prognosintervall " +
        rangeText(entry.p05_seats, entry.p95_seats, 0) +
        " mandat, sannolikhet f\u00f6r minst " + MAJORITY + " mandat " + chance + ".");
      host.appendChild(node);
    });

    // The axis belongs to all six rows at once, so it is drawn from the same
    // domain and carries the majority rule as its one emphasised tick.  The
    // step is chosen so the labels stay apart at phone width.
    var axis = byId("election-alternatives-axis");
    if (axis) {
      var step = 5;
      [5, 10, 20, 25, 50].some(function (candidate) {
        step = candidate;
        return span / candidate <= 6;
      });
      var ticks = "";
      for (var value = Math.ceil(domainStart / step) * step; value <= domainEnd; value += step) {
        // Drop a regular tick that would sit on top of the majority label.
        if (Math.abs(value - MAJORITY) < step * 0.5) continue;
        ticks += axisTick(place(value), String(value), false);
      }
      ticks += axisTick(thresholdLeft, String(MAJORITY), true);
      axis.innerHTML =
        "<span class=\"ea-axis__spacer\" aria-hidden=\"true\"></span>" +
        "<span class=\"ea-axis__track\" aria-hidden=\"true\">" + ticks + "</span>" +
        "<span class=\"ea-axis__unit\" aria-hidden=\"true\">mandat</span>";
    }

    host.setAttribute("data-domain-start", String(domainStart));
    host.setAttribute("data-domain-end", String(domainEnd));
    // Populate before revealing, so a throw leaves the section hidden rather
    // than exposing an empty shell.
    section.hidden = false;
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
      var coalitionTable = validatedCoalitionBuilder(data[3], data[0] && data[0].total_samples);
      renderGovernmentBuilder(coalitionTable, data[0] && data[0].total_samples);
      renderAlternatives(coalitionTable);
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

  // The history artifact is deliberately outside the frozen publication
  // bundle.  Its absence must not make the certified current forecast fail;
  // when it is present, the section validates and renders it independently.
  if (byId("election-timeseries")) {
    getJson("history/coalition-timeseries.json", base).then(function (history) {
      if (!renderForecastHistory(history)) {
        var invalidSection = byId("election-timeseries");
        if (invalidSection) invalidSection.setAttribute("data-history-state", "invalid");
      }
    }).catch(function () {
      var missingSection = byId("election-timeseries");
      if (missingSection) missingSection.setAttribute("data-history-state", "unavailable");
    });
  }
}());
