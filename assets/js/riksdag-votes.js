// Riksdagen röstar: party agreement, a map of the chamber, votes against the
// party line and a vote browser, from the riksdag's open roll-call data.
//
// The data are the outputs of the election-simulator repository's
// riksdag_votes pipeline (docs/riksdag_votes.md), published under
// files/riksdag/: index.json names every session and term with its paths and
// sha256; <rm>/summary.json and term-<...>/summary.json carry the party
// lines, agreement matrices, the map and per-member counts; <rm>/votes.json
// carries every vote's ballots bench by bench. This file only reads and draws
// them: it never re-derives a statistic the summary publishes. The one thing
// it computes itself is a single vote's party lines from that vote's ballots
// (the pipeline's rule 2, plurality of Ja/Nej/Avstår), because votes.json is
// what the vote browser and the chamber overlay hold.
//
// Two consumers:
//   * the page /riksdagen-roster/ (#riksdag-app), and
//   * the "Som i kammaren" view on /election-simulator/, through
//     RiksdagVotes.attachChamberOverlay, called by election-simulator.js.
// Both fail closed: a file that does not validate is not drawn.
(function (root) {
  "use strict";

  var CHAMBER = 349;
  // The chamber's left-to-right seating order, as on the election page.
  var SEATING_ORDER = ["V", "S", "MP", "C", "L", "KD", "M", "SD"];
  var INDEPENDENT = "-";
  var PARTY_COLORS = {
    M: "#3657A7", L: "#4A9AD6", C: "#2B8569", KD: "#5B7C9B",
    S: "#ED1B34", V: "#A81420", MP: "#4C983E", SD: "#A87F00", "-": "#8A8A8A"
  };
  var PARTY_NAMES = {
    M: "Moderaterna", L: "Liberalerna", C: "Centerpartiet", KD: "Kristdemokraterna",
    S: "Socialdemokraterna", V: "Vänsterpartiet", MP: "Miljöpartiet",
    SD: "Sverigedemokraterna", "-": "Politisk vilde"
  };
  // Fallback only: the summary names each committee itself.
  var COMMITTEE_NAMES = {
    AU: "Arbetsmarknadsutskottet", CU: "Civilutskottet", FiU: "Finansutskottet",
    "FöU": "Försvarsutskottet", JuU: "Justitieutskottet", KU: "Konstitutionsutskottet",
    KrU: "Kulturutskottet", MJU: "Miljö- och jordbruksutskottet", NU: "Näringsutskottet",
    SfU: "Socialförsäkringsutskottet", SkU: "Skatteutskottet", SoU: "Socialutskottet",
    TU: "Trafikutskottet", UbU: "Utbildningsutskottet", UU: "Utrikesutskottet",
    "UFöU": "Sammansatta utrikes- och försvarsutskottet", "övrigt": "Övriga voteringar"
  };
  var CHOICE_CODES = ["J", "N", "A", "F"];
  var CHOICE_LABELS = { J: "Ja", N: "Nej", A: "Avstår", F: "Frånvarande" };
  // Ja and Nej are a blue/orange pair (validated for colour-vision
  // deficiency); Avstår is the dark ink and Frånvarande a pale grey, so the
  // four also differ in lightness. Every use also carries a text label.
  var CHOICE_COLORS = { J: "#2a6cb0", N: "#d4622a", A: "#2c2a25", F: "#d9d4ca" };
  var MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
  var DOCS_URL = "https://github.com/edvinli/election-simulator/blob/main/docs/riksdag_votes.md";
  // The page opens on the newest term once it has this many analysis votes;
  // until then on the last complete term, saying why.
  var DEFAULT_SCOPE_MIN_VOTES = 100;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isInt(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtInt(value) {
    // Swedish thousands separator, a non-breaking space.
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  }

  function fmtPct(share, digits) {
    return (share * 100).toFixed(digits === undefined ? 0 : digits).replace(".", ",") + "\u00a0%";
  }

  function swedishDate(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "–";
    var parts = iso.split("-");
    return Number(parts[2]) + " " + MONTHS[Number(parts[1]) - 1] + " " + parts[0];
  }

  function swedishInstant(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return "–";
    return swedishDate(iso.slice(0, 10)) + " " + iso.slice(11, 16) + " UTC";
  }

  function partyName(party) {
    return PARTY_NAMES[party] || party;
  }

  function partyColor(party) {
    return PARTY_COLORS[party] || "#8A8A8A";
  }

  function swatch(party) {
    return "<span class=\"rv-swatch\" style=\"background:" + partyColor(party) + "\" aria-hidden=\"true\"></span>";
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function fetchJson(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error("Kunde inte läsa " + url + " (" + response.status + ")");
      return response.json();
    });
  }

  // One file entry of index.json: {path, sha256, bytes}, the path relative
  // to the index (files/riksdag/) and unable to leave it.
  function fileInfo(value) {
    if (!isObject(value)) return null;
    var path = value.path;
    if (typeof path !== "string" || !/^[A-Za-z0-9._\-\/]+\.json$/.test(path)) return null;
    if (path.indexOf("..") >= 0 || path.charAt(0) === "/") return null;
    if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
    if (!isInt(value.bytes) || value.bytes <= 0) return null;
    return { path: path, sha256: value.sha256, bytes: value.bytes };
  }

  function isoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }

  function orderParties(parties) {
    var known = SEATING_ORDER.filter(function (party) { return parties.indexOf(party) >= 0; });
    return known.concat(parties.filter(function (party) { return known.indexOf(party) < 0; }).sort());
  }

  function committeeName(code, summary) {
    var entry = summary && summary.agreement && summary.agreement.by_committee && summary.agreement.by_committee[code];
    return (entry && typeof entry.name === "string" && entry.name) || COMMITTEE_NAMES[code] || code;
  }

  // ---------------------------------------------------------------------
  // Validation. Each returns a normalized object or null.
  // ---------------------------------------------------------------------
  // index.json as scripts.riksdag_votes.site writes it: role
  // riksdag_votes_index; sessions[] {rm, slug, files: {votes, summary},
  // n_votes, n_votes_analysis, first/latest_vote_date, generated_at_utc};
  // terms[] {label, sessions, term_complete, files: {summary}, n_votes,
  // n_votes_analysis, latest_vote_date, generated_at_utc}. Any entry that
  // does not match fails the whole index.
  function normalizeIndex(payload) {
    if (!isObject(payload) || payload.schema_version !== "1.0" || payload.role !== "riksdag_votes_index") return null;
    if (!Array.isArray(payload.sessions) || !payload.sessions.length || !Array.isArray(payload.terms)) return null;
    var sessions = [];
    for (var i = 0; i < payload.sessions.length; i += 1) {
      var entry = payload.sessions[i];
      if (!isObject(entry) || typeof entry.rm !== "string" || !/^\d{4}\/\d{2}$/.test(entry.rm) || !isObject(entry.files)) return null;
      var votes = fileInfo(entry.files.votes);
      var summary = fileInfo(entry.files.summary);
      if (!votes || !summary || !isInt(entry.n_votes_analysis) || !isInt(entry.n_votes)) return null;
      sessions.push({
        kind: "session",
        key: "rm:" + entry.rm,
        rm: entry.rm,
        sessions: [entry.rm],
        votes: votes,
        summary: summary,
        latestVoteDate: isoDate(entry.latest_vote_date),
        nVotes: entry.n_votes,
        nAnalysis: entry.n_votes_analysis
      });
    }
    sessions.sort(function (a, b) { return a.rm < b.rm ? -1 : a.rm > b.rm ? 1 : 0; });
    var terms = [];
    for (var t = 0; t < payload.terms.length; t += 1) {
      var term = payload.terms[t];
      if (!isObject(term) || typeof term.label !== "string" || !/^\d{4}-\d{2}$/.test(term.label) ||
          !Array.isArray(term.sessions) || !isObject(term.files) || typeof term.term_complete !== "boolean") return null;
      var termSummary = fileInfo(term.files.summary);
      if (!termSummary || !isInt(term.n_votes_analysis)) return null;
      var members = term.sessions.filter(function (rm) {
        return sessions.some(function (s) { return s.rm === rm; });
      });
      if (members.length !== term.sessions.length) return null;
      terms.push({
        kind: "term",
        key: "term:" + term.label,
        label: term.label,
        sessions: members,
        summary: termSummary,
        latestVoteDate: isoDate(term.latest_vote_date),
        nAnalysis: term.n_votes_analysis,
        complete: term.term_complete
      });
    }
    terms.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
    return {
      sessions: sessions,
      terms: terms,
      // The newest session is the one under way.
      currentSession: sessions[sessions.length - 1].rm,
      generatedAt: typeof payload.generated_at_utc === "string" ? payload.generated_at_utc : null,
      source: isObject(payload.source) ? payload.source : null
    };
  }

  function normalizeVotes(payload) {
    if (!isObject(payload) || payload.schema_version !== "1.0" || payload.role !== "riksdag_votes_session_votes") return null;
    if (payload.seats !== CHAMBER || typeof payload.rm !== "string") return null;
    var people = payload.people;
    var holders = payload.seat_holders;
    var rosters = payload.rosters;
    if (!Array.isArray(people) || !Array.isArray(holders) || !Array.isArray(rosters) || !Array.isArray(payload.votes)) return null;
    for (var p = 0; p < people.length; p += 1) {
      if (!isObject(people[p]) || typeof people[p].name !== "string") return null;
    }
    for (var h = 0; h < holders.length; h += 1) {
      var holder = holders[h];
      if (!Array.isArray(holder) || !isInt(holder[0]) || holder[0] < 0 || holder[0] >= people.length ||
          typeof holder[1] !== "string") return null;
    }
    for (var r = 0; r < rosters.length; r += 1) {
      var roster = rosters[r];
      if (!Array.isArray(roster) || roster.length !== CHAMBER) return null;
      for (var b = 0; b < CHAMBER; b += 1) {
        if (!isInt(roster[b]) || roster[b] < 0 || roster[b] >= holders.length) return null;
      }
    }
    var votes = [];
    var byId = {};
    for (var v = 0; v < payload.votes.length; v += 1) {
      var vote = payload.votes[v];
      if (!isObject(vote) || typeof vote.id !== "string" || byId[vote.id]) return null;
      if (typeof vote.ballots !== "string" || !/^[JNAF]{349}$/.test(vote.ballots)) return null;
      if (!isInt(vote.roster) || vote.roster < 0 || vote.roster >= rosters.length) return null;
      if (vote.date !== null && (typeof vote.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(vote.date))) return null;
      if (typeof vote.beteckning !== "string") return null;
      var tally = { J: 0, N: 0, A: 0, F: 0 };
      for (var c = 0; c < CHAMBER; c += 1) tally[vote.ballots.charAt(c)] += 1;
      var counts = vote.counts;
      if (!Array.isArray(counts) || counts[0] !== tally.J || counts[1] !== tally.N ||
          counts[2] !== tally.A || counts[3] !== tally.F) return null;
      var normal = {
        id: vote.id,
        rm: payload.rm,
        date: vote.date,
        beteckning: vote.beteckning,
        punkt: vote.punkt === null || vote.punkt === undefined ? null : String(vote.punkt),
        committee: typeof vote.committee === "string" ? vote.committee : null,
        avser: typeof vote.avser === "string" ? vote.avser : null,
        votering: typeof vote.votering === "string" ? vote.votering : null,
        analysis: vote.analysis === true,
        title: typeof vote.title === "string" && vote.title.trim() ? vote.title.trim() : null,
        punktTitle: typeof vote.punkt_title === "string" && vote.punkt_title.trim() ? vote.punkt_title.trim() : null,
        dokId: typeof vote.dok_id === "string" && vote.dok_id ? vote.dok_id : null,
        ballots: vote.ballots,
        roster: vote.roster,
        counts: tally,
        order: v
      };
      votes.push(normal);
      byId[vote.id] = normal;
    }
    return {
      rm: payload.rm,
      people: people,
      holders: holders,
      rosters: rosters,
      votes: votes,
      byId: byId,
      excluded: Array.isArray(payload.excluded_votes) ? payload.excluded_votes : [],
      documentUrl: documentTemplate(payload.encoding),
      provenance: isObject(payload.provenance) ? payload.provenance : null
    };
  }

  // votes.json's encoding.dok_id says where a document is:
  // "... the document is at https://data.riksdagen.se/dokument/<dok_id>".
  // Only that host is linked.
  function documentTemplate(encoding) {
    var text = isObject(encoding) && typeof encoding.dok_id === "string" ? encoding.dok_id : "";
    var match = /(https:\/\/data\.riksdagen\.se\/[A-Za-z0-9_\-\/]*)<dok_id>/.exec(text);
    return match ? match[1] : null;
  }

  function documentLink(data, vote) {
    return data.documentUrl && vote.dokId ? data.documentUrl + encodeURIComponent(vote.dokId) : null;
  }

  function validMatrix(block, size) {
    if (!isObject(block)) return false;
    return ["agree", "n", "share"].every(function (key) {
      return Array.isArray(block[key]) && block[key].length === size && block[key].every(function (row) {
        return Array.isArray(row) && row.length === size;
      });
    });
  }

  // Per-vote flags from the summary (margin, votes against the line,
  // cross-bloc); null when the summary does not carry them.
  // summary.vote_flags: columns ja, nej, avstar, franvarande, margin,
  // against_line, cross_bloc (1/0/null), one entry per vote in the order of
  // party_lines.votes. Anything else and the flags are not used.
  var FLAG_COLUMNS = ["ja", "nej", "avstar", "franvarande", "margin", "against_line", "cross_bloc"];

  function normalizeVoteFlags(payload) {
    var flags = payload.vote_flags;
    var votes = payload.party_lines.votes;
    if (!isObject(flags) || !isObject(flags.columns)) return null;
    var columns = flags.columns;
    var ok = FLAG_COLUMNS.every(function (name) {
      return Array.isArray(columns[name]) && columns[name].length === votes.length;
    });
    if (!ok) return null;
    var byId = {};
    for (var i = 0; i < votes.length; i += 1) {
      var cross = columns.cross_bloc[i];
      if (!isInt(columns.margin[i]) || !isInt(columns.against_line[i]) || !(cross === 0 || cross === 1 || cross === null)) return null;
      byId[votes[i].id] = {
        margin: columns.margin[i],
        against: columns.against_line[i],
        crossBloc: cross === null ? null : cross === 1,
        counts: [columns.ja[i], columns.nej[i], columns.avstar[i], columns.franvarande[i]]
      };
    }
    return byId;
  }

  // summary.blocs: the term's approved statsministeromröstning, or null.
  function normalizeBlocs(blocs) {
    if (!isObject(blocs) || !Array.isArray(blocs.government_side) || !Array.isArray(blocs.opposition) ||
        !blocs.government_side.length || !blocs.opposition.length) return null;
    return blocs;
  }

  function normalizeSummary(payload) {
    if (!isObject(payload) || payload.schema_version !== "1.0" || payload.role !== "riksdag_votes_summary") return null;
    var agreement = payload.agreement;
    if (!isObject(agreement) || !Array.isArray(agreement.parties) || !isObject(agreement.overall)) return null;
    var size = agreement.parties.length;
    if (!validMatrix(agreement.overall.three_way, size) || !validMatrix(agreement.overall.ja_nej, size)) return null;
    if (!Array.isArray(payload.members) || !isObject(payload.map) || !isObject(payload.scope)) return null;
    if (!payload.members.every(function (m) { return isObject(m) && typeof m.name === "string" && typeof m.party === "string"; })) return null;
    if (!isObject(payload.party_lines) || !Array.isArray(payload.party_lines.parties) || !Array.isArray(payload.party_lines.votes)) return null;
    var voteRm = {};
    var lineIndex = {};
    payload.party_lines.votes.forEach(function (entry) {
      if (!isObject(entry) || typeof entry.id !== "string" || typeof entry.rm !== "string" || !Array.isArray(entry.lines)) return;
      voteRm[entry.id] = entry.rm;
      lineIndex[entry.id] = entry.lines;
    });
    payload.voteRm = voteRm;
    payload.lineIndex = lineIndex;
    payload.voteFlags = normalizeVoteFlags(payload);
    payload.blocs = normalizeBlocs(payload.blocs);
    return payload;
  }

  // ---------------------------------------------------------------------
  // One vote, from votes.json
  // ---------------------------------------------------------------------
  function occupant(data, vote, bench) {
    var holder = data.holders[data.rosters[vote.roster][bench - 1]];
    var person = data.people[holder[0]];
    return {
      index: holder[0],
      id: typeof person.id === "string" ? person.id : null,
      name: person.name,
      party: holder[1],
      valkrets: typeof holder[2] === "string" ? holder[2] : null
    };
  }

  // The pipeline's rule 2: a party's line is the plurality among its members
  // voting Ja, Nej or Avstår; a tie or nobody casting gives no line.
  // Independents ("-") have none.
  function partyLines(data, vote) {
    var tally = {};
    var roster = data.rosters[vote.roster];
    for (var b = 0; b < CHAMBER; b += 1) {
      var party = data.holders[roster[b]][1];
      if (!tally[party]) tally[party] = { J: 0, N: 0, A: 0, F: 0 };
      tally[party][vote.ballots.charAt(b)] += 1;
    }
    var lines = {};
    var ties = [];
    var noCast = [];
    Object.keys(tally).forEach(function (party) {
      if (party === INDEPENDENT) return;
      var t = tally[party];
      var best = Math.max(t.J, t.N, t.A);
      if (best === 0) { lines[party] = null; noCast.push(party); return; }
      var leaders = ["J", "N", "A"].filter(function (code) { return t[code] === best; });
      if (leaders.length > 1) { lines[party] = null; ties.push(party); return; }
      lines[party] = leaders[0];
    });
    return { lines: lines, tally: tally, ties: ties, noCast: noCast };
  }

  // Benches whose occupant cast a ballot that differs from their party's
  // non-null line on this vote (rule 4).
  function againstLine(data, vote, lines) {
    var result = [];
    var roster = data.rosters[vote.roster];
    for (var b = 0; b < CHAMBER; b += 1) {
      var code = vote.ballots.charAt(b);
      if (code === "F") continue;
      var party = data.holders[roster[b]][1];
      if (party === INDEPENDENT) continue;
      var line = lines.lines[party];
      if (line && code !== line) result.push(b + 1);
    }
    return result;
  }

  // The document's title (the betänkande, or a chamber vote's subject); the
  // pipeline leaves it null when none was found.
  function voteTitle(vote) {
    if (vote.title) return vote.title;
    return isPoint(vote) ? vote.beteckning + " punkt " + vote.punkt : "Votering " + vote.beteckning;
  }

  // A committee vote is one förslagspunkt of a betänkande; a chamber vote
  // (numeric beteckning, punkt "0", no committee) is not.
  function isPoint(vote) {
    return Boolean(vote.committee) || (vote.punkt !== null && vote.punkt !== "0");
  }

  // "KU6 punkt 3: Ändring i en huvudbestämmelse i riksdagsordningen".
  function votePoint(vote) {
    if (!isPoint(vote)) return null;
    return vote.beteckning + " punkt " + vote.punkt + (vote.punktTitle ? ": " + vote.punktTitle : "");
  }

  function voteSubtitle(vote, summary) {
    var parts = [];
    if (vote.committee) parts.push(committeeName(vote.committee, summary));
    if (vote.avser && vote.avser !== "sakfrågan") parts.push(vote.avser);
    if (vote.votering && vote.votering !== "huvud") parts.push(vote.votering + "votering");
    return parts.join(" · ");
  }

  function sortedVotes(data) {
    return data.votes.slice().sort(function (a, b) {
      var da = a.date || "";
      var db = b.date || "";
      return da < db ? 1 : da > db ? -1 : b.order - a.order;
    });
  }

  // ---------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------
  function initPage(app) {
    var base = (app.getAttribute("data-riksdag-base") || "").replace(/\/$/, "");
    var status = byId("rv-status");
    var state = {
      index: null,
      scope: null,
      summary: null,
      summaries: {},
      votes: {},
      votesPending: {},
      mode: "three_way",
      committee: "",
      browserSession: null,
      selectedVote: null
    };

    function setStatus(text, isError) {
      if (!status) return;
      status.hidden = !text;
      status.textContent = text || "";
      status.classList.toggle("election-status--error", Boolean(isError));
    }

    function loadVotes(rm) {
      if (state.votes[rm]) return Promise.resolve(state.votes[rm]);
      if (state.votesPending[rm]) return state.votesPending[rm];
      var entry = state.index.sessions.filter(function (s) { return s.rm === rm; })[0];
      if (!entry) return Promise.reject(new Error("okänt riksmöte " + rm));
      state.votesPending[rm] = fetchJson(base + "/" + entry.votes.path).then(function (payload) {
        var data = normalizeVotes(payload);
        if (!data || data.rm !== rm) throw new Error("voteringsfilen för " + rm + " gick inte att läsa");
        state.votes[rm] = data;
        return data;
      });
      state.votesPending[rm].catch(function () { delete state.votesPending[rm]; });
      return state.votesPending[rm];
    }

    function loadSummary(scope) {
      if (state.summaries[scope.key]) return Promise.resolve(state.summaries[scope.key]);
      return fetchJson(base + "/" + scope.summary.path).then(function (payload) {
        var summary = normalizeSummary(payload);
        if (!summary) throw new Error("sammanfattningen för " + scopeLabel(scope) + " gick inte att läsa");
        state.summaries[scope.key] = summary;
        return summary;
      });
    }

    function scopeLabel(scope) {
      if (scope.kind === "term") return "mandatperioden " + scope.label.replace("-", "–");
      return "riksmötet " + scope.rm;
    }

    function scopeOptionLabel(scope) {
      var name = scope.kind === "term" ? "Mandatperioden " + scope.label.replace("-", "–") : "Riksmötet " + scope.rm;
      var ongoing = scope.kind === "term" ? scope.complete === false : scope.rm === state.index.currentSession;
      var n = fmtInt(scope.nAnalysis) + " voteringar";
      return name + (ongoing || n ? " (" + [ongoing ? "pågår" : null, n].filter(Boolean).join(", ") + ")" : "");
    }

    function allScopes() {
      var scopes = [];
      var terms = state.index.terms.slice().reverse();
      var placed = {};
      terms.forEach(function (term) {
        scopes.push(term);
        state.index.sessions.slice().reverse().forEach(function (session) {
          if (term.sessions.indexOf(session.rm) >= 0 && !placed[session.rm]) {
            scopes.push(session);
            placed[session.rm] = true;
          }
        });
      });
      state.index.sessions.slice().reverse().forEach(function (session) {
        if (!placed[session.rm]) scopes.push(session);
      });
      return scopes;
    }

    // The newest term once it holds enough votes; until then the last
    // complete term. The note says why and gives the current session's n.
    function defaultScope() {
      var terms = state.index.terms;
      var current = state.index.sessions.filter(function (s) { return s.rm === state.index.currentSession; })[0];
      var newest = terms[terms.length - 1] || null;
      if (newest && newest.nAnalysis >= DEFAULT_SCOPE_MIN_VOTES) return { scope: newest, note: null };
      var complete = terms.filter(function (t) { return t.complete; });
      var chosen = complete[complete.length - 1] || newest || current;
      var note = null;
      if (chosen !== newest && current) {
        note = "Riksmötet " + current.rm + " har hittills " +
          fmtInt(current.nAnalysis) +
          " voteringar i analysen, för få för att jämföra partierna. Därför visas " +
          scopeLabel(chosen) + " tills vidare. Välj " + current.rm + " i listan för att se det nya riksmötet.";
      }
      return { scope: chosen, note: note };
    }

    function start() {
      fetchJson(base + "/index.json").then(function (payload) {
        var index = normalizeIndex(payload);
        if (!index) throw new Error("index.json gick inte att läsa");
        state.index = index;
        var picker = byId("rv-scope");
        var scopes = allScopes();
        picker.innerHTML = "";
        scopes.forEach(function (scope) {
          var option = new Option(scopeOptionLabel(scope), scope.key);
          picker.appendChild(option);
        });
        var chosen = defaultScope();
        state.defaultScope = chosen.scope;
        var url = readUrl();
        var asked = scopes.filter(function (scope) {
          return url.period && (scope.kind === "term" ? scope.label === url.period : scope.rm === url.period);
        })[0];
        var first = asked || chosen.scope;
        picker.value = first.key;
        var note = byId("rv-scope-note");
        if (note) {
          note.textContent = chosen.note || "";
          note.hidden = !chosen.note;
        }
        picker.addEventListener("change", function () {
          var scope = scopes.filter(function (s) { return s.key === picker.value; })[0];
          if (!scope) return;
          // A pair, a vote and an open member belong to the old period.
          browserState.cell = null;
          state.selectedVote = null;
          againstState.open = null;
          byId("rv-vote-detail").hidden = true;
          selectScope(scope).then(writeUrl);
        });
        byId("rv-controls").hidden = false;
        renderSources();
        return selectScope(first).then(function () {
          if (state.summary) return restoreFromUrl(url);
        }).then(function () {
          urlReady = true;
          writeUrl();
        });
      }).catch(function (error) {
        console.warn("Riksdagens voteringar kunde inte visas.", error);
        setStatus("Voteringsdata kunde inte läsas in just nu. Försök igen senare.", true);
        Array.prototype.forEach.call(app.querySelectorAll(".rv-panel"), function (panel) { panel.hidden = true; });
      });
    }

    function selectScope(scope) {
      state.scope = scope;
      setStatus("Läser in " + scopeLabel(scope) + " …", false);
      return loadSummary(scope).then(function (summary) {
        if (state.scope !== scope) return;
        state.summary = summary;
        if (state.committee && !(summary.agreement.by_committee || {})[state.committee]) state.committee = "";
        renderHero();
        renderMatrixControls();
        renderMatrix();
        renderMap();
        renderAgainst();
        renderChips();
        renderBrowserSessions();
        renderProvenance();
        setStatus("", false);
        Array.prototype.forEach.call(app.querySelectorAll(".rv-panel"), function (panel) { panel.hidden = false; });
      }).catch(function (error) {
        console.warn("Sammanfattningen kunde inte visas.", error);
        setStatus("Uppgifterna för " + scopeLabel(scope) + " kunde inte läsas in.", true);
      });
    }

    // --- the address bar ---------------------------------------------------------
    // The page's state lives in the query string, so a view can be linked:
    // period, utskott, rakna, par + linje, filter, sok, riksmote,
    // votering_utskott, votering, ledamot, sortera, parti, alla_ledamoter,
    // ledamot_sok. Anything that does not name something on the page is
    // ignored.
    var CHIP_PARAMS = { jamnast: "close", block: "cross", avvikande: "dissent" };
    var VOTE_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
    var urlReady = false;

    function readUrl() {
      var params = null;
      try { params = new URLSearchParams(window.location.search); } catch (error) { params = null; }
      var get = function (key) {
        var value = params ? params.get(key) : null;
        return typeof value === "string" && value && value.length <= 200 ? value : null;
      };
      return {
        period: get("period"), utskott: get("utskott"), rakna: get("rakna"), par: get("par"), linje: get("linje"),
        filter: get("filter"), sok: get("sok"), riksmote: get("riksmote"), voteringUtskott: get("votering_utskott"),
        votering: get("votering"), ledamot: get("ledamot"), sortera: get("sortera"), parti: get("parti"),
        alla: get("alla_ledamoter"), ledamotSok: get("ledamot_sok")
      };
    }

    function writeUrl() {
      if (!urlReady || !state.scope || !window.history || !window.history.replaceState) return;
      var params = [];
      var add = function (key, value) { params.push(key + "=" + encodeURIComponent(value)); };
      if (state.scope !== state.defaultScope) add("period", state.scope.kind === "term" ? state.scope.label : state.scope.rm);
      if (state.committee) add("utskott", state.committee);
      if (state.mode === "ja_nej") add("rakna", "janej");
      var cell = browserState.cell;
      if (cell) {
        add("par", cell.a + "-" + cell.b);
        if (cell.rel === "diff") add("linje", "olika");
      }
      var chips = Object.keys(CHIP_PARAMS).filter(function (key) { return browserState.chips[CHIP_PARAMS[key]]; });
      if (chips.length) add("filter", chips.join(","));
      if (browserState.query.trim()) add("sok", browserState.query.trim());
      if (browserState.committee) add("votering_utskott", browserState.committee);
      if (state.browserSession && state.browserSession !== defaultBrowserSession()) add("riksmote", state.browserSession);
      if (state.selectedVote) add("votering", state.selectedVote.id);
      if (againstState.open) add("ledamot", againstState.open);
      if (againstState.sort !== "namn") add("sortera", againstState.sort);
      if (againstState.party) add("parti", againstState.party);
      if (!againstState.onlyAgainst) add("alla_ledamoter", "1");
      if (againstState.query.trim()) add("ledamot_sok", againstState.query.trim());
      var next = window.location.pathname + (params.length ? "?" + params.join("&") : "") + window.location.hash;
      try { window.history.replaceState(window.history.state, "", next); } catch (error) { /* a sandboxed frame */ }
    }

    function restoreFromUrl(url) {
      var summary = state.summary;
      var sessions = browserSessions();
      // Agreement.
      if (url.utskott && (summary.agreement.by_committee || {})[url.utskott]) state.committee = url.utskott;
      if (url.rakna === "janej") state.mode = "ja_nej";
      Array.prototype.forEach.call(app.querySelectorAll("#rv-mode button[data-mode]"), function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-mode") === state.mode ? "true" : "false");
      });
      byId("rv-committee").value = state.committee;
      renderMatrix();
      // Members.
      if (url.sortera && AGAINST_SORTS.indexOf(url.sortera) >= 0) againstState.sort = url.sortera;
      if (url.parti && summary.members.some(function (m) { return m.party === url.parti; })) againstState.party = url.parti;
      if (url.alla === "1") againstState.onlyAgainst = false;
      if (url.ledamotSok) againstState.query = url.ledamotSok;
      var member = url.ledamot ? summary.members.filter(function (m) { return m.id === url.ledamot; })[0] : null;
      if (member) {
        againstState.open = member.id;
        if (filteredMembers().indexOf(member) < 0 || filteredMembers().indexOf(member) >= againstState.limit) {
          againstState.query = member.name;
          againstState.party = "";
          if (!(member.against_line > 0)) againstState.onlyAgainst = false;
        }
      }
      byId("rv-against-sort").value = againstState.sort;
      byId("rv-against-party").value = againstState.party;
      byId("rv-against-only").checked = againstState.onlyAgainst;
      byId("rv-against-search").value = againstState.query;
      renderMemberList();
      // Votes.
      var browse = false;
      if (url.riksmote && (url.riksmote === ALL_SESSIONS ? sessions.length > 1 : sessions.indexOf(url.riksmote) >= 0)) {
        state.browserSession = url.riksmote;
        browse = true;
      }
      (url.filter || "").split(",").forEach(function (key) {
        if (CHIP_PARAMS[key]) {
          browserState.chips[CHIP_PARAMS[key]] = true;
          browse = true;
        }
      });
      if (url.sok) {
        browserState.query = url.sok;
        byId("rv-browser-search").value = url.sok;
        browse = true;
      }
      var pair = url.par ? url.par.split("-") : [];
      var parties = summary.agreement.parties;
      if (pair.length === 2 && pair[0] !== pair[1] && parties.indexOf(pair[0]) >= 0 && parties.indexOf(pair[1]) >= 0) {
        browserState.cell = { a: pair[0], b: pair[1], rel: url.linje === "olika" ? "diff" : "same", mode: state.mode, committee: state.committee };
        browserState.committee = state.committee;
        if (!url.riksmote && sessions.length > 1) state.browserSession = ALL_SESSIONS;
        browse = true;
      }
      if (url.voteringUtskott) {
        browserState.committee = url.voteringUtskott;
        browse = true;
      }
      if (browserState.chips.cross && !url.riksmote && sessions.length > 1 &&
          state.browserSession !== ALL_SESSIONS && !sessionHasCrossBloc(state.browserSession)) {
        state.browserSession = ALL_SESSIONS;
      }
      var voteRm = url.votering && VOTE_ID.test(url.votering) ? summary.voteRm[url.votering] : null;
      if (voteRm && shownSessions().indexOf(voteRm) < 0) state.browserSession = voteRm;
      var tasks = [];
      if (browse || voteRm) {
        renderBrowserSessions();
        tasks.push(loadBrowser().then(function () {
          var data = voteRm ? state.votes[voteRm] : null;
          var vote = data ? data.byId[url.votering] : null;
          if (vote) {
            state.selectedVote = vote;
            renderVoteList();
            selectVote(data, vote, false);
          }
          var section = byId("rv-browser");
          if (section && section.scrollIntoView) section.scrollIntoView({ block: "start" });
        }));
      }
      if (member && !browse && !voteRm) {
        var item = app.querySelector("#rv-members li[data-member=\"" + member.id + "\"]");
        if (item && item.scrollIntoView) item.scrollIntoView({ block: "center" });
      }
      return Promise.all(tasks);
    }

    // --- hero --------------------------------------------------------------
    function renderHero() {
      var summary = state.summary;
      var scope = state.scope;
      byId("rv-fact-scope").textContent = scope.kind === "term" ? scope.label.replace("-", "–") : scope.rm;
      byId("rv-fact-votes").textContent = fmtInt(summary.counts && isInt(summary.counts.votes_analysis)
        ? summary.counts.votes_analysis : 0);
      byId("rv-fact-latest").textContent = swedishDate(scope.latestVoteDate);
      var updated = byId("rv-updated");
      var generated = summary.provenance && summary.provenance.generated_at_utc;
      updated.textContent = generated ? "Data sammanställda " + swedishInstant(generated) + "." : "";
    }

    // --- 1. agreement ---------------------------------------------------------
    function renderMatrixControls() {
      var select = byId("rv-committee");
      var summary = state.summary;
      var committees = summary.agreement.by_committee || {};
      select.innerHTML = "";
      select.appendChild(new Option("Alla utskott (" + fmtInt(summary.agreement.overall.n_votes || 0) + " voteringar)", ""));
      Object.keys(committees).sort(function (a, b) {
        return committeeName(a, summary).localeCompare(committeeName(b, summary), "sv");
      }).forEach(function (code) {
        var entry = committees[code];
        select.appendChild(new Option(committeeName(code, summary) + " (" + code + ", " + fmtInt(entry.n_votes || 0) + ")", code));
      });
      select.value = state.committee;
    }

    function matrixBlock() {
      var agreement = state.summary.agreement;
      var source = state.committee ? (agreement.by_committee || {})[state.committee] : agreement.overall;
      var block = source && source[state.mode];
      return validMatrix(block, agreement.parties.length) ? block : null;
    }

    // One hue, light to dark: more agreement is darker.
    function heat(share) {
      var from = [243, 241, 236];
      var to = [31, 62, 102];
      var t = Math.max(0, Math.min(1, share));
      return "rgb(" + from.map(function (c, i) { return Math.round(c + (to[i] - c) * t); }).join(",") + ")";
    }

    function renderMatrix() {
      var table = byId("rv-matrix");
      var detail = byId("rv-matrix-detail");
      var summary = state.summary;
      var source = summary.agreement.parties;
      var minN = isInt(summary.agreement.min_cell_n) ? summary.agreement.min_cell_n : 10;
      var block = matrixBlock();
      table.innerHTML = "";
      if (!block) {
        matrixCells = [];
        if (byId("rv-matrix-empty")) byId("rv-matrix-empty").hidden = true;
        detail.textContent = "Ingen jämförelse finns för det här urvalet.";
        return;
      }
      var parties = orderParties(source);
      var modeLabel = state.mode === "three_way" ? "ja, nej eller avstår" : "bara ja och nej";
      var scopeText = scopeLabel(state.scope) + (state.committee ? ", " + committeeName(state.committee, summary) : "");
      var caption = document.createElement("caption");
      caption.className = "visually-hidden";
      caption.textContent = "Andel voteringar där två partier hade samma linje (" + modeLabel + "), " + scopeText +
        ". Rutor med färre än " + minN + " voteringar visas som streck.";
      table.appendChild(caption);
      var head = document.createElement("thead");
      var headRow = document.createElement("tr");
      var corner = document.createElement("td");
      corner.className = "rv-matrix__corner";
      headRow.appendChild(corner);
      parties.forEach(function (party) {
        var th = document.createElement("th");
        th.scope = "col";
        th.innerHTML = swatch(party) + "<abbr title=\"" + escapeHtml(partyName(party)) + "\">" + escapeHtml(party) + "</abbr>";
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      var body = document.createElement("tbody");
      var cells = [];
      parties.forEach(function (rowParty, r) {
        var tr = document.createElement("tr");
        var th = document.createElement("th");
        th.scope = "row";
        th.innerHTML = swatch(rowParty) + "<abbr title=\"" + escapeHtml(partyName(rowParty)) + "\">" + escapeHtml(rowParty) + "</abbr>";
        tr.appendChild(th);
        var i = source.indexOf(rowParty);
        parties.forEach(function (colParty, c) {
          var j = source.indexOf(colParty);
          var td = document.createElement("td");
          var n = block.n[i][j];
          var agree = block.agree[i][j];
          var share = block.share[i][j];
          td.className = "rv-matrix__cell";
          td.setAttribute("data-row", rowParty);
          td.setAttribute("data-col", colParty);
          td.setAttribute("data-n", String(n));
          var text;
          if (i === j) {
            td.className += " rv-matrix__cell--self";
            td.innerHTML = "<span aria-hidden=\"true\">·</span>";
            text = partyName(rowParty) + ": samma parti.";
          } else if (typeof share !== "number" || n < minN) {
            td.className += " rv-matrix__cell--few";
            td.setAttribute("data-share", "");
            td.innerHTML = "<span class=\"rv-matrix__value\">–</span><span class=\"rv-matrix__n\">n=" + fmtInt(n) + "</span>";
            text = rowParty + " och " + colParty + ": för få voteringar (" + fmtInt(n) + ") för att visa en andel.";
          } else {
            td.style.background = heat(share);
            td.className += share >= 0.55 ? " is-dark" : "";
            td.setAttribute("data-share", String(share));
            td.innerHTML = "<span class=\"rv-matrix__value\">" + Math.round(share * 100) + "</span>";
            text = rowParty + " och " + colParty + " hade samma linje i " + fmtPct(share) + " av voteringarna (" +
              fmtInt(agree) + " av " + fmtInt(n) + ").";
          }
          td.rvText = text;
          if (i !== j && n > 0) {
            td.className += " is-pickable";
            text += " Enter visar voteringarna.";
          }
          td.setAttribute("aria-label", text);
          td.tabIndex = r === 0 && c === 1 ? 0 : -1;
          tr.appendChild(td);
          cells.push(td);
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      detail.textContent = "Peka på en ruta, eller gå med piltangenterna, för att se antalet voteringar.";
      // When no pair reaches the minimum the whole matrix is "–": say so
      // in words rather than leave a grid of dashes to explain itself.
      var empty = byId("rv-matrix-empty");
      var shown = cells.filter(function (cell) { return cell.getAttribute("data-share"); }).length;
      var most = 0;
      cells.forEach(function (cell) {
        if (cell.getAttribute("data-row") !== cell.getAttribute("data-col")) most = Math.max(most, Number(cell.getAttribute("data-n")));
      });
      if (empty) {
        empty.hidden = shown > 0;
        empty.innerHTML = shown > 0 ? "" : "<strong>För få voteringar än.</strong> " +
          escapeHtml("Partierna har som mest " + fmtInt(most) + " gemensamma voteringar i " + scopeText +
            ", och en andel visas först från " + minN + ". Rutorna visar därför bara antalet.");
      }
      table.classList.toggle("is-empty", shown === 0);

      matrixCells = cells;
      matrixSize = parties.length;
    }

    // Bound once; the cells are whatever renderMatrix drew last. One cell is
    // in the tab order; the arrow keys move between cells.
    var matrixCells = [];
    var matrixSize = 0;

    function focusCell(cell) {
      matrixCells.forEach(function (other) { other.tabIndex = -1; other.classList.remove("is-current"); });
      cell.tabIndex = 0;
      cell.classList.add("is-current");
      byId("rv-matrix-detail").textContent = cell.rvText;
    }

    function bindMatrixKeys() {
      var table = byId("rv-matrix");
      function cellOf(event) {
        var cell = event.target && event.target.closest ? event.target.closest(".rv-matrix__cell") : null;
        return cell && matrixCells.indexOf(cell) >= 0 ? cell : null;
      }
      table.addEventListener("mouseover", function (event) {
        var cell = cellOf(event);
        if (!cell) return;
        matrixCells.forEach(function (other) { other.classList.remove("is-current"); });
        cell.classList.add("is-current");
        byId("rv-matrix-detail").textContent = cell.rvText;
      });
      // Clicking a pair (or Enter/Space on it) lists the votes behind it.
      // The diagonal -- a party against itself -- lists nothing.
      function choose(cell) {
        focusCell(cell);
        var a = cell.getAttribute("data-row");
        var b = cell.getAttribute("data-col");
        if (a !== b && Number(cell.getAttribute("data-n")) > 0) setCellFilter(a, b);
      }
      table.addEventListener("click", function (event) {
        var cell = cellOf(event);
        if (cell) choose(cell);
      });
      table.addEventListener("focusin", function (event) {
        var cell = cellOf(event);
        if (cell) focusCell(cell);
      });
      table.addEventListener("keydown", function (event) {
        var at = matrixCells.indexOf(document.activeElement);
        if (at < 0) return;
        var size = matrixSize;
        var row = Math.floor(at / size);
        var col = at % size;
        if (event.key === "ArrowRight") col = Math.min(size - 1, col + 1);
        else if (event.key === "ArrowLeft") col = Math.max(0, col - 1);
        else if (event.key === "ArrowDown") row = Math.min(size - 1, row + 1);
        else if (event.key === "ArrowUp") row = Math.max(0, row - 1);
        else if (event.key === "Home") col = 0;
        else if (event.key === "End") col = size - 1;
        else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose(matrixCells[at]);
          return;
        }
        else return;
        event.preventDefault();
        matrixCells[row * size + col].focus();
      });
    }

    function bindMatrixControls() {
      var buttons = Array.prototype.slice.call(app.querySelectorAll("#rv-mode button[data-mode]"));
      buttons.forEach(function (button) {
        button.addEventListener("click", function () {
          state.mode = button.getAttribute("data-mode");
          buttons.forEach(function (other) {
            other.setAttribute("aria-pressed", other === button ? "true" : "false");
          });
          if (state.summary) renderMatrix();
          writeUrl();
        });
      });
      byId("rv-committee").addEventListener("change", function (event) {
        state.committee = event.target.value;
        if (state.summary) renderMatrix();
        writeUrl();
      });
    }

    // --- 2. the map ---------------------------------------------------------------
    var mapState = { points: [], current: null };

    function patternText(pattern) {
      var parts = [];
      if (pattern.parties_ja && pattern.parties_ja.length) parts.push(pattern.parties_ja.join(", ") + " röstar ja");
      if (pattern.parties_nej && pattern.parties_nej.length) parts.push(pattern.parties_nej.join(", ") + " nej");
      if (pattern.parties_avstar && pattern.parties_avstar.length) parts.push(pattern.parties_avstar.join(", ") + " avstår");
      return parts.join(" – ");
    }

    // An axis is described by its top-loading party-line pattern, never by
    // a named scale. Its two ends are labelled with that pattern's sides:
    // the end the Ja parties score towards, and the opposite one.
    function axisText(map, axis) {
      var patterns = map.top_loading_patterns && map.top_loading_patterns["axis_" + axis];
      var share = Array.isArray(map.explained_variance_ratio) ? map.explained_variance_ratio[axis - 1] : null;
      var head = "Axel " + axis + (typeof share === "number" ? " – förklarar " + fmtPct(share) + " av variationen" : "");
      if (!Array.isArray(patterns) || !patterns.length || typeof patterns[0].loading !== "number") {
        return { head: head, body: "", positive: null, negative: null };
      }
      var top = patterns[0];
      var ja = (top.parties_ja || []).join(", ") + " ja";
      var nej = (top.parties_nej || []).join(", ") + " nej";
      // The pipeline names a few votes with that pattern; the first one
      // makes the pattern concrete.
      var example = Array.isArray(top.example_votes) && isObject(top.example_votes[0]) ? top.example_votes[0] : null;
      var exampleText = example && typeof example.title === "string"
        ? " Till exempel ”" + example.title + "”" +
          (typeof example.beteckning === "string" ? " (" + example.beteckning + (example.punkt ? " punkt " + example.punkt : "") +
            (example.date ? ", " + swedishDate(example.date) : "") + ")" : "") + "."
        : "";
      return {
        head: head,
        body: "Tyngst väger röstmönstret ”" + patternText(top) + "” (" + fmtInt(top.n_votes) +
          " voteringar)." + exampleText + " Axelns ändar är märkta med det mönstret.",
        positive: top.loading >= 0 ? ja : nej,
        negative: top.loading >= 0 ? nej : ja
      };
    }

    // Which way the axes point: a convention, so that the same direction
    // means the same thing in every period.
    // A term's map is anchored (map.orientation_axes[k].anchor); a
    // session's is aligned to its term (map.orientation_reference), so the
    // same direction means the same thing in both.
    function orientationText(summary) {
      var map = summary.map;
      var axes = Array.isArray(map.orientation_axes) ? map.orientation_axes : [];
      var anchors = summary.rules && Array.isArray(summary.rules.map_axis_anchors) ? summary.rules.map_axis_anchors : [];
      var anchored = axes.length === 2 && axes.every(function (a) { return isObject(a) && a.method === "anchor" && typeof a.anchor === "string"; });
      var reference = typeof map.orientation_reference === "string" && /^term-\d{4}-\d{2}$/.test(map.orientation_reference)
        ? map.orientation_reference.slice(5).replace("-", "–") : null;
      if (anchored) {
        return "Riktningen är en konvention: axel 1 är vänd så att " + axes[0].anchor + " hamnar på den positiva sidan, axel 2 så att " +
          axes[1].anchor + " gör det. Riksmötena i perioden vänds likadant, så samma riktning betyder samma sak.";
      }
      if (reference) {
        return "Axlarna är vända som i mandatperioden " + reference +
          (anchors.length === 2 ? " (där " + anchors[0] + " är på axel 1:s och " + anchors[1] + " på axel 2:s positiva sida)" : "") +
          ", så samma riktning betyder samma sak i riksmötet och i perioden.";
      }
      return "";
    }

    function renderMap() {
      var summary = state.summary;
      var map = summary.map;
      var frame = byId("rv-map-frame");
      var svg = byId("rv-map");
      var note = byId("rv-map-unavailable");
      var axes = byId("rv-map-axes");
      var unplacedNote = byId("rv-map-unplaced");
      var tip = byId("rv-map-tip");
      tip.hidden = true;
      mapState.current = null;
      var coords = map && map.party_coordinates;
      var help = byId("rv-map-help");
      if (!map || map.available !== true || !isObject(coords)) {
        frame.hidden = true;
        if (help) help.hidden = true;
        axes.innerHTML = "";
        unplacedNote.textContent = "";
        var n = map && map.n_votes && isInt(map.n_votes.map) ? map.n_votes.map : null;
        note.innerHTML = "<strong>För få voteringar än.</strong> " + escapeHtml("Kartan över " + scopeLabel(state.scope) +
          " ritas när det finns minst " + ((summary.rules && summary.rules.min_map_votes_for_fit) || 20) +
          " voteringar där alla partier har en linje och minoriteten är minst 2,5 %" +
          (n !== null ? "; hittills finns " + fmtInt(n) : "") + ". Välj en tidigare period i listan ovan för att se kartan.");
        note.hidden = false;
        return;
      }
      note.hidden = true;
      frame.hidden = false;
      if (help) help.hidden = false;
      var parties = orderParties(Object.keys(coords).filter(function (p) {
        return Array.isArray(coords[p]) && typeof coords[p][0] === "number" && typeof coords[p][1] === "number";
      }));
      var members = summary.members.filter(function (m) {
        return m.map && typeof m.map.x === "number" && typeof m.map.y === "number";
      });
      var unplaced = summary.members.length - members.length;
      var xs = parties.map(function (p) { return coords[p][0]; }).concat(members.map(function (m) { return m.map.x; }));
      var ys = parties.map(function (p) { return coords[p][1]; }).concat(members.map(function (m) { return m.map.y; }));
      var pad = 0.08;
      var x0 = Math.min.apply(null, xs) - pad;
      var x1 = Math.max.apply(null, xs) + pad;
      var y0 = Math.min.apply(null, ys) - pad;
      var y1 = Math.max.apply(null, ys) + pad;
      // One scale on both axes, so a distance means the same in every direction.
      var width = 640;
      var scale = width / (x1 - x0);
      var height = Math.max(240, Math.min(420, (y1 - y0) * scale));
      if ((y1 - y0) * scale < height) {
        var extra = (height / scale - (y1 - y0)) / 2;
        y0 -= extra;
        y1 += extra;
      } else {
        scale = height / (y1 - y0);
        var extraX = (width / scale - (x1 - x0)) / 2;
        x0 -= extraX;
        x1 += extraX;
      }
      var px = function (x) { return (x - x0) * scale; };
      var py = function (y) { return height - (y - y0) * scale; };
      var ns = "http://www.w3.org/2000/svg";
      svg.setAttribute("viewBox", "0 0 " + width + " " + Math.round(height));
      svg.innerHTML = "";
      function el(name, attrs, parent) {
        var node = document.createElementNS(ns, name);
        Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
        (parent || svg).appendChild(node);
        return node;
      }
      el("line", { x1: px(0), x2: px(0), y1: 0, y2: height, "class": "rv-map__axis" });
      el("line", { x1: 0, x2: width, y1: py(0), y2: py(0), "class": "rv-map__axis" });
      var dots = el("g", { "class": "rv-map__members", "aria-hidden": "true" });
      mapState.points = members.map(function (member) {
        var x = px(member.map.x);
        var y = py(member.map.y);
        var dot = el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.6, fill: partyColor(member.party), "class": "rv-map__mp" }, dots);
        dot.setAttribute("data-party", member.party);
        return { x: x, y: y, member: member, node: dot };
      });
      // Parties that vote alike share a point; they are drawn as a row of
      // chips centred on it rather than on top of one another.
      var clusters = [];
      parties.forEach(function (party) {
        var x = px(coords[party][0]);
        var y = py(coords[party][1]);
        var hit = clusters.filter(function (c) { return Math.abs(c.x - x) < 14 && Math.abs(c.y - y) < 14; })[0];
        if (hit) hit.parties.push(party);
        else clusters.push({ x: x, y: y, parties: [party] });
      });
      var partyLayer = el("g", { "class": "rv-map__parties" });
      var chip = 26;
      clusters.forEach(function (cluster) {
        var count = cluster.parties.length;
        var startX = cluster.x - (count - 1) * chip / 2;
        startX = Math.max(chip / 2 + 2, Math.min(width - chip / 2 - 2 - (count - 1) * chip, startX));
        if (count > 1) {
          el("rect", {
            x: (startX - chip / 2 - 3).toFixed(1), y: (cluster.y - chip / 2 - 3).toFixed(1),
            width: (count * chip + 6).toFixed(1), height: chip + 6, rx: (chip / 2 + 3).toFixed(1),
            "class": "rv-map__cluster"
          }, partyLayer);
        }
        cluster.parties.forEach(function (party, k) {
          var cx = startX + k * chip;
          var group = el("g", { "class": "rv-map__party", "data-party": party }, partyLayer);
          el("circle", { cx: cx.toFixed(1), cy: cluster.y.toFixed(1), r: chip / 2 - 1, fill: partyColor(party) }, group);
          var label = el("text", { x: cx.toFixed(1), y: (cluster.y + 3.6).toFixed(1), "text-anchor": "middle" }, group);
          label.textContent = party;
        });
      });
      var described = parties.map(function (p) {
        return p + " " + coords[p][0].toFixed(2).replace(".", ",") + "/" + coords[p][1].toFixed(2).replace(".", ",");
      }).join("; ");
      svg.setAttribute("aria-label", "Karta över riksdagen, " + scopeLabel(state.scope) + ". Partiernas lägen (axel 1/axel 2): " +
        described + ". " + members.length + " ledamöter som små punkter; använd piltangenterna för att gå mellan dem.");
      var shared = clusters.filter(function (c) { return c.parties.length > 1; });
      var axisOne = axisText(map, 1);
      var axisTwo = axisText(map, 2);
      var ends = el("g", { "class": "rv-map__ends", "aria-hidden": "true" });
      svg.insertBefore(ends, dots);
      function endLabel(text, x, y, anchor, kind) {
        var node = el("text", { x: x, y: y, "text-anchor": anchor, "class": "rv-map__end", "data-end": kind }, ends);
        node.textContent = text;
      }
      if (axisOne.positive) {
        endLabel(axisOne.positive + " →", width - 6, height - 7, "end", "x+");
        endLabel("← " + axisOne.negative, 6, height - 7, "start", "x-");
      }
      if (axisTwo.positive) {
        endLabel("↑ " + axisTwo.positive, px(0) + 6, 14, "start", "y+");
        endLabel("↓ " + axisTwo.negative, px(0) + 6, height - 22, "start", "y-");
      }
      axes.innerHTML =
        "<li><strong>" + escapeHtml(axisOne.head) + " (vågrät).</strong> " + escapeHtml(axisOne.body) + "</li>" +
        "<li><strong>" + escapeHtml(axisTwo.head) + " (lodrät).</strong> " + escapeHtml(axisTwo.body) + "</li>" +
        (shared.length ? "<li>" + escapeHtml(shared.map(function (c) { return c.parties.join(", "); }).join("; ")) +
          " röstar så lika att de hamnar på samma punkt och ritas bredvid varandra.</li>" : "");
      byId("rv-map-orientation").textContent = orientationText(summary);
      var minMp = (summary.rules && summary.rules.min_mp_map_votes) || 50;
      unplacedNote.textContent = members.length + " ledamöter är utplacerade" +
        (unplaced ? "; " + unplaced + " som har avlagt färre än " + minMp + " röster i kartans voteringar visas inte" : "") + ".";
    }

    function memberLines(member, summary) {
      var parties = isObject(member.parties) ? Object.keys(member.parties) : [member.party];
      var partyText = parties.length > 1
        ? parties.map(function (p) { return p === INDEPENDENT ? "politisk vilde" : p; }).join(" → ")
        : partyName(member.party);
      var seated = isInt(member.seated) ? member.seated : null;
      var cast = isInt(member.cast) ? member.cast : null;
      var lines = [partyText + (member.valkrets ? " · " + member.valkrets : "")];
      if (cast !== null && seated !== null) {
        lines.push("Avlagda röster: " + fmtInt(cast) + " av " + fmtInt(seated) + " voteringar på sin plats" +
          (seated > 0 ? " (deltagande " + fmtPct(cast / seated) + ")" : ""));
      }
      return lines;
    }

    var KVITTNING = "Frånvaro omfattar kvittning, där en ledamot avstår från att rösta efter överenskommelse med en ledamot från andra sidan; det är inget mått på flit.";

    function showMapPoint(point, announce) {
      var tip = byId("rv-map-tip");
      var frame = byId("rv-map-frame");
      if (mapState.current) mapState.current.node.classList.remove("is-current");
      mapState.current = point;
      if (!point) { tip.hidden = true; return; }
      point.node.classList.add("is-current");
      point.node.parentNode.appendChild(point.node);
      var lines = memberLines(point.member, state.summary);
      tip.innerHTML = "<span class=\"ep-tip__name\">" + swatch(point.member.party) + escapeHtml(point.member.name) + "</span>" +
        lines.map(function (line, i) {
          return "<span class=\"" + (i === 0 ? "ep-tip__meta" : "ep-tip__line") + "\">" + escapeHtml(line) + "</span>";
        }).join("") +
        "<span class=\"ep-tip__role\">Frånvaro omfattar kvittning.</span>";
      tip.hidden = false;
      var svg = byId("rv-map");
      var box = frame.getBoundingClientRect();
      var svgBox = svg.getBoundingClientRect();
      var view = svg.viewBox.baseVal;
      var k = svgBox.width / view.width;
      var x = svgBox.left - box.left + point.x * k;
      var y = svgBox.top - box.top + point.y * k;
      var half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(box.width - half, x)) + "px";
      var above = y - tip.offsetHeight - 10;
      tip.style.top = (above >= 0 ? above : y + 10) + "px";
      if (announce) {
        byId("rv-map-status").textContent = point.member.name + ", " + lines.join(", ") + ". " + KVITTNING;
      }
    }

    function bindMap() {
      var svg = byId("rv-map");
      function nearest(event) {
        var view = svg.viewBox.baseVal;
        var box = svg.getBoundingClientRect();
        if (!view || !box.width) return null;
        var k = view.width / box.width;
        var x = (event.clientX - box.left) * k;
        var y = (event.clientY - box.top) * k;
        var best = null;
        var limit = 14 * k;
        mapState.points.forEach(function (point) {
          var d = Math.sqrt((point.x - x) * (point.x - x) + (point.y - y) * (point.y - y));
          if (d <= limit && (!best || d < best.d)) best = { d: d, point: point };
        });
        return best ? best.point : null;
      }
      svg.addEventListener("pointermove", function (event) {
        if (event.pointerType === "touch") return;
        var point = nearest(event);
        if (point !== mapState.current) showMapPoint(point, false);
      });
      svg.addEventListener("pointerleave", function () {
        if (document.activeElement !== svg) showMapPoint(null);
      });
      svg.addEventListener("click", function (event) {
        showMapPoint(nearest(event), true);
      });
      svg.addEventListener("blur", function () { showMapPoint(null); });
      svg.addEventListener("keydown", function (event) {
        var points = mapState.points.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
        if (!points.length) return;
        var at = mapState.current ? points.indexOf(mapState.current) : -1;
        var next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = at + 1;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = at < 0 ? points.length - 1 : at - 1;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = points.length - 1;
        else if (event.key === "Escape") { showMapPoint(null); return; }
        if (next === null) return;
        event.preventDefault();
        showMapPoint(points[Math.max(0, Math.min(points.length - 1, next))], true);
      });
      document.addEventListener("click", function (event) {
        if (mapState.current && !svg.contains(event.target)) showMapPoint(null);
      });
    }

    // --- 3. against the party line ---------------------------------------------------
    // Sorted by name, by the number of votes against the line, or by that
    // number's share of the member's comparable votes. Never by
    // participation: absence includes kvittning.
    var AGAINST_SORTS = ["namn", "antal", "andel"];
    var againstState = { query: "", party: "", onlyAgainst: true, limit: 40, sort: "namn", open: null };

    function againstShare(member) {
      return member.against_line_comparable > 0 ? member.against_line / member.against_line_comparable : -1;
    }

    function renderAgainst() {
      var summary = state.summary;
      var table = byId("rv-against-parties");
      var counts = summary.party_against_line || {};
      var parties = orderParties(Object.keys(counts));
      var rows = parties.map(function (party) {
        var entry = counts[party] || {};
        var against = isInt(entry.against) ? entry.against : 0;
        var comparable = isInt(entry.comparable) ? entry.comparable : 0;
        return "<tr data-party=\"" + escapeHtml(party) + "\"><th scope=\"row\">" + swatch(party) + escapeHtml(partyName(party)) + "</th>" +
          "<td class=\"rv-num\">" + fmtInt(against) + "</td>" +
          "<td class=\"rv-num\">" + fmtInt(comparable) + "</td>" +
          "<td class=\"rv-num\">" + (comparable ? fmtPct(against / comparable, 2) : "–") + "</td></tr>";
      });
      table.innerHTML = "<caption class=\"visually-hidden\">Röster mot partilinjen per parti, " + escapeHtml(scopeLabel(state.scope)) + "</caption>" +
        "<thead><tr><th scope=\"col\">Parti</th><th scope=\"col\" class=\"rv-num\">Mot partilinjen</th>" +
        "<th scope=\"col\" class=\"rv-num\">Jämförbara röster</th><th scope=\"col\" class=\"rv-num\">Andel</th></tr></thead>" +
        "<tbody>" + rows.join("") + "</tbody>";
      var party = byId("rv-against-party");
      party.innerHTML = "";
      party.appendChild(new Option("Alla partier", ""));
      orderParties(summary.members.map(function (m) { return m.party; }).filter(function (p, i, all) {
        return all.indexOf(p) === i && p !== INDEPENDENT;
      })).concat(summary.members.some(function (m) { return m.party === INDEPENDENT; }) ? [INDEPENDENT] : []).forEach(function (p) {
        party.appendChild(new Option(p === INDEPENDENT ? "Politiska vildar" : partyName(p), p));
      });
      if (againstState.party && !summary.members.some(function (m) { return m.party === againstState.party; })) againstState.party = "";
      party.value = againstState.party;
      againstState.limit = 40;
      renderMemberList();
    }

    function filteredMembers() {
      var q = againstState.query.trim().toLowerCase();
      return state.summary.members.filter(function (m) {
        if (againstState.party && m.party !== againstState.party) return false;
        if (againstState.onlyAgainst && !(m.against_line > 0)) return false;
        if (q && (m.name + " " + (m.valkrets || "")).toLowerCase().indexOf(q) < 0) return false;
        return true;
      }).sort(function (a, b) {
        var byName = a.name.localeCompare(b.name, "sv");
        if (againstState.sort === "antal") return (b.against_line || 0) - (a.against_line || 0) || byName;
        if (againstState.sort === "andel") return againstShare(b) - againstShare(a) || byName;
        return byName;
      });
    }

    function renderMemberList() {
      var list = byId("rv-members");
      var count = byId("rv-members-count");
      var more = byId("rv-members-more");
      var members = filteredMembers();
      var shown = members.slice(0, againstState.limit);
      count.textContent = members.length === 1 ? "1 ledamot" : fmtInt(members.length) + " ledamöter";
      list.innerHTML = "";
      shown.forEach(function (member, i) {
        var li = document.createElement("li");
        li.className = "rv-member";
        li.setAttribute("data-member", member.id || "");
        var id = "rv-member-" + i;
        var against = isInt(member.against_line) ? member.against_line : 0;
        var comparable = isInt(member.against_line_comparable) ? member.against_line_comparable : 0;
        li.innerHTML =
          "<button type=\"button\" class=\"rv-member__toggle\" aria-expanded=\"false\" aria-controls=\"" + id + "\">" +
            "<span class=\"rv-member__name\">" + swatch(member.party) + escapeHtml(member.name) + "</span>" +
            "<span class=\"rv-member__meta\">" + escapeHtml((member.party === INDEPENDENT ? "politisk vilde" : member.party) +
              (member.valkrets ? " · " + member.valkrets : "")) + "</span>" +
            "<span class=\"rv-member__count\">" + fmtInt(against) + " av " + fmtInt(comparable) +
              (againstState.sort === "andel" && comparable > 0 ? " · " + fmtPct(against / comparable, 2) : "") + "</span>" +
          "</button>" +
          "<div class=\"rv-member__detail\" id=\"" + id + "\" hidden></div>";
        var button = li.querySelector("button");
        var detail = li.querySelector(".rv-member__detail");
        function toggle(open) {
          button.setAttribute("aria-expanded", open ? "true" : "false");
          detail.hidden = !open;
          if (open && !detail.getAttribute("data-filled")) fillMemberDetail(member, detail);
        }
        button.addEventListener("click", function () {
          var open = button.getAttribute("aria-expanded") !== "true";
          toggle(open);
          if (open) againstState.open = member.id;
          else if (againstState.open === member.id) againstState.open = null;
          writeUrl();
        });
        if (againstState.open && againstState.open === member.id) toggle(true);
        list.appendChild(li);
      });
      more.hidden = members.length <= shown.length;
      more.textContent = "Visa fler (" + fmtInt(members.length - shown.length) + " till)";
    }

    function fillMemberDetail(member, detail) {
      detail.setAttribute("data-filled", "true");
      var lines = memberLines(member, state.summary);
      var head = "<p class=\"rv-member__facts\">" + lines.map(escapeHtml).join("<br>") + "</p>" +
        "<p class=\"election-muted rv-member__caveat\">" + escapeHtml(KVITTNING) + "</p>";
      var ids = Array.isArray(member.against_line_vote_ids) ? member.against_line_vote_ids : [];
      if (!ids.length) {
        detail.innerHTML = head + "<p class=\"rv-member__none\">Inga röster mot partilinjen i " + escapeHtml(scopeLabel(state.scope)) + ".</p>";
        return;
      }
      detail.innerHTML = head + "<p class=\"election-muted\">Läser in voteringarna …</p>";
      var summary = state.summary;
      var sessions = [];
      ids.forEach(function (id) {
        var rm = summary.voteRm[id] || (state.scope.kind === "session" ? state.scope.rm : null);
        if (rm && sessions.indexOf(rm) < 0) sessions.push(rm);
      });
      Promise.all(sessions.map(loadVotes)).then(function () {
        var rows = ids.map(function (id) {
          var rm = summary.voteRm[id] || state.scope.rm;
          var data = state.votes[rm];
          var vote = data && data.byId[id];
          if (!vote) return { date: "", html: "<li>Votering " + escapeHtml(id) + "</li>" };
          var lines = partyLines(data, vote);
          var bench = null;
          for (var b = 1; b <= CHAMBER; b += 1) {
            var who = occupant(data, vote, b);
            if (who.id && who.id === member.id) { bench = b; break; }
          }
          var cast = bench ? vote.ballots.charAt(bench - 1) : null;
          var party = bench ? occupant(data, vote, bench).party : member.party;
          var line = lines.lines[party];
          return {
            date: vote.date || "",
            html: "<li><button type=\"button\" class=\"rv-linkish\" data-vote=\"" + escapeHtml(vote.id) + "\" data-rm=\"" + escapeHtml(rm) + "\">" +
              escapeHtml(voteTitle(vote)) + "</button>" +
              (votePoint(vote) ? "<span class=\"rv-member__vote-meta\">" + escapeHtml(votePoint(vote)) + "</span>" : "") +
              "<span class=\"rv-member__vote-meta\">" + escapeHtml(swedishDate(vote.date)) +
              (cast ? " · röstade " + CHOICE_LABELS[cast].toLowerCase() : "") +
              (line ? ", " + party + " " + CHOICE_LABELS[line].toLowerCase() : "") + "</span></li>"
          };
        }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
        detail.innerHTML = head + "<ul class=\"rv-member__votes\">" + rows.map(function (r) { return r.html; }).join("") + "</ul>" +
          "<p class=\"election-muted\">Enstaka röster mot partilinjen kan vara feltryckningar; de står kvar i protokollet som avlagda.</p>";
        Array.prototype.forEach.call(detail.querySelectorAll("button[data-vote]"), function (button) {
          button.addEventListener("click", function () {
            openVote(button.getAttribute("data-rm"), button.getAttribute("data-vote"));
          });
        });
      }).catch(function (error) {
        console.warn("Voteringarna kunde inte läsas in.", error);
        detail.innerHTML = head + "<p class=\"election-muted\">Voteringarna kunde inte läsas in just nu.</p>";
      });
    }

    function bindAgainst() {
      var search = byId("rv-against-search");
      var party = byId("rv-against-party");
      var only = byId("rv-against-only");
      search.addEventListener("input", function () {
        againstState.query = search.value;
        againstState.limit = 40;
        renderMemberList();
        writeUrl();
      });
      party.addEventListener("change", function () {
        againstState.party = party.value;
        againstState.limit = 40;
        renderMemberList();
        writeUrl();
      });
      only.addEventListener("change", function () {
        againstState.onlyAgainst = only.checked;
        againstState.limit = 40;
        renderMemberList();
        writeUrl();
      });
      byId("rv-against-sort").addEventListener("change", function (event) {
        againstState.sort = AGAINST_SORTS.indexOf(event.target.value) >= 0 ? event.target.value : "namn";
        againstState.limit = 40;
        renderMemberList();
        writeUrl();
      });
      byId("rv-members-more").addEventListener("click", function () {
        againstState.limit += 80;
        renderMemberList();
      });
    }

    // --- 4. the vote browser ----------------------------------------------------------
    // One session at a time, or every session of a term ("Hela perioden").
    // The filters combine: utskott, search, the quick filters and a pair of
    // parties picked in the agreement matrix.
    var ALL_SESSIONS = "alla";
    var browserState = {
      query: "", committee: "", limit: 30, requested: false,
      chips: { close: false, cross: false, dissent: false },
      // {a, b, rel: "same"|"diff", mode, committee} from a matrix cell.
      cell: null
    };
    // The riksmöte the chamber's seating plan is for: its votes link to
    // "Som i kammaren" on the election page. Null until the plan is read.
    var chamberSession = null;

    function browserSessions() {
      return state.scope.sessions.filter(function (rm) {
        return state.index.sessions.some(function (s) { return s.rm === rm; });
      });
    }

    function shownSessions() {
      if (state.browserSession === ALL_SESSIONS) return browserSessions();
      return state.browserSession ? [state.browserSession] : [];
    }

    function defaultBrowserSession() {
      var sessions = browserSessions();
      return sessions[sessions.length - 1] || null;
    }

    function renderBrowserSessions() {
      var select = byId("rv-browser-session");
      var sessions = browserSessions().slice().reverse();
      select.innerHTML = "";
      if (sessions.length > 1) select.appendChild(new Option("Hela perioden", ALL_SESSIONS));
      sessions.forEach(function (rm) { select.appendChild(new Option(rm, rm)); });
      var valid = state.browserSession === ALL_SESSIONS ? sessions.length > 1 : sessions.indexOf(state.browserSession) >= 0;
      if (!valid) state.browserSession = defaultBrowserSession();
      select.value = state.browserSession || "";
      if (browserState.requested) loadBrowser();
    }

    function loadSeatingPlan() {
      if (chamberSession !== null || !app.getAttribute("data-seating-plan")) return Promise.resolve(chamberSession);
      return fetchJson(app.getAttribute("data-seating-plan")).then(function (plan) {
        if (isObject(plan) && plan.role === "riksdag_seating_plan" && typeof plan.riksmote === "string" &&
            /^\d{4}\/\d{2}$/.test(plan.riksmote)) chamberSession = plan.riksmote;
        else chamberSession = "";
        return chamberSession;
      }).catch(function () {
        chamberSession = "";
        return chamberSession;
      });
    }

    function loadBrowser() {
      browserState.requested = true;
      var wanted = shownSessions();
      var key = state.browserSession;
      var list = byId("rv-votes");
      var count = byId("rv-votes-count");
      if (!wanted.length) return Promise.resolve();
      if (wanted.some(function (rm) { return !state.votes[rm]; })) {
        count.textContent = "Läser in voteringarna …";
        list.innerHTML = "";
      }
      return Promise.all(wanted.map(loadVotes).concat([loadSeatingPlan()])).then(function () {
        if (state.browserSession !== key) return;
        renderBrowserCommittees();
        renderChips();
        renderVoteList();
      }).catch(function (error) {
        console.warn("Voteringarna kunde inte läsas in.", error);
        count.textContent = "Voteringarna kunde inte läsas in just nu.";
      });
    }

    function loadedData() {
      return shownSessions().map(function (rm) { return state.votes[rm]; }).filter(Boolean);
    }

    function renderBrowserCommittees() {
      var select = byId("rv-browser-committee");
      var codes = [];
      loadedData().forEach(function (data) {
        data.votes.forEach(function (vote) {
          var code = vote.committee || "övrigt";
          if (codes.indexOf(code) < 0) codes.push(code);
        });
      });
      select.innerHTML = "";
      select.appendChild(new Option("Alla utskott", ""));
      codes.sort(function (a, b) {
        return committeeName(a, state.summary).localeCompare(committeeName(b, state.summary), "sv");
      }).forEach(function (code) {
        select.appendChild(new Option(committeeName(code, state.summary) + (code !== "övrigt" ? " (" + code + ")" : ""), code));
      });
      if (codes.indexOf(browserState.committee) < 0) browserState.committee = "";
      select.value = browserState.committee;
    }

    // What the pipeline says about one vote: its margin, how many voted
    // against their party line, and whether it split the blocs.
    function voteFacts(data, vote) {
      var flags = state.summary && state.summary.voteFlags ? state.summary.voteFlags[vote.id] : null;
      return flags || { margin: Math.abs(vote.counts.J - vote.counts.N), against: null, crossBloc: null };
    }

    function sessionHasCrossBloc(rm) {
      if (!state.summary || !state.summary.voteFlags || !rm) return false;
      return state.summary.party_lines.votes.some(function (entry) {
        if (entry.rm !== rm) return false;
        var flags = state.summary.voteFlags[entry.id];
        return Boolean(flags && flags.crossBloc === true);
      });
    }

    // A party's line on a vote, as the pipeline's party_lines records it.
    function lineOf(id, party) {
      var lines = state.summary.lineIndex[id];
      var at = state.summary.party_lines.parties.indexOf(party);
      return lines && at >= 0 ? lines[at] : null;
    }

    // The matrix's rule, for one pair: an analysis vote of the cell's
    // committee where both parties have a line (Ja or Nej in "Bara Ja/Nej").
    function cellMatches(vote) {
      var cell = browserState.cell;
      if (!cell) return true;
      if (!vote.analysis) return false;
      if (cell.committee && (vote.committee || "övrigt") !== cell.committee) return false;
      var a = lineOf(vote.id, cell.a);
      var b = lineOf(vote.id, cell.b);
      if (cell.mode === "ja_nej" ? !/^[JN]$/.test(a || "") || !/^[JN]$/.test(b || "") : !a || !b) return false;
      return cell.rel === "same" ? a === b : a !== b;
    }

    function voteMatches(data, vote, q) {
      if (browserState.committee && (vote.committee || "övrigt") !== browserState.committee) return false;
      if (!cellMatches(vote)) return false;
      var facts = voteFacts(data, vote);
      if (browserState.chips.dissent && !(facts.against > 0)) return false;
      if (browserState.chips.cross && facts.crossBloc !== true) return false;
      if (!q) return true;
      var hay = [voteTitle(vote), vote.punktTitle || "", vote.beteckning, vote.committee || "",
        vote.committee ? committeeName(vote.committee, state.summary) : "", vote.date || "", swedishDate(vote.date)]
        .join(" ").toLowerCase();
      return q.split(/\s+/).every(function (word) { return hay.indexOf(word) >= 0; });
    }

    function blocsText() {
      var blocs = state.summary.blocs;
      if (!isObject(blocs)) return null;
      var side = Array.isArray(blocs.government_side) ? blocs.government_side.join(", ") : "";
      var other = Array.isArray(blocs.opposition) ? blocs.opposition.join(", ") : "";
      return "Blocken är statsministeromröstningens " + swedishDate(blocs.date) +
        (typeof blocs.title === "string" ? " (" + blocs.title + ")" : "") + ": regeringssidan " + side + ", oppositionen " + other +
        (Array.isArray(blocs.abstained) && blocs.abstained.length ? "; " + blocs.abstained.join(", ") + " avstod" : "") + ".";
    }

    function renderChips() {
      var cross = app.querySelector("#rv-chips [data-chip=\"cross\"]");
      var dissent = app.querySelector("#rv-chips [data-chip=\"dissent\"]");
      var flags = Boolean(state.summary.voteFlags);
      var text = blocsText();
      var available = Boolean(text) && flags;
      if (!available) browserState.chips.cross = false;
      if (!flags) browserState.chips.dissent = false;
      cross.hidden = !flags;
      cross.disabled = !available;
      dissent.hidden = !flags;
      cross.title = available ? text : (flags ? "Blocköverskridande är inaktiverat: ingen godkänd statsministeromröstning i perioden än." : "");
      var note = byId("rv-blocs-note");
      note.textContent = available
        ? "Blocköverskridande (ja/nej-linjer): både regeringssidan och oppositionen har minst ett parti på vinnande och minst ett på förlorande sida. " + text
        : (flags ? "Blocköverskridande är inaktiverat tills en statsministeromröstning har fastställt blocken i perioden." : "");
      note.hidden = !flags;
      Array.prototype.forEach.call(app.querySelectorAll("#rv-chips [data-chip]"), function (chip) {
        var pressed = !chip.disabled && Boolean(browserState.chips[chip.getAttribute("data-chip")]);
        chip.setAttribute("aria-pressed", pressed ? "true" : "false");
      });
      renderCellPill();
    }

    function renderCellPill() {
      var pill = byId("rv-cell-filter");
      var cell = browserState.cell;
      pill.hidden = !cell;
      if (!cell) return;
      byId("rv-cell-filter-text").textContent = cell.a + " och " + cell.b + " hade " +
        (cell.rel === "same" ? "samma linje" : "olika linjer") + " (" +
        (cell.mode === "ja_nej" ? "bara ja/nej" : "ja/nej/avstår") + ", " +
        (cell.committee ? committeeName(cell.committee, state.summary) : "alla utskott") + ")";
      Array.prototype.forEach.call(pill.querySelectorAll("[data-rel]"), function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-rel") === cell.rel ? "true" : "false");
      });
    }

    function renderVoteList() {
      var datasets = loadedData();
      if (!datasets.length || datasets.length !== shownSessions().length) return;
      var list = byId("rv-votes");
      var count = byId("rv-votes-count");
      var more = byId("rv-votes-more");
      var q = browserState.query.trim().toLowerCase();
      var votes = [];
      datasets.forEach(function (data) {
        data.votes.forEach(function (vote) {
          if (voteMatches(data, vote, q)) votes.push({ data: data, vote: vote });
        });
      });
      var byDate = function (a, b) {
        var da = a.vote.date || "";
        var db = b.vote.date || "";
        return da < db ? 1 : da > db ? -1 : a.data.rm < b.data.rm ? 1 : a.data.rm > b.data.rm ? -1 : b.vote.order - a.vote.order;
      };
      // "Jämnaste": smallest |ja − nej| first; ties newest first.
      votes.sort(browserState.chips.close ? function (a, b) {
        return voteFacts(a.data, a.vote).margin - voteFacts(b.data, b.vote).margin || byDate(a, b);
      } : byDate);
      var shown = votes.slice(0, browserState.limit);
      var filtered = q || browserState.committee || browserState.cell || browserState.chips.cross || browserState.chips.dissent;
      count.textContent = (votes.length === 1 ? "1 votering" : fmtInt(votes.length) + " voteringar") +
        (state.browserSession === ALL_SESSIONS ? " i " + scopeLabel(state.scope) : " i riksmötet " + state.browserSession) +
        (filtered ? " matchar" : "") + (browserState.chips.close ? ", jämnaste först" : "") + ".";
      list.innerHTML = "";
      shown.forEach(function (entry) {
        var vote = entry.vote;
        var li = document.createElement("li");
        li.className = "rv-vote";
        var selected = state.selectedVote && state.selectedVote.id === vote.id;
        var facts = voteFacts(entry.data, vote);
        li.innerHTML =
          "<button type=\"button\" class=\"rv-vote__button\" data-vote=\"" + escapeHtml(vote.id) + "\" data-rm=\"" + escapeHtml(entry.data.rm) +
            "\" aria-pressed=\"" + (selected ? "true" : "false") + "\">" +
            "<span class=\"rv-vote__date\">" + escapeHtml(swedishDate(vote.date)) +
              (state.browserSession === ALL_SESSIONS ? " · " + escapeHtml(entry.data.rm) : "") + "</span>" +
            "<span class=\"rv-vote__title\">" + escapeHtml(voteTitle(vote)) +
              (votePoint(vote) ? "<span class=\"rv-vote__point\">" + escapeHtml(votePoint(vote)) + "</span>" : "") + "</span>" +
            "<span class=\"rv-vote__tally\">" + resultBar(vote) +
              (facts.against > 0 ? "<span class=\"rv-vote__flag\">" + facts.against + " mot partilinjen</span>" : "") +
              (facts.crossBloc === true ? "<span class=\"rv-vote__flag\">blocköverskridande</span>" : "") + "</span>" +
          "</button>" + chamberLink(entry.data, vote, "rv-vote__chamber");
        li.querySelector("button").addEventListener("click", function () {
          selectVote(entry.data, vote, true);
          writeUrl();
        });
        list.appendChild(li);
      });
      more.hidden = votes.length <= shown.length;
      more.textContent = "Visa fler (" + fmtInt(votes.length - shown.length) + " till)";
    }

    // "Visa i kammaren": a vote of the session the chamber's seating plan is
    // for opens on the election page with that vote on the hall.
    function chamberLink(data, vote, className) {
      var page = app.getAttribute("data-chamber-page");
      if (!page || !chamberSession || data.rm !== chamberSession) return "";
      var href = page + "?riksdag_vote=" + encodeURIComponent(vote.id) + "#valet-2026";
      return "<a class=\"" + className + "\" href=\"" + escapeHtml(href) + "\">Visa i kammaren</a>";
    }

    function resultBar(vote) {
      var c = vote.counts;
      return "<span class=\"rv-tally\" aria-label=\"Ja " + c.J + ", nej " + c.N + ", avstår " + c.A + ", frånvarande " + c.F + "\">" +
        CHOICE_CODES.map(function (code) {
          return "<span class=\"rv-tally__part\" style=\"flex-grow:" + c[code] + ";background:" + CHOICE_COLORS[code] + "\"></span>";
        }).join("") + "</span>" +
        "<span class=\"rv-tally__text\" aria-hidden=\"true\">" + c.J + "–" + c.N + (c.A ? " (" + c.A + " avstår)" : "") + "</span>";
    }

    function selectVote(data, vote, focus) {
      state.selectedVote = vote;
      Array.prototype.forEach.call(document.querySelectorAll("#rv-votes button[data-vote]"), function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-vote") === vote.id ? "true" : "false");
      });
      var panel = byId("rv-vote-detail");
      var lines = partyLines(data, vote);
      var against = againstLine(data, vote, lines);
      var parties = orderParties(Object.keys(lines.tally).filter(function (p) { return p !== INDEPENDENT; }));
      if (lines.tally[INDEPENDENT]) parties.push(INDEPENDENT);
      var againstBy = {};
      against.forEach(function (bench) {
        var party = occupant(data, vote, bench).party;
        againstBy[party] = (againstBy[party] || 0) + 1;
      });
      var c = vote.counts;
      var outcome = c.J > c.N ? "Ja vann" : c.N > c.J ? "Nej vann" : "Lika många ja som nej";
      var rows = parties.map(function (party) {
        var t = lines.tally[party];
        var line = party === INDEPENDENT ? null : lines.lines[party];
        // Independents have no line; a tie gives none; nobody casting none.
        var lineText = party === INDEPENDENT ? "–"
          : line ? CHOICE_LABELS[line] : lines.ties.indexOf(party) >= 0 ? "oavgjort" : "ingen";
        return "<tr data-party=\"" + escapeHtml(party) + "\"><th scope=\"row\">" + swatch(party) +
          escapeHtml(party === INDEPENDENT ? "Vildar" : party) + "</th>" +
          "<td class=\"rv-line\"" + (line ? " data-line=\"" + line + "\"" : "") + ">" +
            (line ? "<span class=\"rv-choice\" style=\"background:" + CHOICE_COLORS[line] + "\" aria-hidden=\"true\"></span>" : "") +
            escapeHtml(lineText) + "</td>" +
          CHOICE_CODES.map(function (code) { return "<td class=\"rv-num\">" + t[code] + "</td>"; }).join("") +
          "<td class=\"rv-num\">" + (againstBy[party] || 0) + "</td></tr>";
      });
      var againstList = against.map(function (bench) {
        var who = occupant(data, vote, bench);
        return "<li>" + swatch(who.party) + escapeHtml(who.name) + " (" + escapeHtml(who.party) + ") röstade " +
          CHOICE_LABELS[vote.ballots.charAt(bench - 1)].toLowerCase() + "</li>";
      });
      panel.innerHTML =
        "<h3 class=\"rv-vote-detail__title\" tabindex=\"-1\">" + escapeHtml(voteTitle(vote)) + "</h3>" +
        (votePoint(vote) ? "<p class=\"rv-vote-detail__point\">" + escapeHtml(votePoint(vote)) + "</p>" : "") +
        "<p class=\"election-muted\">" + escapeHtml([swedishDate(vote.date), voteSubtitle(vote, state.summary)].filter(Boolean).join(" · ")) + "</p>" +
        "<p class=\"rv-vote-detail__result\"><strong>" + outcome + ".</strong> Ja " + c.J + ", nej " + c.N + ", avstår " + c.A +
          ", frånvarande " + c.F + ".</p>" +
        "<div class=\"rv-table-wrap\"><table class=\"rv-table rv-lines\"><caption class=\"visually-hidden\">Partiernas linjer och röster</caption>" +
          "<thead><tr><th scope=\"col\">Parti</th><th scope=\"col\">Partilinje</th><th scope=\"col\" class=\"rv-num\">Ja</th>" +
          "<th scope=\"col\" class=\"rv-num\">Nej</th><th scope=\"col\" class=\"rv-num\" title=\"Avstår\">Avst.</th>" +
          "<th scope=\"col\" class=\"rv-num\" title=\"Frånvarande\">Frånv.</th><th scope=\"col\" class=\"rv-num\" title=\"Röster mot partilinjen\">Mot</th></tr></thead>" +
          "<tbody>" + rows.join("") + "</tbody></table></div>" +
        (againstList.length
          ? "<p class=\"rv-vote-detail__against-head\">Röstade mot partilinjen:</p><ul class=\"rv-vote-detail__against\">" + againstList.join("") + "</ul>" +
            "<p class=\"election-muted\">Enstaka fall kan vara feltryckningar: en ledamot trycker på fel knapp och rösten står kvar i protokollet.</p>"
          : "<p class=\"election-muted\">Ingen röstade mot sitt partis linje.</p>") +
        "<p class=\"election-muted\">Partilinjen är det som flest av partiets ledamöter röstade (ja, nej eller avstår). " +
          (documentLink(data, vote) ? "<a class=\"rv-doc-link\" href=\"" + escapeHtml(documentLink(data, vote)) + "\">" +
            (vote.committee ? "Betänkandet " + escapeHtml(vote.beteckning) : "Dokumentet") + " hos riksdagen</a>. " : "") +
          "Voteringsdata: <a href=\"https://data.riksdagen.se/votering/" + encodeURIComponent(vote.id) + "/json\">data.riksdagen.se</a>.</p>" +
        chamberLink(data, vote, "rv-vote-detail__chamber");
      panel.hidden = false;
      if (focus) {
        var title = panel.querySelector(".rv-vote-detail__title");
        if (title) title.focus({ preventScroll: true });
      }
    }

    // Open one vote from elsewhere on the page (a member's list, a link):
    // its session, with every filter that could hide it cleared.
    function openVote(rm, id, scroll) {
      state.browserSession = rm;
      byId("rv-browser-session").value = state.browserSession;
      browserState.query = "";
      browserState.committee = "";
      browserState.cell = null;
      browserState.chips.cross = false;
      browserState.chips.dissent = false;
      byId("rv-browser-search").value = "";
      return loadBrowser().then(function () {
        var data = state.votes[rm];
        var vote = data && data.byId[id];
        if (!vote) return false;
        state.selectedVote = vote;
        renderVoteList();
        selectVote(data, vote, false);
        if (scroll !== false) {
          var section = byId("rv-browser");
          if (section && section.scrollIntoView) section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        var title = byId("rv-vote-detail").querySelector(".rv-vote-detail__title");
        if (title) title.focus({ preventScroll: true });
        writeUrl();
        return true;
      });
    }

    // A matrix cell: the votes of the period on which A and B had the same
    // line, or (toggle) different lines, under the matrix's own rule.
    function setCellFilter(a, b) {
      browserState.cell = { a: a, b: b, rel: "same", mode: state.mode, committee: state.committee };
      browserState.committee = state.committee;
      browserState.limit = 30;
      if (browserSessions().length > 1) state.browserSession = ALL_SESSIONS;
      renderBrowserSessions();
      loadBrowser();
      var section = byId("rv-browser");
      if (section && section.scrollIntoView) section.scrollIntoView({ behavior: "smooth", block: "start" });
      writeUrl();
    }

    function bindBrowser() {
      var section = byId("rv-browser");
      var session = byId("rv-browser-session");
      var search = byId("rv-browser-search");
      var committee = byId("rv-browser-committee");
      session.addEventListener("change", function () {
        state.browserSession = session.value;
        browserState.limit = 30;
        loadBrowser();
        writeUrl();
      });
      search.addEventListener("input", function () {
        browserState.query = search.value;
        browserState.limit = 30;
        if (!browserState.requested) loadBrowser();
        else renderVoteList();
        writeUrl();
      });
      committee.addEventListener("change", function () {
        browserState.committee = committee.value;
        browserState.limit = 30;
        renderVoteList();
        writeUrl();
      });
      Array.prototype.forEach.call(app.querySelectorAll("#rv-chips [data-chip]"), function (chip) {
        chip.addEventListener("click", function () {
          if (chip.disabled) return;
          var name = chip.getAttribute("data-chip");
          browserState.chips[name] = !browserState.chips[name];
          browserState.limit = 30;
          var switchedSession = false;
          if (name === "cross" && browserState.chips.cross && browserSessions().length > 1 &&
              state.browserSession !== ALL_SESSIONS && !sessionHasCrossBloc(state.browserSession)) {
            state.browserSession = ALL_SESSIONS;
            renderBrowserSessions();
            switchedSession = true;
          }
          renderChips();
          if (!browserState.requested || switchedSession) loadBrowser();
          else renderVoteList();
          writeUrl();
        });
      });
      Array.prototype.forEach.call(app.querySelectorAll("#rv-cell-filter [data-rel]"), function (button) {
        button.addEventListener("click", function () {
          if (!browserState.cell) return;
          browserState.cell.rel = button.getAttribute("data-rel");
          renderCellPill();
          renderVoteList();
          writeUrl();
        });
      });
      byId("rv-cell-filter-clear").addEventListener("click", function () {
        browserState.cell = null;
        renderCellPill();
        renderVoteList();
        writeUrl();
      });
      search.addEventListener("focus", function () { if (!browserState.requested) loadBrowser(); });
      byId("rv-votes-more").addEventListener("click", function () {
        browserState.limit += 50;
        renderVoteList();
      });
      // votes.json is fetched only when the browser comes near the screen.
      if ("IntersectionObserver" in window) {
        var observer = new IntersectionObserver(function (entries) {
          if (entries.some(function (entry) { return entry.isIntersecting; }) && state.browserSession) {
            observer.disconnect();
            if (!browserState.requested) loadBrowser();
          }
        }, { rootMargin: "300px 0px" });
        observer.observe(section);
      } else {
        browserState.requested = true;
      }
    }

    // --- methods and sources ---------------------------------------------------------
    function renderSources() {
      var index = state.index;
      var box = byId("rv-origin");
      if (!box) return;
      var source = index.source;
      var parts = [];
      if (index.generatedAt) parts.push("Data senast ändrade " + swedishInstant(index.generatedAt) + ".");
      if (source && typeof source.repository === "string") {
        parts.push("Framtagna av datapipelinen i " + source.repository +
          (typeof source.path === "string" ? " (" + source.path + ")" : "") + ".");
      }
      box.textContent = parts.join(" ");
    }

    function renderProvenance() {
      var list = byId("rv-sources");
      var prov = state.summary.provenance || {};
      var sources = Array.isArray(prov.sources) ? prov.sources : [];
      list.innerHTML = sources.map(function (source) {
        if (!isObject(source)) return "";
        var url = typeof source.url === "string" && /^https:\/\/data\.riksdagen\.se\//.test(source.url) ? source.url : null;
        return "<li><span class=\"rv-source__file\">" + (url ? "<a href=\"" + escapeHtml(url) + "\">" + escapeHtml(source.file || url) + "</a>" : escapeHtml(source.file || "")) + "</span>" +
          "<span class=\"rv-source__meta\">hämtad " + escapeHtml(swedishInstant(source.retrieved_at_utc)) +
          (isInt(source.bytes) ? " · " + fmtInt(source.bytes) + " byte" : "") + "</span>" +
          "<code class=\"rv-source__sha\">sha256 " + escapeHtml(source.sha256 || "") + "</code></li>";
      }).join("");
      var code = byId("rv-code");
      code.textContent = prov.code_commit ? "Pipelinens version: " + String(prov.code_commit).slice(0, 12) +
        (prov.code_dirty ? " (med lokala ändringar)" : "") + "." : "";
      var files = byId("rv-files");
      var scope = state.scope;
      var entries = [{ label: scope.summary.path, info: scope.summary }];
      scope.sessions.forEach(function (rm) {
        var session = state.index.sessions.filter(function (s) { return s.rm === rm; })[0];
        if (session) entries.push({ label: session.votes.path, info: session.votes });
      });
      files.innerHTML = entries.map(function (entry) {
        return "<li><a href=\"" + escapeHtml(base + "/" + entry.info.path) + "\">" + escapeHtml(entry.label) + "</a>" +
          (entry.info.bytes ? " · " + fmtInt(entry.info.bytes) + " byte" : "") +
          (entry.info.sha256 ? " <code class=\"rv-source__sha\">sha256 " + escapeHtml(entry.info.sha256) + "</code>" : "") + "</li>";
      }).join("");
    }

    function bindCopyLink() {
      var button = byId("rv-copy-link");
      var status = byId("rv-copy-status");
      if (!button) return;
      button.addEventListener("click", function () {
        var href = window.location.href;
        var done = function () { status.textContent = "Länken är kopierad."; };
        var fail = function () { status.textContent = href; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(href).then(done, fail);
        else fail();
      });
    }

    function bindInfoPopovers() {
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
        var texts = Array.prototype.filter.call(head.children, function (child) { return child.tagName === "P"; });
        if (!heading || !texts.length) return;
        var panel = document.createElement("div");
        panel.className = "election-info__panel";
        panel.id = (head.parentNode && head.parentNode.id ? head.parentNode.id : "rv-section-" + index) + "-info";
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
          if (entry.button === document.activeElement || entry.panel.contains(document.activeElement)) entry.button.focus();
        });
      });
    }

    bindInfoPopovers();
    bindCopyLink();
    bindMatrixControls();
    bindMatrixKeys();
    bindMap();
    bindAgainst();
    bindBrowser();
    var docs = byId("rv-docs");
    if (docs) docs.href = DOCS_URL;
    start();
  }

  // ---------------------------------------------------------------------
  // The chamber overlay on /election-simulator/ ("Som i kammaren")
  //
  // election-simulator.js calls this once the hall view exists, with the
  // dots it draws. Nothing is fetched until the hall view is first opened;
  // nothing is shown unless index.json and the session's votes.json validate
  // and the session is the one the seating plan is for. Until a vote is
  // picked, the chamber is exactly as before.
  // ---------------------------------------------------------------------
  function attachChamberOverlay(options) {
    var panel = byId("election-result-votes");
    if (!panel || !options || !options.host || !Array.isArray(options.dots) || typeof options.session !== "string") return null;
    var picker = byId("election-votes-pick");
    var againstButton = byId("election-votes-against");
    var legend = byId("election-votes-legend");
    var summary = byId("election-votes-summary");
    var link = byId("election-votes-link");
    // The party legend under the chamber; it steps aside while the seats
    // carry vote colours, and comes back as it was.
    var partyLegend = byId("election-result-legend");
    var partyLegendHidden = null;
    if (!picker || !againstButton || !legend || !summary) return null;
    var base = (panel.getAttribute("data-riksdag-base") || "").replace(/\/$/, "");
    var dots = options.dots;
    var host = options.host;
    var data = null;
    var loading = null;
    var seating = false;
    var vote = null;
    var lines = null;
    var against = {};
    var showAgainst = false;

    dots.forEach(function (dot) { dot.rvPartyColor = dot.style.backgroundColor; });

    function hallDots() {
      return dots.filter(function (dot) { return dot.inHall; });
    }

    function load() {
      if (loading) return loading;
      loading = fetchJson(base + "/index.json").then(function (payload) {
        var index = normalizeIndex(payload);
        if (!index) throw new Error("index.json validerar inte");
        var entry = index.sessions.filter(function (s) { return s.rm === options.session; })[0];
        if (!entry) throw new Error("inget riksmöte " + options.session + " i index.json");
        return fetchJson(base + "/" + entry.votes.path);
      }).then(function (payload) {
        var normal = normalizeVotes(payload);
        if (!normal || normal.rm !== options.session || !normal.votes.length) throw new Error("votes.json validerar inte");
        // Every numbered seat of the hall must be a dot, once.
        var seen = {};
        hallDots().forEach(function (dot) {
          if (dot.hallSeat >= 1 && dot.hallSeat <= CHAMBER) seen[dot.hallSeat] = (seen[dot.hallSeat] || 0) + 1;
        });
        for (var n = 1; n <= CHAMBER; n += 1) if (seen[n] !== 1) throw new Error("platserna stämmer inte");
        data = normal;
        fillPicker();
        panel.hidden = !seating;
        return data;
      }).catch(function (error) {
        console.warn("Voteringarna kunde inte visas i kammaren.", error);
        data = null;
        panel.hidden = true;
        return null;
      });
      return loading;
    }

    function fillPicker() {
      picker.innerHTML = "";
      picker.appendChild(new Option("Ingen – visa partifärger", ""));
      var groups = {};
      sortedVotes(data).slice(0, 60).forEach(function (v) {
        var key = v.date || "utan datum";
        if (!groups[key]) {
          groups[key] = document.createElement("optgroup");
          groups[key].label = v.date ? swedishDate(v.date) : "Utan datum";
          picker.appendChild(groups[key]);
        }
        groups[key].appendChild(new Option(pickerLabel(v), v.id));
      });
      picker.value = "";
    }

    // "KU6 p. 3 – Ändring i en huvudbestämmelse … (ja 341, nej 1)"; a
    // chamber vote by its subject.
    function pickerLabel(v) {
      var name = isPoint(v) ? v.beteckning + " p. " + v.punkt + " – " + (v.punktTitle || voteTitle(v)) : voteTitle(v);
      return name + " (ja " + v.counts.J + ", nej " + v.counts.N + ")";
    }

    function clear() {
      dots.forEach(function (dot) {
        dot.style.backgroundColor = dot.rvPartyColor;
        dot.classList.remove("rv-seat--J", "rv-seat--N", "rv-seat--A", "rv-seat--F", "rv-seat--none", "rv-against", "rv-dim");
        dot.removeAttribute("data-vote");
      });
      host.removeAttribute("data-vote-overlay");
      if (partyLegend && partyLegendHidden !== null) {
        partyLegend.hidden = partyLegendHidden;
        partyLegendHidden = null;
      }
    }

    function apply() {
      clear();
      if (!seating || !vote || !data) {
        legend.hidden = true;
        summary.textContent = "";
        againstButton.disabled = !vote;
        return;
      }
      host.setAttribute("data-vote-overlay", vote.id);
      if (partyLegend) {
        partyLegendHidden = partyLegend.hidden;
        partyLegend.hidden = true;
      }
      var n = { J: 0, N: 0, A: 0, F: 0 };
      hallDots().forEach(function (dot) {
        if (!(dot.hallSeat >= 1 && dot.hallSeat <= CHAMBER)) {
          dot.classList.add("rv-seat--none");
          dot.setAttribute("data-vote", "-");
          if (showAgainst) dot.classList.add("rv-dim");
          return;
        }
        var code = vote.ballots.charAt(dot.hallSeat - 1);
        n[code] += 1;
        dot.style.backgroundColor = CHOICE_COLORS[code];
        dot.classList.add("rv-seat--" + code);
        dot.setAttribute("data-vote", code);
        if (showAgainst) dot.classList.add(against[dot.hallSeat] ? "rv-against" : "rv-dim");
      });
      legend.innerHTML = CHOICE_CODES.map(function (code) {
        return "<li class=\"ep-legend__item\" data-vote=\"" + code + "\"><span class=\"ep-legend__swatch rv-legend__swatch--" + code +
          "\" style=\"background:" + CHOICE_COLORS[code] + "\"></span><span class=\"ep-legend__abbr\">" + CHOICE_LABELS[code] +
          "</span><span class=\"ep-legend__seats\">" + n[code] + "</span></li>";
      }).join("");
      legend.hidden = false;
      var count = Object.keys(against).length;
      againstButton.disabled = false;
      summary.textContent = voteTitle(vote) + (votePoint(vote) ? " (" + votePoint(vote) + ")" : "") + ", " + swedishDate(vote.date) + ": ja " + n.J + ", nej " + n.N + ", avstår " + n.A +
        ", frånvarande " + n.F + ". " + (count === 0 ? "Ingen röstade mot sin partilinje."
          : (count === 1 ? "1 ledamot" : count + " ledamöter") + " röstade mot partilinjen" + (showAgainst ? " och är markerade." : "."));
    }

    picker.addEventListener("change", function () {
      vote = data && picker.value ? data.byId[picker.value] || null : null;
      lines = vote ? partyLines(data, vote) : null;
      against = {};
      if (vote) againstLine(data, vote, lines).forEach(function (bench) { against[bench] = true; });
      apply();
      if (options.refresh) options.refresh();
    });
    againstButton.addEventListener("click", function () {
      showAgainst = !showAgainst;
      againstButton.setAttribute("aria-pressed", showAgainst ? "true" : "false");
      apply();
    });
    if (link && !link.getAttribute("href")) link.setAttribute("href", "/riksdagen-roster/");

    // ?riksdag_vote=<votering_id>, from "Visa i kammaren" on the voting
    // page: open the hall with that vote on it. An id that is malformed or
    // not a vote of the session changes nothing.
    var requested = null;
    try { requested = new URLSearchParams(window.location.search).get("riksdag_vote"); } catch (error) { requested = null; }
    if (requested && !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(requested)) requested = null;
    if (requested) {
      // After election-simulator.js has bound the view toggle.
      window.setTimeout(function () {
        var toggle = byId("election-result-view");
        var button = toggle ? toggle.querySelector("[data-view=\"seating\"]") : null;
        if (!button || toggle.hidden) return;
        load().then(function () {
          if (!data || !data.byId[requested]) return;
          if (button.getAttribute("aria-pressed") !== "true") button.click();
          if (!Array.prototype.some.call(picker.options, function (o) { return o.value === requested; })) {
            picker.appendChild(new Option(pickerLabel(data.byId[requested]), requested));
          }
          picker.value = requested;
          picker.dispatchEvent(new Event("change"));
          if (toggle.scrollIntoView) toggle.scrollIntoView({ block: "start" });
        });
      }, 0);
    }

    return {
      setSeating: function (isSeating) {
        seating = Boolean(isSeating);
        if (seating) {
          load().then(function () {
            if (data) panel.hidden = !seating;
            apply();
          });
        } else {
          panel.hidden = true;
          apply();
        }
      },
      // The card for a hall seat while a vote is shown: who sat there on
      // that vote, from the vote's own roster, so a substitute is named.
      card: function (dot) {
        if (!seating || !vote || !data || !dot || !(dot.hallSeat >= 1 && dot.hallSeat <= CHAMBER)) return null;
        var bench = dot.hallSeat;
        var who = occupant(data, vote, bench);
        var code = vote.ballots.charAt(bench - 1);
        var line = who.party === INDEPENDENT ? null : lines.lines[who.party];
        var isAgainst = Boolean(against[bench]);
        var listed = dot.member && dot.member.name && dot.member.name !== who.name ? dot.member.name : null;
        var meta = partyName(who.party) + (who.valkrets ? " · " + who.valkrets : "");
        var choice = code === "F" ? "Frånvarande" : "Röstade " + CHOICE_LABELS[code].toLowerCase();
        var lineText = who.party === INDEPENDENT ? "Ingen partilinje (politisk vilde)"
          : line ? "Partilinjen (" + who.party + "): " + CHOICE_LABELS[line].toLowerCase() : "Partiet hade ingen linje";
        var notes = [];
        if (isAgainst) notes.push("Mot partilinjen. Enstaka fall kan vara feltryckningar.");
        if (code === "F") notes.push("Frånvaro omfattar kvittning.");
        if (listed) notes.push("I ledamotslistan: " + listed);
        var html =
          "<span class=\"ep-tip__name\"><span class=\"ev-swatch\" style=\"background:" + partyColor(who.party) +
            "\" aria-hidden=\"true\"></span>" + escapeHtml(who.name) + "</span>" +
          "<span class=\"ep-tip__meta\">" + escapeHtml(meta) + "</span>" +
          "<span class=\"ep-tip__line\"><span class=\"rv-tip__choice\" style=\"background:" + CHOICE_COLORS[code] + "\" aria-hidden=\"true\"></span>" +
            escapeHtml(choice + " · " + lineText) + "</span>" +
          (notes.length ? "<span class=\"ep-tip__role\">" + escapeHtml(notes.join(" ")) + "</span>" : "");
        return { html: html, text: [who.name, meta, choice, lineText].concat(notes).join(", ") };
      }
    };
  }

  root.RiksdagVotes = {
    CHAMBER: CHAMBER,
    CHOICE_COLORS: CHOICE_COLORS,
    CHOICE_LABELS: CHOICE_LABELS,
    normalizeIndex: normalizeIndex,
    normalizeVotes: normalizeVotes,
    normalizeSummary: normalizeSummary,
    occupant: occupant,
    partyLines: partyLines,
    againstLine: againstLine,
    voteTitle: voteTitle,
    attachChamberOverlay: attachChamberOverlay
  };

  function boot() {
    var app = byId("riksdag-app");
    if (app) initPage(app);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
