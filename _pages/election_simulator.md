---
title: "Election Simulator"
permalink: /election-simulator/
layout: single
author_profile: false
classes: wide
excerpt: "A transparent Swedish Riksdag forecast with predictive intervals, seat distributions, and validation evidence."
---

<div id="election-simulator-app" class="election-app" data-publication-base="{{ site.baseurl }}/files/election-simulator">
  <noscript>
    <p class="notice--warning">This forecast needs JavaScript to load its static data. The downloadable JSON files remain available in the publication directory.</p>
  </noscript>

  <p id="election-app-status" class="election-status" role="status" aria-live="polite">Loading the latest forecast…</p>

  <section id="election-headline" class="election-panel" hidden>
    <div class="election-panel__eyebrow">Swedish Riksdag · <span data-field="as-of"></span></div>
    <h2>National vote forecast</h2>
    <p class="election-muted">Median estimates with central predictive intervals. These are predictive intervals, not confidence intervals.</p>
    <div id="election-party-cards" class="election-party-cards"></div>
  </section>

  <section id="election-seats" class="election-panel" hidden>
    <h2>Seat distribution</h2>
    <p class="election-muted">The parliament contains 349 seats. Bars show marginal medians; ranges show the central 90% predictive interval. The parliament view shows one coherent simulated allocation closest to those medians.</p>
    <div id="election-seat-bars" class="election-seat-bars"></div>
    <div id="election-parliament" class="election-parliament" role="img" aria-label="349-seat parliament visualization"></div>
  </section>

  <section id="election-changes" class="election-panel" hidden>
    <h2>Change since prior forecast</h2>
    <p id="election-changes-status" class="election-muted"></p>
    <div id="election-changes-content" class="election-changes-table"></div>
  </section>

  <section id="election-groups" class="election-panel" hidden>
    <h2>Party-group probabilities</h2>
    <label for="election-group-select">Choose a published group:</label>
    <select id="election-group-select"></select>
    <p id="election-group-result" class="election-group-result"></p>
  </section>

  <section id="election-validation" class="election-panel" hidden>
    <h2>Validation and limitations</h2>
    <div id="election-validation-content"></div>
  </section>

  <section id="election-meta" class="election-panel election-meta" hidden>
    <h2>Model metadata</h2>
    <dl id="election-meta-list"></dl>
  </section>
</div>

<script src="{{ site.baseurl }}/assets/js/election-simulator.js"></script>
