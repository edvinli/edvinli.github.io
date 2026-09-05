(function () {
  "use strict";

  var app = document.getElementById("election-simulator-app");
  if (!app) return;
  var months = ["jan", "feb", "mars", "apr", "maj", "juni",
    "juli", "aug", "sep", "okt", "nov", "dec"];

  function pollDate() {
    var node = document.getElementById("election-latest-poll");
    var match = node && /^(\d{4})-(\d{2})-(\d{2})/.exec(node.getAttribute("data-latest-poll-date") || "");
    return match ? Number(match[3]) + " " + months[Number(match[2]) - 1] + " " + match[1] : null;
  }

  function apply() {
    var asOf = document.getElementById("election-hero-asof");
    var label = asOf && asOf.previousElementSibling;
    var latest = pollDate();
    if (label) label.textContent = latest ? "Opinionsunderlag t.o.m." : "Prognosdag";
    if (latest && asOf) asOf.textContent = latest;

    var updated = document.getElementById("election-hero-updated");
    if (updated && updated.firstChild && updated.firstChild.nodeType === 3 &&
        /^Uppdaterad /.test(updated.firstChild.nodeValue || "")) {
      updated.firstChild.nodeValue = updated.firstChild.nodeValue.replace(/^Uppdaterad /, "Prognos beräknad ");
    }

    var note = document.getElementById("election-vote-change-note");
    if (note && !note.hidden && note.textContent && note.textContent.indexOf("0,05 procentenheter") === -1) {
      note.textContent += " Förändringar under 0,05 procentenheter visas som oförändrade.";
    }
  }

  apply();
  if (typeof MutationObserver === "function") {
    new MutationObserver(apply).observe(app, { childList: true, subtree: true, characterData: true, attributes: true });
  }
})();
