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
  // "Röstandelar på valdagen" and "Vägen till valdagen" load from two
  // independent fetches that race, so the direct-navigation action is wired
  // through these two module-level handles rather than a call ordering.
  var showPartyTimeline = null;
  var partyTimelineLinks = {};
  // Which parties the history artifact actually publishes. Kept at module
  // level because the two sections load from independent fetches in either
  // order: whichever finishes second reads this and reconciles.
  var partyTimelineAvailable = [];

  function partyTimelineIsAvailable(party) {
    return partyTimelineAvailable.indexOf(party) !== -1;
  }

  function enablePartyTimelineLinks(availableParties) {
    partyTimelineAvailable = availableParties || [];
    Object.keys(partyTimelineLinks).forEach(function (party) {
      var link = partyTimelineLinks[party];
      if (link) link.hidden = !partyTimelineIsAvailable(party);
    });
  }

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
      var asOfLabel = swedishDate(asOf) || asOf || "det publicerade underlaget";
      var electionLabel = swedishDate(electionDate) || electionDate || "det publicerade valdatumet";
      lede.textContent = "Valprognosen visar hur valet den " + electionLabel +
        " kan sluta. Den bygger p\u00e5 underlag till och med " + asOfLabel +
        " och " + draws + " simulerade valresultat.";
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
  var HISTORY_DYNAMICS_CAP = 112;
  // ---------------------------------------------------------------------
  // Party definitions on the same time series.
  //
  // A party and a coalition are *different quantities* and the difference is
  // the denominator. A coalition share is renormalized over the eight
  // parliamentary parties; a party share is its share of the whole electorate,
  // REST included, which is the definition parties.json, every published poll
  // and the statutory 4 % threshold all use. Nothing here derives a party from
  // coalition numbers: every party value is read from the publication's own
  // additive party family, and the family is used only if it validates whole.
  // ---------------------------------------------------------------------
  var PARTY_VIEW_ROLE = "party_time_series";
  var PARTY_VOTE_DENOMINATOR = "all_nine_model_categories_including_rest";
  var PARTY_VOTE_DEFINITION = "national_vote_share";
  var PARTY_SEAT_DEFINITION = "statutory_mandate_allocation";
  var PARTY_VIEW_SCHEMA = "1.0";
  var NATIONAL_THRESHOLD_PCT = 4;
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

  // Published dates are calendar dates, not local timestamps. Constructing
  // the offset at UTC midnight keeps a range such as election day minus 30
  // days stable across browser time zones and daylight-saving transitions.
  function historyDateOffset(value, offsetDays) {
    var date = historyDate(value);
    if (!date || !Number.isFinite(Number(offsetDays))) return null;
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.iso);
    if (!parts) return null;
    var shifted = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1,
      Number(parts[3]) + Number(offsetDays)));
    return historyDate(shifted.toISOString().slice(0, 10));
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
        kind: "coalition",
        label: definition.label,
        shortLabel: definition.label,
        // Renormalized over the eight parliamentary parties, which is what a
        // coalition majority question is asking about.
        denominator: "parliamentary_8",
        parties: parties,
        color: definition.color,
        defaultOn: definition.defaultOn
      };
    });
  }

  // The party family is opt-in and fail-closed: an absent, malformed or
  // partial `parties_view` returns null, the switch is never offered, and the
  // coalition experience is bit-for-bit what it was.
  function historyPartyDefinitions(payload) {
    var view = payload && payload.parties_view;
    if (!view || typeof view !== "object" || Array.isArray(view)) return null;
    if (view.schema_version !== PARTY_VIEW_SCHEMA || view.role !== PARTY_VIEW_ROLE) return null;
    if (view.vote_share_denominator !== PARTY_VOTE_DENOMINATOR) return null;
    if (view.vote_share_definition !== PARTY_VOTE_DEFINITION) return null;
    if (view.seat_definition !== PARTY_SEAT_DEFINITION) return null;
    // REST is aggregate vote mass for modelled-ineligible parties. It cannot
    // reach the threshold or hold seats, so it is never a followable party.
    if (view.rest_is_a_party !== false) return null;
    if (view.intermediate_seat_trajectory !== false) return null;
    if (historyNumber(view.national_threshold_pct) !== NATIONAL_THRESHOLD_PCT) return null;
    var parity = view.election_day_parity;
    if (!parity || typeof parity !== "object") return null;
    if (parity.reconstructed_from_coalitions !== false) return null;
    if (typeof parity.guarantee !== "string" || !parity.guarantee.trim()) return null;
    if (!Array.isArray(view.party_order) || view.party_order.length !== HISTORY_PARTIES.length) return null;
    if (!view.party_order.every(function (party, index) { return party === HISTORY_PARTIES[index]; })) {
      return null;
    }
    var names = view.party_names_sv;
    if (!names || typeof names !== "object") return null;
    var definitions = [];
    for (var index = 0; index < HISTORY_PARTIES.length; index += 1) {
      var party = HISTORY_PARTIES[index];
      var published = typeof names[party] === "string" && names[party].trim() ? names[party] : null;
      if (!published) return null;
      definitions.push({
        id: party,
        kind: "party",
        party: party,
        label: published + " (" + party + ")",
        shortLabel: party,
        name: published,
        // The whole electorate, REST included. Never renormalized.
        denominator: "model_categories_9",
        parties: [party],
        color: partyColors[party] || "#777",
        defaultOn: false
      });
    }
    return {
      definitions: definitions,
      thresholdPct: NATIONAL_THRESHOLD_PCT,
      thresholdLabel: typeof view.threshold_label_sv === "string" && view.threshold_label_sv.trim()
        ? view.threshold_label_sv : "4 %-sp\u00e4rr",
      note: typeof view.provenance_note_sv === "string" ? view.provenance_note_sv : ""
    };
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
    var partyGroups = raw.parties && typeof raw.parties === "object" && !Array.isArray(raw.parties)
      ? raw.parties : {};
    var normalizedGroups = {};
    // Coalition ids are lower-case identifiers and party ids are the eight
    // upper-case codes, so the two families share one flat definition
    // namespace without any possibility of collision. That is what lets the
    // renderer stay a single pipeline: it only ever asks a point for a
    // definition id.
    definitions.forEach(function (definition) {
      var source = definition.kind === "party" ? partyGroups : groups;
      var group = source && source[definition.id];
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

  // One published observation, read on the definition's own denominator.
  //
  // A coalition is renormalized over the eight parliamentary parties, matching
  // the coalition quantiles it is drawn beside. A party is *not*: the number a
  // pollster publishes is already that party's share of the electorate, whose
  // remainder is the same REST mass the model carries, so it is exactly
  // comparable to the published party quantiles and to the 4 % line. Dividing
  // it by the eight-party sum would inflate every party by roughly 2 % of its
  // own value and quietly move it away from the threshold.
  function definitionObservation(definition, parties, denominator) {
    if (definition.kind === "party") {
      var value = parties[definition.id];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    var total = definition.parties.reduce(function (sum, party) {
      return sum + (parties[party] || 0);
    }, 0);
    return 100 * total / denominator;
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
      values[definition.id] = definitionObservation(definition, parties, denominator);
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
      values[definition.id] = definitionObservation(definition, parties, denominator);
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

  function futureProjectionGroups(raw, definitions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var ids = definitions.map(function (definition) { return definition.id; });
    function hasExactKeys(value, expected) {
      var actual = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
      return actual.length === expected.length && expected.every(function (key) {
        return Object.prototype.hasOwnProperty.call(value, key);
      });
    }
    if (!hasExactKeys(raw, ids)) return null;
    var normalized = {};
    var quantileKeys = ["p05", "p25", "p50", "p75", "p95"];
    var valid = ids.every(function (id) {
      var group = raw[id];
      if (!group || !hasExactKeys(group, ["vote", "seats"])) return false;
      return ["vote", "seats"].every(function (metric) {
        var values = group[metric];
        if (!values || !hasExactKeys(values, quantileKeys)) return false;
        var upper = metric === "seats" ? CHAMBER : 100;
        var numbers = quantileKeys.map(function (key) { return values[key]; });
        if (!numbers.every(function (value) {
          return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= upper &&
            (metric !== "seats" || Number.isInteger(value));
        })) return false;
        if (!numbers.every(function (value, index) { return index === 0 || value >= numbers[index - 1]; })) {
          return false;
        }
        return true;
      });
    });
    if (!valid) return null;
    ids.forEach(function (id) {
      normalized[id] = {
        vote: historyQuantiles(raw[id].vote),
        seats: historyQuantiles(raw[id].seats)
      };
    });
    return normalized;
  }

  function normalizeFutureProjection(raw, payload, electionDate, definitions, points) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var origin = historyDate(raw.origin_date);
    var election = historyDate(raw.election_date);
    if (!origin || !election || election.iso !== electionDate.iso || origin.time > election.time) return null;
    if (raw.projection_type !== "conditional_forward_projection" ||
        raw.assumption !== "frozen_opinion_state_shrinking_dynamics_horizon" ||
        raw.state_cutoff_date !== origin.iso || raw.future_measurements_known !== false ||
        raw.state_condition !== "underlying_opinion_unchanged_from_origin" ||
        raw.dynamics_horizon_rule !== "election_date_minus_projection_date" ||
        raw.election_noise !== "canonical_adopted_law" ||
        raw.mandate_allocation !== "canonical_production_path" ||
        typeof raw.tooltip_sv !== "string" || !raw.tooltip_sv.trim()) return null;

    var rawSeries = Array.isArray(payload.series) ? payload.series : [];
    var currentRaw = rawSeries.filter(function (point) {
      return point && point.provenance === "current_production";
    });
    if (currentRaw.length !== 1 || currentRaw[0].date !== origin.iso) return null;
    var anchor = raw.anchor;
    if (!anchor || anchor.date !== origin.iso || anchor.provenance !== "current_production" ||
        anchor.samples !== currentRaw[0].samples) return null;
    var anchorGroups = futureProjectionGroups(anchor.groups, definitions);
    var currentGroups = futureProjectionGroups(currentRaw[0].groups, definitions);
    if (!anchorGroups || !currentGroups ||
        JSON.stringify(anchorGroups) !== JSON.stringify(currentGroups)) return null;
    var anchorPoint = points.filter(function (point) {
      return point.date === origin.iso && point.provenance === "current_production";
    })[0];
    if (!anchorPoint || anchorPoint.samples !== anchor.samples) return null;

    var rendering = raw.rendering;
    var region = rendering && rendering.future_region;
    if (!rendering || rendering.x_axis_max !== election.iso || !region ||
        region.start !== origin.iso || region.end !== election.iso || region.background !== "light_neutral" ||
        typeof rendering.latest_forecast_label !== "string" || !rendering.latest_forecast_label.trim() ||
        typeof rendering.election_day_label !== "string" || !rendering.election_day_label.trim() ||
        typeof rendering.legend_label !== "string" || !rendering.legend_label.trim() ||
        rendering.median_line !== "dashed_lighter" ||
        JSON.stringify(rendering.interval_bands) !== JSON.stringify(["p25_p75", "p05_p95"]) ||
        JSON.stringify(rendering.units) !== JSON.stringify(["vote", "seats"]) ||
        rendering.poll_observations_in_future !== false ||
        rendering.poll_of_polls_observations_in_future !== false ||
        rendering.connect_from_history_anchor !== true) return null;

    var series = Array.isArray(raw.series) ? raw.series : null;
    var expectedCount = Math.round((election.time - origin.time) / 86400000);
    if (!series || series.length !== expectedCount) return null;
    var historicalDates = {};
    rawSeries.forEach(function (point) {
      if (point && typeof point.date === "string") historicalDates[point.date] = true;
    });
    var normalizedSeries = [];
    for (var index = 0; index < series.length; index += 1) {
      var item = series[index];
      var expectedTime = origin.time + (index + 1) * 86400000;
      var expectedDate = new Date(expectedTime).toISOString().slice(0, 10);
      var groups = item && futureProjectionGroups(item.groups, definitions);
      if (!item || item.date !== expectedDate || historicalDates[item.date] ||
          item.remaining_horizon_days !== expectedCount - index - 1 ||
          !Number.isInteger(item.samples) || item.samples <= 0 || !groups) return null;
      normalizedSeries.push({
        date: expectedDate,
        time: expectedTime,
        samples: item.samples,
        remainingHorizonDays: item.remaining_horizon_days,
        groups: groups,
        isFuture: true
      });
    }
    if (normalizedSeries.length &&
        (normalizedSeries[normalizedSeries.length - 1].date !== election.iso ||
         normalizedSeries[normalizedSeries.length - 1].remainingHorizonDays !== 0)) return null;
    return {
      origin: origin,
      election: election,
      anchorPoint: anchorPoint,
      points: normalizedSeries,
      tooltip: raw.tooltip_sv,
      rendering: rendering
    };
  }

  // ------------------------------------------------------------------
  // Coherent forward campaign paths (primary future view)
  // ------------------------------------------------------------------
  // Simulated *opinion* trajectories from the certified origin to election
  // day, plus the emphasized election-day forecast distribution.  The
  // intermediate days are the same quantity the Poll of Polls series
  // measures; only the election-day object carries ElectionNoise, geography
  // and mandates.  Every published invariant is re-checked here so a
  // malformed artifact fails closed into "no future region" instead of
  // rendering a claim the model never made.
  var CAMPAIGN_PATH_TYPE = "coherent_campaign_paths";
  var CAMPAIGN_PATH_MODEL_ID = "coherent_campaign_paths_v1";
  var CAMPAIGN_PATH_PRIMARY_ROLE = "primary_future_view";
  var CAMPAIGN_PATH_SECONDARY_ROLE = "secondary_analytical_view";
  var CAMPAIGN_PATH_QUANTITY = "underlying_opinion_share";
  // Path day 0 is the model's latent opinion state at the origin. The
  // certified forecast point sits on the same calendar date but is a *wider,
  // different* distribution -- it adds campaign dynamics and ElectionNoise --
  // so the fan is drawn from its own origin marker, never from that dot.
  var CAMPAIGN_PATH_ORIGIN_QUANTITY = "opinion_state_only";
  var CAMPAIGN_PATH_CONTINUES_FROM = "current_opinion_state";

  function campaignBandGroups(raw, definitions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var ids = definitions.map(function (definition) { return definition.id; });
    var actual = Object.keys(raw);
    if (actual.length !== ids.length) return null;
    if (!ids.every(function (id) { return Object.prototype.hasOwnProperty.call(raw, id); })) return null;
    var quantileKeys = ["p05", "p25", "p50", "p75", "p95"];
    var normalized = {};
    for (var index = 0; index < ids.length; index += 1) {
      var group = raw[ids[index]];
      if (!group || typeof group !== "object" || Array.isArray(group)) return null;
      // Opinion bands publish vote shares only.  A seat quantile here would
      // imply a future seat trajectory, which the model deliberately refuses.
      if (Object.keys(group).length !== 1 || !Object.prototype.hasOwnProperty.call(group, "vote")) return null;
      var values = group.vote;
      if (!values || typeof values !== "object") return null;
      if (Object.keys(values).length !== quantileKeys.length) return null;
      var numbers = [];
      for (var key = 0; key < quantileKeys.length; key += 1) {
        var value = values[quantileKeys[key]];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
        if (key > 0 && value < numbers[key - 1]) return null;
        numbers.push(value);
      }
      normalized[ids[index]] = { vote: historyQuantiles(values) };
      if (!normalized[ids[index]].vote) return null;
    }
    return normalized;
  }

  // A vote-only party band. A seat quantile here would assert an intermediate
  // future mandate trajectory, which the model refuses to publish: latent
  // opinion has no seat allocation.
  function campaignBandParties(raw, partyDefinitions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var ids = partyDefinitions.map(function (definition) { return definition.id; });
    if (Object.keys(raw).length !== ids.length) return null;
    var normalized = {};
    for (var index = 0; index < ids.length; index += 1) {
      var entry = raw[ids[index]];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      if (Object.keys(entry).length !== 1 ||
          !Object.prototype.hasOwnProperty.call(entry, "vote")) return null;
      var quantiles = historyQuantiles(entry.vote);
      if (!quantiles) return null;
      normalized[ids[index]] = { vote: quantiles };
    }
    return normalized;
  }

  // A full party summary: vote and seats, as the certified election-day
  // distribution and every historical point publish them.
  function partySummaryGroups(raw, partyDefinitions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var ids = partyDefinitions.map(function (definition) { return definition.id; });
    if (Object.keys(raw).length !== ids.length) return null;
    var normalized = {};
    for (var index = 0; index < ids.length; index += 1) {
      var entry = raw[ids[index]];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      if (Object.keys(entry).length !== 2 ||
          !Object.prototype.hasOwnProperty.call(entry, "vote") ||
          !Object.prototype.hasOwnProperty.call(entry, "seats")) return null;
      var vote = historyQuantiles(entry.vote);
      var seats = historyQuantiles(entry.seats);
      if (!vote || !seats) return null;
      var seatValues = ["p05", "p25", "p50", "p75", "p95"].map(function (key) { return seats[key]; });
      if (!seatValues.every(function (value) {
        return Number.isInteger(value) && value >= 0 && value <= CHAMBER;
      })) return null;
      normalized[ids[index]] = { vote: vote, seats: seats };
    }
    return normalized;
  }

  // Merge the published party family into the already-normalized campaign
  // object. All or nothing: if any surface is missing or disagrees with the
  // certified point, the whole party family is refused and the page keeps the
  // coalition view exactly as it was.
  function mergeCampaignPartyFamily(raw, normalized, partyDefinitions, certifiedRaw) {
    var electionDayRaw = raw.election_day;
    if (!electionDayRaw || !Object.prototype.hasOwnProperty.call(electionDayRaw, "parties")) {
      return false;
    }
    var construction = raw.path_construction;
    if (!construction || construction.party_vote_share_denominator !== PARTY_VOTE_DENOMINATOR) {
      return false;
    }
    var rendering = raw.rendering;
    if (!rendering ||
        JSON.stringify(rendering.party_units) !== JSON.stringify(["vote"]) ||
        JSON.stringify(rendering.party_election_day_units) !== JSON.stringify(["vote", "seats"]) ||
        rendering.party_intermediate_seat_trajectory !== false ||
        historyNumber(rendering.national_threshold_pct) !== NATIONAL_THRESHOLD_PCT) {
      return false;
    }
    var electionParties = partySummaryGroups(electionDayRaw.parties, partyDefinitions);
    var certifiedParties = partySummaryGroups(certifiedRaw && certifiedRaw.parties, partyDefinitions);
    // The emphasized election-day party distribution must be the certified
    // production one, value for value. Anything else would mean the chart had
    // changed a published probability.
    if (!electionParties || !certifiedParties ||
        JSON.stringify(electionParties) !== JSON.stringify(certifiedParties)) return false;

    var bands = Array.isArray(raw.bands) ? raw.bands : [];
    if (bands.length !== normalized.bands.length) return false;
    var bandParties = [];
    for (var index = 0; index < bands.length; index += 1) {
      var parsed = campaignBandParties(bands[index] && bands[index].parties, partyDefinitions);
      if (!parsed) return false;
      bandParties.push(parsed);
    }

    var series = raw.paths && Array.isArray(raw.paths.series) ? raw.paths.series : [];
    if (series.length !== normalized.paths.length) return false;
    var pathParties = [];
    for (var track = 0; track < series.length; track += 1) {
      var values = series[track] && series[track].party_values;
      if (!values || typeof values !== "object") return false;
      var normalizedValues = {};
      var valid = partyDefinitions.every(function (definition) {
        var line = values[definition.id];
        if (!Array.isArray(line) || line.length !== normalized.bands.length) return false;
        if (!line.every(function (value) {
          return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
        })) return false;
        normalizedValues[definition.id] = line.slice();
        return true;
      });
      if (!valid) return false;
      pathParties.push(normalizedValues);
    }

    // Everything validated; commit into the shared definition namespace.
    normalized.bands.forEach(function (band, bandIndex) {
      partyDefinitions.forEach(function (definition) {
        band.groups[definition.id] = bandParties[bandIndex][definition.id];
      });
    });
    normalized.paths.forEach(function (track, trackIndex) {
      partyDefinitions.forEach(function (definition) {
        track.values[definition.id] = pathParties[trackIndex][definition.id];
      });
    });
    partyDefinitions.forEach(function (definition) {
      normalized.electionDay.groups[definition.id] = electionParties[definition.id];
    });
    return true;
  }

  function normalizeCampaignPaths(raw, payload, electionDate, definitions, partyDefinitions, points) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var origin = historyDate(raw.origin_date);
    var election = historyDate(raw.election_date);
    if (!origin || !election || election.iso !== electionDate.iso || origin.time >= election.time) return null;
    if (raw.projection_type !== CAMPAIGN_PATH_TYPE || raw.model_id !== CAMPAIGN_PATH_MODEL_ID ||
        raw.role !== CAMPAIGN_PATH_PRIMARY_ROLE || raw.quantity !== CAMPAIGN_PATH_QUANTITY ||
        raw.state_cutoff_date !== origin.iso || raw.future_measurements_known !== false ||
        typeof raw.tooltip_sv !== "string" || !raw.tooltip_sv.trim()) return null;
    var pathDays = Math.round((election.time - origin.time) / 86400000);
    if (raw.path_days !== pathDays) return null;
    if (!Number.isInteger(raw.samples) || raw.samples <= 0) return null;

    var construction = raw.path_construction;
    if (!construction || typeof construction !== "object" ||
        construction.space !== "clr" || construction.categories !== 9 ||
        construction.sign_policy !== "single_sign_per_whole_trajectory" ||
        construction.transition_pool !== "all_history_leakage_safe" ||
        construction.leakage_rule !== "trajectory_end_le_origin" ||
        construction.synthesized_future_polls !== false ||
        construction.daily_independent_random_walk !== false ||
        construction.directional_momentum !== false ||
        !Number.isInteger(construction.eligible_trajectories) || construction.eligible_trajectories < 30 ||
        !Number.isInteger(construction.endpoint_horizon_days) || construction.endpoint_horizon_days < 1 ||
        construction.origin_day_quantity !== CAMPAIGN_PATH_ORIGIN_QUANTITY ||
        ["identity", "monotone_stretch"].indexOf(construction.time_warp) === -1) return null;
    if (construction.time_warp === "identity" && construction.endpoint_horizon_days !== pathDays) return null;
    var latestEnd = historyDate(construction.latest_trajectory_end);
    if (!latestEnd || latestEnd.time > origin.time) return null;

    var parity = raw.endpoint_parity;
    if (!parity || typeof parity !== "object" ||
        parity.guarantee !== "bitwise_identical_to_production_election_day_draws" ||
        parity.election_day_summaries_source !== "certified_current_production_point" ||
        ["generate_national_vote_shares", "certified_production_result"]
          .indexOf(parity.reference) === -1) return null;
    if (parity.verified === true && parity.max_abs_vote_share_difference_pp !== 0) return null;

    var rawSeries = Array.isArray(payload.series) ? payload.series : [];
    var currentRaw = rawSeries.filter(function (point) {
      return point && point.provenance === "current_production";
    });
    if (currentRaw.length !== 1 || currentRaw[0].date !== origin.iso) return null;
    var anchorPoint = points.filter(function (point) {
      return point.date === origin.iso && point.provenance === "current_production";
    })[0];
    if (!anchorPoint) return null;

    var bands = Array.isArray(raw.bands) ? raw.bands : null;
    if (!bands || bands.length !== pathDays + 1) return null;
    var historicalDates = {};
    rawSeries.forEach(function (point) {
      if (point && typeof point.date === "string") historicalDates[point.date] = true;
    });
    var normalizedBands = [];
    for (var index = 0; index < bands.length; index += 1) {
      var band = bands[index];
      var expectedTime = origin.time + index * 86400000;
      var expectedDate = new Date(expectedTime).toISOString().slice(0, 10);
      var groups = band && campaignBandGroups(band.groups, definitions);
      if (!band || band.date !== expectedDate || band.path_day !== index || !groups) return null;
      // Day zero is the origin itself and legitimately shares that calendar
      // date with the certified historical point; every later day must not.
      if (index > 0 && historicalDates[band.date]) return null;
      normalizedBands.push({
        date: expectedDate,
        time: expectedTime,
        pathDay: index,
        groups: groups,
        provenance: CAMPAIGN_PATH_PRIMARY_ROLE,
        isFuture: index > 0,
        isCampaignBand: index > 0,
        isOriginState: index === 0
      });
    }

    var paths = raw.paths;
    if (!paths || typeof paths !== "object" || !Array.isArray(paths.series) || !paths.series.length) return null;
    if (paths.selection !== "evenly_spaced_draw_indices") return null;
    if (paths.count !== paths.series.length) return null;
    var indices = paths.sample_indices;
    if (!Array.isArray(indices) || indices.length !== paths.series.length) return null;
    var normalizedPaths = [];
    for (var track = 0; track < paths.series.length; track += 1) {
      var item = paths.series[track];
      if (!item || typeof item !== "object" || item.sample_index !== indices[track]) return null;
      if (!Number.isInteger(item.sample_index) || item.sample_index < 0 || item.sample_index >= raw.samples) return null;
      if (track > 0 && !(indices[track] > indices[track - 1])) return null;
      var values = item.values;
      if (!values || typeof values !== "object") return null;
      var normalizedValues = {};
      var validTrack = definitions.every(function (definition) {
        var line = values[definition.id];
        if (!Array.isArray(line) || line.length !== pathDays + 1) return false;
        if (!line.every(function (value) {
          return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
        })) return false;
        normalizedValues[definition.id] = line.slice();
        return true;
      });
      if (!validTrack) return null;
      normalizedPaths.push({ sampleIndex: item.sample_index, values: normalizedValues });
    }

    var electionDayRaw = raw.election_day;
    if (!electionDayRaw || typeof electionDayRaw !== "object" ||
        electionDayRaw.date !== election.iso ||
        electionDayRaw.includes_election_noise !== true ||
        electionDayRaw.includes_geography_and_mandates !== true ||
        electionDayRaw.provenance !== "current_production" ||
        typeof electionDayRaw.label_sv !== "string" || !electionDayRaw.label_sv.trim() ||
        typeof electionDayRaw.tooltip_sv !== "string" || !electionDayRaw.tooltip_sv.trim() ||
        electionDayRaw.samples !== currentRaw[0].samples) return null;
    var electionGroups = futureProjectionGroups(electionDayRaw.groups, definitions);
    var certifiedGroups = futureProjectionGroups(currentRaw[0].groups, definitions);
    // The emphasized election-day distribution must be the certified
    // production one, value for value.  Anything else would mean the
    // visualization had changed a published probability.
    if (!electionGroups || !certifiedGroups ||
        JSON.stringify(electionGroups) !== JSON.stringify(certifiedGroups)) return null;

    var rendering = raw.rendering;
    var region = rendering && rendering.future_region;
    if (!rendering || rendering.x_axis_max !== election.iso || !region ||
        region.start !== origin.iso || region.end !== election.iso ||
        region.background !== "light_distinct" ||
        typeof region.label !== "string" || !region.label.trim() ||
        typeof rendering.origin_boundary_label !== "string" || !rendering.origin_boundary_label.trim() ||
        typeof rendering.origin_state_label !== "string" || !rendering.origin_state_label.trim() ||
        typeof rendering.origin_state_tooltip_sv !== "string" ||
        !rendering.origin_state_tooltip_sv.trim() ||
        typeof rendering.election_day_label !== "string" || !rendering.election_day_label.trim() ||
        typeof rendering.election_day_distribution_label !== "string" ||
        !rendering.election_day_distribution_label.trim() ||
        typeof rendering.path_legend_label !== "string" || !rendering.path_legend_label.trim() ||
        typeof rendering.band_legend_label !== "string" || !rendering.band_legend_label.trim() ||
        JSON.stringify(rendering.interval_bands) !== JSON.stringify(["p25_p75", "p05_p95"]) ||
        JSON.stringify(rendering.path_units) !== JSON.stringify(["vote"]) ||
        JSON.stringify(rendering.election_day_units) !== JSON.stringify(["vote", "seats"]) ||
        rendering.median_may_be_flat !== true ||
        rendering.intermediate_seat_trajectory !== false ||
        rendering.poll_observations_in_future !== false ||
        rendering.poll_of_polls_observations_in_future !== false ||
        rendering.continues_from !== CAMPAIGN_PATH_CONTINUES_FROM) return null;

    var normalized = {
      origin: origin,
      election: election,
      pathDays: pathDays,
      samples: raw.samples,
      anchorPoint: anchorPoint,
      construction: construction,
      parity: parity,
      bands: normalizedBands,
      paths: normalizedPaths,
      electionDay: {
        date: election.iso,
        time: election.time,
        samples: electionDayRaw.samples,
        label: electionDayRaw.label_sv,
        tooltip: electionDayRaw.tooltip_sv,
        groups: electionGroups,
        provenance: "current_production",
        isFuture: true,
        isElectionDay: true
      },
      tooltip: raw.tooltip_sv,
      rendering: rendering
    };
    // The coalition object above is complete and correct on its own. The party
    // family is merged in afterwards precisely so that its failure cannot cost
    // the reader the coalition view.
    normalized.partyFamily = Boolean(partyDefinitions) &&
      mergeCampaignPartyFamily(raw, normalized, partyDefinitions, currentRaw[0]);
    normalized.partyFamilyDeclared = Boolean(raw.election_day &&
      Object.prototype.hasOwnProperty.call(raw.election_day, "parties"));
    return normalized;
  }

  function normalizeHistoryPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    var electionDate = historyDate(payload.election_date || payload.electionDate);
    if (!electionDate) return null;
    var definitions = historyDefinitions(payload);
    var partyView = historyPartyDefinitions(payload);
    var partyDefinitions = partyView ? partyView.definitions : null;
    // One flat definition namespace for the renderer; the two families keep
    // their own selectors, domains and copy.
    var allDefinitions = partyDefinitions ? definitions.concat(partyDefinitions) : definitions;
    var rawSeries = Array.isArray(payload.series) ? payload.series
      : (Array.isArray(payload.forecasts) ? payload.forecasts : []);
    var points = rawSeries.map(function (point) {
      return historyPoint(point, electionDate.iso, allDefinitions);
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
    // Archived prospective forecasts are kept in the payload but are not
    // charted: they belong to whichever model was current on their date, not
    // to the reconstructed curve, and an undrawn mark must not stay a pointer
    // or keyboard target.
    var archived = points.filter(function (point) {
      return point.provenance === "prospective_archived";
    });
    points = points.filter(function (point) {
      return point.provenance !== "prospective_archived";
    });
    if (!points.length) return null;
    var rawPop = Array.isArray(payload.poll_of_polls) ? payload.poll_of_polls
      : (Array.isArray(payload.pollofpolls) ? payload.pollofpolls : []);
    var pop = rawPop.map(function (item) {
      return historyPopPoint(item, allDefinitions);
    }).filter(function (item) { return item !== null; }).sort(function (a, b) {
      return a.time - b.time;
    });
    var rawPolls = Array.isArray(payload.polls) ? payload.polls
      : (Array.isArray(payload.poll_points) ? payload.poll_points : []);
    var polls = rawPolls.map(function (poll) {
      return historyPoll(poll, allDefinitions);
    }).filter(function (poll) { return poll !== null; }).sort(function (a, b) {
      return a.time - b.time;
    });
    var futureProjectionPresent = Object.prototype.hasOwnProperty.call(payload, "future_projection");
    var futureProjection = futureProjectionPresent
      ? normalizeFutureProjection(payload.future_projection, payload, electionDate, definitions, points)
      : null;
    var campaignPathsPresent = Object.prototype.hasOwnProperty.call(payload, "future_campaign_paths");
    var campaignPaths = campaignPathsPresent
      ? normalizeCampaignPaths(payload.future_campaign_paths, payload, electionDate, definitions,
        partyDefinitions, points)
      : null;
    // The shrinking-horizon fan is a secondary analytical view once the
    // campaign-path model is published, and it must say so itself.
    var secondaryProjection = payload.future_projection &&
      payload.future_projection.role === CAMPAIGN_PATH_SECONDARY_ROLE &&
      payload.future_projection.primary === false &&
      typeof payload.future_projection.description_sv === "string" &&
      payload.future_projection.description_sv.trim()
      ? payload.future_projection.description_sv : null;
    // Party mode is offered only when every surface it needs is present and
    // agrees. A published campaign region whose party family failed to
    // validate disables party mode outright rather than letting the chart mix
    // a party history with a coalition future.
    var pointsWithParties = partyDefinitions ? points.filter(function (point) {
      return partyDefinitions.every(function (definition) {
        return point.groups && point.groups[definition.id];
      });
    }) : [];
    var certifiedPoints = pointsWithParties.filter(function (point) {
      return point.provenance === "current_production";
    });
    var partyModeAvailable = Boolean(partyDefinitions) && pointsWithParties.length > 0 &&
      certifiedPoints.length > 0 &&
      (!campaignPaths || campaignPaths.partyFamily === true);

    return {
      partyView: partyModeAvailable ? partyView : null,
      partyDefinitions: partyModeAvailable ? partyDefinitions : null,
      partyDefinitionsDeclared: Boolean(payload.parties_view),
      partyPointCount: pointsWithParties.length,
      campaignPaths: campaignPaths,
      campaignPathsPresent: campaignPathsPresent,
      secondaryProjectionDescription: secondaryProjection,
      schemaVersion: String(payload.schema_version || "1.1"),
      electionDate: electionDate.iso,
      modelCommit: payload.model_commit || payload.model_revision || null,
      pollSourceSha256: payload.poll_source_sha256 || null,
      definitions: definitions,
      points: points,
      archivedPoints: archived,
      pop: pop,
      polls: polls,
      futureProjection: futureProjection,
      futureProjectionPresent: futureProjectionPresent
    };
  }

  function historyProvenanceLabel(value) {
    if (value === "current_production") {
      return "Officiell aktuell valprognos";
    }
    if (value === "prospective_archived") {
      return "Prospektiv arkiverad prognos";
    }
    if (value === "reconstructed_current_model") {
      return "Rekonstruerad med dagens modell";
    }
    return String(value || "Okänt ursprung").replace(/_/g, " ");
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
    // the detail panel's exact seat count.
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

  // The publication contains a broad, deterministic draw sample.  The chart
  // keeps a small evenly spaced subset visible so the individual movement is
  // legible without turning the fan into a dark block.  The complete sample
  // remains available to the normalized publication and to the uncertainty
  // bands; this is a presentation-only choice.
  var CAMPAIGN_VISIBLE_PATH_COUNT = 8;
  function representativeCampaignPaths(paths) {
    if (!Array.isArray(paths) || paths.length <= CAMPAIGN_VISIBLE_PATH_COUNT) return paths || [];
    var selected = [];
    var count = CAMPAIGN_VISIBLE_PATH_COUNT;
    for (var index = 0; index < count; index += 1) {
      var sourceIndex = Math.round(index * (paths.length - 1) / (count - 1));
      selected.push(paths[sourceIndex]);
    }
    return selected;
  }

  function historyAxisTicks(minTime, maxTime) {
    var ticks = [];
    var firstYear = new Date(minTime).getUTCFullYear();
    var lastYear = new Date(maxTime).getUTCFullYear();
    var seenYears = {};
    for (var year = firstYear; year <= lastYear; year += 1) {
      var yearStart = Date.parse(String(year) + "-01-01T00:00:00Z");
      var time = year === firstYear ? minTime : Math.max(minTime, yearStart);
      if (time > maxTime) continue;
      if (seenYears[year]) continue;
      seenYears[year] = true;
      ticks.push({
        time: time,
        iso: new Date(time).toISOString().slice(0, 10),
        label: String(year)
      });
    }
    // Very short histories can fall within a single year.  Keep the axis
    // useful without manufacturing duplicate year labels.
    if (!ticks.length) {
      var fallbackIso = new Date(minTime).toISOString().slice(0, 10);
      ticks.push({ time: minTime, iso: fallbackIso, label: String(firstYear) });
    }
    return ticks;
  }

  // A tick ladder that keeps every domain readable, from a 0.6 pp party window
  // to a 60 pp coalition span, without inventing a fixed zoom level.
  var HISTORY_TICK_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];
  function historyTickStep(span) {
    for (var index = 0; index < HISTORY_TICK_STEPS.length; index += 1) {
      if (span / HISTORY_TICK_STEPS[index] <= 8) return HISTORY_TICK_STEPS[index];
    }
    return HISTORY_TICK_STEPS[HISTORY_TICK_STEPS.length - 1];
  }

  function historyTickDigits(step) {
    if (step >= 1) return 0;
    var fraction = String(step).split(".")[1] || "";
    return fraction.length;
  }

  // Snap a raw data-driven domain onto its own tick ladder, so the axis labels
  // are round numbers and the ribbons still clear the frame.
  function historySnapToTicks(lower, upper, minimumSpan) {
    var span = Math.max(minimumSpan, upper - lower);
    if (upper - lower < minimumSpan) {
      var midpoint = (lower + upper) / 2;
      lower = midpoint - minimumSpan / 2;
      upper = midpoint + minimumSpan / 2;
    }
    var step = historyTickStep(span);
    var snappedLower = Math.max(0, Math.floor(lower / step) * step);
    var snappedUpper = Math.min(100, Math.ceil(upper / step) * step);
    if (snappedUpper - snappedLower < minimumSpan) {
      snappedUpper = Math.min(100, snappedLower + Math.ceil(minimumSpan / step) * step);
      if (snappedUpper - snappedLower < minimumSpan) {
        snappedLower = Math.max(0, snappedUpper - Math.ceil(minimumSpan / step) * step);
      }
    }
    step = historyTickStep(snappedUpper - snappedLower);
    // Re-snap once against the final step so the first gridline is a round
    // number rather than the raw minimum.
    snappedLower = Math.max(0, Math.floor(snappedLower / step) * step);
    snappedUpper = Math.min(100, Math.ceil(snappedUpper / step) * step);
    return {
      min: Number(snappedLower.toFixed(4)),
      max: Number(snappedUpper.toFixed(4)),
      step: step,
      digits: historyTickDigits(step)
    };
  }

  // A party moves far less than a coalition, so its domain is derived purely
  // from what is on screen. Two coalition-specific anchors are deliberately
  // absent: the 50 % vote line, which means nothing to a single party, and the
  // 20 pp minimum span, which would flatten a real 0.4 pp campaign move into a
  // horizontal line.
  function historyPartyValueDomain(values, metric, range, thresholdPct) {
    if (!values.length) {
      return historySnapToTicks(0, metric === "seats" ? 20 : 10, metric === "seats" ? 5 : 3);
    }
    var lower = Math.min.apply(Math, values);
    var upper = Math.max.apply(Math, values);
    var dataSpan = Math.max(0, upper - lower);
    var padding;
    var minimumSpan;
    if (metric === "seats") {
      padding = Math.max(0.5, Math.min(3, dataSpan * 0.08));
      minimumSpan = 3;
    } else if (range === "short") {
      // The election-relative window is where sub-percentage-point movement
      // has to be legible. The padding is proportional so a flat party is not
      // magnified into false drama, and the floor only prevents a hairline.
      padding = Math.max(0.15, Math.min(1, dataSpan * 0.1));
      minimumSpan = 1;
    } else {
      padding = Math.max(0.4, Math.min(2, dataSpan * 0.08));
      minimumSpan = 3;
    }
    var domain = historySnapToTicks(
      Math.max(0, lower - padding), Math.min(100, upper + padding), minimumSpan
    );
    domain.thresholdVisible = false;
    if (metric === "vote" && Number.isFinite(thresholdPct)) {
      // Strictly inside, by half a tick. A line drawn on the frame coincides
      // with the axis, which already labels that value, so it would add ink
      // without adding information -- and widening the domain to lift it off
      // the frame would be distorting the scale to include it.
      var margin = domain.step / 2;
      if (thresholdPct >= domain.min + margin && thresholdPct <= domain.max - margin) {
        domain.thresholdVisible = true;
      } else if (thresholdPct >= domain.min && thresholdPct <= domain.max) {
        domain.thresholdVisible = false;
      } else {
        // The threshold is drawn when it is genuinely near what is on screen.
        // A party fighting for its survival has a band that reaches towards
        // the line, so the reach needed is small; a party at 30 % never comes
        // close and the scale is left alone rather than being stretched down
        // to a line that carries no information for it.
        var reach = Math.max(0.25, dataSpan * 0.15);
        if (thresholdPct > domain.max && thresholdPct - domain.max <= reach) {
          domain = historySnapToTicks(domain.min, thresholdPct + padding / 2, minimumSpan);
          domain.thresholdVisible = true;
        } else if (thresholdPct < domain.min && domain.min - thresholdPct <= reach) {
          domain = historySnapToTicks(Math.max(0, thresholdPct - padding / 2), domain.max, minimumSpan);
          domain.thresholdVisible = true;
        }
      }
    }
    return domain;
  }

  function historyValueDomain(history, metric, definitions, domain) {
    var values = [];
    var inDomain = function (point) {
      return point && (!domain || (point.time >= domain.minTime && point.time <= domain.maxTime));
    };
    var futureOrigin = history.campaignPaths ? history.campaignPaths.origin
      : (history.futureProjection ? history.futureProjection.origin : null);
    var inHistoricalDomain = function (point) {
      return inDomain(point) && (!futureOrigin || point.time <= futureOrigin.time);
    };
    // One renderer owns both regions, so the y-scale must cover whichever
    // future view is on screen as well as the historical series.
    var futureView = domain && domain.futureView ? domain.futureView : "paths";
    // Mandatandel always uses the campaign-path container only as the
    // election-day distribution host. The opinion fan and its paths remain
    // vote-only, even if the secondary view was selected beforehand.
    var showPaths = Boolean(history.campaignPaths) &&
      (futureView === "paths" || metric === "seats");
    var tightCampaignWindow = Boolean(domain && domain.range === "short" && showPaths && metric === "vote");
    var projectionPoints = history.futureProjection && !showPaths && metric === "vote"
      ? history.futureProjection.points.filter(inDomain) : [];
    var bandPoints = showPaths && metric === "vote"
      ? history.campaignPaths.bands.filter(inDomain) : [];
    var electionDayPoints = showPaths && inDomain(history.campaignPaths.electionDay)
      ? [history.campaignPaths.electionDay] : [];
    definitions.forEach(function (definition) {
      history.points.filter(inDomain).forEach(function (point) {
        var group = point.groups && point.groups[definition.id];
        var low = historyMetricValue(group, metric, "p05");
        var high = historyMetricValue(group, metric, "p95");
        if (low !== null) values.push(low);
        if (high !== null) values.push(high);
      });
      projectionPoints.concat(bandPoints).concat(electionDayPoints).forEach(function (point) {
        var group = point.groups && point.groups[definition.id];
        var low = historyMetricValue(group, metric, "p05");
        var high = historyMetricValue(group, metric, "p95");
        if (low !== null) values.push(low);
        if (high !== null) values.push(high);
      });
      // Individual rendered trajectories must not be clipped by the frame.
      if (showPaths && metric === "vote") {
        representativeCampaignPaths(history.campaignPaths.paths).forEach(function (track) {
          var line = track.values[definition.id];
          if (!line) return;
          history.campaignPaths.bands.forEach(function (band, index) {
            if (!inDomain(band)) return;
            var value = historyNumber(line[index]);
            if (value !== null) values.push(value);
          });
        });
      }
    });
    var partyMode = Boolean(domain && domain.viewMode === "parties");
    if (metric === "vote") {
      // Individual measurements are drawn beside the series. In party mode
      // they are part of the domain in *both* ranges: a single party's poll
      // cloud is wide relative to its own forecast band, and clipping it would
      // hide exactly the disagreement the dots are there to show.
      if (domain && (partyMode || domain.range === "short") && history.polls && history.polls.length) {
        history.polls.filter(inHistoricalDomain).forEach(function (item) {
          definitions.forEach(function (definition) {
            var value = item.values && historyNumber(item.values[definition.id]);
            if (value !== null) values.push(value);
          });
        });
      }
    }
    if (partyMode) {
      return historyPartyValueDomain(values, metric, domain && domain.range,
        history.partyView ? history.partyView.thresholdPct : NATIONAL_THRESHOLD_PCT);
    }
    var lower = values.length ? Math.min.apply(Math, values) : 0;
    var upper = values.length ? Math.max.apply(Math, values) : (metric === "seats" ? 100 : 50);
    // The election-relative campaign window gets a data-driven scale.  It is
    // deliberately based on the selected series, visible representative
    // trajectories, their 90% bands, in-range observations, and the
    // election-day distribution.  A small proportional pad keeps the ink off
    // the frame without introducing a fixed visual zoom.
    if (tightCampaignWindow) {
      var dataSpan = Math.max(0, upper - lower);
      var campaignPadding = dataSpan > 0
        ? Math.max(0.4, Math.min(1.25, dataSpan * 0.08)) : 0.5;
      lower = Math.max(0, Math.floor((lower - campaignPadding) * 2) / 2);
      upper = Math.min(100, Math.ceil((upper + campaignPadding) * 2) / 2);
      // A single selected coalition can have a very narrow visible envelope.
      // Four percentage points is only a guard against a hairline plot; the
      // actual values still determine the centre and both domain edges.
      var minimumCampaignSpan = 4;
      if (upper - lower < minimumCampaignSpan) {
        var campaignMidpoint = (lower + upper) / 2;
        lower = Math.max(0, Math.floor((campaignMidpoint - minimumCampaignSpan / 2) * 2) / 2);
        upper = Math.min(100, Math.ceil((campaignMidpoint + minimumCampaignSpan / 2) * 2) / 2);
        if (upper - lower < minimumCampaignSpan) {
          if (lower === 0) upper = Math.min(100, lower + minimumCampaignSpan);
          else lower = Math.max(0, upper - minimumCampaignSpan);
        }
      }
      return {
        min: lower, max: upper,
        step: (upper - lower) <= 14 ? 2 : 5,
        digits: (upper - lower) <= 14 ? 1 : 0,
        thresholdVisible: false
      };
    }
    var anchor = metric === "seats" ? 100 * MAJORITY / CHAMBER : 50;
    // A small amount of breathing room prevents the uncertainty ribbons from
    // touching the frame.  Rounding at the end gives stable five-point ticks.
    lower = Math.floor((lower - 2) / 5) * 5;
    upper = Math.ceil((upper + 2) / 5) * 5;
    lower = Math.min(lower, anchor);
    upper = Math.max(upper, anchor);
    var minimumSpan = 20;
    if (upper - lower < minimumSpan) {
      var midpoint = (lower + upper) / 2;
      lower = Math.floor((midpoint - minimumSpan / 2) / 5) * 5;
      upper = Math.ceil((midpoint + minimumSpan / 2) / 5) * 5;
      lower = Math.min(lower, anchor);
      upper = Math.max(upper, anchor);
    }
    // All published vote and seat-share values are percentages.  Clamp only
    // the padded frame, never the observations themselves, so bands cannot be
    // clipped at a scale boundary.
    lower = Math.max(0, lower);
    upper = Math.min(100, upper);
    if (upper - lower < minimumSpan) {
      if (lower === 0) upper = Math.min(100, lower + minimumSpan);
      else lower = Math.max(0, upper - minimumSpan);
    }
    return {
      min: lower, max: upper,
      step: (upper - lower) <= 40 ? 5 : 10,
      digits: 0,
      thresholdVisible: false
    };
  }

  function renderForecastHistory(payload) {
    var section = byId("election-timeseries");
    var svg = byId("election-timeseries-svg");
    if (!section || !svg) return false;
    var history = normalizeHistoryPayload(payload);
    if (!history) return false;
    var projection = history.futureProjection;
    var campaignPaths = history.campaignPaths;
    if (history.futureProjectionPresent && !projection) {
      section.setAttribute("data-future-projection", "invalid");
    } else if (projection) {
      section.setAttribute("data-future-projection", projection.points.length ? "true" : "empty");
      section.setAttribute("data-future-projection-point-count", String(projection.points.length));
    } else {
      section.removeAttribute("data-future-projection");
      section.removeAttribute("data-future-projection-point-count");
    }
    if (history.campaignPathsPresent && !campaignPaths) {
      section.setAttribute("data-campaign-paths", "invalid");
      section.removeAttribute("data-campaign-path-count");
      section.removeAttribute("data-campaign-path-days");
    } else if (campaignPaths) {
      section.setAttribute("data-campaign-paths", "true");
      section.setAttribute("data-campaign-path-count", String(campaignPaths.paths.length));
      section.setAttribute("data-campaign-path-days", String(campaignPaths.pathDays));
      section.setAttribute("data-campaign-path-warp", String(campaignPaths.construction.time_warp));
    } else {
      section.removeAttribute("data-campaign-paths");
      section.removeAttribute("data-campaign-path-count");
      section.removeAttribute("data-campaign-path-days");
      section.removeAttribute("data-campaign-path-warp");
    }
    // The primary future region is the campaign-path model whenever it is
    // published and valid.  The shrinking-horizon fan is reachable only
    // through the explicit secondary control.
    var futureView = campaignPaths ? "paths" : "projection";
    var futureOrigin = campaignPaths ? campaignPaths.origin : (projection ? projection.origin : null);
    var futureElection = campaignPaths ? campaignPaths.election : (projection ? projection.election : null);
    function pathsActive() {
      return Boolean(campaignPaths) && (futureView === "paths" || selectedMetric === "seats");
    }
    function projectionActive() {
      return Boolean(projection) && projection.points.length > 0 && !pathsActive();
    }

    var liveStatus = byId("election-timeseries-status");
    var detailBody = byId("election-timeseries-detail-body");
    var seatNote = byId("election-timeseries-seat-note");
    var modeVote = byId("election-timeseries-vote");
    var modeSeats = byId("election-timeseries-seats");
    var rangeFull = byId("election-timeseries-range-full");
    var rangeShort = byId("election-timeseries-range-short");
    var campaignCue = byId("election-timeseries-campaign-cue");
    var futureViewHost = byId("election-timeseries-future");
    var futureViewPaths = byId("election-timeseries-future-paths");
    var futureViewStability = byId("election-timeseries-future-stability");
    var coalitionHost = byId("election-timeseries-coalitions");
    var partyHost = byId("election-timeseries-parties");
    var viewHost = byId("election-timeseries-view");
    var viewCoalitions = byId("election-timeseries-view-coalitions");
    var viewParties = byId("election-timeseries-view-parties");
    var partyNote = byId("election-timeseries-party-note");
    var partyDefinitions = history.partyDefinitions;
    var partyModeAvailable = Boolean(partyDefinitions && partyDefinitions.length);
    // Koalitioner stays the default and the coalition experience is unchanged.
    var viewMode = "coalitions";
    var selectedPartyId = null;
    var partyButtons = {};
    var selectedMetric = "vote";
    // "Sedan 2022" stays the opening range.  A published campaign-path region
    // is only a few pixels wide at that scale, but the fix for that is
    // discoverability -- the "Visa kampanjperioden" cue below -- not silently
    // changing which view the page opens on.
    var selectedRange = "full";
    var selected = {};
    var selectedDate = null;
    var selectedPoint = null;
    var pinnedSelection = false;
    var renderSelection = function () {};
    var renderDetail = function () {};
    var keyboardSelect = function () {};
    var activeDomain = null;
    var compactChart = Boolean(window.matchMedia && window.matchMedia("(max-width: 46em)").matches);
    var width = compactChart ? 600 : 960;
    var height = compactChart ? 500 : 430;
    // Keep a quiet right-hand gutter for the current-value labels.  The
    // generous top/bottom margins also make the chart read like the site's
    // histogram sections rather than a boxed dashboard widget.
    var plot = compactChart
      ? { left: 62, right: 520, top: 50, bottom: 415 }
      : { left: 72, right: 880, top: 40, bottom: 360 };
    plot.width = plot.right - plot.left;
    plot.height = plot.bottom - plot.top;
    var electionDate = historyDate(history.electionDate);
    var shortRangeStart = historyDateOffset(history.electionDate, -30);
    history.definitions.forEach(function (definition) {
      selected[definition.id] = Boolean(definition.defaultOn);
    });

    function activeTimeDomain() {
      var shortRangeEnd = electionDate;
      var useShortRange = selectedRange === "short" && shortRangeStart && shortRangeEnd;
      // Sedan 2022 keeps the metric-specific published extent: vote share
      // includes the historical series and the individual polls drawn beside
      // it; seat share has no individual-poll values, so its extent is the
      // series alone.  The future region always extends the right edge
      // through election day.
      var fullTimes = history.points.map(function (point) { return point.time; });
      if (selectedMetric === "vote" && history.polls && history.polls.length) {
        history.polls.forEach(function (item) { fullTimes.push(item.time); });
      }
      if (futureElection) fullTimes.push(futureElection.time);
      var fullMinTime = Math.min.apply(Math, fullTimes);
      var fullMaxTime = futureElection ? futureElection.time : Math.max.apply(Math, fullTimes);
      if (!Number.isFinite(fullMinTime)) fullMinTime = history.points[0].time;
      if (!Number.isFinite(fullMaxTime)) fullMaxTime = history.points[history.points.length - 1].time;
      var minTime = useShortRange ? shortRangeStart.time : fullMinTime;
      var maxTime = useShortRange ? shortRangeEnd.time : fullMaxTime;
      if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) return null;
      if (maxTime <= minTime) maxTime = minTime + 86400000;
      return {
        minTime: minTime,
        maxTime: maxTime,
        minIso: new Date(minTime).toISOString().slice(0, 10),
        maxIso: new Date(maxTime).toISOString().slice(0, 10),
        range: selectedRange,
        futureView: futureView,
        viewMode: viewMode
      };
    }

    // One party at a time. Eight simultaneous party series would be an
    // unreadable tangle, and the page already has a small-multiples view of
    // all eight in "Röstandelar på valdagen".
    function activePartyDefinition() {
      if (!partyModeAvailable) return null;
      var match = partyDefinitions.filter(function (definition) {
        return definition.id === selectedPartyId;
      });
      return match.length ? match[0] : partyDefinitions[0];
    }

    function activeDefinitions() {
      if (viewMode === "parties") {
        var definition = activePartyDefinition();
        return definition ? [definition] : [];
      }
      return history.definitions.filter(function (definition) {
        return selected[definition.id];
      });
    }

    function pointInActiveDomain(point) {
      return Boolean(point && activeDomain && point.time >= activeDomain.minTime &&
        point.time <= activeDomain.maxTime);
    }

    function setRangeButtons() {
      if (rangeFull) rangeFull.setAttribute("aria-pressed", selectedRange === "full" ? "true" : "false");
      if (rangeShort) rangeShort.setAttribute("aria-pressed", selectedRange === "short" ? "true" : "false");
    }

    function setCampaignCue() {
      // The campaign region is a few pixels wide on the four-year scale.  The
      // opening range stays "Sedan 2022"; this is the cue that the
      // election-relative window exists, and it retires once you are in it.
      if (!campaignCue) return;
      campaignCue.hidden = !(campaignPaths && selectedRange !== "short");
    }

    function setFutureViewButtons() {
      // The control only makes sense when both views exist.  A publication
      // without campaign paths keeps exactly the previous behaviour.
      //
      // Party mode deliberately has one future interpretation -- campaign
      // opinion paths meeting the election-day forecast -- so the secondary
      // "Kvarvarande osäkerhet" fan is not offered there. The simulator does
      // not publish a party version of it either, so offering the control
      // would promise a view that has no data behind it.
      var available = Boolean(campaignPaths) && Boolean(projection) && projection.points.length > 0;
      if (futureViewHost) {
        futureViewHost.hidden = !available || selectedMetric === "seats" || viewMode === "parties";
      }
      if (futureViewPaths) {
        futureViewPaths.setAttribute("aria-pressed", futureView === "paths" ? "true" : "false");
        if (campaignPaths) futureViewPaths.setAttribute("aria-label", campaignPaths.rendering.future_region.label);
      }
      if (futureViewStability) {
        futureViewStability.setAttribute("aria-pressed", futureView === "projection" ? "true" : "false");
      }
      section.setAttribute("data-future-view", pathsActive() ? "campaign_paths"
        : (projectionActive() ? "conditional_projection" : "none"));
    }

    function setModeButtons() {
      if (modeVote) modeVote.setAttribute("aria-pressed", selectedMetric === "vote" ? "true" : "false");
      if (modeSeats) modeSeats.setAttribute("aria-pressed", selectedMetric === "seats" ? "true" : "false");
      if (seatNote) seatNote.hidden = selectedMetric !== "seats";
      var pollsKey = byId("election-timeseries-key-polls");
      if (pollsKey) pollsKey.hidden = selectedMetric !== "vote";
      // Only the active view's legend keys and disclosure are shown.  Both
      // remain in the DOM so assistive technology and contract tests can see
      // that the published copy is the copy the chart uses.
      var paths = pathsActive();
      [["election-timeseries-key-campaign-paths", paths && selectedMetric === "vote"],
        ["election-timeseries-key-election-day", paths],
        ["election-timeseries-campaign-note", paths && selectedMetric === "vote"],
        ["election-timeseries-key-projection", projectionActive() && selectedMetric === "vote"],
        ["election-timeseries-projection-note", projectionActive()]
      ].forEach(function (entry) {
        var element = byId(entry[0]);
        if (element) element.hidden = !entry[1];
      });
      setRangeButtons();
      setFutureViewButtons();
      setCampaignCue();
      setViewButtons();
    }

    function setViewButtons() {
      var parties = viewMode === "parties";
      if (viewHost) viewHost.hidden = !partyModeAvailable;
      if (viewCoalitions) viewCoalitions.setAttribute("aria-pressed", parties ? "false" : "true");
      if (viewParties) {
        viewParties.setAttribute("aria-pressed", parties ? "true" : "false");
        viewParties.disabled = !partyModeAvailable;
      }
      if (coalitionHost) coalitionHost.hidden = parties;
      if (partyHost) partyHost.hidden = !parties;
      // Party mode's one standing note. It exists because the switch changes
      // what the y-axis measures -- a party share has a different denominator
      // from a coalition share -- and nothing else on the page says so at the
      // moment the reader makes that switch. It is not a return of the
      // methodology paragraphs the page deliberately retired: those describe
      // the model, this describes the scale currently on screen.
      if (partyNote) partyNote.hidden = !parties;
      section.setAttribute("data-view-mode", viewMode);
      section.setAttribute("data-party-view", partyModeAvailable ? "available" : "unavailable");
      if (parties) {
        var definition = activePartyDefinition();
        section.setAttribute("data-selected-party", definition ? definition.id : "");
      } else {
        section.removeAttribute("data-selected-party");
      }
    }

    function setPartyButtons() {
      var current = activePartyDefinition();
      Object.keys(partyButtons).forEach(function (id) {
        var button = partyButtons[id];
        var active = Boolean(current) && current.id === id;
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.className = "election-timeseries__coalition election-timeseries__coalition-button" +
          " election-timeseries__party-button" + (active ? " is-active" : "");
      });
    }

    // Selecting a party never clears the selection: the chart always has
    // exactly one party on screen in party mode.
    function selectTimeseriesParty(id, options) {
      if (!partyModeAvailable) return false;
      var match = partyDefinitions.filter(function (definition) { return definition.id === id; });
      if (!match.length) return false;
      selectedPartyId = match[0].id;
      setPartyButtons();
      if (!options || options.render !== false) renderChart();
      return true;
    }

    function dateForEvent(event) {
      if (!event || !svg || !svg.getBoundingClientRect) return null;
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return null;
      var clientX = event.clientX;
      if (!Number.isFinite(clientX) && event.touches && event.touches.length) {
        clientX = event.touches[0].clientX;
      }
      if (!Number.isFinite(clientX) && event.changedTouches && event.changedTouches.length) {
        clientX = event.changedTouches[0].clientX;
      }
      if (!Number.isFinite(clientX)) return null;
      // SVG coordinates include the left plot margin.  Mapping the entire
      // element would make a pointer on the first plotted date resolve several
      // percent into the series.
      var svgX = (clientX - rect.left) * width / rect.width;
      var ratio = Math.max(0, Math.min(1, (svgX - plot.left) / plot.width));
      if (!activeDomain) return null;
      return activeDomain.minTime + (activeDomain.maxTime - activeDomain.minTime) * ratio;
    }

    // Which future marks a pointer or the keyboard may land on.  Opinion
    // bands carry no seat distribution, so they are selectable in the vote
    // view only; the election-day distribution is selectable in both.
    function selectableFuturePoints() {
      if (pathsActive()) {
        // Opinion bands and the origin state carry no seat distribution, so
        // they are selectable in the vote view only.
        var marks = selectedMetric === "vote" ? campaignPaths.bands : [];
        return marks.concat([campaignPaths.electionDay]);
      }
      return projectionActive() && selectedMetric === "vote" ? projection.points : [];
    }

    function nearestPoint(time, direction) {
      var candidates = history.points.concat(selectableFuturePoints()).filter(function (point) {
        if (!pointInActiveDomain(point)) return false;
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

    function defaultVisiblePoint() {
      var candidates = history.points.concat(selectableFuturePoints()).filter(function (point) {
        return pointInActiveDomain(point) && activeDefinitions().some(function (definition) {
          return point.groups && point.groups[definition.id] && point.groups[definition.id][selectedMetric];
        });
      }).sort(function (left, right) { return left.time - right.time; });
      if (!candidates.length) return null;
      var current = candidates.filter(function (point) {
        return point.provenance === "current_production";
      });
      return current.length ? current[current.length - 1] : candidates[candidates.length - 1];
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

    function seatRangeText(group, low, high) {
      var seats = group && group.seats;
      var lower = seats && historyNumber(seats[low]);
      var upper = seats && historyNumber(seats[high]);
      return lower !== null && upper !== null
        ? grouped(lower) + EN_DASH + grouped(upper) + NBSP + "mandat" : "—";
    }

    function seatMedianText(group) {
      var seats = group && group.seats;
      var median = seats && historyNumber(seats.p50);
      return median === null ? "—" : grouped(median) + NBSP + "mandat";
    }

    function forecastDetail(point) {
      if (!point) return "";
      var popPoint = selectedMetric === "vote" ? findPopForDate(point.date) : null;
      var rows = activeDefinitions().map(function (definition) {
        var group = point.groups && point.groups[definition.id];
        var values = historyDisplayQuantiles(group, selectedMetric);
        if (!values) return "";
        var popValue = popPoint && popPoint.values && popPoint.values[definition.id] !== undefined
          ? popPoint.values[definition.id] : null;
        return "<section class=\"election-timeseries__detail-group\" data-coalition=\"" +
          escapeHtml(definition.id) + "\"><h4>" + escapeHtml(definition.label) + "</h4><dl>" +
          (selectedMetric === "vote" && popValue !== null
            ? "<dt>Poll of Polls</dt><dd>" + escapeHtml(percent(popValue, 1)) + "</dd>" : "") +
          "<dt>Vår simulering</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatMedianText(group) : percent(values.p50, 1)) + "</dd>" +
          "<dt>50 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatRangeText(group, "p25", "p75") : rangeTextFor(values, "p25", "p75")) + "</dd>" +
          "<dt>90 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatRangeText(group, "p05", "p95") : rangeTextFor(values, "p05", "p95")) + "</dd>" +
          "</dl></section>";
      }).filter(function (row) { return row; });
      return "<h3 class=\"election-timeseries__detail-date\">" +
        escapeHtml(swedishDate(point.date) || point.date) + "</h3>" +
        "<div class=\"election-timeseries__detail-groups\">" + rows.join("") + "</div>" +
        "<dl class=\"election-timeseries__detail-meta\">" +
        "<div><dt>Simuleringar</dt><dd>" + escapeHtml(historyDaysText(point.samples)) + "</dd></div>" +
        "<div><dt>Ursprung</dt><dd>" + escapeHtml(historyProvenanceLabel(point.provenance)) + "</dd></div>" +
        "<div><dt>Horisont</dt><dd>" + escapeHtml(historyDaysText(point.horizonDays)) +
        " dagar · rörelsedel " + escapeHtml(historyDaysText(point.dynamicsHorizonDays)) + " dagar</dd></div>" +
        "</dl>";
    }

    function futureDetail(point) {
      if (!point || !projection) return "";
      var rows = activeDefinitions().map(function (definition) {
        var group = point.groups && point.groups[definition.id];
        var values = historyDisplayQuantiles(group, selectedMetric);
        if (!values) return "";
        return "<section class=\"election-timeseries__detail-group\" data-coalition=\"" +
          escapeHtml(definition.id) + "\"><h4>" + escapeHtml(definition.label) + "</h4><dl>" +
          "<dt>" + escapeHtml(projection.rendering.legend_label) + "</dt><dd>" +
          escapeHtml(selectedMetric === "seats" ? seatMedianText(group) : percent(values.p50, 1)) + "</dd>" +
          "<dt>50 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatRangeText(group, "p25", "p75") : rangeTextFor(values, "p25", "p75")) + "</dd>" +
          "<dt>90 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatRangeText(group, "p05", "p95") : rangeTextFor(values, "p05", "p95")) + "</dd>" +
          "</dl></section>";
      }).filter(function (row) { return row; });
      return "<h3 class=\"election-timeseries__detail-date\">" +
        escapeHtml(swedishDate(point.date) || point.date) + "</h3>" +
        "<div class=\"election-timeseries__detail-groups\">" + rows.join("") + "</div>" +
        "<dl class=\"election-timeseries__detail-meta\">" +
        "<div><dt>Simuleringar</dt><dd>" + escapeHtml(historyDaysText(point.samples)) + "</dd></div>" +
        "<div><dt>Ursprung</dt><dd>" + escapeHtml(projection.rendering.legend_label) + "</dd></div>" +
        "<div><dt>Rörelsedel</dt><dd>" + escapeHtml(historyDaysText(point.remainingHorizonDays)) +
        " dagar kvar</dd></div></dl>" +
        "<p class=\"election-timeseries__note election-muted\">" + escapeHtml(projection.tooltip) + "</p>";
    }

    function originStateDetail(point) {
      if (!point || !campaignPaths) return "";
      var rows = activeDefinitions().map(function (definition) {
        var values = historyDisplayQuantiles(point.groups && point.groups[definition.id], "vote");
        if (!values) return "";
        return "<section class=\"election-timeseries__detail-group\" data-coalition=\"" +
          escapeHtml(definition.id) + "\"><h4>" + escapeHtml(definition.label) + "</h4><dl>" +
          "<dt>Opinionsläge</dt><dd>" + escapeHtml(percent(values.p50, 1)) + "</dd>" +
          "<dt>50 % intervall</dt><dd>" + escapeHtml(rangeTextFor(values, "p25", "p75")) + "</dd>" +
          "<dt>90 % intervall</dt><dd>" + escapeHtml(rangeTextFor(values, "p05", "p95")) + "</dd>" +
          "</dl></section>";
      }).filter(function (row) { return row; });
      return "<h3 class=\"election-timeseries__detail-date\">" +
        escapeHtml(swedishDate(point.date) || point.date) + "</h3>" +
        "<div class=\"election-timeseries__detail-groups\">" + rows.join("") + "</div>" +
        "<dl class=\"election-timeseries__detail-meta\">" +
        "<div><dt>Vy</dt><dd>" + escapeHtml(campaignPaths.rendering.origin_state_label) +
        "</dd></div>" +
        "<div><dt>Storhet</dt><dd>Underliggande opinionsläge</dd></div>" +
        "<div><dt>Simuleringar</dt><dd>" +
        escapeHtml(historyDaysText(campaignPaths.samples)) + "</dd></div>" +
        "</dl>" +
        "<p class=\"election-timeseries__note election-muted\">" +
        escapeHtml(campaignPaths.rendering.origin_state_tooltip_sv) + "</p>";
    }

    function campaignBandDetail(point) {
      if (!point || !campaignPaths) return "";
      var rows = activeDefinitions().map(function (definition) {
        var values = historyDisplayQuantiles(point.groups && point.groups[definition.id], "vote");
        if (!values) return "";
        return "<section class=\"election-timeseries__detail-group\" data-coalition=\"" +
          escapeHtml(definition.id) + "\"><h4>" + escapeHtml(definition.label) + "</h4><dl>" +
          "<dt>Medianbana</dt><dd>" + escapeHtml(percent(values.p50, 1)) + "</dd>" +
          "<dt>50 % av banorna</dt><dd>" + escapeHtml(rangeTextFor(values, "p25", "p75")) + "</dd>" +
          "<dt>90 % av banorna</dt><dd>" + escapeHtml(rangeTextFor(values, "p05", "p95")) + "</dd>" +
          "</dl></section>";
      }).filter(function (row) { return row; });
      return "<h3 class=\"election-timeseries__detail-date\">" +
        escapeHtml(swedishDate(point.date) || point.date) + "</h3>" +
        "<div class=\"election-timeseries__detail-groups\">" + rows.join("") + "</div>" +
        "<dl class=\"election-timeseries__detail-meta\">" +
        "<div><dt>Vy</dt><dd>" + escapeHtml(campaignPaths.rendering.future_region.label) + "</dd></div>" +
        "<div><dt>Storhet</dt><dd>Underliggande opinionsläge</dd></div>" +
        "<div><dt>Dag</dt><dd>" + escapeHtml(historyDaysText(point.pathDay)) +
        " av " + escapeHtml(historyDaysText(campaignPaths.pathDays)) + "</dd></div>" +
        "<div><dt>Simuleringar</dt><dd>" + escapeHtml(historyDaysText(campaignPaths.samples)) + "</dd></div>" +
        "</dl>" +
        "<p class=\"election-timeseries__note election-muted\">" + escapeHtml(campaignPaths.tooltip) + "</p>";
    }

    function electionDayDetail(point) {
      if (!point || !campaignPaths) return "";
      var rows = activeDefinitions().map(function (definition) {
        var group = point.groups && point.groups[definition.id];
        var values = historyDisplayQuantiles(group, selectedMetric);
        if (!values) return "";
        return "<section class=\"election-timeseries__detail-group\" data-coalition=\"" +
          escapeHtml(definition.id) + "\"><h4>" + escapeHtml(definition.label) + "</h4><dl>" +
          "<dt>Valdagsprognos</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatMedianText(group) : percent(values.p50, 1)) + "</dd>" +
          "<dt>50 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatRangeText(group, "p25", "p75") : rangeTextFor(values, "p25", "p75")) + "</dd>" +
          "<dt>90 % intervall</dt><dd>" + escapeHtml(selectedMetric === "seats"
            ? seatRangeText(group, "p05", "p95") : rangeTextFor(values, "p05", "p95")) + "</dd>" +
          "</dl></section>";
      }).filter(function (row) { return row; });
      return "<h3 class=\"election-timeseries__detail-date\">" +
        escapeHtml(swedishDate(point.date) || point.date) + "</h3>" +
        "<div class=\"election-timeseries__detail-groups\">" + rows.join("") + "</div>" +
        "<dl class=\"election-timeseries__detail-meta\">" +
        "<div><dt>Vy</dt><dd>" + escapeHtml(campaignPaths.electionDay.label) + "</dd></div>" +
        "<div><dt>Simuleringar</dt><dd>" +
        escapeHtml(historyDaysText(campaignPaths.electionDay.samples)) + "</dd></div>" +
        "<div><dt>Ursprung</dt><dd>Officiell aktuell valprognos</dd></div>" +
        "</dl>" +
        "<p class=\"election-timeseries__note election-muted\">" +
        escapeHtml(campaignPaths.electionDay.tooltip) + "</p>";
    }

    function futureMarkLabel(point) {
      if (!point) return "";
      if (point.isElectionDay && campaignPaths) return campaignPaths.electionDay.label;
      if (point.isOriginState && campaignPaths) return campaignPaths.rendering.origin_state_label;
      if (point.isCampaignBand && campaignPaths) return campaignPaths.rendering.future_region.label;
      return projection ? projection.rendering.legend_label : "";
    }

    function forecastStatus(point) {
      if (!point) return "Välj en punkt i diagrammet för detaljer.";
      var descriptions = activeDefinitions().map(function (definition) {
        var group = point.groups && point.groups[definition.id];
        var values = historyDisplayQuantiles(group, selectedMetric);
        if (!values) return "";
        var median = selectedMetric === "seats" ? seatMedianText(group) : percent(values.p50, 1);
        return definition.label + ": vår simulering " + median;
      }).filter(function (value) { return value; });
      return (swedishDate(point.date) || point.date) + " · " + descriptions.join(", ") + ". " +
        (point.isFuture || point.isOriginState
          ? futureMarkLabel(point) : historyProvenanceLabel(point.provenance)) + ".";
    }

    renderDetail = function (point) {
      if (!point) {
        if (detailBody) {
          detailBody.innerHTML = "";
          detailBody.hidden = true;
        }
        if (liveStatus) {
          liveStatus.hidden = false;
          liveStatus.textContent = "Välj en punkt i diagrammet för detaljer.";
        }
        return;
      }
      if (detailBody) {
        if (point.isElectionDay) detailBody.innerHTML = electionDayDetail(point);
        else if (point.isOriginState) detailBody.innerHTML = originStateDetail(point);
        else if (point.isCampaignBand) detailBody.innerHTML = campaignBandDetail(point);
        else if (point.isFuture) detailBody.innerHTML = futureDetail(point);
        else detailBody.innerHTML = forecastDetail(point);
        detailBody.hidden = false;
      }
      if (liveStatus) {
        liveStatus.hidden = true;
        liveStatus.textContent = forecastStatus(point);
      }
    };

    function clearSelection() {
      selectedDate = null;
      selectedPoint = null;
      pinnedSelection = false;
      svg.removeAttribute("data-selected-date");
      svg.removeAttribute("data-inspection-date");
      renderSelection(null);
      renderDetail(null);
    }

    clearTimeseriesSelection = clearSelection;

    function renderChart() {
      // Keep an inspected date stable while the metric or visible coalitions
      // change. The detail panel is rebuilt from the newly active series below,
      // avoiding a distracting collapse-and-expand layout jump.
      var retainedDate = selectedDate;
      var retainedPinnedSelection = pinnedSelection;
      var definitions = activeDefinitions();
      activeDomain = activeTimeDomain();
      if (!activeDomain) return;
      section.setAttribute("data-time-range", activeDomain.range);
      section.setAttribute("data-range", activeDomain.range);
      section.setAttribute("data-time-range-start", activeDomain.minIso);
      section.setAttribute("data-time-range-end", activeDomain.maxIso);
      var minTime = activeDomain.minTime;
      var maxTime = activeDomain.maxTime;
      var visibleHistoryPoints = history.points.filter(pointInActiveDomain);
      var futureActive = pathsActive() || projectionActive();
      var visibleProjectionPoints = projectionActive() && selectedMetric === "vote"
        ? projection.points.filter(pointInActiveDomain) : [];
      var visibleBandPoints = pathsActive() ? campaignPaths.bands.filter(pointInActiveDomain) : [];
      // No poll observation may ever appear after the forecast origin: the
      // future region is simulated, not measured.
      var visiblePollPoints = history.polls ? history.polls.filter(function (point) {
        return pointInActiveDomain(point) && (!futureOrigin || point.time <= futureOrigin.time);
      }) : [];
      var span = activeDomain.maxTime - activeDomain.minTime;
      var xScale = function (time) {
        return plot.left + (time - activeDomain.minTime) / span * plot.width;
      };
      var yDomain = historyValueDomain(history, selectedMetric, definitions, activeDomain);
      var minValue = yDomain.min;
      var maxValue = yDomain.max;
      var yScale = function (value) {
        var parsed = historyNumber(value);
        if (parsed === null) return plot.bottom;
        // The guard exists only to avoid dividing by zero on a degenerate
        // domain. It must stay well below one percentage point: a party window
        // can legitimately be a single point wide, and clamping the divisor at
        // 1 would silently flatten it.
        return plot.bottom - (parsed - minValue) / Math.max(1e-6, maxValue - minValue) * plot.height;
      };
      // Path day 0 shares its calendar date with the certified forecast point
      // but is a different, much narrower distribution.  Shifting it a few
      // pixels into the future region separates the two quantities and lets
      // the fan visibly emanate from the opinion state, not from the forecast.
      var originTime = campaignPaths ? campaignPaths.origin.time : null;
      // Half a day where a day is wide enough to hold a marker, floored so the
      // mark always clears the certified forecast dot on the same date, capped
      // so it never reaches the first campaign day.
      var originDayGap = campaignPaths
        ? xScale(originTime + 86400000) - xScale(originTime) : 0;
      var originShift = Math.max(
        compactChart ? 7 : 8,
        Math.min(compactChart ? 12 : 13, originDayGap * 0.55),
      );
      // Clamped so the marker cannot walk past the election-day glyph when the
      // four-year scale squeezes the whole campaign into a few pixels; there it
      // simply sits on the boundary, where a sliver cannot mislead anyone.
      var originX = campaignPaths
        ? Math.min(
          xScale(originTime) + originShift,
          // Never past the left edge of the election-day glyph; on the
          // four-year scale that floor collapses onto the boundary itself.
          Math.max(xScale(originTime),
            xScale(campaignPaths.election.time) - (compactChart ? 10 : 13) / 2 - 3),
        )
        : null;
      var campaignX = function (time) {
        return time === originTime ? originX : xScale(time);
      };

      svg.innerHTML = "";
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.setAttribute("data-metric", selectedMetric);
      svg.setAttribute("data-y-min", String(minValue));
      svg.setAttribute("data-y-max", String(maxValue));
      svg.setAttribute("data-y-domain", String(minValue) + "–" + String(maxValue));
      svg.setAttribute("data-y-domain-mode", viewMode === "parties"
        ? "adaptive-party-window"
        : (pathsActive() && selectedMetric === "vote" && activeDomain.range === "short"
          ? "adaptive-campaign-window" : "published-history"));
      svg.setAttribute("data-view-mode", viewMode);
      svg.setAttribute("data-threshold-visible", yDomain.thresholdVisible ? "true" : "false");
      if (viewMode === "parties") {
        var activeParty = activePartyDefinition();
        svg.setAttribute("data-selected-party", activeParty ? activeParty.id : "");
      } else {
        svg.removeAttribute("data-selected-party");
      }
      svg.setAttribute("data-dynamics-horizon-cap", String(HISTORY_DYNAMICS_CAP));
      svg.setAttribute("data-majority-rule", String(MAJORITY));
      svg.setAttribute("data-time-range", activeDomain.range);
      svg.setAttribute("data-range", activeDomain.range);
      svg.setAttribute("data-x-axis-min", activeDomain.minIso);
      svg.setAttribute("data-x-axis-max", activeDomain.maxIso);
      if (projection) {
        svg.setAttribute("data-future-projection-origin", projection.origin.iso);
        svg.setAttribute("data-future-projection-election", projection.election.iso);
      }
      svg.setAttribute("data-future-view", pathsActive() ? "campaign_paths"
        : (projectionActive() ? "conditional_projection" : "none"));
      if (campaignPaths) {
        svg.setAttribute("data-campaign-path-origin", campaignPaths.origin.iso);
        svg.setAttribute("data-campaign-path-election", campaignPaths.election.iso);
        svg.setAttribute("data-campaign-visible-path-count", String(
          representativeCampaignPaths(campaignPaths.paths).length));
      }
      svg.appendChild(svgNode("title", { id: "election-timeseries-title" },
        "Vägen till valdagen, " + historyMetricLabel(selectedMetric)));
      svg.appendChild(svgNode("desc", { id: "election-timeseries-description" },
        "Vår simulering med median och 50- samt 90-procentiga prognosintervall från " +
        (swedishDate(activeDomain.minIso) || activeDomain.minIso) + " till " +
        (swedishDate(activeDomain.maxIso) || activeDomain.maxIso) +
        ". Skalan är anpassad efter de valda serierna." +
        (viewMode === "parties" && activeDefinitions().length
          ? " Visar " + activeDefinitions()[0].label + "." : "") +
        (selectedMetric === "vote" ? " Enskilda mätningar visas som jämförelse." : "")));

      var plotDefs = svgNode("defs");
      var plotClip = svgNode("clipPath", { id: "election-timeseries-plot-clip" });
      plotClip.appendChild(svgNode("rect", {
        x: plot.left, y: plot.top, width: plot.width, height: plot.height
      }));
      plotDefs.appendChild(plotClip);
      svg.appendChild(plotDefs);

      var background = svgNode("g", { class: "election-timeseries__background", "aria-hidden": "true" });
      if (futureActive && futureOrigin && futureElection) {
        var paths = pathsActive();
        var futureStartX = xScale(futureOrigin.time);
        var futureEndX = xScale(futureElection.time);
        var boundaryLabel = paths ? campaignPaths.rendering.origin_boundary_label
          : projection.rendering.latest_forecast_label;
        var electionLabel = paths ? campaignPaths.rendering.election_day_label
          : projection.rendering.election_day_label;
        var regionWidth = Math.max(0, futureEndX - futureStartX);
        background.appendChild(svgNode("rect", {
          x: futureStartX, y: plot.top, width: regionWidth, height: plot.height,
          fill: paths ? "#5b74a8" : "#777", opacity: paths ? "0.075" : "0.055",
          "data-future-region": "true", "data-future-background": "true",
          "data-future-view": paths ? "campaign_paths" : "conditional_projection",
          "data-region-start": futureOrigin.iso, "data-region-end": futureElection.iso
        }));
        background.appendChild(svgNode("line", {
          x1: futureStartX, y1: plot.top, x2: futureStartX, y2: plot.bottom,
          stroke: "#777", "stroke-width": "1", "stroke-dasharray": "3 4",
          "data-latest-forecast-boundary": "true", "data-date": futureOrigin.iso
        }));
        // Keep only the two dated landmarks inside the chart.  The future
        // view's meaning is carried by the fan, paths and legend, so a large
        // region caption would repeat the same phrase and compete with the
        // plotted quantities.
        background.appendChild(svgNode("text", {
          x: futureStartX + 5, y: plot.top + 14, "text-anchor": "start",
          class: "election-timeseries__future-label",
          "data-latest-forecast-label": "true"
        }, boundaryLabel));
        background.appendChild(svgNode("line", {
          x1: futureEndX, y1: plot.top, x2: futureEndX, y2: plot.bottom,
          stroke: "#555", "stroke-width": "1.2", "data-election-day-boundary": "true",
          "data-date": futureElection.iso
        }));
        background.appendChild(svgNode("text", {
          x: futureEndX - 4, y: plot.bottom + 24, fill: "#666", "font-size": compactChart ? "11" : "12",
          "text-anchor": "end", "data-election-day-label": "true", "data-date": futureElection.iso
        }, electionLabel));
      }
      // The tick ladder belongs to the domain that produced it, so a 0.6 pp
      // party window and a 60 pp coalition span are both readable without the
      // renderer keeping its own second copy of the rule.
      var yStep = yDomain.step;
      var yDigits = yDomain.digits;
      for (var yValue = minValue; yValue <= maxValue + 0.001; yValue += yStep) {
        var y = yScale(yValue);
        background.appendChild(svgNode("line", {
          x1: plot.left, y1: y, x2: plot.right, y2: y,
          class: "election-timeseries__grid-line"
        }));
        background.appendChild(svgNode("text", {
          x: plot.left - 10, y: y + 4, "text-anchor": "end", class: "election-timeseries__axis-label",
          "data-y-tick": String(yValue)
        }, format(yValue, yDigits) + "%"));
      }
      background.appendChild(svgNode("line", {
        x1: plot.left, y1: plot.bottom, x2: plot.right, y2: plot.bottom,
        class: "election-timeseries__axis-line"
      }));
      if (viewMode === "parties" && selectedMetric === "vote" && yDomain.thresholdVisible) {
        // Drawn only when it already falls inside what the data put on screen.
        // The scale is never stretched to reach it: for a party at 30 % the
        // line carries no information and its absence is the honest state.
        var thresholdPct = history.partyView ? history.partyView.thresholdPct : NATIONAL_THRESHOLD_PCT;
        var thresholdY = yScale(thresholdPct);
        background.appendChild(svgNode("line", {
          x1: plot.left, y1: thresholdY, x2: plot.right, y2: thresholdY,
          class: "election-timeseries__threshold", "data-national-threshold": String(thresholdPct),
          "data-threshold-line": "true"
        }));
        background.appendChild(svgNode("text", {
          x: plot.right - 4, y: thresholdY - 6, "text-anchor": "end",
          class: "election-timeseries__threshold-label", "data-threshold-label": "true"
        }, history.partyView ? history.partyView.thresholdLabel : "4\u00a0%-sp\u00e4rr"));
      }
      // The 175-seat rule is a question about a government, not about a party:
      // no single party is going to hold a majority, and drawing the line
      // invites reading a party's distance from one as meaningful. Coalition
      // mode keeps it exactly as before; "Regeringsalternativ" and the builder
      // are where the majority question belongs for a party combination.
      if (selectedMetric === "seats" && viewMode !== "parties") {
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
      var dateTicks = historyAxisTicks(minTime, maxTime);
      if (compactChart && dateTicks.length > 1 &&
          dateTicks[1].time - dateTicks[0].time < 180 * 86400000) {
        dateTicks.shift();
      }
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
        x: plot.left, y: height - 8, "text-anchor": "start", class: "election-timeseries__axis-label"
      }, historyMetricLabel(selectedMetric)));
      svg.appendChild(background);

      var seriesLayer = svgNode("g", {
        class: "election-timeseries__series", "aria-label": "Prognosserier", "pointer-events": "none"
      });
      var endpointLabels = [];
      definitions.forEach(function (definition) {
        var validPoints = visibleHistoryPoints.filter(function (point) {
          return point.groups && point.groups[definition.id] && point.groups[definition.id][selectedMetric];
        });
        if (!validPoints.length) return;
        // The continuous line and bands answer "what would the CURRENT model
        // have forecast through time".  A prospective_archived point answers a
        // different question -- "what was actually published that day", under
        // whatever model was current then -- so it is never a vertex of this
        // curve.  Those points are filtered out of the chart entirely in
        // normalizeHistoryPayload; the payload still carries them.
        var curvePoints = validPoints;
        if (!curvePoints.length) return;
        var group = svgNode("g", {
          class: "election-timeseries__series-group" + (definition.defaultOn ? " is-primary" : ""),
          "data-coalition": definition.id,
          "data-coalition-label": definition.label,
          "data-color": definition.color,
          "data-provenance": curvePoints[curvePoints.length - 1].provenance
        });
        var ninety = historyAreaPath(curvePoints, selectedMetric, definition.id, xScale, yScale, "p95", "p05");
        var fifty = historyAreaPath(curvePoints, selectedMetric, definition.id, xScale, yScale, "p75", "p25");
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
        var medianPath = historyAreaPath(curvePoints, selectedMetric, definition.id, xScale, yScale, "p50", "p50");
        if (medianPath) group.appendChild(svgNode("path", {
          class: "election-timeseries__line election-timeseries__median", d: medianPath, stroke: definition.color,
          "data-coalition": definition.id, "data-quantile": "p50"
        }));
        var currentPoints = curvePoints.filter(function (point) {
          return point.provenance === "current_production";
        });
        var latest = currentPoints.length ? currentPoints[currentPoints.length - 1] : curvePoints[curvePoints.length - 1];
        curvePoints.forEach(function (point) {
          var rawPointValues = point.groups[definition.id][selectedMetric];
          var pointValues = historyDisplayQuantiles(point.groups[definition.id], selectedMetric);
          var current = point === latest;
          var pointCircle = svgNode("circle", {
            class: "election-timeseries__forecast-point"
              + (current ? " election-timeseries__current" : ""),
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
            "data-current": current ? "true" : "false", "data-forecast-point": "true",
            "pointer-events": "all", tabindex: "0", role: "img",
            "aria-label": definition.label + ", " + (swedishDate(point.date) || point.date) +
              ": median " + percent(pointValues.p50, 1)
          });
          if (pointCircle.addEventListener) {
            pointCircle.addEventListener("mouseenter", function (event) { chooseForecast(point, false, event); });
            pointCircle.addEventListener("focus", function (event) { chooseForecast(point, false, event); });
            pointCircle.addEventListener("mouseleave", hideInspection);
            pointCircle.addEventListener("blur", hideInspection);
            pointCircle.addEventListener("click", function (event) { chooseForecast(point, false, event); });
            pointCircle.addEventListener("keydown", function (event) {
              if (event && (event.key === "Enter" || event.key === " ")) {
                if (event.preventDefault) event.preventDefault();
                chooseForecast(point, false, event);
              } else if (event && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                if (event.preventDefault) event.preventDefault();
                chooseForecast(nearestPoint(point.time, event.key === "ArrowRight" ? 1 : -1), false, event);
              }
            });
          }
          group.appendChild(pointCircle);
          if (current && pointValues.p50 !== null) {
            // The current-value label belongs to the last certified point.
            // Once a future region exists to the right of it, printing the
            // label there would read as a claim about the simulated paths, so
            // it is flipped to the historical side of the boundary.
            endpointLabels.push({
              definition: definition,
              value: pointValues.p50,
              text: selectedMetric === "seats" ? seatMedianText(point.groups[definition.id]) : percent(pointValues.p50, 1),
              x: futureActive ? xScale(point.time) - 9 : xScale(point.time) + 9,
              anchor: futureActive ? "end" : "start",
              y: yScale(pointValues.p50)
            });
          }
        });
        seriesLayer.appendChild(group);
      });

      // Endpoint values are deliberately the only numeric labels on the
      // series.  Sort and nudge them apart so the latest coalition values stay
      // legible even when several alternatives converge.
      endpointLabels.sort(function (left, right) { return left.y - right.y; });
      var endpointGap = compactChart ? 20 : 16;
      endpointLabels.forEach(function (label, index) {
        if (index > 0) label.y = Math.max(label.y, endpointLabels[index - 1].y + endpointGap);
      });
      if (endpointLabels.length) {
        var endpointOverflow = endpointLabels[endpointLabels.length - 1].y - (plot.bottom - 3);
        if (endpointOverflow > 0) {
          endpointLabels.forEach(function (label) { label.y -= endpointOverflow; });
        }
        endpointLabels.forEach(function (label) {
          label.y = Math.max(plot.top + 8, Math.min(plot.bottom - 3, label.y));
          seriesLayer.appendChild(svgNode("text", {
            x: label.x, y: label.y + 4, "text-anchor": label.anchor || "start",
            class: "election-timeseries__endpoint-label",
            fill: label.definition.color, "data-endpoint-label": "true",
            "data-coalition": label.definition.id, "data-value": label.value,
            "data-label-value": label.text
          }, label.text));
        });
      }
      svg.appendChild(seriesLayer);

      if (projectionActive() && selectedMetric === "vote") {
        var futureLayer = svgNode("g", {
          class: "election-timeseries__future-series",
          "aria-label": projection.rendering.legend_label,
          "data-future-series": "true", "pointer-events": "none"
        });
        var projectedCurve = [projection.anchorPoint].concat(projection.points);
        definitions.forEach(function (definition) {
          var futureGroup = svgNode("g", {
            class: "election-timeseries__future-series-group",
            "data-coalition": definition.id,
            "data-coalition-label": definition.label,
            "data-color": definition.color,
            "data-projection": "true",
            "clip-path": "url(#election-timeseries-plot-clip)"
          });
          var futureNinety = historyAreaPath(projectedCurve, selectedMetric, definition.id,
            xScale, yScale, "p95", "p05");
          var futureFifty = historyAreaPath(projectedCurve, selectedMetric, definition.id,
            xScale, yScale, "p75", "p25");
          var futureMedian = historyAreaPath(projectedCurve, selectedMetric, definition.id,
            xScale, yScale, "p50", "p50");
          if (futureNinety) futureGroup.appendChild(svgNode("path", {
            d: futureNinety, fill: definition.color, opacity: "0.06",
            class: "election-timeseries__future-band election-timeseries__future-band--90",
            "data-future-band": "90", "data-coalition": definition.id
          }));
          if (futureFifty) futureGroup.appendChild(svgNode("path", {
            d: futureFifty, fill: definition.color, opacity: "0.15",
            class: "election-timeseries__future-band election-timeseries__future-band--50",
            "data-future-band": "50", "data-coalition": definition.id
          }));
          if (futureMedian) futureGroup.appendChild(svgNode("path", {
            d: futureMedian, fill: "none", stroke: definition.color, opacity: "0.68",
            "stroke-width": "2.2", "stroke-dasharray": "7 5", "vector-effect": "non-scaling-stroke",
            class: "election-timeseries__future-median", "data-future-median": "true",
            "data-coalition": definition.id
          }));
          visibleProjectionPoints.forEach(function (point) {
            var group = point.groups && point.groups[definition.id];
            var values = historyDisplayQuantiles(group, selectedMetric);
            var rawValues = group && group[selectedMetric];
            if (!values || !rawValues) return;
            var futurePoint = svgNode("circle", {
              cx: xScale(point.time), cy: yScale(values.p50), r: "3.1", fill: definition.color,
              opacity: "0.72", "pointer-events": "all", tabindex: "0", role: "button",
              class: "election-timeseries__future-point", "data-future-point": "true",
              "data-projection": "true", "data-coalition": definition.id, "data-date": point.date,
              "data-p05": values.p05, "data-p25": values.p25, "data-p50": values.p50,
              "data-p75": values.p75, "data-p95": values.p95,
              "data-seat-quantiles": selectedMetric === "seats" ? JSON.stringify(rawValues) : "",
              "aria-label": definition.label + ", " + projection.rendering.legend_label.toLowerCase() + " " +
                (swedishDate(point.date) || point.date) + ": median " +
                (selectedMetric === "seats" ? grouped(rawValues.p50) + " mandat" : percent(values.p50, 1))
            });
            futurePoint.addEventListener("mouseenter", function (event) { chooseForecast(point, false, event); });
            futurePoint.addEventListener("focus", function (event) { chooseForecast(point, false, event); });
            futurePoint.addEventListener("mouseleave", hideInspection);
            futurePoint.addEventListener("blur", hideInspection);
            futurePoint.addEventListener("click", function (event) { chooseForecast(point, false, event); });
            futurePoint.addEventListener("keydown", function (event) {
              if (event.key === "Enter" || event.key === " ") {
                if (event.preventDefault) event.preventDefault();
                chooseForecast(point, false, event);
              }
            });
            futureGroup.appendChild(futurePoint);
          });
          futureLayer.appendChild(futureGroup);
        });
        svg.appendChild(futureLayer);
      }

      if (pathsActive()) {
        var pathLayer = svgNode("g", {
          class: "election-timeseries__campaign",
          "aria-label": campaignPaths.rendering.future_region.label,
          "data-campaign-path-series": "true", "pointer-events": "none"
        });
        // The x-axis maximum *is* election day, so the distribution glyph is
        // inset by its own half-width to stay inside the frame while keeping
        // its published election-day date.
        // Horizontal position encodes time, so the election-day glyph sits
        // exactly on election day.  It is drawn in an un-clipped overlay below
        // instead of being nudged inwards to avoid the plot clip: moving a
        // dated mark to solve clipping puts it at the wrong date, and on the
        // four-year scale it moved left of the "I dag" boundary entirely.
        var glyphX = xScale(campaignPaths.election.time);
        var boxWidth = compactChart ? 10 : 13;
        var electionLayer = svgNode("g", {
          class: "election-timeseries__election-day",
          "aria-label": campaignPaths.electionDay.label,
          "data-election-day-series": "true", "pointer-events": "none"
        });
        definitions.forEach(function (definition) {
          var group = svgNode("g", {
            class: "election-timeseries__campaign-group",
            "data-coalition": definition.id,
            "data-coalition-label": definition.label,
            "data-color": definition.color,
            "data-campaign-paths": "true",
            "clip-path": "url(#election-timeseries-plot-clip)"
          });
          if (selectedMetric === "vote" && visibleBandPoints.length) {
            var ninety = historyAreaPath(visibleBandPoints, "vote", definition.id, campaignX, yScale, "p95", "p05");
            var fifty = historyAreaPath(visibleBandPoints, "vote", definition.id, campaignX, yScale, "p75", "p25");
            if (ninety) group.appendChild(svgNode("path", {
              d: ninety, fill: definition.color, opacity: "0.10",
              class: "election-timeseries__campaign-band election-timeseries__campaign-band--90",
              "data-campaign-band": "90", "data-coalition": definition.id
            }));
            if (fifty) group.appendChild(svgNode("path", {
              d: fifty, fill: definition.color, opacity: "0.20",
              class: "election-timeseries__campaign-band election-timeseries__campaign-band--50",
              "data-campaign-band": "50", "data-coalition": definition.id
            }));
            // A limited, deterministically chosen set of faint individual
            // trajectories.  They are the point of the view: they show that a
            // flat median is an average over movement, not a prediction of
            // stillness.
            representativeCampaignPaths(campaignPaths.paths).forEach(function (track) {
              var line = track.values[definition.id];
              if (!line) return;
              var commands = "";
              var drawn = 0;
              campaignPaths.bands.forEach(function (band, index) {
                if (!pointInActiveDomain(band)) return;
                var value = historyNumber(line[index]);
                if (value === null) return;
                commands += (drawn ? "L" : "M") + campaignX(band.time).toFixed(2) + "," +
                  yScale(value).toFixed(2);
                drawn += 1;
              });
              if (drawn < 2) return;
              group.appendChild(svgNode("path", {
                d: commands, fill: "none", stroke: definition.color, opacity: "0.22",
                "stroke-width": "1", "vector-effect": "non-scaling-stroke",
                class: "election-timeseries__campaign-path", "data-campaign-path": "true",
                "data-coalition": definition.id, "data-sample-index": String(track.sampleIndex)
              }));
            });
            var medianPath = historyAreaPath(visibleBandPoints, "vote", definition.id,
              campaignX, yScale, "p50", "p50");
            if (medianPath) group.appendChild(svgNode("path", {
              d: medianPath, fill: "none", stroke: definition.color, opacity: "0.18",
              "stroke-width": "1.2", "stroke-dasharray": "4 6", "vector-effect": "non-scaling-stroke",
              class: "election-timeseries__campaign-median", "data-campaign-median": "true",
              "data-coalition": definition.id
            }));
            var originBand = visibleBandPoints.filter(function (band) {
              return band.pathDay === 0;
            })[0];
            visibleBandPoints.forEach(function (band) {
              if (band.pathDay === 0) return;
              var values = historyDisplayQuantiles(band.groups[definition.id], "vote");
              if (!values || values.p50 === null) return;
              var mark = svgNode("circle", {
                cx: xScale(band.time), cy: yScale(values.p50), r: "9", fill: "transparent",
                opacity: "0", stroke: "none", "pointer-events": "all", "aria-hidden": "true",
                class: "election-timeseries__campaign-point", "data-campaign-point": "true",
                "data-coalition": definition.id, "data-date": band.date,
                "data-path-day": String(band.pathDay),
                "data-p05": values.p05, "data-p25": values.p25, "data-p50": values.p50,
                "data-p75": values.p75, "data-p95": values.p95,
              });
              mark.addEventListener("mouseenter", function (event) { chooseForecast(band, false, event); });
              mark.addEventListener("mouseleave", hideInspection);
              mark.addEventListener("click", function (event) { chooseForecast(band, false, event); });
              group.appendChild(mark);
            });
            // Painted after the daily marks so a pointer at its centre resolves
            // to the origin state rather than to the neighbouring first day.
            if (originBand) {
              var originValues = historyDisplayQuantiles(originBand.groups[definition.id], "vote");
              if (originValues && originValues.p50 !== null) {
                var tickWidth = compactChart ? 8 : 9;
                group.appendChild(svgNode("line", {
                  x1: originX, y1: yScale(originValues.p95), x2: originX,
                  y2: yScale(originValues.p05),
                  stroke: definition.color, "stroke-width": "1.5", opacity: "0.65",
                  "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
                  class: "election-timeseries__origin-state-whisker",
                  "data-origin-state-interval": "90", "data-coalition": definition.id
                }));
                group.appendChild(svgNode("line", {
                  x1: originX, y1: yScale(originValues.p75), x2: originX,
                  y2: yScale(originValues.p25),
                  stroke: definition.color, "stroke-width": "4.5", opacity: "0.4",
                  "vector-effect": "non-scaling-stroke",
                  class: "election-timeseries__origin-state-box",
                  "data-origin-state-interval": "50", "data-coalition": definition.id
                }));
                group.appendChild(svgNode("line", {
                  x1: originX - tickWidth / 2, y1: yScale(originValues.p50),
                  x2: originX + tickWidth / 2, y2: yScale(originValues.p50),
                  stroke: definition.color, "stroke-width": "2.4",
                  "vector-effect": "non-scaling-stroke",
                  class: "election-timeseries__origin-state-median",
                  "data-origin-state-median": "true", "data-coalition": definition.id
                }));
                // A square, so it cannot be mistaken for the round certified
                // forecast point a few pixels to its left.
                var originSize = compactChart ? 5.2 : 5.6;
                var originMark = svgNode("rect", {
                  x: originX - originSize / 2, y: yScale(originValues.p50) - originSize / 2,
                  width: originSize, height: originSize, rx: "1",
                  fill: definition.color, stroke: "#fff", "stroke-width": "1.2",
                  "pointer-events": "all", tabindex: "0", role: "button",
                  class: "election-timeseries__origin-state-point",
                  "data-origin-state-point": "true", "data-coalition": definition.id,
                  "data-date": originBand.date, "data-path-day": "0",
                  "data-origin-state-label": campaignPaths.rendering.origin_state_label,
                  "data-p05": originValues.p05, "data-p25": originValues.p25,
                  "data-p50": originValues.p50, "data-p75": originValues.p75,
                  "data-p95": originValues.p95,
                  "aria-label": definition.label + ", " +
                    campaignPaths.rendering.origin_state_label.toLowerCase() + " " +
                    (swedishDate(originBand.date) || originBand.date) + ": median " +
                    percent(originValues.p50, 1)
                });
                originMark.addEventListener("mouseenter", function (event) {
                  chooseForecast(originBand, false, event);
                });
                originMark.addEventListener("focus", function (event) {
                  chooseForecast(originBand, false, event);
                });
                originMark.addEventListener("mouseleave", hideInspection);
                originMark.addEventListener("blur", hideInspection);
                originMark.addEventListener("click", function (event) {
                  chooseForecast(originBand, false, event);
                });
                originMark.addEventListener("keydown", function (event) {
                  if (event.key === "Enter" || event.key === " ") {
                    if (event.preventDefault) event.preventDefault();
                    chooseForecast(originBand, false, event);
                  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    if (event.preventDefault) event.preventDefault();
                    chooseForecast(nearestPoint(originBand.time,
                      event.key === "ArrowRight" ? 1 : -1), false, event);
                  }
                });
                group.appendChild(originMark);
              }
            }
          }

          pathLayer.appendChild(group);

          // The emphasized election-day forecast distribution.  Unlike the
          // opinion bands it carries ElectionNoise, geography and mandates,
          // and it is the certified production distribution value for value.
          // It lives outside the plot clip so it can straddle election day at
          // the frame's right edge without being cut in half.
          var electionDayGroup = svgNode("g", {
            class: "election-timeseries__election-day-group",
            "data-coalition": definition.id,
            "data-coalition-label": definition.label,
            "data-color": definition.color,
            "data-election-day": "true"
          });
          var electionGroup = campaignPaths.electionDay.groups[definition.id];
          var electionValues = historyDisplayQuantiles(electionGroup, selectedMetric);
          var electionRaw = electionGroup && electionGroup[selectedMetric];
          if (electionValues && electionValues.p50 !== null && electionValues.p05 !== null &&
              electionValues.p95 !== null) {
            electionDayGroup.appendChild(svgNode("line", {
              x1: glyphX, y1: yScale(electionValues.p95), x2: glyphX, y2: yScale(electionValues.p05),
              stroke: definition.color, "stroke-width": "2", opacity: "0.55",
              "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
              class: "election-timeseries__election-day-whisker",
              "data-election-day-interval": "90", "data-coalition": definition.id
            }));
            electionDayGroup.appendChild(svgNode("rect", {
              x: glyphX - boxWidth / 2, y: yScale(electionValues.p75),
              width: boxWidth,
              height: Math.max(1.5, yScale(electionValues.p25) - yScale(electionValues.p75)),
              fill: definition.color, opacity: "0.42", rx: "1.5",
              class: "election-timeseries__election-day-box",
              "data-election-day-interval": "50", "data-coalition": definition.id
            }));
            electionDayGroup.appendChild(svgNode("line", {
              x1: glyphX - boxWidth / 2 - 2, y1: yScale(electionValues.p50),
              x2: glyphX + boxWidth / 2 + 2, y2: yScale(electionValues.p50),
              stroke: definition.color, "stroke-width": "2.6",
              "vector-effect": "non-scaling-stroke",
              class: "election-timeseries__election-day-median",
              "data-election-day-median": "true", "data-coalition": definition.id
            }));
            var electionMark = svgNode("circle", {
              cx: glyphX, cy: yScale(electionValues.p50), r: compactChart ? "4.6" : "5",
              fill: definition.color, stroke: "#fff", "stroke-width": "1.2",
              "pointer-events": "all", tabindex: "0", role: "button",
              class: "election-timeseries__election-day-point",
              "data-election-day-point": "true", "data-coalition": definition.id,
              "data-date": campaignPaths.electionDay.date, "data-metric": selectedMetric,
              "data-p05": electionValues.p05, "data-p25": electionValues.p25,
              "data-p50": electionValues.p50, "data-p75": electionValues.p75,
              "data-p95": electionValues.p95,
              "data-seat-quantiles": selectedMetric === "seats" ? JSON.stringify(electionRaw) : "",
              "aria-label": definition.label + ", " + campaignPaths.electionDay.label.toLowerCase() +
                " " + (swedishDate(campaignPaths.electionDay.date) || campaignPaths.electionDay.date) +
                ": median " + (selectedMetric === "seats"
                  ? grouped(electionRaw.p50) + " mandat" : percent(electionValues.p50, 1))
            });
            var electionPoint = campaignPaths.electionDay;
            electionMark.addEventListener("mouseenter", function (event) {
              chooseForecast(electionPoint, false, event);
            });
            electionMark.addEventListener("focus", function (event) {
              chooseForecast(electionPoint, false, event);
            });
            electionMark.addEventListener("mouseleave", hideInspection);
            electionMark.addEventListener("blur", hideInspection);
            electionMark.addEventListener("click", function (event) {
              chooseForecast(electionPoint, false, event);
            });
            electionMark.addEventListener("keydown", function (event) {
              if (event.key === "Enter" || event.key === " ") {
                if (event.preventDefault) event.preventDefault();
                chooseForecast(electionPoint, false, event);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                if (event.preventDefault) event.preventDefault();
                chooseForecast(nearestPoint(electionPoint.time,
                  event.key === "ArrowRight" ? 1 : -1), false, event);
              }
            });
            electionDayGroup.appendChild(electionMark);
          }
          electionLayer.appendChild(electionDayGroup);
        });
        svg.appendChild(pathLayer);
        svg.appendChild(electionLayer);
        background.appendChild(svgNode("text", {
          x: glyphX + boxWidth / 2 + 2, y: plot.top + (compactChart ? 34 : 31),
          "text-anchor": "end",
          class: "election-timeseries__future-label election-timeseries__future-label--election",
          "data-election-day-distribution-label": "true"
        }, campaignPaths.rendering.election_day_distribution_label));
      }

      if (selectedMetric === "vote" && visiblePollPoints.length) {
        var scatterLayer = svgNode("g", {
          class: "election-timeseries__polls", "aria-hidden": "true",
          "clip-path": "url(#election-timeseries-plot-clip)", "pointer-events": "none"
        });
        definitions.forEach(function (definition) {
          visiblePollPoints.forEach(function (poll) {
            var pollValue = poll.values && historyNumber(poll.values[definition.id]);
            if (pollValue === null) return;
            scatterLayer.appendChild(svgNode("circle", {
              class: "election-timeseries__poll", cx: xScale(poll.time), cy: yScale(pollValue),
              r: compactChart ? 3.2 : 3.5, fill: definition.color,
              "data-poll-point": "true", "data-poll": "true",
              "data-coalition": definition.id, "data-date": poll.date,
              "data-company": poll.company, "data-value": pollValue
            }));
          });
        });
        svg.appendChild(scatterLayer);
      }

      var selectionLayer = svgNode("g", {
        class: "election-timeseries__selection", "aria-hidden": "true", "pointer-events": "none"
      });
      renderSelection = function (point) {
        selectionLayer.innerHTML = "";
        if (!point) {
          svg.removeAttribute("data-selected-date");
          svg.removeAttribute("data-inspection-date");
          return;
        }
        var iso = point.date;
        var x = point.isOriginState ? originX : xScale(point.time);
        selectionLayer.appendChild(svgNode("line", {
          x1: x, y1: plot.top, x2: x, y2: plot.bottom,
          class: "election-timeseries__crosshair", "data-timeseries-crosshair": "true",
          "data-date": iso
        }));
        definitions.forEach(function (definition) {
          var group = point.groups && point.groups[definition.id];
          var values = historyDisplayQuantiles(group, selectedMetric);
          if (!values || values.p50 === null) return;
          selectionLayer.appendChild(svgNode("circle", {
            cx: x, cy: yScale(values.p50), r: 5.5,
            class: "election-timeseries__inspection-point election-timeseries__selected-point",
            fill: definition.color, stroke: "#fff", "data-inspection-marker": "true",
            "data-marker": "selected-date", "data-coalition": definition.id,
            "data-date": iso, "data-value": values.p50,
            "aria-label": definition.label + ", " + (swedishDate(iso) || iso) +
              ": markerad median " + percent(values.p50, 1)
          }));
        });
        svg.setAttribute("data-selected-date", iso);
        svg.setAttribute("data-inspection-date", iso);
      };
      svg.appendChild(selectionLayer);

      var retainedPoint = retainedDate === null ? null :
        (pointInActiveDomain({ time: retainedDate }) ? nearestPoint(retainedDate) : defaultVisiblePoint());
      if (retainedPoint) {
        selectedDate = retainedPoint.time;
        selectedPoint = retainedPoint;
        pinnedSelection = retainedPinnedSelection;
        renderSelection(retainedPoint);
        renderDetail(retainedPoint);
      } else {
        selectedDate = null;
        selectedPoint = null;
        pinnedSelection = false;
        renderSelection(null);
        renderDetail(null);
      }

      var interactionMaxTime = futureOrigin
        ? Math.max(minTime, Math.min(futureOrigin.time, maxTime)) : maxTime;
      var hitRight = xScale(interactionMaxTime);
      var hit = svgNode("rect", {
        class: "election-timeseries__hit", x: plot.left, y: plot.top,
        width: Math.max(0, hitRight - plot.left), height: plot.height, tabindex: "0", role: "button",
        "aria-label": "Välj datum i prognosdiagrammet"
      });
      function chooseByEvent(event, persistent) {
        var time = dateForEvent(event);
        var point = nearestPoint(time === null ? interactionMaxTime : Math.min(interactionMaxTime, time));
        chooseForecast(point, persistent, event);
      }
      if (hit.addEventListener) {
        hit.addEventListener("mouseenter", function (event) { chooseByEvent(event, false); });
        hit.addEventListener("mousemove", function (event) { chooseByEvent(event, false); });
        hit.addEventListener("mouseleave", hideInspection);
        hit.addEventListener("click", function (event) { chooseByEvent(event, false); });
        hit.addEventListener("touchstart", function (event) {
          chooseByEvent(event, true);
        }, { passive: false });
      }
      svg.appendChild(hit);
      keyboardSelect = function (event) {
        // Point circles own their Enter/Arrow interaction.  This handler is
        // for the SVG and the plot hit target, which are the keyboard entry
        // points for users who do not tab through every historical mark.
        if (event && event.target !== svg && event.target !== hit) return;
        if (event && (event.key === "Enter" || event.key === " ")) {
          if (event.preventDefault) event.preventDefault();
          chooseForecast(nearestPoint(interactionMaxTime), false, event);
        } else if (event && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          if (event.preventDefault) event.preventDefault();
          chooseForecast(nearestPoint(selectedDate === null ? interactionMaxTime : selectedDate,
            event.key === "ArrowRight" ? 1 : -1), false, event);
        }
      };
      if (!svg.__timeseriesKeyboardBound) {
        svg.addEventListener("keydown", function (event) { keyboardSelect(event); });
        svg.__timeseriesKeyboardBound = true;
      }
      setModeButtons();
    }

    function chooseForecast(point, persistent, event) {
      if (!point) return;
      selectedDate = point.time;
      selectedPoint = point;
      // Only a touch selection is pinned. Mouse movement and keyboard
      // inspection always remain live, including immediately after a click.
      pinnedSelection = Boolean(persistent);
      renderSelection(point);
      renderDetail(point);
      if (event && event.preventDefault && persistent) event.preventDefault();
    }

    function hideInspection() {
      if (pinnedSelection && selectedPoint) {
        renderSelection(selectedPoint);
        renderDetail(selectedPoint);
        return;
      }
      selectedDate = null;
      selectedPoint = null;
      renderSelection(null);
      renderDetail(null);
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
    if (partyHost && partyModeAvailable) {
      partyHost.innerHTML = "";
      partyButtons = {};
      partyDefinitions.forEach(function (definition) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "election-timeseries__coalition election-timeseries__coalition-button" +
          " election-timeseries__party-button";
        button.setAttribute("data-coalition", definition.id);
        button.setAttribute("data-party", definition.id);
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-label", "Visa " + definition.name + " i diagrammet");
        button.innerHTML = "<span class=\"election-timeseries__coalition-swatch\" style=\"background:" +
          definition.color + "\" aria-hidden=\"true\"></span>" +
          "<span class=\"election-timeseries__coalition-label\">" +
          escapeHtml(definition.shortLabel) + "</span>";
        button.addEventListener("click", function () { selectTimeseriesParty(definition.id); });
        partyButtons[definition.id] = button;
        partyHost.appendChild(button);
      });
    }

    function setViewMode(mode, options) {
      var next = mode === "parties" && partyModeAvailable ? "parties" : "coalitions";
      if (next === viewMode && (!options || !options.force)) {
        setViewButtons();
        return;
      }
      viewMode = next;
      // The secondary fan has no party counterpart, so entering party mode
      // returns the future region to the primary campaign-path view.
      if (viewMode === "parties" && campaignPaths) futureView = "paths";
      renderChart();
    }

    if (viewCoalitions) viewCoalitions.addEventListener("click", function () {
      setViewMode("coalitions");
    });
    if (viewParties) viewParties.addEventListener("click", function () {
      setViewMode("parties");
    });

    if (modeVote) modeVote.addEventListener("click", function () {
      selectedMetric = "vote";
      renderChart();
    });
    if (modeSeats) modeSeats.addEventListener("click", function () {
      selectedMetric = "seats";
      renderChart();
    });
    if (futureViewPaths) futureViewPaths.addEventListener("click", function () {
      if (!campaignPaths) return;
      futureView = "paths";
      renderChart();
    });
    if (futureViewStability) futureViewStability.addEventListener("click", function () {
      if (!projection || !projection.points.length) return;
      futureView = "projection";
      renderChart();
    });
    if (campaignCue) campaignCue.addEventListener("click", function () {
      selectedRange = "short";
      renderChart();
      var shortButton = byId("election-timeseries-range-short");
      if (shortButton && shortButton.focus) shortButton.focus();
    });
    if (rangeFull) rangeFull.addEventListener("click", function () {
      selectedRange = "full";
      renderChart();
    });
    if (rangeShort) rangeShort.addEventListener("click", function () {
      selectedRange = "short";
      renderChart();
    });
    section.setAttribute("data-history-schema-version", history.schemaVersion);
    section.setAttribute("data-history-point-count", String(history.points.length));
    section.setAttribute("data-history-poll-count", String(history.polls.length));
    section.setAttribute("data-party-point-count", String(history.partyPointCount || 0));
    if (history.partyDefinitionsDeclared && !partyModeAvailable) {
      // Declared but unusable: say so in the DOM rather than silently
      // pretending nothing was published.
      section.setAttribute("data-party-view-state", "invalid");
    } else {
      section.setAttribute("data-party-view-state", partyModeAvailable ? "ready" : "absent");
    }

    if (partyModeAvailable) {
      // Prefer whatever the reader already singled out elsewhere on the page.
      // Otherwise pick the largest party in the certified forecast: a
      // deterministic, data-driven default that opens on a series with real
      // movement rather than on an alphabetical accident.
      var certified = history.points.filter(function (point) {
        return point.provenance === "current_production";
      }).pop();
      var fallback = partyDefinitions[0].id;
      var best = null;
      partyDefinitions.forEach(function (definition) {
        var group = certified && certified.groups && certified.groups[definition.id];
        var median = group && group.vote ? historyNumber(group.vote.p50) : null;
        if (median !== null && (best === null || median > best.median)) {
          best = { id: definition.id, median: median };
        }
      });
      if (best) fallback = best.id;
      var preselected = partyDefinitions.filter(function (definition) {
        return definition.id === selectedParty;
      });
      selectedPartyId = preselected.length ? preselected[0].id : fallback;
      setPartyButtons();
      enablePartyTimelineLinks(partyDefinitions.map(function (definition) {
        return definition.id;
      }));
      // The direct-navigation action from "Röstandelar på valdagen".
      showPartyTimeline = function (party) {
        if (!selectTimeseriesParty(party, { render: false })) return false;
        setViewMode("parties", { force: true });
        if (section.scrollIntoView) {
          section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        // Focus lands on the control that now holds the state, so a keyboard
        // reader arrives at the chart's own party selector rather than being
        // scrolled somewhere with focus left behind in the vote rows.
        var button = partyButtons[party];
        if (button && button.focus) button.focus({ preventScroll: true });
        return true;
      };
    } else {
      enablePartyTimelineLinks([]);
      showPartyTimeline = null;
    }
    ["election-timeseries-key-projection", "election-timeseries-key-campaign-paths",
      "election-timeseries-key-election-day", "election-timeseries-projection-note",
      "election-timeseries-campaign-note"
    ].forEach(function (id) {
      var previous = byId(id);
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
    });
    var keyList = section.querySelector(".election-timeseries__key");
    var provenanceAnchor = byId("election-timeseries-provenance-note");
    function appendNote(id, text) {
      if (!provenanceAnchor || !provenanceAnchor.parentNode) return;
      var note = document.createElement("p");
      note.id = id;
      note.className = "election-timeseries__note election-muted";
      note.textContent = text;
      provenanceAnchor.parentNode.insertBefore(note, provenanceAnchor);
      return note;
    }
    // Both future views publish their own Swedish copy.  Create every legend
    // key and note that the payload supports, then let setModeButtons show
    // only the copy that belongs to the view actually on screen.
    if (campaignPaths) {
      if (keyList) {
        var pathKey = document.createElement("span");
        pathKey.id = "election-timeseries-key-campaign-paths";
        pathKey.className = "election-timeseries__key-item";
        pathKey.innerHTML = "<span aria-hidden=\"true\" style=\"display:inline-block;width:1.5rem;" +
          "border-top:1px solid currentColor;vertical-align:middle;margin-right:.35rem;opacity:.4\"></span>" +
          escapeHtml(campaignPaths.rendering.path_legend_label);
        keyList.appendChild(pathKey);
        var electionKey = document.createElement("span");
        electionKey.id = "election-timeseries-key-election-day";
        electionKey.className = "election-timeseries__key-item";
        electionKey.innerHTML = "<span aria-hidden=\"true\" style=\"display:inline-block;width:.5rem;" +
          "height:1rem;border-radius:2px;background:currentColor;vertical-align:middle;" +
          "margin-right:.35rem;opacity:.5\"></span>" +
          escapeHtml(campaignPaths.rendering.election_day_distribution_label);
        keyList.appendChild(electionKey);
      }
      appendNote("election-timeseries-campaign-note",
        "Fanan börjar i opinionsläget i dag. Valdagsprognosen är bredare eftersom den också " +
        "inkluderar osäkerheten mellan dagens opinion och det faktiska valresultatet.");
    }
    if (projection && projection.points.length) {
      if (keyList) {
        var projectionKey = document.createElement("span");
        projectionKey.id = "election-timeseries-key-projection";
        projectionKey.className = "election-timeseries__key-item";
        projectionKey.innerHTML = "<span aria-hidden=\"true\" style=\"display:inline-block;width:1.5rem;" +
          "border-top:2px dashed currentColor;vertical-align:middle;margin-right:.35rem;opacity:.65\"></span>" +
          escapeHtml(projection.rendering.legend_label);
        keyList.appendChild(projectionKey);
      }
      // The concrete conditional disclosure, plus the demotion sentence when
      // the publication carries one.
      appendNote("election-timeseries-projection-note",
        (history.secondaryProjectionDescription
          ? history.secondaryProjectionDescription + " "
          : "") + projection.tooltip);
    }
    if (campaignPaths) {
      setText("election-timeseries-intro",
        "Historisk prognos fram till i dag. Därefter visas möjliga opinionsbanor fram till valdagen. " +
        "Valdagsprognosen är bredare eftersom den också inkluderar osäkerheten mellan dagens " +
        "opinion och det faktiska valresultatet.");
    } else {
      setText("election-timeseries-intro", projection && projection.points.length
        ? "Historisk prognos fram till i dag. Därefter visas en villkorad projektion till valdagen. " +
          "Enskilda mätningar visas i den historiska röstandelsdelen."
        : "Historisk prognos med enskilda mätningar som jämförelse i röstandelsvyn.");
    }
    setViewButtons();
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
            : "<p class=\"ev-detail__actions\"><button type=\"button\" class=\"ev-detail__timeline\"" +
              " data-party-timeline=\"" + escapeHtml(name) + "\"" +
              " aria-label=\"Visa " + escapeHtml(fullName) + "s utveckling i V\u00e4gen till valdagen\"" +
              " hidden>Visa utveckling <span aria-hidden=\"true\">\u2192</span></button></p>") +
        "</div>";

      track(name, row, "ev-row");
      var head = row.querySelector(".ev-head");
      var detail = row.querySelector(".ev-detail");
      partyPanels[name] = { head: head, detail: detail };
      if (head && head.addEventListener) {
        head.addEventListener("click", function () { selectParty(name); });
      }
      // Stays hidden until the history artifact turns out to publish the
      // party family, so an older publication never offers a dead action.
      var timelineLink = row.querySelector(".ev-detail__timeline");
      if (timelineLink) {
        partyTimelineLinks[name] = timelineLink;
        timelineLink.hidden = !partyTimelineIsAvailable(name);
        if (timelineLink.addEventListener) {
          timelineLink.addEventListener("click", function () {
            if (typeof showPartyTimeline === "function") showPartyTimeline(name);
          });
        }
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
    // 1.4 is 1.3 plus metadata only (election_noise_law / election_noise_candidate);
    // groups.json keeps the 1.3 coalition contract, histograms included.  Without
    // accepting it the builder returns null and every panel built on the coalition
    // table silently vanishes from a perfectly valid publication.
    var COALITION_SCHEMAS = ["1.2", "1.3", "1.4"];
    var HISTOGRAM_SCHEMAS = ["1.3", "1.4"];
    if (!groups || COALITION_SCHEMAS.indexOf(groups.schema_version) === -1) {
      return null;
    }
    var histogramRequired = HISTOGRAM_SCHEMAS.indexOf(groups.schema_version) !== -1;
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
    // The published calibration evidence was produced under the previous model and is
    // deliberately not regenerated, so the page must say which model it describes.
    // Presenting v1.0-rc1 hindcasts under a v1.1 forecast without that sentence would
    // read as a validation of the adopted election-day error model, which it is not.
    blocks.push("<p>Den h\u00e4r efterhandsutv\u00e4rderingen avser den tidigare modellen " +
      "v1.0-rc1. Den visas som historisk dokumentation och ska inte tolkas som en separat " +
      "utv\u00e4rdering av den nya valdagsfelsmodellen i v1.1.</p>");

    var coverage = coverageRow(sources.vote_share_hindcast);
    if (coverage) {
      blocks.push("<h3 class=\"election-subhead\">Historisk tr\u00e4ffs\u00e4kerhet f\u00f6r prognosintervall</h3>" +
        "<p>Tabellen visar hur ofta valresultatet l\u00e5g inom modellens intervall i " +
        "efterhandsutv\u00e4rderingen av valen 2018 och 2022, ber\u00e4knad med den tidigare " +
        "modellen v1.0-rc1. Det \u00e4r ingen garanti f\u00f6r 2026.</p>" +
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
      ["Valresultatsbrus", metadata.election_noise_law
        ? metadata.election_noise_law + " (kandidat " + (metadata.election_noise_candidate || "\u2014") + ")"
        : "\u2014"],
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
