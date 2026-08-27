(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var base = app.getAttribute("data-publication-base").replace(/\/$/, "");
  var status = document.getElementById("election-app-status");
  var partyColors = {
    M: "#6b4f9c", L: "#6b6b6b", C: "#2d8f45", KD: "#2d6ca2",
    S: "#d84b4b", V: "#be5b82", MP: "#4a9b48", SD: "#e28a32", REST: "#9b9b9b"
  };
  var partyNames = { M: "M", L: "L", C: "C", KD: "KD", S: "S", V: "V", MP: "MP", SD: "SD", REST: "REST" };

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

  function format(value, digits) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toFixed(digits === undefined ? 1 : digits);
  }

  function interval(party, low, high) {
    return "[" + format(party[low], 1) + "–" + format(party[high], 1) + "]";
  }

  function renderForecast(forecast, parties) {
    var headline = document.getElementById("election-headline");
    headline.hidden = false;
    headline.querySelector("[data-field=as-of]").textContent = forecast.as_of || "";
    var cards = document.getElementById("election-party-cards");
    var order = parties.party_order || Object.keys(forecast.parties);
    cards.innerHTML = "";
    order.forEach(function (name) {
      var party = forecast.parties[name];
      if (!party) return;
      var card = document.createElement("article");
      card.className = "election-party-card";
      card.style.borderTopColor = partyColors[name] || "#777";
      var thresholdValue = forecast.threshold_probabilities_4pct && forecast.threshold_probabilities_4pct[name];
      var threshold = name === "REST" || thresholdValue === undefined ? "n/a (aggregate)" : format(thresholdValue * 100, 1) + "%";
      card.innerHTML = "<h3>" + (partyNames[name] || name) + "</h3>" +
        "<div class=\"election-party-card__median\">" + format(party.vote_share_median, 1) + "%</div>" +
        "<dl>" +
        "<dt>50% interval</dt><dd>" + interval(party, "vote_share_p25", "vote_share_p75") + "</dd>" +
        "<dt>80% interval</dt><dd>" + interval(party, "vote_share_p10", "vote_share_p90") + "</dd>" +
        "<dt>90% interval</dt><dd>" + interval(party, "vote_share_p05", "vote_share_p95") + "</dd>" +
        "<dt>≥4% probability</dt><dd>" + threshold + "</dd>" +
        "</dl>";
      cards.appendChild(card);
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

  function renderSeats(seats, requireRepresentative) {
    var section = document.getElementById("election-seats");
    section.hidden = false;
    var bars = document.getElementById("election-seat-bars");
    bars.innerHTML = "";
    var order = seats.party_order || Object.keys(seats.seat_summary);
    order.forEach(function (name) {
      var row = seats.seat_summary[name];
      if (!row) return;
      var item = document.createElement("div");
      item.className = "election-seat-row";
      item.innerHTML = "<span class=election-seat-row__label>" + name + "</span>" +
        "<span class=election-seat-row__track><span class=election-seat-row__fill></span></span>" +
        "<span class=election-seat-row__value>" + format(row.median, 0) + " <small>(" + format(row.p05, 0) + "–" + format(row.p95, 0) + ")</small></span>";
      item.querySelector(".election-seat-row__fill").style.width = Math.min(100, (Number(row.median) / 175) * 100) + "%";
      item.querySelector(".election-seat-row__fill").style.backgroundColor = partyColors[name] || "#777";
      bars.appendChild(item);
    });
    var parliament = document.getElementById("election-parliament");
    parliament.innerHTML = "";
    var display = displaySeatAllocation(seats, order, requireRepresentative);
    var seatIndex = 0;
    order.forEach(function (name) {
      var seatCount = display.allocation[name] || 0;
      for (var i = 0; i < seatCount; i += 1) {
        var seat = document.createElement("span");
        seat.className = "election-seat";
        seat.style.backgroundColor = partyColors[name] || "#777";
        seat.setAttribute("aria-hidden", "true");
        parliament.appendChild(seat);
        seatIndex += 1;
      }
    });
    while (seatIndex < 349) {
      var empty = document.createElement("span");
      empty.className = "election-seat election-seat--empty";
      empty.setAttribute("aria-hidden", "true");
      parliament.appendChild(empty);
      seatIndex += 1;
    }
    parliament.setAttribute("aria-label", "349-seat parliament; " + display.source.replace(/_/g, " ") + " with " + seatIndex + " seat positions");
  }

  function renderChanges(forecast, parties) {
    var section = document.getElementById("election-changes");
    section.hidden = false;
    var statusText = document.getElementById("election-changes-status");
    var content = document.getElementById("election-changes-content");
    var change = forecast.change_since_prior || {};
    if (change.status !== "AVAILABLE") {
      statusText.textContent = "No earlier immutable snapshot is available for comparison.";
      content.textContent = "";
      return;
    }
    statusText.textContent = "Median change since the snapshot dated " + (change.prior_as_of || "unknown") + ". Positive values indicate an increase.";
    var vote = change.vote_share_median_change_pp || {};
    var seats = change.seat_median_change || {};
    var order = parties.party_order || Object.keys(vote);
    var rows = order.map(function (name) {
      if (name === "REST") return "";
      var voteValue = vote[name];
      var seatValue = seats[name];
      return "<tr><th scope=\"row\">" + name + "</th><td>" + (voteValue === undefined ? "—" : (Number(voteValue) >= 0 ? "+" : "") + format(voteValue, 1) + " pp") + "</td><td>" + (seatValue === undefined ? "—" : (Number(seatValue) >= 0 ? "+" : "") + format(seatValue, 0)) + "</td></tr>";
    }).join("");
    content.innerHTML = "<table><thead><tr><th scope=\"col\">Party</th><th scope=\"col\">Vote median</th><th scope=\"col\">Seat median</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function renderGroups(groups) {
    var section = document.getElementById("election-groups");
    section.hidden = false;
    var select = document.getElementById("election-group-select");
    var result = document.getElementById("election-group-result");
    Object.keys(groups.groups || {}).forEach(function (name) {
      var option = document.createElement("option");
      option.value = name;
      option.textContent = name.replace(/_/g, " ");
      select.appendChild(option);
    });
    function update() {
      var group = groups.groups[select.value];
      if (!group) return;
      result.textContent = group.parties.join(" + ") + ": " + format(Number(group.prob_majority) * 100, 1) + "% probability of at least " + group.majority_threshold + " seats (median " + format(group.median_seats, 0) + ").";
    }
    select.addEventListener("change", update);
    update();
  }

  function renderValidation(calibration) {
    var section = document.getElementById("election-validation");
    section.hidden = false;
    var content = document.getElementById("election-validation-content");
    var head = calibration.source_files && calibration.source_files.pop_head_to_head;
    var statusText = head && head.summary ? head.summary.benchmark_status : "not run";
    content.innerHTML = "<p>Historical scores are retrospective evidence, not independent holdout validation. The PoP head-to-head benchmark status is <strong>" + statusText + "</strong>.</p>" +
      "<p>Uncertainty is represented by joint Python simulations; intervals are predictive intervals. REST is aggregate modeled-ineligible vote mass and cannot independently qualify.</p>";
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

  function renderMetadata(metadata, manifest) {
    var section = document.getElementById("election-meta");
    section.hidden = false;
    var dl = document.getElementById("election-meta-list");
    var rows = [
      ["Last update", metadata.generated_at_utc || "—"],
      ["As of", metadata.as_of || "—"],
      ["Model", (metadata.model && metadata.model.version) || "—"],
      ["Source commit", metadata.source_git_commit || "—"],
      ["Payload hash", metadata.deterministic_payload_sha256 || (manifest && manifest.deterministic_payload_sha256) || "—"],
      ["Publication", metadata.source_worktree_clean === true && manifest && manifest.source_worktree_clean === true ? "CERTIFIED (clean source)" : "UNCERTIFIED (source provenance is not clean/complete)"]
    ];
    dl.innerHTML = rows.map(function (row) { return "<dt>" + row[0] + "</dt><dd><code>" + row[1] + "</code></dd>"; }).join("");
    return metadata.source_worktree_clean === true && manifest && manifest.source_worktree_clean === true;
  }

  loadPublication()
    .then(function (publication) {
      var data = publication.files;
      validatePublicationBundle(data, publication.pointer, publication.manifest_sha256);
      renderForecast(data[0], data[1]);
      renderSeats(data[2], Boolean(publication.pointer));
      renderChanges(data[0], data[1]);
      renderGroups(data[3]);
      renderValidation(data[4]);
      var certified = renderMetadata(data[5], data[6]);
      status.textContent = certified ? "Certified forecast loaded." : "Forecast loaded, but it is not certified.";
    })
    .catch(function (error) {
      status.className += " election-status--error";
      status.textContent = "Forecast unavailable: " + error.message;
    });
}());
