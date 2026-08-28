---
title: "Prognos för riksdagsvalet 2026"
permalink: /election-simulator/
layout: single
author_profile: false
classes: wide
excerpt: "En öppen prognos för riksdagsvalet 2026 med prognosintervall, mandatfördelning och utvärdering."
---

<div id="election-simulator-app" class="election-app" data-publication-base="{{ site.baseurl }}/files/election-simulator">
  <noscript>
    <p class="notice--warning">Prognosen behöver JavaScript för att läsa in sina data. JSON-filerna finns kvar för nedladdning i publiceringskatalogen.</p>
  </noscript>
  <header class="election-hero" id="election-hero">
    <p class="election-hero__kicker">Sverige · Riksdagen · valprognos 2026</p>
    <dl class="election-hero__facts">
      <div class="election-hero__fact">
        <dt>Opinionsläge</dt>
        <dd id="election-hero-asof">—</dd>
      </div>
      <div class="election-hero__fact">
        <dt>Valdag</dt>
        <dd id="election-hero-election">—</dd>
      </div>
      <div class="election-hero__fact">
        <dt>Dagar kvar</dt>
        <dd id="election-hero-countdown">—</dd>
      </div>
    </dl>
    <p class="election-hero__lede" id="election-hero-lede">Läser in den publicerade simuleringen…</p>
    <p class="election-status" id="election-app-status" role="status" aria-live="polite">Läser in den senaste prognosen…</p>
    <p class="election-hero__links"><a href="#election-model">Så fungerar modellen</a><span aria-hidden="true"> · </span><a href="#election-methodology">Metod och utvärdering</a><span aria-hidden="true"> · </span><a href="#election-technical">Teknisk information</a></p>
  </header>
  <p id="election-selection-note" class="visually-hidden" role="status" aria-live="polite"></p>
  <section id="election-headline" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Röstandelar</h2>
      <p class="election-muted">Median röstandel med centrala 50- och 90-procentiga prognosintervall. Det är prognosintervall, inte konfidensintervall. Klicka på ett parti för mer information.</p>
    </div>
    <div id="election-party-cards" class="election-vote-rows"></div>
    <div id="election-vote-axis" class="ev-axis"></div>
    <p class="election-legend-note election-muted"><span class="election-key"><span class="election-key__mark election-key__mark--median" aria-hidden="true"></span>median</span><span class="election-key"><span class="election-key__mark election-key__mark--p50" aria-hidden="true"></span>50 % intervall</span><span class="election-key"><span class="election-key__mark election-key__mark--p90" aria-hidden="true"></span>90 % intervall</span><span class="election-key"><span class="election-key__mark election-key__mark--threshold" aria-hidden="true"></span>4 %-spärr</span></p>
  </section>
  <section id="election-seats" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Mandat</h2>
      <p class="election-muted">Riksdagen har 349 mandat; 175 krävs för majoritet. Stapeln visar partiets median och den mörka linjen det centrala 90-procentiga prognosintervallet. Medianerna beräknas var för sig och behöver därför inte summera till 349.</p>
    </div>
    <div id="election-seat-bars" class="election-seat-bars" role="list"></div>
    <div id="election-seat-axis" class="es-axis"></div>
    <h3 class="election-subhead">Ett simulerat riksdagsutfall</h3>
    <p class="election-muted" id="election-parliament-caption"></p>
    <div class="election-parliament-frame">
      <div id="election-parliament" class="election-parliament" role="img" aria-label="Riksdagen med 349 mandat"></div>
      <span class="election-parliament__centre" aria-hidden="true"><span class="election-parliament__centre-label">175:e mandatet</span></span>
    </div>
    <ul id="election-parliament-legend" class="ep-legend"></ul>
  </section>
  <section id="election-government-builder" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Bygg din egen regering</h2>
      <p class="election-muted">Välj regeringspartier och eventuella stödpartier. Diagrammet visar hur många mandat de brukar få tillsammans i simuleringarna.</p>
    </div>
    <div class="eg-builder">
      <div class="eg-pool">
        <h3 class="eg-pool__title" id="election-pool-title">Tillgängliga partier</h3>
        <div id="election-available-parties" class="eg-zone eg-zone--pool" role="group" aria-labelledby="election-pool-title"></div>
        <p id="election-pool-empty" class="eg-pool__empty" hidden>Alla partier är placerade.</p>
      </div>
      <div class="eg-chart">
        <div class="eg-chart__row eg-chart__row--heads">
          <div class="eg-chart__gutter" aria-hidden="true"></div>
          <div class="eg-chart__head" id="election-government-column" data-coalition-mask="0">
            <h3 class="eg-chart__title" id="election-government-title">Regering</h3>
            <p class="eg-chart__total"><span class="eg-chart__total-value" id="election-government-total">0</span> mandat</p>
          </div>
          <div class="eg-chart__head" id="election-union-column" data-coalition-mask="0">
            <h3 class="eg-chart__title" id="election-union-title">Med stöd</h3>
            <p class="eg-chart__total"><span class="eg-chart__total-value" id="election-union-total">0</span> mandat</p>
          </div>
        </div>
        <div class="eg-chart__plot">
          <div class="eg-chart__axis" aria-hidden="true">
            <span class="eg-chart__tick eg-chart__tick--max">349</span>
            <span class="eg-chart__tick eg-chart__tick--zero">0</span>
          </div>
          <div class="eg-bar" id="election-government-bar" role="img" aria-label="Regering: inga partier valda"></div>
          <div class="eg-bar" id="election-union-bar" role="img" aria-label="Med stöd: inga partier valda"></div>
          <div class="eg-chart__majority" aria-hidden="true"><span class="eg-chart__majority-label">Majoritetsgräns: 175 mandat</span></div>
        </div>
        <div class="eg-chart__row eg-chart__row--zones">
          <div class="eg-chart__gutter" aria-hidden="true"></div>
          <div class="eg-chart__zone-cell">
            <h4 class="eg-zone__title" id="election-government-zone-title">Regeringspartier</h4>
            <div id="election-government-parties" class="eg-zone eg-zone--column" role="group" aria-labelledby="election-government-zone-title"></div>
          </div>
          <div class="eg-chart__zone-cell">
            <h4 class="eg-zone__title" id="election-support-zone-title">Stödpartier</h4>
            <div id="election-support-parties" class="eg-zone eg-zone--column" role="group" aria-labelledby="election-support-zone-title"></div>
          </div>
        </div>
      </div>
      <p id="election-government-empty" class="eg-builder__empty" hidden>Välj minst ett regeringsparti.</p>
      <dl id="election-government-results" class="eg-summary" hidden data-coalition-mask="" data-government-mask="" data-support-mask=""></dl>
      <p id="election-government-note" class="eg-builder__note" hidden>Den högra stapeln visar regeringen och stödpartierna tillsammans; stödpartiernas delar är skrafferade. Medianerna beräknas var för sig och summerar därför inte exakt, så staplarnas höjd följer kombinationens egen median.</p>
      <div id="election-government-histogram" class="egh-histogram" hidden data-coalition-mask="" data-total-count="0" data-min-seats="" data-max-seats="">
        <h3 class="egh-histogram__title">Mandatfördelning i 100 000 simuleringar</h3>
        <p id="election-government-histogram-context" class="egh-histogram__context"></p>
        <div class="egh-histogram__key" aria-label="Diagramförklaring">
          <span class="egh-histogram__key-item"><span class="egh-histogram__key-mark egh-histogram__key-mark--below" aria-hidden="true"></span>under 175 mandat</span>
          <span class="egh-histogram__key-item"><span class="egh-histogram__key-mark egh-histogram__key-mark--majority" aria-hidden="true"></span>175 mandat eller fler</span>
        </div>
        <div class="egh-histogram__frame">
          <svg id="election-government-histogram-svg" class="egh-histogram__svg" role="group" aria-labelledby="election-government-histogram-title election-government-histogram-description" viewBox="0 0 420 320" preserveAspectRatio="xMidYMid meet">
            <title id="election-government-histogram-title">Mandatfördelning för den valda koalitionen</title>
            <desc id="election-government-histogram-description"></desc>
          </svg>
          <p id="election-government-histogram-status" class="egh-histogram__status" role="status" aria-live="polite" aria-atomic="true" hidden></p>
        </div>
        <p id="election-government-histogram-text" class="egh-histogram__text"></p>
      </div>
    </div>
    <p id="election-government-announcement" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>
    <p class="eg-builder__disclaimer">Det här visar sannolikheten att de valda partierna tillsammans får minst 175 mandat – inte sannolikheten att de faktiskt bildar regering.</p>
  </section>
  <section id="election-groups" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Majoritetsscenarier</h2>
      <p class="election-muted">Välj en kombination för att se mandatfördelningen och sannolikheten att nå minst 175 mandat.</p>
    </div>
    <div id="election-group-pills" class="eg-pills"></div>
    <div id="election-group-result" class="eg-result"></div>
    <div id="election-group-histogram" class="eg-histogram"></div>
  </section>
  <section id="election-changes" class="election-panel" hidden>
    <div class="election-panel__head">
      <h2>Förändring sedan föregående prognos</h2>
      <p class="election-muted" id="election-changes-status"></p>
    </div>
    <div id="election-changes-content" class="election-changes-table"></div>
  </section>
  <section id="election-how-it-works" class="election-panel election-disclosure">
    <details id="election-model">
      <summary><h2 class="election-disclosure__title">Så fungerar modellen<span class="election-disclosure__hint" aria-hidden="true">opinionsläge, osäkerhet, mandat och sannolikheter</span></h2></summary>
      <div class="election-disclosure__body">
        <p>Prognosen simulerar valdagen, inte bara en felmarginal runt dagens opinionsmätningar. Modellen skapar 100&#160;000 möjliga valresultat. Intervall och sannolikheter på sidan beräknas direkt från dessa simuleringar.</p>
        <h3 class="election-subhead">1. Opinionsläget i dag</h3>
        <p>Utgångspunkten är den senaste skattningen från Poll of Polls. För att uppskatta osäkerheten runt dagens läge jämför modellen historiska enskilda mätningar med Poll of Polls.</p>
        <p>Röstandelar kan inte behandlas som vanliga oberoende tal eftersom de tillsammans måste summera till 100&#160;%. Därför arbetar modellen med log-kvoter. För parti <var>j</var>:</p>
        <div class="election-equation">\[ z_j = \log\!\left(\frac{p_j}{p_{\mathrm{övr}}}\right) \]</div>
        <p>där <var>p_j</var> är partiets röstandel och <var>p_övr</var> är den samlade andelen för övriga partier.</p>
        <p>Historiska avvikelser används för att skatta en gemensam kovariansmatris, <var>Σ_res</var>. Osäkerheten i dagens läge minskar när det finns fler färska mätningar:</p>
        <div class="election-equation">\[ \Sigma_{\mathrm{dag}} = \frac{\Sigma_{\mathrm{res}}}{n_{\mathrm{eff}}} \]</div>
        <p>Färska mätningar väger mer än äldre. Urvalsstorleken påverkar också vikten:</p>
        <div class="election-equation">\[\begin{aligned}
          w_i &amp;= 2^{-\mathrm{ålder}_i / 21}
                 \times \operatorname{clip}\!\left(\sqrt{\tfrac{N_i}{1000}},\; 0{,}7,\; 1{,}5\right) \\[6pt]
          n_{\mathrm{eff}} &amp;= \frac{\left(\sum_i w_i\right)^{2}}{\sum_i w_i^{2}}
        \end{aligned}\]</div>
        <p>Det effektiva antalet mätningar begränsas till högst 8. Ett simulerat opinionsläge i dag dras sedan runt Poll of Polls med denna gemensamma osäkerhet.</p>
        <h3 class="election-subhead">2. Vad kan hända fram till valdagen?</h3>
        <p>Osäkerheten beror på hur många dagar som återstår. Om det är <var>h</var> dagar kvar tittar modellen på hur hela opinionsläget historiskt har förändrats över <var>h</var> dagar.</p>
        <p>För den delen används en symmetrisk log-kvotstransformation, CLR. En historisk förändring definieras som:</p>
        <div class="election-equation">\[ \Delta_{s,h} = \operatorname{CLR}\!\left(\mathrm{PoP}_{s+h}\right) - \operatorname{CLR}\!\left(\mathrm{PoP}_{s}\right) \]</div>
        <p>Hela vektorn med partiernas förändringar sparas tillsammans. Modellen drar sedan en sådan historisk förändring och använder den med slumpmässigt tecken:</p>
        <div class="election-equation">\[\begin{aligned}
          \operatorname{CLR}(p_{\mathrm{val}}) &amp;= \operatorname{CLR}(p_{\mathrm{idag}}) + S \times \Delta_{s,h} \\[6pt]
          S &amp;\in \{-1,\, +1\}, \qquad P(S = +1) = P(S = -1) = 0{,}5
        \end{aligned}\]</div>
        <p>Det betyder två saker. Partiernas rörelser simuleras gemensamt, inte oberoende. Och modellen antar inte att en historisk trend fortsätter i samma riktning 2026.</p>
        <p>Om M historiskt har tappat samtidigt som vissa andra partier har ökat, finns den samvariationen med i den dragna förändringen. Däremot finns ingen separat modell som säger att en väljare går från exempelvis M till SD eller S.</p>
        <h3 class="election-subhead">3. Fel som kan finnas kvar på valdagen</h3>
        <p>Även nära valdagen kan opinionsmätningarna missa det faktiska resultatet. Modellen använder därför historiska skillnader mellan det sista samlade mätläget och valresultatet:</p>
        <div class="election-equation">\[\begin{aligned}
          r_e &amp;= \text{valresultat}_e - \text{slutligt mätläge}_e \\[6pt]
          \tilde{r}_e &amp;= r_e - \operatorname{medel}(r)
        \end{aligned}\]</div>
        <p>Ett historiskt, centrerat fel dras gemensamt för alla partier och läggs på den simulerade röstandelen.</p>
        <p>För att ingen röstandel ska bli negativ skalas felet vid behov:</p>
        <div class="election-equation">\[ p' = p + \lambda\,\tilde{r}, \qquad 0 \le \lambda \le 1 \]</div>
        <p>I praktiken är <var>λ</var> nästan alltid nära 1. Centreringen innebär att modellen använder den historiska storleken och samvariationen i mätfelen utan att anta att tidigare fel i en viss riktning upprepas.</p>
        <p>Den här osäkerheten försvinner därför inte helt bara för att valdagen närmar sig.</p>
        <h3 class="election-subhead">4. Från nationella röster till 29 valkretsar</h3>
        <p>Varje simulerat nationellt resultat måste därefter fördelas geografiskt. Modellen utgår från partiernas geografiska mönster i föregående val och använder deterministisk biproportionell raking, även kallad IPF.</p>
        <p>Om <var>B_c,p</var> är tidigare röster för parti <var>p</var> i valkrets <var>c</var>, söker modellen faktorer <var>a_c</var> och <var>b_p</var> så att:</p>
        <div class="election-equation">\[ X_{c,p} = a_c \times B_{c,p} \times b_p \]</div>
        <p>samtidigt som:</p>
        <div class="election-equation">\[\begin{aligned}
          \sum_p X_{c,p} &amp;= \text{röster i valkrets } c \\[6pt]
          \sum_c X_{c,p} &amp;= \text{partiets nationella röster}
        \end{aligned}\]</div>
        <p>Resultatet behåller alltså tidigare geografiska skillnader så långt det går, men måste exakt stämma med det simulerade nationella valresultatet och valkretsarnas röstvolymer.</p>
        <p>Det läggs ingen extra slumpmässig geografisk variation ovanpå detta i dagens modell.</p>
        <h3 class="election-subhead">5. Från röster till mandat</h3>
        <p>De simulerade rösterna i de 29 valkretsarna skickas sedan genom en implementation av de svenska mandatreglerna.</p>
        <p>Den hanterar bland annat:</p>
        <ul class="election-list">
          <li>4-procentsspärren nationellt;</li>
          <li>12-procentsregeln i en enskild valkrets;</li>
          <li>310 fasta valkretsmandat;</li>
          <li>39 utjämningsmandat;</li>
          <li>den jämkade uddatalsmetoden;</li>
          <li>återföring av mandat.</li>
        </ul>
        <p>Varje simulering slutar med exakt 349 mandat.</p>
        <h3 class="election-subhead">6. Vad betyder sannolikheterna?</h3>
        <p>Det finns ingen separat formel som uppskattar sannolikheten för exempelvis en majoritet. Den räknas helt enkelt som andelen simuleringar där utfallet inträffar.</p>
        <div class="election-equation">\[\begin{aligned}
          &amp;P(\text{minst 175 mandat}) \\[6pt]
          &amp;\qquad = \frac{\begin{gathered}\text{antal simuleringar} \\ \text{med minst 175 mandat}\end{gathered}}{100\,000}
        \end{aligned}\]</div>
        <p>Samma princip används för prognosintervallen. Ett 90-procentigt prognosintervall går från den 5:e till den 95:e percentilen bland de simulerade utfallen.</p>
        <h3 class="election-subhead">7. Fler mandat i median är inte samma sak som större chans till majoritet</h3>
        <p>Två kombinationer kan byta inbördes ordning beroende på vad man jämför. En kombination kan ligga högre i median och ändå nå 175 mandat i färre simuleringar. Det är inget räknefel, utan en följd av att sannolikheten för majoritet inte avgörs av var fördelningen ligger i mitten, utan av hur ofta den hamnar över gränsen.</p>
        <p>Hur bred fördelningen blir beror på hur partierna rör sig i förhållande till varandra. Spridningen för en kombination är inte bara summan av partiernas egna varianser, utan innehåller också deras samvariation:</p>
        <div class="election-equation">\[ \operatorname{Var}(A + B) = \operatorname{Var}(A) + \operatorname{Var}(B) + 2\operatorname{Cov}(A, B) \]</div>
        <p>Om två partier i de historiska mönstren tenderar att gå upp när det andra går ned är kovariansen negativ. Deras rörelser tar då delvis ut varandra, och kombinationens fördelning blir smalare. En smal fördelning strax under 175 mandat når sällan över gränsen. Går partierna i stället ofta upp och ned samtidigt är kovariansen positiv, fördelningen blir bredare, och den kan nå 175 mandat oftare trots ett lägre medianvärde.</p>
        <p>Samvariationen är inte ett eget antagande om väljarflöden mellan enskilda partier. Den följer av att varje simulering drar hela opinionsläget gemensamt i steg 2 och 3, så att historiska mönster i hur partierna rört sig i förhållande till varandra finns kvar hela vägen fram till mandaten.</p>
        <p>Jämför man därför två kombinationer är medianen och sannolikheten två olika frågor, och de behöver inte peka åt samma håll.</p>
        <h3 class="election-subhead">Viktigaste antagandena</h3>
        <p>Modellen bygger framför allt på fyra antaganden:</p>
        <ol class="election-list">
          <li>Poll of Polls är ett rimligt ankare för opinionsläget i dag.</li>
          <li>Historiska svenska opinionsrörelser är informativa om hur mycket opinionen kan röra sig fram till valet 2026.</li>
          <li>Historiska skillnader mellan slutmätningar och valresultat är informativa om den osäkerhet som finns kvar på valdagen.</li>
          <li>Partiernas relativa geografiska styrka är tillräckligt stabil för att tidigare val ska vara användbara när nationella röster fördelas över valkretsarna.</li>
        </ol>
        <p>Modellen har ingen separat modell för ekonomin, valkampanjshändelser, individuella väljarflöden, taktisk röstning eller vilka partier som faktiskt bildar regering. Sådana saker kan påverka prognosen indirekt genom de historiska opinionsrörelser som modellen använder, men de läggs inte in som egna politiska antaganden.</p>
      </div>
    </details>
  </section>
  <section id="election-validation" class="election-panel election-disclosure" hidden>
    <details id="election-methodology">
      <summary><h2 class="election-disclosure__title">Metod och utvärdering<span class="election-disclosure__hint" aria-hidden="true">efterhandsutvärdering, träffsäkerhet och begränsningar</span></h2></summary>
      <div id="election-validation-content" class="election-disclosure__body"></div>
    </details>
  </section>
  <section id="election-meta" class="election-panel election-disclosure election-meta" hidden>
    <details id="election-technical">
      <summary><h2 class="election-disclosure__title">Teknisk information<span class="election-disclosure__hint" aria-hidden="true">ursprung, hashar och modellversion</span></h2></summary>
      <dl id="election-meta-list" class="election-disclosure__body"></dl>
    </details>
  </section>
</div>

<script src="{{ site.baseurl }}/assets/js/election-simulator.js"></script>

<!-- Equation typesetting for "Så fungerar modellen". MathJax 3.2.2 is pinned
     and loaded on this page only; the LaTeX sits in the markup as plain text,
     so if the CDN is unreachable the source stays visible instead of the
     equations vanishing. -->
<script>
  window.MathJax = {
    tex: {
      inlineMath: [['\\(', '\\)']],
      displayMath: [['\\[', '\\]']]
    },
    chtml: {
      displayAlign: 'left',
      displayIndent: '0'
    },
    options: {
      // Confine MathJax to the equation blocks. Nothing else on the page is
      // math, and the forecast app rewrites large parts of the DOM.
      ignoreHtmlClass: '.*',
      processHtmlClass: 'election-equation'
    },
    startup: {
      // The equations live inside a collapsed <details>. CHTML cannot measure
      // a display:none subtree, so typesetting is deferred until the section
      // is first opened.
      typeset: false,
      pageReady: function () {
        return window.MathJax.startup.defaultPageReady().then(function () {
          window.electionTypesetEquations();
        });
      }
    }
  };

  (function () {
    var details = document.getElementById('election-model');
    var done = false;

    function typeset() {
      if (done) return;
      if (!window.MathJax || !window.MathJax.typesetPromise) return;
      if (details && !details.open) return;
      done = true;
      window.MathJax.typesetPromise().catch(function (error) {
        done = false;
        console.warn('MathJax kunde inte typsätta ekvationerna.', error);
      });
    }

    window.electionTypesetEquations = typeset;
    if (details) details.addEventListener('toggle', typeset);
  })();
</script>
<script id="MathJax-script" async
        src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js"
        integrity="sha384-AHAnt9ZhGeHIrydA1Kp1L7FN+2UosbF7RQg6C+9Is/a7kDpQ1684C2iH2VWil6r4"
        crossorigin="anonymous"></script>
