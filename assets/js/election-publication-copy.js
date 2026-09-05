(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni",
    "juli", "aug", "sep", "okt", "nov", "dec"];

  function swedishDate(value) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    if (!parts) return null;
    var month = MONTHS[Number(parts[2]) - 1];
    return month ? String(Number(parts[3])) + " " + month + " " + parts[1] : null;
  }

  function latestPollDate() {
    var latest = document.getElementById("election-latest-poll");
    return latest ? swedishDate(latest.getAttribute("data-latest-poll-date")) : null;
  }

  function clarifyLede(node, pollDate) {
    if (!node) return;
    var text = node.textContent || "";
    var markers = [
      "Den bygger på underlag till och med ",
      "Prognosen är beräknad för ",
      "Den använder opinionsunderlag t.o.m. "
    ];
    var marker = null;
    var start = -1;
    for (var index = 0; index < markers.length; index += 1) {
      start = text.indexOf(markers[index]);
      if (start !== -1) {
        marker = markers[index];
        break;
      }
    }
    if (!marker) return;

    var suffixStart = text.indexOf(" och ", start + marker.length);
    if (suffixStart === -1) return;
    var currentDate = text.slice(start + marker.length, suffixStart);
    var replacement = pollDate
      ? "Den använder opinionsunderlag t.o.m. " + pollDate
      : "Prognosen är beräknad för " + currentDate;
    var next = text.slice(0, start) + replacement + text.slice(suffixStart);
    if (next !== text) node.textContent = next;
  }

  function applyCopy() {
    var pollDate = latestPollDate();
    var asOf = document.getElementById("election-hero-asof");
    var asOfLabel = asOf && asOf.previousElementSibling;
    if (pollDate && asOf) {
      if (asOfLabel) asOfLabel.textContent = "Opinionsunderlag t.o.m.";
      if (asOf.textContent !== pollDate) asOf.textContent = pollDate;
    } else if (asOfLabel && asOfLabel.textContent === "Underlag t.o.m.") {
      asOfLabel.textContent = "Prognosdag";
    }

    var updated = document.getElementById("election-hero-updated");
    if (updated && updated.firstChild && updated.firstChild.nodeType === 3) {
      var prefix = updated.firstChild.nodeValue || "";
      if (prefix.indexOf("Uppdaterad ") === 0) {
        updated.firstChild.nodeValue = prefix.replace(/^Uppdaterad /, "Prognos beräknad ");
      }
    }

    clarifyLede(document.getElementById("election-hero-lede"), pollDate);

    var voteNote = document.getElementById("election-vote-change-note");
    if (voteNote && !voteNote.hidden && voteNote.textContent &&
        voteNote.textContent.indexOf("Förändringar under 0,05 procentenheter") === -1) {
      voteNote.textContent += " Förändringar under 0,05 procentenheter visas som oförändrade.";
    }
  }

  applyCopy();
  if (typeof MutationObserver === "function") {
    new MutationObserver(applyCopy).observe(app, {
      attributes: true,
      attributeFilter: ["data-latest-poll-date", "hidden"],
      characterData: true,
      childList: true,
      subtree: true
    });
  }
})();
