(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // The election page in two parts: the forecast (what the next election
  // could bring) and the 2026 election (what happened), which has views of
  // its own -- the result, the voter flows and the demographic analysis.
  // The forecast is the default. A view's data-tab-hash (#valet-2026,
  // #valjarfloden, #demografi) opens it directly, and a link to anything
  // inside a view brings that view, and the part holding it, back.
  // ---------------------------------------------------------------------
  var main = document.getElementById("election-tabs");
  if (!main) return;

  function panelFor(tab) {
    return document.getElementById(tab.getAttribute("aria-controls"));
  }

  function tablist(root) {
    var tabs = root ? Array.prototype.slice.call(root.querySelectorAll("[role=tab]")) : [];
    return tabs.length && tabs.every(panelFor) ? tabs : null;
  }

  var parts = tablist(main);
  if (!parts) return;
  // The views inside a part, keyed by the part's panel id.
  var views = {};
  parts.forEach(function (part) {
    var panel = panelFor(part);
    var inner = tablist(panel.querySelector("[role=tablist]"));
    if (inner) views[panel.id] = inner;
  });

  function selected(tabs) {
    return tabs.filter(function (tab) { return tab.getAttribute("aria-selected") === "true"; })[0] || tabs[0];
  }

  // The innermost panel on screen: the chosen view of a part that has views.
  function visiblePanel() {
    var panel = panelFor(selected(parts));
    var inner = views[panel.id];
    return inner ? panelFor(selected(inner)) : panel;
  }

  function hashFor(tab) {
    var inner = views[panelFor(tab).id];
    return (inner ? selected(inner) : tab).getAttribute("data-tab-hash");
  }

  function select(tabs, tab) {
    tabs.forEach(function (other) {
      var chosen = other === tab;
      other.setAttribute("aria-selected", chosen ? "true" : "false");
      other.tabIndex = chosen ? 0 : -1;
      panelFor(other).hidden = !chosen;
    });
  }

  // Show a view: its own tab, and the part it belongs to.
  function activate(tab, updateHash) {
    var owner = null;
    Object.keys(views).forEach(function (id) {
      if (views[id].indexOf(tab) >= 0) owner = id;
    });
    if (owner) {
      select(views[owner], tab);
      select(parts, parts.filter(function (part) { return panelFor(part).id === owner; })[0]);
    } else {
      select(parts, tab);
    }
    if (updateHash && window.history && window.history.replaceState) {
      var hash = owner ? tab.getAttribute("data-tab-hash") : hashFor(tab);
      window.history.replaceState(null, "",
        window.location.pathname + window.location.search + (hash ? "#" + hash : ""));
    }
    document.dispatchEvent(new CustomEvent("election-tab-change", { detail: { panel: visiblePanel().id } }));
  }

  function bindKeys(tabs) {
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
  }
  bindKeys(parts);
  Object.keys(views).forEach(function (id) { bindKeys(views[id]); });

  // Every tab that names a view, innermost first, so a part and its first
  // view sharing a hash resolve to the view.
  function allTabs() {
    var inner = [];
    Object.keys(views).forEach(function (id) { inner = inner.concat(views[id]); });
    return inner.concat(parts);
  }

  function syncToHash() {
    var hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    var named = allTabs().filter(function (tab) { return tab.getAttribute("data-tab-hash") === hash; })[0];
    if (named) {
      activate(named, false);
      return;
    }
    var target = null;
    try { target = document.getElementById(decodeURIComponent(hash)); } catch (error) { target = null; }
    if (!target) return;
    var owner = allTabs().filter(function (tab) { return panelFor(tab).contains(target); })[0];
    if (owner) activate(owner, false);
  }
  window.addEventListener("hashchange", syncToHash);
  syncToHash();
}());
