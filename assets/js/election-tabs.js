(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // The election page's views: the forecast and the panels beside it.  The
  // forecast is the default; a tab's data-tab-hash (#valjarfloden,
  // #demografi) opens it directly, and a link to anything inside a panel
  // brings that panel back.
  // ---------------------------------------------------------------------
  var tablist = document.getElementById("election-tabs");
  if (!tablist) return;
  var tabs = Array.prototype.slice.call(tablist.querySelectorAll("[role=tab]"));

  function panelFor(tab) {
    return document.getElementById(tab.getAttribute("aria-controls"));
  }
  if (!tabs.length || !tabs.every(panelFor)) return;

  function activate(tab, updateHash) {
    tabs.forEach(function (other) {
      var selected = other === tab;
      other.setAttribute("aria-selected", selected ? "true" : "false");
      other.tabIndex = selected ? 0 : -1;
      panelFor(other).hidden = !selected;
    });
    if (updateHash && window.history && window.history.replaceState) {
      var hash = tab.getAttribute("data-tab-hash");
      window.history.replaceState(null, "",
        window.location.pathname + window.location.search + (hash ? "#" + hash : ""));
    }
    document.dispatchEvent(new CustomEvent("election-tab-change", { detail: { panel: panelFor(tab).id } }));
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { activate(tab, true); });
    tab.addEventListener("keydown", function (event) {
      var next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      activate(next, true);
      next.focus();
    });
  });

  function syncToHash() {
    var hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    var named = tabs.filter(function (tab) { return tab.getAttribute("data-tab-hash") === hash; })[0];
    if (named) {
      activate(named, false);
      return;
    }
    var target = null;
    try { target = document.getElementById(decodeURIComponent(hash)); } catch (error) { target = null; }
    if (!target) return;
    var owner = tabs.filter(function (tab) { return panelFor(tab).contains(target); })[0];
    if (owner) activate(owner, false);
  }
  window.addEventListener("hashchange", syncToHash);
  syncToHash();
}());
