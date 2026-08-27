---
title: "Swedish Riksdag election forecast"
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
  <header class="election-hero" id="election-hero">
    <p class="election-hero__kicker">Sweden · Riksdag · 2026 election forecast</p>
    <dl class="election-hero__facts">
      <div class="election-hero__fact">
        <dt>Forecast as of</dt>
        <dd id="election-hero-asof">—</dd>
      </div>
      <div class="election-hero__fact">
        <dt>Election day</dt>
        <dd id="election-hero-election">—</dd>
      </div>
      <div class="election-hero__fact">
        <dt>Time remaining</dt>
        <dd id="election-hero-countdown">—</dd>
      </div>
    </dl>
    <p class="election-hero__lede" id="election-hero-lede">Loading the published simulation…</p>
    <p class="election-status" id="election-app-status" role="status" aria-live="polite">Loading the latest forecast…</p>
    <p class="election-hero__links"><a href="#election-methodology">Methodology &amp; validation</a><span aria-hidden="true"> · </span><a href="#election-technical">Technical metadata</a></p>
  </header>
  <p id="election-selection-note" class="visually-hidden" role="status" aria-live="polite"></p>
  <section id="election-headline" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>National vote forecast</h2>
      <p class="election-muted">Median vote share with the central 90% predictive interval (light) and 50% predictive interval (solid). These are predictive intervals, not confidence intervals. Select a party to see every interval and to highlight it across the page.</p>
    </div>
    <div id="election-party-cards" class="election-vote-rows"></div>
    <div id="election-vote-axis" class="ev-axis"></div>
    <p class="election-legend-note election-muted"><span class="election-key"><span class="election-key__mark election-key__mark--median" aria-hidden="true"></span>median</span><span class="election-key"><span class="election-key__mark election-key__mark--p50" aria-hidden="true"></span>50% interval</span><span class="election-key"><span class="election-key__mark election-key__mark--p90" aria-hidden="true"></span>90% interval</span><span class="election-key"><span class="election-key__mark election-key__mark--threshold" aria-hidden="true"></span>4% national threshold</span></p>
  </section>
  <section id="election-seats" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Seats</h2>
      <p class="election-muted">The Riksdag has 349 seats; 175 are needed for a majority. Each bar shows a party’s median seat count across the simulations, and the darker line shows its central 90% predictive interval. Party medians are calculated separately and therefore do not necessarily add up to 349.</p>
    </div>
    <div id="election-seat-bars" class="election-seat-bars" role="list"></div>
    <div id="election-seat-axis" class="es-axis"></div>
    <h3 class="election-subhead">A representative chamber</h3>
    <p class="election-muted" id="election-parliament-caption"></p>
    <div class="election-parliament-frame">
      <div id="election-parliament" class="election-parliament" role="img" aria-label="349-seat parliament visualization"></div>
      <span class="election-parliament__centre" aria-hidden="true"><span class="election-parliament__centre-label">175th seat</span></span>
    </div>
    <ul id="election-parliament-legend" class="ep-legend"></ul>
  </section>
  <section id="election-groups" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Majority scenarios</h2>
      <p class="election-muted">Select a party combination to see its combined seat distribution and chance of reaching 175 seats.</p>
    </div>
    <div id="election-group-pills" class="eg-pills"></div>
    <div id="election-group-result" class="eg-result"></div>
    <div id="election-group-histogram" class="eg-histogram"></div>
  </section>
  <section id="election-changes" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Change since the prior forecast</h2>
      <p class="election-muted" id="election-changes-status"></p>
    </div>
    <div id="election-changes-content" class="election-changes-table"></div>
  </section>
  <section id="election-validation" class="election-panel election-disclosure" hidden>
    <details id="election-methodology">
      <summary><h2 class="election-disclosure__title">Methodology &amp; validation<span class="election-disclosure__hint" aria-hidden="true">retrospective evidence, coverage and limitations</span></h2></summary>
      <div id="election-validation-content" class="election-disclosure__body"></div>
    </details>
  </section>
  <section id="election-meta" class="election-panel election-disclosure election-meta" hidden>
    <details id="election-technical">
      <summary><h2 class="election-disclosure__title">Technical metadata<span class="election-disclosure__hint" aria-hidden="true">provenance, hashes and model version</span></h2></summary>
      <dl id="election-meta-list" class="election-disclosure__body"></dl>
    </details>
  </section>
</div>

<script src="{{ site.baseurl }}/assets/js/election-simulator.js"></script>
