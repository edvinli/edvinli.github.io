---
title: "Riksdagen röstar"
permalink: /riksdagen-roster/
layout: single
author_profile: false
classes: wide
excerpt: "Hur partierna och ledamöterna röstar i riksdagens voteringar: samstämmighet mellan partierna, en karta över röstmönstren, röster mot partilinjen och alla voteringar."
---

<!-- Everything on this page is drawn by assets/js/riksdag-votes.js from
     files/riksdag/ (the riksdag_votes pipeline in the election-simulator
     repository). The page loads index.json and one summary first; a
     session's votes.json is fetched only when the vote browser, or a
     member's list of votes, needs it. -->
<div id="riksdag-app" class="election-app riksdag-app" data-riksdag-base="{{ site.baseurl }}/files/riksdag" data-seating-plan="{{ site.baseurl }}/files/election-simulator/results/2026-seating.json" data-chamber-page="{{ site.baseurl }}/election-simulator/">
  <noscript>
    <div class="notice--warning rv-noscript">
      <p><strong>Sidan behöver JavaScript.</strong> Riksdagen röstar ritar riksdagens voteringar ur riksdagens öppna data: hur ofta partierna har samma linje i voteringarna, en karta över röstmönstren, röster mot partilinjen per parti och ledamot, och alla voteringar med resultat och partiernas linjer. Allt räknas fram i webbläsaren ur färdiga datafiler.</p>
      <p>Utan JavaScript kan du läsa datafilerna direkt: <a href="{{ site.baseurl }}/files/riksdag/index.json">index.json</a> listar varje riksmöte och mandatperiod med sina filer (<code>votes.json</code> med varje röst, <code>summary.json</code> med partilinjer, samstämmighet, karta och per ledamot). Hur filerna tas fram står i <a href="https://github.com/edvinli/election-simulator/blob/main/docs/riksdag_votes.md">dokumentationen av datapipelinen</a>.</p>
    </div>
  </noscript>
  <header class="election-hero">
    <p class="election-hero__kicker">Sverige · Riksdagen · voteringar</p>
    <dl class="election-hero__facts">
      <div class="election-hero__fact">
        <dt>Period</dt>
        <dd id="rv-fact-scope">—</dd>
      </div>
      <div class="election-hero__fact">
        <dt>Voteringar i analysen</dt>
        <dd id="rv-fact-votes">—</dd>
      </div>
      <div class="election-hero__fact">
        <dt>Senaste votering</dt>
        <dd id="rv-fact-latest">—</dd>
      </div>
    </dl>
    <p class="election-hero__updated" id="rv-updated"></p>
    <p class="election-hero__lede">Så röstar partierna och ledamöterna i riksdagens voteringar, ur riksdagens öppna data. Sidan beskriver vad som har hänt, inte vad som borde hända.</p>
    <div class="rv-controls" id="rv-controls" hidden>
      <label class="ep-filter rv-scope">
        <span class="ep-filter__label">Period</span>
        <select class="ep-filter__select" id="rv-scope"></select>
      </label>
      <p class="election-muted rv-scope-note" id="rv-scope-note" hidden></p>
      <button type="button" class="ep-filters__reset rv-copy" id="rv-copy-link">Kopiera länk till vyn</button>
      <span class="election-muted rv-copy-status" id="rv-copy-status" role="status" aria-live="polite"></span>
    </div>
    <p class="election-status" id="rv-status" role="status" aria-live="polite">Läser in voteringar …</p>
  </header>

  <section class="election-panel rv-panel" id="rv-agreement" aria-labelledby="rv-agreement-title" hidden>
    <div class="election-panel__head">
      <h2 id="rv-agreement-title">Partiernas samstämmighet</h2>
      <p>Varje ruta visar i hur stor andel av voteringarna två partier hade samma linje. Ett partis linje är det som flest av partiets ledamöter röstade: ja, nej eller avstår. Den som är frånvarande räknas inte. Mörkare ruta betyder oftare samma linje. Klicka på en ruta, eller tryck Enter, för att se voteringarna bakom den.</p>
      <p><strong>Ja/Nej/Avstår</strong> räknar avstår som ett eget ställningstagande: om ett parti avstår när ett annat röstar ja har de olika linjer. <strong>Bara Ja/Nej</strong> räknar bara voteringar där båda partierna röstade ja eller nej, och tar bort dem där något av partierna avstod. Rutor med färre än 10 voteringar visas som – med antalet (n). Utskottet är det som beredde ärendet.</p>
    </div>
    <p class="election-muted rv-subtitle">Andel voteringar där två partier hade samma linje. Klicka på en ruta för att lista voteringarna.</p>
    <div class="rv-matrix-controls">
      <div class="ep-filter">
        <span class="ep-filter__label" id="rv-mode-label">Räkna</span>
        <div class="ep-filter__segments" id="rv-mode" role="group" aria-labelledby="rv-mode-label">
          <button type="button" class="election-timeseries__control" data-mode="three_way" aria-pressed="true">Ja/Nej/Avstår</button>
          <button type="button" class="election-timeseries__control" data-mode="ja_nej" aria-pressed="false">Bara Ja/Nej</button>
        </div>
      </div>
      <label class="ep-filter">
        <span class="ep-filter__label">Utskott</span>
        <select class="ep-filter__select" id="rv-committee"></select>
      </label>
    </div>
    <p class="rv-callout" id="rv-acklamation"><strong>Voteringar är de omstridda besluten.</strong> De flesta beslut i riksdagen fattas med acklamation, utan votering. Det blir votering bara när en ledamot begär det. Andelarna nedan gäller därför de omstridda frågorna och underskattar hur ofta partierna är överens om besluten i stort.</p>
    <p class="rv-empty" id="rv-matrix-empty" role="status" hidden></p>
    <div class="rv-table-wrap">
      <table class="rv-matrix" id="rv-matrix"></table>
    </div>
    <p class="rv-matrix-detail" id="rv-matrix-detail" role="status" aria-live="polite"></p>
  </section>

  <section class="election-panel rv-panel" id="rv-map-section" aria-labelledby="rv-map-title" hidden>
    <div class="election-panel__head">
      <h2 id="rv-map-title">Karta över riksdagen</h2>
      <p>Kartan sammanfattar vilka som brukar rösta lika: ju närmare varandra, desto oftare samma röst. Stora märken är partier, små prickar ledamöter. Axlarna är statistiska sammanfattningar av röstmönstren, inte en vänster–högerskala; vad varje axel fångar står under kartan.</p>
      <p>De flesta ledamöter ligger nästan på sitt partis märke, eftersom partierna nästan alltid röstar samlat (partidisciplin).</p>
    </div>
    <p class="election-muted rv-subtitle">Partier (stora märken) och ledamöter (prickar) placerade efter hur ofta de röstar lika.</p>
    <p class="rv-empty rv-map-unavailable" id="rv-map-unavailable" role="status" hidden></p>
    <div class="rv-map-frame" id="rv-map-frame">
      <svg class="rv-map" id="rv-map" role="img" tabindex="0" aria-describedby="rv-map-help" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="ep-tip rv-map-tip" id="rv-map-tip" role="tooltip" hidden></div>
    </div>
    <ul class="rv-map-axes" id="rv-map-axes"></ul>
    <p class="election-muted" id="rv-map-help">Peka på eller tryck på en prick (eller använd piltangenterna). <span id="rv-map-orientation"></span> <span id="rv-map-unplaced"></span></p>
    <p id="rv-map-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>
  </section>

  <section class="election-panel rv-panel" id="rv-against" aria-labelledby="rv-against-title" hidden>
    <div class="election-panel__head">
      <h2 id="rv-against-title">Röster mot partilinjen</h2>
      <p>En röst mot partilinjen är ett ja, nej eller avstår som skiljer sig från partiets linje i samma votering. Jämförbara röster är de ja, nej och avstår som partiets ledamöter lade när partiet hade en linje. Enstaka fall kan vara feltryckningar: en ledamot trycker på fel knapp, och rösten står kvar i protokollet som avlagd.</p>
    </div>
    <p class="election-muted rv-subtitle">Röster mot partilinjen av jämförbara röster per parti och ledamot. Öppna en ledamot för att se voteringarna.</p>
    <div class="rv-table-wrap">
      <table class="rv-table" id="rv-against-parties"></table>
    </div>
    <h3 class="election-subhead">Ledamöter</h3>
    <div class="rv-member-controls" role="group" aria-label="Sök bland ledamöterna">
      <label class="ep-filter">
        <span class="ep-filter__label">Sök ledamot</span>
        <input type="search" class="ep-filter__select" id="rv-against-search" autocomplete="off" placeholder="Namn eller valkrets">
      </label>
      <label class="ep-filter">
        <span class="ep-filter__label">Parti</span>
        <select class="ep-filter__select" id="rv-against-party"></select>
      </label>
      <label class="ep-filter">
        <span class="ep-filter__label">Sortera</span>
        <select class="ep-filter__select" id="rv-against-sort">
          <option value="namn">Namn A–Ö</option>
          <option value="antal">Flest röster mot partilinjen</option>
          <option value="andel">Störst andel av jämförbara röster</option>
        </select>
      </label>
      <label class="rv-check">
        <input type="checkbox" id="rv-against-only" checked>
        <span>Bara ledamöter med röster mot partilinjen</span>
      </label>
    </div>
    <p class="ep-filters__count" id="rv-members-count" role="status" aria-live="polite"></p>
    <ul class="rv-members" id="rv-members"></ul>
    <button type="button" class="ep-filters__reset rv-more" id="rv-members-more" hidden>Visa fler</button>
  </section>

  <section class="election-panel rv-panel" id="rv-browser" aria-labelledby="rv-browser-title" hidden>
    <div class="election-panel__head">
      <h2 id="rv-browser-title">Voteringar</h2>
      <p>Alla voteringar i ett riksmöte eller hela perioden, senaste först. Välj en votering för att se resultatet och hur varje parti röstade.</p>
      <p><em>Jämnaste</em> sorterar på minst skillnad mellan ja och nej; <em>Med avvikande röster</em> visar voteringar där minst en ledamot röstade mot sitt partis linje; <em>Blocköverskridande</em> visar voteringar där båda blocken splittrades över vinnande och förlorande sida (endast ja/nej-linjer).</p>
    </div>
    <p class="election-muted rv-subtitle">Välj en votering för resultat och partilinjer, eller filtrera på snabbfilter och utskott.</p>
    <div class="rv-browser-controls" role="group" aria-label="Sök bland voteringarna">
      <label class="ep-filter">
        <span class="ep-filter__label">Riksmöte</span>
        <select class="ep-filter__select" id="rv-browser-session"></select>
      </label>
      <label class="ep-filter">
        <span class="ep-filter__label">Sök</span>
        <input type="search" class="ep-filter__select" id="rv-browser-search" autocomplete="off" placeholder="Rubrik, beteckning, utskott eller datum">
      </label>
      <label class="ep-filter">
        <span class="ep-filter__label">Utskott</span>
        <select class="ep-filter__select" id="rv-browser-committee"><option value="">Alla utskott</option></select>
      </label>
    </div>
    <div class="rv-chips" id="rv-chips" role="group" aria-label="Snabbfilter">
      <button type="button" class="election-timeseries__control rv-chip" data-chip="close" aria-pressed="false">Jämnaste</button>
      <button type="button" class="election-timeseries__control rv-chip" data-chip="cross" aria-pressed="false" hidden>Blocköverskridande</button>
      <button type="button" class="election-timeseries__control rv-chip" data-chip="dissent" aria-pressed="false">Med avvikande röster</button>
    </div>
    <p class="election-muted rv-blocs-note" id="rv-blocs-note" hidden></p>
    <div class="rv-cell-filter" id="rv-cell-filter" role="group" aria-label="Partipar från samstämmigheten" hidden>
      <span class="rv-cell-filter__text" id="rv-cell-filter-text"></span>
      <span class="ep-filter__segments">
        <button type="button" class="election-timeseries__control" data-rel="same" aria-pressed="true">Samma linje</button>
        <button type="button" class="election-timeseries__control" data-rel="diff" aria-pressed="false">Olika linje</button>
      </span>
      <button type="button" class="rv-cell-filter__clear" id="rv-cell-filter-clear" aria-label="Ta bort partiparet">Rensa ×</button>
    </div>
    <p class="ep-filters__count" id="rv-votes-count" role="status" aria-live="polite"></p>
    <div class="rv-browser">
      <ul class="rv-votes" id="rv-votes"></ul>
      <div class="rv-vote-detail" id="rv-vote-detail" aria-live="polite" hidden></div>
    </div>
    <button type="button" class="ep-filters__reset rv-more" id="rv-votes-more" hidden>Visa fler</button>
  </section>

  <section class="election-panel election-disclosure rv-panel rv-methods" id="rv-methods" aria-labelledby="rv-methods-title" hidden>
    <details id="rv-methods-details">
      <summary><h2 class="election-disclosure__title" id="rv-methods-title">Metod och källor<span class="election-disclosure__hint" aria-hidden="true">acklamation, regler, källfiler och kontrollsummor</span></h2></summary>
      <div class="election-disclosure__body">
        <ul class="rv-rules">
          <li><strong>Voteringar är ett urval.</strong> De flesta beslut fattas med acklamation, utan votering; votering blir det bara när en ledamot begär det. Samstämmigheten och röster mot partilinjen gäller därför de omstridda frågorna. Partierna är överens om fler beslut än andelarna visar.</li>
          <li><strong>Källa.</strong> Riksdagens öppna data, <a href="https://data.riksdagen.se/">data.riksdagen.se</a>: voteringsfilerna per riksmöte och voteringslistan, som avgör vilka voteringar som finns.</li>
          <li><strong>Vilka voteringar.</strong> Samstämmighet, karta och röster mot partilinjen bygger på huvudvoteringar i sakfrågan. Voteringar om motiveringen och övriga frågor, till exempel statsministeromröstningen, finns med i voteringslistan nedan.</li>
          <li><strong>Avstår är ett ställningstagande.</strong> Partilinjen är det som flest av partiets ledamöter röstade bland ja, nej och avstår. Lika många ger ingen linje.</li>
          <li><strong>Frånvarande</strong> omfattar kvittning, där en ledamot avstår från att rösta efter överenskommelse med en ledamot från andra sidan så att styrkeförhållandet består. Data skiljer inte kvittning från annan frånvaro, därför rangordnas ingen efter närvaro.</li>
          <li><strong>Politiska vildar</strong> (ledamöter utan parti, "-") har ingen partilinje och ingår inte i partiernas jämförelser, men har egna siffror och en plats på kartan.</li>
          <li><strong>Kartan</strong> är en principalkomponentanalys av partiernas linjer i voteringar där minoriteten är minst 2,5 % och alla partier har en linje. Ledamöter placeras med sina egna avlagda röster (minst 50), aldrig med gissade röster för frånvaro.</li>
        </ul>
        <p class="election-muted" id="rv-origin"></p>
        <p class="election-muted" id="rv-code"></p>
        <details class="rv-details">
          <summary>Källfiler med kontrollsummor</summary>
          <ul class="rv-sources" id="rv-sources"></ul>
          <p class="election-muted">Publicerade filer för perioden:</p>
          <ul class="rv-sources" id="rv-files"></ul>
        </details>
        <p class="election-muted">Hela metoden: <a id="rv-docs" href="https://github.com/edvinli/election-simulator/blob/main/docs/riksdag_votes.md">dokumentationen av datapipelinen</a>. Alla data: <a href="{{ site.baseurl }}/files/riksdag/index.json">files/riksdag/</a>.</p>
      </div>
    </details>
  </section>
</div>

<script src="{{ site.baseurl }}/assets/js/riksdag-votes.js?v={{ site.time | date: '%s' }}"></script>
