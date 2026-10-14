(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // The forecast's section descriptions, behind a small (i) beside each
  // heading. The charts are what a reader came for; the sentence explaining
  // a chart is one hover or tap away instead of a paragraph between the
  // heading and the chart.
  //
  // The description paragraphs are moved, not copied, into the popover, so
  // everything that writes them by id -- the app rewrites several once the
  // data is in -- keeps working, and a paragraph the app hides stays hidden.
  // Hovering the button shows the text; a click or tap pins it open until
  // the next click, a click elsewhere or Escape.
  // ---------------------------------------------------------------------
  var app = document.getElementById("election-simulator-app");
  if (!app) return;

  var finePointer = Boolean(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  var popovers = [];

  function close(entry) {
    entry.pinned = false;
    entry.panel.hidden = true;
    entry.button.setAttribute("aria-expanded", "false");
  }

  function open(entry, pinned) {
    popovers.forEach(function (other) { if (other !== entry) close(other); });
    entry.pinned = Boolean(pinned);
    entry.panel.hidden = false;
    entry.button.setAttribute("aria-expanded", "true");
  }

  Array.prototype.forEach.call(app.querySelectorAll(".election-panel__head"), function (head, index) {
    var heading = head.querySelector("h2");
    var texts = Array.prototype.filter.call(head.children, function (child) {
      return child.tagName === "P";
    });
    if (!heading || !texts.length) return;

    var panel = document.createElement("div");
    panel.className = "election-info__panel";
    panel.id = (head.parentNode && head.parentNode.id ? head.parentNode.id : "election-section-" + index) + "-info";
    panel.hidden = true;
    texts.forEach(function (text) { panel.appendChild(text); });

    var button = document.createElement("button");
    button.type = "button";
    button.className = "election-info__button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panel.id);
    button.setAttribute("aria-label", "Om " + heading.textContent.replace(/\s+/g, " ").trim());
    button.textContent = "i";

    head.classList.add("election-panel__head--info");
    heading.insertAdjacentElement("afterend", button);
    button.insertAdjacentElement("afterend", panel);

    var entry = { button: button, panel: panel, pinned: false };
    popovers.push(entry);

    button.addEventListener("click", function () {
      if (entry.pinned) close(entry);
      else open(entry, true);
    });
    if (finePointer) {
      button.addEventListener("mouseenter", function () { if (panel.hidden) open(entry, false); });
      head.addEventListener("mouseleave", function () { if (!entry.pinned) close(entry); });
    }
  });

  if (!popovers.length) return;

  document.addEventListener("click", function (event) {
    popovers.forEach(function (entry) {
      if (entry.panel.hidden) return;
      if (entry.button.contains(event.target) || entry.panel.contains(event.target)) return;
      close(entry);
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    popovers.forEach(function (entry) {
      if (entry.panel.hidden) return;
      close(entry);
      if (entry.button === document.activeElement || entry.panel.contains(document.activeElement)) {
        entry.button.focus();
      }
    });
  });
})();
