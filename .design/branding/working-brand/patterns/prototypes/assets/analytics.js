/* Bearing analytics view for the landing prototype (hero-3d.html, #analytics).
   Reads the risk API at <html data-api> (default http://localhost:3011); when it does not answer within 3 s it
   reads the snapshot under assets/analytics/ (manifest.json) and every figure takes the stale state.
   Every figure is a fact from the API (value, source, fetchedAt, method, methodVersion, quality) or a route field
   wrapped with the route's own source and time. A missing fact shows its reason in words: never zero, never hatched.
   No library: charts are inline SVG. Review aids: ?theme=light, ?check=1 (DOM check in the console), ?api=<base>. */
(function () {
  'use strict';
  var ROOT = document.documentElement;
  var Q = new URLSearchParams(location.search);
  if (Q.get('theme') === 'light') ROOT.setAttribute('data-theme', 'light');
  var API = (Q.get('api') || ROOT.getAttribute('data-api') || 'http://localhost:3011').replace(/\/$/, '');   /* ?api= overrides, e.g. a dead port to review the snapshot */
  var SNAP = 'assets/analytics/';
  var CHECK = Q.get('check') === '1';

  /* The DISCLAIMER constant (packages/schemas/src/constants.ts, en), copied verbatim: a static file cannot import it. */
  var DISCLAIMER = 'This tool is not licensed investment advice. It structures and explains an allocation from a goal you state; the decision and custody are yours. The distributor embedding this tool holds the client relationship.';

  var REGIMES = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'];
  var RW = { us_market_hours: 'market hours', us_offhours_weekday: 'off-hours', weekend: 'weekend', us_holiday: 'holiday' };
  var SIZES = [10000, 50000, 100000, 250000];
  var TAUS = [0.005, 0.01, 0.02];
  var GAPS = [5, 10, 15, 20, 25, 30];
  /** Registry assets that are not stocks. The facts route answers them with their reasons (item 17 measures them). */
  var OTHER = [
    { id: 'usdy', label: 'USDY' }, { id: 'syrupusdc', label: 'syrupUSDC' },
    { id: 'usdt', label: 'USDT' }, { id: 'kamino-usdc', label: 'Kamino USDC supply' }
  ];
  /* NYSE calendar, the same fixture the API's regime rule reads (fixtures/risk/us-market-holidays.json). */
  var CAL = {
    source: 'NYSE holidays and trading hours calendar, transcribed 2026-10-01 (fixtures/risk/us-market-holidays.json)',
    closed: ['2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
    early: ['2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']
  };
  var REASON = {
    no_samples_in_regime: 'no samples in this regime yet',
    insufficient_samples: 'too few samples to fit',
    beyond_measured_size: 'beyond the largest size measured',
    no_reference_price: 'no reference price',
    no_external_source: 'no external source for this',
    chain_not_covered: 'chain not covered',
    not_collected: 'not collected yet',
    not_imported: 'not imported yet',
    not_followed: 'not followed',
    before_routed_curves: 'from before routed curves',
    gate_open: 'waiting on an open gate',
    not_applicable: 'does not apply here',
    not_served: 'not served by the API',
    not_in_snapshot: 'not in the snapshot',
    api_error: 'the API returned no answer'
  };

  /* ---------------- formatting (en-US, 2 decimals on percentages, U+2212 minus) ---------------- */
  var NF = {};
  function nf(o) { var k = JSON.stringify(o); return NF[k] || (NF[k] = new Intl.NumberFormat('en-US', o)); }
  function minus(s) { return s.replace(/-/g, '−'); }
  function pct(v) { return minus(nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v * 100)) + '%'; }
  function pct0(v) { return minus(nf({ maximumFractionDigits: 0 }).format(v * 100)) + '%'; }
  function usd(v) {
    var a = Math.abs(v);
    if (a === 0) return '$0';
    if (a < 1) return minus(nf({ style: 'currency', currency: 'USD', maximumSignificantDigits: 2 }).format(v));
    if (a < 100) return minus(nf({ style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v));
    return minus(nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v));
  }
  function usdC(v) { return Math.abs(v) < 10000 ? usd(v) : minus(nf({ style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(v)); }
  /** Capacity 0 is measured: not even the smallest grid size ($100) sells within τ. */
  function capW(v) { return v === 0 ? '< $100' : usdC(v); }
  function sizeW(n) { return '$' + (n >= 1e6 ? n / 1e6 + 'M' : n / 1e3 + 'k'); }
  function num(v, d) { return minus(nf({ maximumFractionDigits: d == null ? 0 : d }).format(v)); }
  function ratio(v) { return minus(nf(Math.abs(v) >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)); }
  function mins(h) { var m = h * 60; if (m < 1) return minus(nf({ maximumFractionDigits: 2 }).format(m)) + ' min'; return m < 120 ? minus(nf({ maximumFractionDigits: 1 }).format(m)) + ' min' : minus(nf({ maximumFractionDigits: 1 }).format(h)) + ' h'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
  function iso(t) { return t ? new Date(t).toISOString().slice(0, 19) + 'Z' : 'no time given'; }
  function hhmm(t) { var d = new Date(t); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC'; }
  function day(t) { return new Date(t).toISOString().slice(0, 10); }
  function short(a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : ''; }
  function age(t) {
    var s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 3600) return { short: Math.max(1, Math.round(s / 60)) + ' min', long: Math.max(1, Math.round(s / 60)) + ' minutes' };
    if (s < 172800) return { short: Math.round(s / 3600) + ' h', long: Math.round(s / 3600) + ' hours' };
    return { short: Math.round(s / 86400) + ' d', long: Math.round(s / 86400) + ' days' };
  }
  function venueW(v) { return { kamino: 'Kamino', jupiter_lend: 'Jupiter Lend', orca_whirlpool: 'Orca', raydium_clmm: 'Raydium CLMM', raydium_cpmm: 'Raydium CPMM', raydium_amm: 'Raydium AMM', meteora_dlmm: 'Meteora DLMM', meteora_damm: 'Meteora DAMM', meteora_damm_v2: 'Meteora DAMM v2' }[v] || String(v || '').replace(/_/g, ' '); }
  function explorer(addr, label) { return '<a class="an-addr" href="https://solscan.io/account/' + esc(addr) + '" target="_blank" rel="noopener" aria-label="View ' + esc(label || addr) + ' on Solscan">' + esc(short(addr)) + ' ↗</a>'; }

  /* ---------------- data: live API or snapshot ---------------- */
  var S = { mode: null, manifest: null, cache: {}, tau: 0.01, size: 100000, asset: null, lending: null };
  var R = {
    methodology: function () { return '/risk/facts/methodology'; },
    assets: function (tau) { return '/risk/assets?tau=' + tau; },
    pools: function (a) { return a ? '/risk/pools?asset=' + encodeURIComponent(a) : '/risk/pools'; },
    sheet: function (a, n) { return '/risk/facts/assets/' + encodeURIComponent(a) + '?sizeUsd=' + n; },
    depth: function (a, r) { return '/risk/assets/' + encodeURIComponent(a) + '/depth?side=sell&regime=' + r; },
    heatmap: function (a, n) { return '/risk/assets/' + encodeURIComponent(a) + '/heatmap?notional=' + n; },
    lp: function (a) { return '/risk/assets/' + encodeURIComponent(a) + '/lp'; },
    score: function (a, tau, n) { return '/risk/assets/' + encodeURIComponent(a) + '/score?tau=' + tau + '&nRef=' + n + '&hours=72'; },
    lendingList: function () { return '/risk/facts/lending'; },
    lending: function (acc) { return '/risk/facts/lending/' + encodeURIComponent(acc); },
    coverage: function (a) { return '/risk/lending/coverage?asset=' + encodeURIComponent(a); },
    markets: function () { return '/risk/markets'; },
    gap: function (acc) { return '/risk/markets/' + acc + '/gap'; },
    depthBuy: function (a, r) { return '/risk/assets/' + encodeURIComponent(a) + '/depth?side=buy&regime=' + r; },
    history: function (a, tau) { return '/risk/assets/' + encodeURIComponent(a) + '/history?days=7&tau=' + tau; },
    prices: function (a) { return '/risk/assets/' + encodeURIComponent(a) + '/prices?days=365'; },
    pricesH: function (a) { return '/risk/assets/' + encodeURIComponent(a) + '/prices?days=31'; },
    lendHistory: function (acc) { return '/risk/facts/lending/' + encodeURIComponent(acc) + '/history?days=365'; },
    liquidity: function (pool) { return '/risk/pools/' + encodeURIComponent(pool) + '/liquidity?bands=60&rangePct=0.3'; }
  };
  function notServed(status, b) { return status === 404 && b && /^Route /.test(b.message || ''); }
  function timeout(ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); }); }
  /** Resolves to { ok, status, body, reason }. Never rejects: a failed read is a reason the page shows. */
  function load(key, init) {
    if (S.cache[key]) return S.cache[key];
    var p;
    if (S.mode === 'live') {
      var path = key.indexOf('POST ') === 0 ? key.slice(5, key.indexOf(' {')) : key;
      p = fetch(API + path, init).then(function (r) {
        return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b, reason: r.ok ? null : notServed(r.status, b) ? 'not_served' : 'api_error' }; });
      });
    } else {
      var f = S.manifest && S.manifest.files[key];
      p = f ? fetch(SNAP + 'snapshot/' + f).then(function (r) { return r.json(); }).then(function (w) {
        return { ok: w.status >= 200 && w.status < 300, status: w.status, body: w.body, reason: w.status < 300 ? null : notServed(w.status, w.body) ? 'not_served' : 'api_error' };
      }) : Promise.resolve({ ok: false, status: 0, body: null, reason: 'not_in_snapshot' });
    }
    p = p.catch(function () { return { ok: false, status: 0, body: null, reason: 'api_error' }; });
    S.cache[key] = p;
    return p;
  }
  function get(path) { return load(path); }
  function post(path, body) {
    var b = JSON.stringify(body);
    return load('POST ' + path + ' ' + b, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
  }
  function pool(items, n, fn) {
    var q = items.slice(), out = [];
    return Promise.all(Array.from({ length: n }, function () {
      return (function next() { if (!q.length) return Promise.resolve(); var it = q.shift(); return fn(it).then(function (v) { out.push(v); return next(); }); })();
    })).then(function () { return out; });
  }
  function detectMode() {
    return Promise.race([fetch(API + R.methodology()).then(function (r) { if (!r.ok) throw new Error('status'); return r.json(); }), timeout(3000)])
      .then(function (body) { S.mode = 'live'; S.cache[R.methodology()] = Promise.resolve({ ok: true, status: 200, body: body }); })
      .catch(function () {
        return fetch(SNAP + 'manifest.json').then(function (r) { if (!r.ok) throw new Error('no manifest'); return r.json(); })
          .then(function (m) { S.mode = 'snapshot'; S.manifest = m; })
          .catch(function () { S.mode = 'none'; });
      });
  }

  /* ---------------- figures and the provenance pin ---------------- */
  var PINS = [];
  /** A route field wrapped as a fact, with the route's own source, time and method. */
  function mk(value, o) {
    if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) return { value: null, reason: o.reason || 'not_served', detail: o.detail };
    return { value: value, quality: o.quality || 'measured', source: o.source, fetchedAt: o.fetchedAt, method: o.method, methodVersion: o.methodVersion, samples: o.samples, dataFrom: o.dataFrom, regime: o.regime, sizeUsd: o.sizeUsd, provenance: o.provenance || 'live' };
  }
  function reason(code, detail) {
    var w = REASON[code] || String(code || 'not served').replace(/_/g, ' ');
    return '<span class="an-reason"' + (detail ? ' title="' + esc(detail) + '"' : '') + '>' + esc(w) + '</span>';
  }
  /* the provenance glyph: the tenon end as an outline (3:2, radius 2.5) with the square pin set toward the end; stale hollows the pin (analytics.css) */
  var PIN_SVG = '<svg viewBox="0 0 18 12" aria-hidden="true"><rect class="o" x=".75" y=".75" width="16.5" height="10.5" rx="2.5"/><rect class="p" x="11" y="4" width="4" height="4" rx="1"/></svg>';
  function pin(f, shown) {
    var stale = S.mode === 'snapshot';
    var a = stale && f.fetchedAt ? age(f.fetchedAt) : null;
    PINS.push(f);
    var label = 'Source for ' + shown + (stale ? ', stale' + (a ? ', ' + a.long + ' old' : '') : '');
    return '<button type="button" class="an-pin' + (stale ? ' stale' : '') + '" data-pin="' + (PINS.length - 1) + '" aria-label="' + esc(label) + '" aria-haspopup="dialog">' + PIN_SVG + '</button>' +
      (stale ? '<span class="an-stale">stale' + (a ? ' · ' + a.short : '') + '</span>' : '');
  }
  /** fig(fact, formatter): the figure with its pin, "≥" for a lower bound, "assumption" beside an assumption. */
  function fig(f, fmt, o) {
    o = o || {};
    if (!f) return reason('not_served');
    if (f.value === null || f.value === undefined) return reason(f.reason, f.detail);
    if (!f.source && !f.method) return reason('not_served');
    var shown = (f.quality === 'lower_bound' ? '≥ ' : '') + fmt(f.value);
    return '<span class="an-fig"><span class="an-num">' + esc(shown) + '</span> ' + pin(f, shown) +
      (f.quality === 'assumption' ? '<span class="an-assume">assumption</span>' : '') + (o.after || '') + '</span>';
  }
  var pop = null, popFrom = null;
  function openPop(btn) {
    var f = PINS[+btn.getAttribute('data-pin')];
    if (!f) return;
    if (!pop) { pop = document.createElement('div'); pop.className = 'an-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Source'); pop.hidden = true; document.body.appendChild(pop); }
    var l1 = [String(f.source || 'source not given').replace(/~\/[^,]*,\s*/g, ''), iso(f.fetchedAt), f.method || 'method not given', f.methodVersion].filter(Boolean).join(' · ');
    var l2 = [f.quality === 'lower_bound' ? 'lower bound' : f.quality, f.regime ? RW[f.regime] || f.regime : null, f.sizeUsd ? 'at ' + usd(f.sizeUsd) : null,
      f.samples != null ? 'n=' + num(f.samples) : null, f.dataFrom ? 'data from ' + iso(f.dataFrom) : null, f.provenance].filter(Boolean).join(' · ');
    var l3 = S.mode === 'snapshot' ? '<p class="stale-line">Stale: read from the snapshot captured ' + esc(iso(S.manifest.captured_at)) + '; this figure was measured ' + esc(f.fetchedAt ? age(f.fetchedAt).long + ' ago' : 'at a time not given') + '.</p>' : '';
    pop.innerHTML = '<p>' + esc(l1) + '</p><p>' + esc(l2) + '</p>' + l3;
    pop.hidden = false;
    var r = btn.getBoundingClientRect();
    var left = Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 16);
    pop.style.left = Math.max(16, left) + 'px';
    pop.style.top = (window.scrollY + r.bottom + 8) + 'px';
    popFrom = btn; btn.setAttribute('aria-expanded', 'true');
  }
  function closePop(focus) {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (popFrom) { popFrom.setAttribute('aria-expanded', 'false'); if (focus) popFrom.focus(); }
    popFrom = null;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.an-pin');
    if (b) { e.preventDefault(); if (popFrom === b && !pop.hidden) closePop(false); else { closePop(false); openPop(b); } return; }
    if (pop && !pop.hidden && !pop.contains(e.target)) closePop(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(true); });

  function status(kind, word) {
    var shape = kind === 'on' ? '<rect x="0" y="0" width="10" height="10"/>'
      : kind === 'watch' ? '<rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/><rect x="0" y="5" width="10" height="5"/>'
      : '<path d="M.5 .5H6.5L9.5 3.5V9.5H.5Z" fill="none" stroke="currentColor" stroke-width="1.2"/>';
    return '<span class="an-status ' + kind + '"><svg viewBox="0 0 10 10" aria-hidden="true" fill="currentColor">' + shape + '</svg>' + esc(word) + '</span>';
  }

  /* ---------------- the regime now, by the API's rule (packages/risk/src/time.ts), in the browser ---------------- */
  var ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  function etParts(at) {
    var p = {}; ETF.formatToParts(at).forEach(function (x) { p[x.type] = x.value; });
    return { date: p.year + '-' + p.month + '-' + p.day, dow: DOW[p.weekday], hour: +p.hour, minute: +p.minute, label: p.weekday + ' ' + p.hour + ':' + p.minute + ' ET' };
  }
  function regimeAt(at) {
    var e = etParts(at);
    if (CAL.closed.indexOf(e.date) >= 0) return 'us_holiday';
    var t = e.dow * 24 + e.hour + e.minute / 60;
    if (t >= 4 * 24 + 20 && t < 6 * 24 + 20) return 'weekend';
    var h = e.hour + e.minute / 60, close = CAL.early.indexOf(e.date) >= 0 ? 13 : 16;
    if (e.dow <= 4 && h >= 9.5 && h < close) return 'us_market_hours';
    return 'us_offhours_weekday';
  }

  /* ---------------- the view ---------------- */
  var view, els = {};
  function shell() {
    view.innerHTML =
      '<div class="wrap">' +
      '<header class="an-sec" style="margin-top:0"><div class="an-bhead">Bearing · liquidity and risk</div>' +
      '<h1 class="an-lede">What it costs to leave, and who is holding the door.</h1>' +
      '<p class="an-meta" id="an-cov">Reading the collectors…</p><div id="an-banner" role="status"></div></header>' +
      '<section class="an-sec" id="an-assets" aria-labelledby="an-assets-h"></section>' +
      '<section class="an-sec" id="an-asset" aria-live="polite"></section>' +
      '<section class="an-sec" id="an-lend" aria-labelledby="an-lend-h"></section>' +
      '<section class="an-sec" id="an-lendp" aria-live="polite"></section>' +
      '<section class="an-sec" id="an-sim" aria-labelledby="an-sim-h"></section>' +
      '<section class="an-sec" id="an-method" aria-labelledby="an-method-h"></section>' +
      '<footer class="an-sec" id="an-foot"></footer>' +
      '</div>';
    ['an-cov', 'an-banner', 'an-assets', 'an-asset', 'an-lend', 'an-lendp', 'an-sim', 'an-method', 'an-foot'].forEach(function (id) { els[id] = document.getElementById(id); });
  }

  /* ---------------- 1. header, coverage line, banner ---------------- */
  var A = { rows: [], sheets: {}, poolTimes: {}, lastRun: null, nPools: 0 };
  function header(assetsBody) {
    var regs = {}, last = null, weekStart = Date.now() - 7 * 86400000;
    assetsBody.assets.forEach(function (a) {
      REGIMES.forEach(function (r) { var c = a.capacityAtTau[r]; if (c && c.status === 'ok' && c.to && new Date(c.to).getTime() > weekStart) regs[r] = 1; if (c && c.to && (!last || c.to > last)) last = c.to; });
    });
    A.lastRun = last;
    var n = assetsBody.assets.length;
    els['an-cov'].textContent = n + ' stocks and ' + OTHER.length + ' other assets · ' + A.nPools + ' pools · regimes measured this week: ' +
      (REGIMES.filter(function (r) { return regs[r]; }).map(function (r) { return RW[r]; }).join(', ') || 'none') +
      ' · collectors’ last run ' + (last ? iso(last) : 'not known') + ' · now: ' + RW[regimeAt(new Date())] + ' (' + etParts(new Date()).label + ')';
    var b = els['an-banner'];
    b.className = 'an-banner';
    if (S.mode === 'live') b.innerHTML = '<b>Live from the collectors, as of ' + esc(last ? hhmm(last) : 'an unknown time') + '.</b><span class="an-meta">' + esc(API) + '</span>';
    else b.innerHTML = '<b>Snapshot captured ' + esc(iso(S.manifest.captured_at).replace('T', ' ').replace('Z', ' UTC')) + ', the API is not running.</b>' +
      '<span>Every figure below is stale: measured, only old. Its age is beside it.</span>';
  }

  /* ---------------- 2. asset table ---------------- */
  function seg(name, values, cur, label, fmt) {
    return '<div class="an-field"><span id="seg-' + name + '">' + esc(label) + '</span><div class="an-seg" role="group" aria-labelledby="seg-' + name + '">' +
      values.map(function (v) { return '<button type="button" data-' + name + '="' + v + '" aria-pressed="' + (v === cur) + '">' + esc(fmt(v)) + '</button>'; }).join('') + '</div></div>';
  }
  function capFact(a, r, body) {
    var c = a.capacityAtTau && a.capacityAtTau[r];
    if (!c) return { value: null, reason: 'no_samples_in_regime' };
    if (c.status !== 'ok' || c.capacityUsd == null) return { value: null, reason: c.status === 'insufficient_samples' ? 'insufficient_samples' : 'no_samples_in_regime' };
    return mk(c.capacityUsd, { quality: c.lowerBound ? 'lower_bound' : 'measured', source: 'risk_depth_curves (GET /risk/assets)', fetchedAt: c.to, dataFrom: c.from, samples: c.samples, regime: r,
      method: 'largest sale at cost ≤ τ = ' + pct(body.tau) + ' on the fitted sell curve', methodVersion: body.methodVersion });
  }
  function worstExit(sheet) {
    if (!sheet || !sheet.costs) return null;
    var w = sheet.worstRegime, c = sheet.costs.filter(function (x) { return x.regime === w; })[0];
    if (!c && sheet.costs[0]) return { fact: sheet.costs[0].exit.total, regime: null };
    return c ? { fact: c.exit.total, regime: w } : null;
  }
  function assetTable() {
    var box = els['an-assets'];
    box.innerHTML = '<header><h2 id="an-assets-h">The pools, by asset</h2><span class="an-meta">GET /risk/assets · /risk/facts/assets/:id</span></header>' +
      '<div class="an-controls">' + seg('tau', TAUS, S.tau, 'Cost tolerance τ', pct) + seg('size', SIZES, S.size, 'Size', sizeW) + '</div>' +
      '<p class="an-note" style="margin-bottom:8px">Exit capacity is the largest sale that costs at most τ, by time of week. Volume is counted from successful swaps once item 16 lands. Concentration is by position, not by owner.</p>' +
      '<div id="an-overview"></div>' +
      '<div class="an-scroll" role="region" tabindex="0" aria-labelledby="an-assets-h"><table class="an-table stack" id="an-at"><caption class="an-sr">Assets with pools, capacity and exit cost</caption><thead><tr>' +
      '<th scope="col">Asset</th><th scope="col" class="n">Pools</th><th scope="col" class="n">On-chain TVL</th>' +
      '<th scope="col" class="n">Capacity, market hours</th><th scope="col" class="n">Capacity, off-hours</th><th scope="col" class="n">Capacity, weekend</th><th scope="col" class="n">Capacity, holiday</th>' +
      '<th scope="col" class="n">Weekend ÷ market hours</th><th scope="col" class="n">Volume 24 h</th><th scope="col" class="n">Top-3 LP share, largest pool</th>' +
      '<th scope="col">Exit capacity, 7 d</th><th scope="col" class="n">Exit cost at $10k, worst regime</th><th scope="col" class="n" id="an-at-size">Exit cost at ' + sizeW(S.size) + ', worst regime</th>' +
      '</tr></thead><tbody></tbody></table></div><p class="an-meta" id="an-at-meta" style="margin-top:8px"></p>';
    box.querySelectorAll('[data-tau]').forEach(function (b) { b.addEventListener('click', function () { S.tau = +b.getAttribute('data-tau'); refreshAssets(); if (S.asset) openAsset(S.asset, false); }); });
    box.querySelectorAll('[data-size]').forEach(function (b) { b.addEventListener('click', function () { S.size = +b.getAttribute('data-size'); refreshAssets(); if (S.asset) openAsset(S.asset, false); }); });
    return refreshAssets();
  }
  function cell(label, html, cls) { return '<td data-label="' + esc(label) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + html + '</td>'; }
  var atSeq = 0;
  function refreshAssets() {
    var seq = ++atSeq, box = els['an-assets'];
    box.querySelectorAll('[data-tau]').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-tau') === S.tau)); });
    box.querySelectorAll('[data-size]').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-size') === S.size)); });
    document.getElementById('an-at-size').textContent = 'Exit cost at ' + sizeW(S.size) + ', worst regime';
    return get(R.assets(S.tau)).then(function (res) {
      if (seq !== atSeq) return;
      var tb = box.querySelector('tbody');
      if (!res.ok) { tb.innerHTML = '<tr><td colspan="13">' + reason(res.reason) + ' for τ = ' + esc(pct(S.tau)) + (S.mode === 'snapshot' ? '. The snapshot holds τ = 0.50%, 1.00% and 2.00%.' : '') + '</td></tr>'; return; }
      var body = res.body;
      A.rows = body.assets;
      var rows = body.assets.map(function (a) { return { id: a.symbol, label: a.symbol, a: a }; })
        .concat([{ group: 'Other assets: not stocks, measured once item 17 lands' }])
        .concat(OTHER.map(function (o) { return { id: o.id, label: o.label, a: null }; }));
      tb.innerHTML = rows.map(function (r) {
        if (r.group) return '<tr class="group"><td colspan="13">' + esc(r.group) + '</td></tr>';
        var a = r.a, pt = A.poolTimes[a ? a.assetMint : ''];
        var tvl = a ? mk(a.poolTvlUsd, { source: 'risk_pools.tvl_usd, tier A and B pools (GET /risk/assets)', fetchedAt: pt, method: 'sum of on-chain pool TVL', methodVersion: 'registry-0.1' }) : { value: null, reason: 'not_collected' };
        var ratioF = a ? (a.weekendRatio == null ? { value: null, reason: 'no_samples_in_regime' } : mk(a.weekendRatio, { source: 'risk_depth_curves (GET /risk/assets)', fetchedAt: (a.capacityAtTau.weekend || {}).to, method: 'weekend capacity ÷ market-hours capacity at τ = ' + pct(body.tau), methodVersion: body.methodVersion })) : { value: null, reason: 'not_collected' };
        return '<tr data-asset="' + esc(r.id) + '"' + (S.asset === r.id ? ' class="sel"' : '') + '>' +
          cell('Asset', '<button type="button" class="an-rowbtn" aria-expanded="' + (S.asset === r.id) + '" aria-controls="an-asset">' + esc(r.label) + '</button>', 'first') +
          cell('Pools', a && a.pools != null ? esc(num(a.pools)) : reason('not_collected'), 'n') +
          cell('On-chain TVL', fig(tvl, usdC), 'n') +
          REGIMES.map(function (g) { return cell('Capacity, ' + RW[g], a ? fig(capFact(a, g, body), capW) : reason('not_collected'), 'n'); }).join('') +
          cell('Weekend ÷ market hours', fig(ratioF, ratio), 'n') +
          cell('Volume 24 h', reason('not_collected'), 'n') +
          cell('Top-3 LP share', '<span data-lp>' + '<span class="an-loading">reading</span></span>', 'n') +
          cell('Exit capacity, 7 d', '<span data-sp></span>') +
          cell('Exit cost at $10k', '<span data-c10><span class="an-loading">reading</span></span>', 'n') +
          cell('Exit cost at ' + sizeW(S.size), '<span data-cn><span class="an-loading">reading</span></span>', 'n') +
          '</tr>';
      }).join('');
      tb.querySelectorAll('tr[data-asset]').forEach(function (tr) {
        tr.addEventListener('click', function (e) { if (e.target.closest('.an-pin')) return; selectAsset(tr.getAttribute('data-asset')); });
      });
      overviewChart(body);
      document.getElementById('an-at-meta').textContent = 'method ' + body.methodVersion + ' · τ = ' + pct(body.tau) + ' · ' + body.honesty.join(' ');
      var ids = rows.filter(function (r) { return !r.group; }).map(function (r) { return r.id; });
      return pool(ids, 6, function (id) {
        if (seq !== atSeq) return Promise.resolve();
        if (A.rows.some(function (a) { return a.symbol === id; })) get(R.history(id, S.tau)).then(function (hr) {
          if (seq !== atSeq) return;
          var tr2 = tb.querySelector('tr[data-asset="' + id.replace(/"/g, '') + '"]'); if (!tr2 || !hr.ok) return;
          var v = (hr.body.points || []).map(function (p) { return p.sellCapacityUsd; });
          tr2.querySelector('[data-sp]').innerHTML = C.spark(v, 's1');
        });
        return Promise.all([get(R.sheet(id, 10000)), get(R.sheet(id, S.size))]).then(function (rs) {
          if (seq !== atSeq) return;
          var tr = tb.querySelector('tr[data-asset="' + id.replace(/"/g, '') + '"]');
          if (!tr) return;
          var s10 = rs[0].ok ? rs[0].body : null, sn = rs[1].ok ? rs[1].body : null;
          var lp = (sn || s10) && (sn || s10).liquidityStability;
          tr.querySelector('[data-lp]').innerHTML = lp ? fig(lp.lpTop3Share, pct) : reason(rs[0].reason);
          var w10 = worstExit(s10), wn = worstExit(sn);
          tr.querySelector('[data-c10]').innerHTML = w10 ? fig(w10.fact, pct) + (w10.regime ? '<span class="an-sub">' + esc(RW[w10.regime]) + '</span>' : '') : (s10 ? reason('no_samples_in_regime') : reason(rs[0].reason));
          tr.querySelector('[data-cn]').innerHTML = wn ? fig(wn.fact, pct) + (wn.regime ? '<span class="an-sub">' + esc(RW[wn.regime]) + '</span>' : '') : (sn ? reason('no_samples_in_regime') : reason(rs[1].reason));
        });
      }).then(check);
    });
  }
  function selectAsset(id) {
    if (S.asset === id) { location.hash = '#analytics'; return; }
    location.hash = '#asset=' + encodeURIComponent(id);
  }

  /* ---------------- 3. asset panel ---------------- */
  var NS = 'http://www.w3.org/2000/svg';
  function legVar(i) { return 'var(--an-leg-' + (i + 1) + ')'; }
  function readAt() { return S.mode === 'live' ? new Date().toISOString() : S.manifest.captured_at; }
  function th(t, n) { return '<th scope="col"' + (n ? ' class="n"' : '') + '>' + esc(t) + '</th>'; }
  function table(id, caption, heads, rows, stack) {
    id = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return '<div class="an-scroll" role="region" tabindex="0" aria-labelledby="' + id + '"><table class="an-table' + (stack ? ' stack' : '') + '"><caption id="' + id + '">' + esc(caption) + '</caption><thead><tr>' +
      heads.map(function (h) { return th(h[0], h[1]); }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  function tr(heads, cells, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map(function (c, i) { return cell(heads[i][0], c, (i === 0 ? 'first' : '') + (heads[i][1] ? ' n' : '')); }).join('') + '</tr>'; }

  var panelSeq = 0;
  function openAsset(id, scroll) {
    S.asset = id;
    var seq = ++panelSeq;
    var box = els['an-asset'];
    document.querySelectorAll('#an-at tr[data-asset]').forEach(function (r) {
      var on = r.getAttribute('data-asset') === id; r.classList.toggle('sel', on);
      var b = r.querySelector('.an-rowbtn'); if (b) b.setAttribute('aria-expanded', String(on));
    });
    var row = A.rows.filter(function (a) { return a.symbol === id; })[0];
    var other = OTHER.filter(function (o) { return o.id === id; })[0];
    var label = row ? row.symbol : other ? other.label : id;
    box.innerHTML = '<div class="an-panel an-fade"><div class="an-ph"><h2 id="an-asset-h">' + esc(label) + ' at ' + esc(usd(S.size)) + '</h2><span class="an-meta">reading the sheet</span></div><div class="an-pb"><p class="an-loading" role="status">Reading the asset sheet…</p></div></div>';
    if (scroll !== false) box.scrollIntoView({ block: 'start' });
    var reads = [get(R.sheet(id, S.size))];
    if (row) reads.push(Promise.all(REGIMES.map(function (r) { return get(R.depth(id, r)); })), get(R.heatmap(id, heatSize(S.size))), get(R.lp(id)), get(R.pools(id)), get(R.score(id, S.tau, S.size)),
      Promise.all(REGIMES.map(function (r) { return get(R.depthBuy(id, r)); })), get(R.history(id, S.tau)), get(R.prices(id)), get(R.pricesH(id)));
    return Promise.all(reads).then(function (rs) {
      if (seq !== panelSeq) return;
      var sh = rs[0];
      if (!sh.ok) { box.querySelector('.an-pb').innerHTML = '<p>' + reason(sh.reason) + (S.mode === 'snapshot' ? '. The snapshot holds the sheets at $10k, $50k, $100k and $250k.' : '') + '</p>'; return; }
      var s = sh.body, ra = readAt();
      var parts = [];
      if (row) {
        parts.push(priceCard(id, label, rs[9], rs[8], rs[7]));
        parts.push(depthCard(id, rs[1], rs[6]));
        parts.push(distCard(rs[4]));
      }
      parts.push(costSection(s));
      if (row) {
        parts.push(historyCard(rs[7]));
        parts.push(curveSection(id, rs[1]));
        parts.push(heatSection(id, rs[2], ra));
        parts.push(lpSection(rs[3], rs[4]));
      } else {
        parts.push('<div class="an-sec"><h3>The cost curve, hour of week, who provides the liquidity</h3><p class="an-note" style="margin-top:4px">' + reason('not_collected') + ': the collectors do not read pools for ' + esc(label) + ' yet. Item 17 measures its exit cost; until then every fact on its sheet carries its reason.</p></div>');
      }
      parts.push(stabilitySection(s));
      parts.push(trackingSection(s, label));
      if (row) parts.push(poolsSection(rs[4]));
      parts.push(coverageSection(s, row));
      var head = '<h2 id="an-asset-h">' + esc(label) + ' at ' + esc(usd(S.size)) + '</h2><span class="an-meta">' + esc(s.chain) + ' · mint ' + explorer(s.mint, label + ' mint') + ' · ' + esc(s.methodVersion) + '</span>';
      var score = row && rs[5] && rs[5].ok ? rs[5].body : null;
      var lead = score && score.score != null
        ? '<p style="font-size:15px;line-height:24px;margin-bottom:8px">Over the next 72 hours, ' + fig(mk(score.score, { quality: score.lowerBound ? 'lower_bound' : 'measured', source: 'risk_depth_curves (GET /risk/assets/:id/score)', fetchedAt: ra, method: 'share of ' + usd(score.nRef) + ' exitable at ≤ τ = ' + pct(score.tau) + ' in the worst regime of the window; time is when the page read it', methodVersion: score.methodVersion }), pct) +
          ' of a ' + esc(usd(score.nRef)) + ' sale can leave at a cost of ' + esc(pct(score.tau)) + ' or less; the thinnest regime in that window is ' + esc(RW[score.worstRegime] || score.worstRegime) + '.</p>'
        : row ? '<p class="an-note" style="margin-bottom:8px">Liquidity score for the next 72 hours: ' + reason(rs[5] && rs[5].ok ? 'no_samples_in_regime' : (rs[5] && rs[5].reason)) + '.</p>' : '';
      box.innerHTML = '<div class="an-panel an-fade" aria-labelledby="an-asset-h"><div class="an-ph">' + head + '</div><div class="an-pb">' + lead + parts.join('') + '</div></div>';
      wireHeat(box);
      wireDistribution(box);
      C.mount(box);
      check();
    });
  }

  function costSection(s) {
    var comps = [['poolFee', 'pool fee'], ['transferFee', 'transfer fee'], ['impact', 'impact'], ['basis', 'basis']];
    var lo = 0, hi = 0;
    s.costs.forEach(function (c) {
      var e = c.exit, t = e.total.value, pos = 0;
      comps.forEach(function (k) { var v = e[k[0]].value; if (v != null) { if (v < 0) lo = Math.min(lo, v); else pos += v; } });
      if (t != null) hi = Math.max(hi, t, pos);
    });
    var span = (hi - lo) || 1;
    function bar(c) {
      var e = c.exit;
      if (e.total.value == null) return reason(e.total.reason, e.total.detail);
      var z = (-lo / span) * 100, x = z, out = '<div class="an-bar" role="img" aria-label="' + esc(RW[c.regime] + ': exit cost ' + pct(e.total.value)) + '"><span class="zero" style="left:' + z + '%"></span>';
      var split = comps.filter(function (k) { return e[k[0]].value != null; });
      if (!split.length) return out + '<span class="seg" style="left:' + z + '%;width:' + Math.max(0.5, e.total.value / span * 100) + '%;background:var(--an-total)"></span></div>';
      comps.forEach(function (k, i) {
        var v = e[k[0]].value; if (v == null) return;
        var w = Math.abs(v) / span * 100;
        if (v < 0) out += '<span class="seg" style="left:' + (z - w) + '%;width:' + w + '%;background:' + legVar(i) + '"></span>';
        else { out += '<span class="seg" style="left:' + x + '%;width:' + w + '%;background:' + legVar(i) + ';border-right:2px solid var(--an-card)"></span>'; x += w; }
      });
      return out + '</div>';
    }
    var heads = [['Regime'], ['Fee split'], ['Exit cost', 1], ['Pool fee', 1], ['Transfer fee', 1], ['Impact', 1], ['Basis', 1], ['Network fee', 1], ['Loss in dollars', 1], ['Round trip', 1], ['Break-even return', 1]];
    var rows = s.costs.map(function (c) {
      var e = c.exit;
      return tr(heads, [esc(RW[c.regime]), '<div style="min-width:160px">' + bar(c) + '</div>', fig(e.total, pct), fig(e.poolFee, pct), fig(e.transferFee, pct), fig(e.impact, pct), fig(e.basis, pct),
        fig(e.networkFeeUsd, usd), fig(e.lossUsd, usd), fig(c.roundTrip, pct), fig(c.breakEvenReturn, pct)]);
    });
    var w = s.costs.filter(function (c) { return c.regime === s.worstRegime; })[0];
    var be = w && w.breakEvenReturn.value != null
      ? '<p style="margin-top:8px">To break even on a ' + esc(usd(s.sizeUsd)) + ' round trip you need ' + fig(w.breakEvenReturn, pct) + ' before costs in ' + esc(RW[w.regime]) + ', the worst measured regime: entry ' + fig(w.entry.total, pct) + ', exit ' + fig(w.exit.total, pct) + '.</p>'
      : '<p class="an-note" style="margin-top:8px">Break-even return: ' + reason(w ? w.breakEvenReturn.reason : (s.costs[0] && s.costs[0].breakEvenReturn.reason)) + '.</p>';
    var hol = s.costs.filter(function (c) { return c.regime === 'us_holiday'; })[0], wk = s.costs.filter(function (c) { return c.regime === 'weekend'; })[0];
    var holNote = hol && wk && hol.exit.total.value != null && hol.exit.total.dataFrom && hol.exit.total.dataFrom === wk.exit.total.dataFrom
      ? '<p class="an-callout">Holiday figures are the weekend curve’s: no holiday has been sampled yet, and the API’s rule is that a holiday falls back to the weekend (both are closed-market regimes).</p>' : '';
    return '<div><h3>Cost to leave at this size</h3><p class="an-note" style="margin:4px 0 8px">The bar splits the exit cost into pool fee, transfer fee, impact and basis where the split is measured; a single member-grey bar is the total where it is not. Basis compares the pools a sale uses with the reference pool, and it can be negative, which is why a small sale sometimes shows a negative cost.</p>' +
      table('an-cost-c', 'Exit at ' + usd(s.sizeUsd) + ' by regime', heads, rows, true) +
      '<div class="an-bar-legend" aria-hidden="true">' + comps.map(function (k, i) { return '<span><i style="background:' + legVar(i) + '"></i>' + k[1] + '</span>'; }).join('') + '<span><i style="background:var(--an-total)"></i>total, split not measured</span></div>' +
      be + holNote + '</div>';
  }

  function curveSection(id, depths) {
    var curves = depths.map(function (d, i) { return d.ok ? { r: REGIMES[i], d: d.body } : { r: REGIMES[i], miss: d.body && d.body.error || REASON[d.reason] }; });
    var have = curves.filter(function (c) { return c.d && c.d.points && c.d.points.length; });
    if (!have.length) return '<div class="an-sec"><h3>The cost curve</h3><p class="an-note">' + reason('no_samples_in_regime') + '</p></div>';
    var W = 720, H = 300, ml = 52, mr = 112, mt = 12, mb = 36;
    var sizes = have[0].d.points.map(function (p) { return p.notionalUsd; });
    var xmin = Math.log10(sizes[0]), xmax = Math.log10(sizes[sizes.length - 1]);
    var allC = [].concat.apply([], have.map(function (c) { return c.d.points.map(function (p) { return p.cost; }); }));
    var near = [].concat.apply([], have.map(function (c) { return c.d.points.filter(function (p) { return p.notionalUsd <= Math.max(250000, S.size); }).map(function (p) { return p.cost; }); }));
    var ymax = Math.min(0.25, Math.max(0.005, Math.max.apply(null, near) * 1.5)), ymin = Math.min(0, Math.min.apply(null, allC));
    var step = ymax > 0.1 ? 0.05 : ymax > 0.04 ? 0.01 : ymax > 0.02 ? 0.005 : ymax > 0.008 ? 0.002 : 0.001;
    ymax = Math.ceil(ymax / step) * step; ymin = Math.floor(ymin / step) * step;
    function X(n) { return ml + (Math.log10(n) - xmin) / (xmax - xmin) * (W - ml - mr); }
    function Y(c) { return mt + (ymax - c) / (ymax - ymin) * (H - mt - mb); }
    var g = '';
    for (var t = ymin; t <= ymax + 1e-9; t += step) g += '<line class="grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(t) + '" y2="' + Y(t) + '"/><text x="' + (ml - 6) + '" y="' + (Y(t) + 4) + '" text-anchor="end">' + esc(pct(t).replace('.00%', '%')) + '</text>';
    sizes.forEach(function (n) { g += '<line class="grid" x1="' + X(n) + '" x2="' + X(n) + '" y1="' + mt + '" y2="' + (H - mb) + '"/><text x="' + X(n) + '" y="' + (H - mb + 16) + '" text-anchor="middle">' + esc(sizeW(n).replace('$0.1k', '$100').replace('$0.5k', '$500')) + '</text>'; });
    g += '<text x="' + (ml + (W - ml - mr) / 2) + '" y="' + (H - 2) + '" text-anchor="middle">sale size, USD (log scale)</text>';
    g += '<text x="12" y="' + (mt + (H - mt - mb) / 2) + '" text-anchor="middle" transform="rotate(-90 12 ' + (mt + (H - mt - mb) / 2) + ')">exit cost</text>';
    if (sizes.indexOf(S.size) < 0 && S.size >= sizes[0] && S.size <= sizes[sizes.length - 1]) g += '<line x1="' + X(S.size) + '" x2="' + X(S.size) + '" y1="' + mt + '" y2="' + (H - mb) + '" stroke="var(--an-muted)" stroke-width="1"/><text x="' + (X(S.size) + 4) + '" y="' + (mt + 10) + '">' + esc(sizeW(S.size)) + '</text>';
    var labels = [];
    have.forEach(function (c) {
      var i = REGIMES.indexOf(c.r), pts = c.d.points, cut = c.d.insufficientFrom == null ? pts.length : c.d.insufficientFrom;
      var solid = pts.slice(0, cut).map(function (p) { return X(p.notionalUsd) + ',' + Y(p.cost); }).join(' ');
      var dash = pts.slice(Math.max(0, cut - 1)).map(function (p) { return X(p.notionalUsd) + ',' + Y(p.cost); }).join(' ');
      if (cut > 1) g += '<polyline class="ln" clip-path="url(#an-clip)" style="stroke:' + legVar(i) + '" points="' + solid + '"/>';
      if (cut < pts.length) g += '<polyline class="ln dash" clip-path="url(#an-clip)" style="stroke:' + legVar(i) + '" points="' + dash + '"/>';
      var vis = pts.filter(function (p) { return p.cost <= ymax; }), last = vis[vis.length - 1] || pts[0];
      labels.push({ i: i, y: Y(last.cost), x: X(last.notionalUsd), t: RW[c.r] + (c.d.insufficientFrom != null ? ' (dashed: too few samples)' : '') });
    });
    labels.sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < labels.length; k++) if (labels[k].y - labels[k - 1].y < 14) labels[k].y = labels[k - 1].y + 14;
    labels.forEach(function (l) { g += '<text class="lab" x="' + (l.x + 6) + '" y="' + (l.y + 4) + '" style="fill:' + legVar(l.i) + '">' + esc(l.t) + '</text>'; });
    var clipped = allC.some(function (c) { return c > ymax; });
    var heads = [['Regime']].concat(sizes.map(function (n) { return [sizeW(n).replace('$0.1k', '$100').replace('$0.5k', '$500'), 1]; })).concat([['Samples', 1]]);
    var rows = curves.map(function (c) {
      if (!c.d) return tr(heads, [esc(RW[c.r])].concat(sizes.map(function () { return reason('no_samples_in_regime'); })).concat(['']));
      return tr(heads, [esc(RW[c.r])].concat(sizes.map(function (n, j) {
        var p = c.d.points.filter(function (q) { return q.notionalUsd === n; })[0];
        if (!p) return reason('beyond_measured_size');
        if (c.d.insufficientFrom != null && j >= c.d.insufficientFrom) return reason('insufficient_samples');
        return fig(mk(p.cost, { source: c.d.source, fetchedAt: c.d.dataTo, dataFrom: c.d.dataFrom, samples: p.samples, regime: c.r, sizeUsd: n, method: c.d.method + ', quantile ' + c.d.quantile + ', min ' + c.d.minSamples + ' samples per point', methodVersion: c.d.methodVersion }), pct);
      })).concat([esc(num(c.d.samples))]));
    });
    var aria = 'Exit cost by sale size for ' + have.map(function (c) { return RW[c.r]; }).join(', ') + '. ' + have.map(function (c) { var p = c.d.points; return RW[c.r] + ' from ' + pct(p[0].cost) + ' at ' + usd(p[0].notionalUsd) + ' to ' + pct(p[p.length - 1].cost) + ' at ' + usd(p[p.length - 1].notionalUsd); }).join('; ') + '.';
    return '<div class="an-sec"><h3>The cost curve</h3><p class="an-note" style="margin:4px 0 8px">Median exit cost by sale size for each measured regime, routed across the dollar-exit pools. Solid where every point has enough samples; dashed from the point where samples fall under the minimum.' + (clipped ? ' Costs above ' + esc(pct(ymax)) + ' run off the top of the chart; the table lists every point.' : '') + '</p>' +
      '<div class="an-chart" role="img" aria-label="' + esc(aria) + '"><svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="' + NS + '"><defs><clipPath id="an-clip"><rect x="' + ml + '" y="' + (mt - 2) + '" width="' + (W - ml - mr + 2) + '" height="' + (H - mt - mb + 4) + '"/></clipPath></defs>' + g + '<line class="axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(0) + '" y2="' + Y(0) + '"/></svg></div>' +
      '<details style="margin-top:8px"><summary class="an-btn" style="display:inline-block">The curve points as a table</summary><div style="margin-top:8px">' + table('an-curve-t', 'Exit cost by size and regime', heads, rows, false) + '</div></details>' +
      curves.filter(function (c) { return !c.d; }).map(function (c) { return '<p class="an-meta" style="margin-top:4px">' + esc(RW[c.r]) + ': ' + esc(c.miss || 'no curve') + '</p>'; }).join('') + '</div>';
  }

  var GRID = [100, 500, 2500, 10000, 50000, 250000, 1000000, 5000000];
  /** The hour-of-week medians are kept at the curve's grid sizes only: the nearest one on a log scale. */
  function heatSize(n) { return GRID.reduce(function (a, b) { return Math.abs(Math.log(b / n)) < Math.abs(Math.log(a / n)) ? b : a; }); }
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function heatSection(id, res, ra) {
    if (!res.ok) return '<div class="an-sec"><h3>Hour of week</h3><p class="an-note">' + reason(res.reason) + '</p></div>';
    var h = res.body, cells = h.cells || [];
    if (!cells.length) return '<div class="an-sec"><h3>Hour of week</h3><p class="an-note">' + reason('no_samples_in_regime') + '</p></div>';
    var src = { source: 'risk_asset_snapshots (GET /risk/assets/:id/heatmap)', fetchedAt: ra, method: 'median of the best single-pool sell cost per snapshot in that ET hour at ' + usd(h.notionalUsd) + '; the route gives no measurement time, so the time is when the page read it', methodVersion: 'risk-0.3' };
    var sorted = cells.map(function (c) { return c.medianCost; }).sort(function (a, b) { return a - b; });
    function q(p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }
    var bins = [q(0.2), q(0.4), q(0.6), q(0.8)];
    function bin(v) { var b = 0; while (b < 4 && v > bins[b]) b++; return 5 - b; }
    var by = {}; cells.forEach(function (c) { by[c.hourOfWeekEt] = c; });
    var worst = cells.reduce(function (a, b) { return b.medianCost > a.medianCost ? b : a; });
    var best = cells.reduce(function (a, b) { return b.medianCost < a.medianCost ? b : a; });
    function when(how) { return DAYS[Math.floor(how / 24)] + ' ' + ('0' + (how % 24)).slice(-2) + ':00 ET'; }
    HEAT.cells = by; HEAT.src = src; HEAT.n = h.notionalUsd; HEAT.when = when;
    var g = '<div class="an-heat" role="grid" aria-label="Median sell cost at ' + esc(usd(h.notionalUsd)) + ' by hour of week, Eastern time" id="an-heatgrid"><div role="row" style="display:contents"><span class="rh" aria-hidden="true"></span>';
    for (var c = 0; c < 24; c++) g += '<span class="ch" role="columnheader">' + (c % 3 === 0 ? ('0' + c).slice(-2) : '<span class="an-sr">' + ('0' + c).slice(-2) + '</span>') + '</span>';
    g += '</div>';
    var first = true;
    for (var d = 0; d < 7; d++) {
      g += '<div role="row" style="display:contents"><span class="rh" role="rowheader">' + DAYS[d] + '</span>';
      for (var hr = 0; hr < 24; hr++) {
        var how = d * 24 + hr, cc = by[how];
        var name = cc ? when(how) + ', ' + pct(cc.medianCost) + ' at ' + usd(h.notionalUsd) + ', n=' + cc.samples : when(how) + ', no sample';
        g += '<button type="button" role="gridcell" class="c' + (cc ? ' h' + bin(cc.medianCost) : '') + '" data-how="' + how + '" tabindex="' + (first ? 0 : -1) + '" aria-label="' + esc(name) + '">' + (cc ? '' : '–') + '</button>';
        first = false;
      }
      g += '</div>';
    }
    g += '</div>';
    var ramp = '<div class="an-ramp"><span>lowest cost ' + fig(mk(best.medianCost, Object.assign({ samples: best.samples }, src)), pct) + '</span><span class="sw" aria-hidden="true">' +
      [5, 4, 3, 2, 1].map(function (i) { return '<i style="background:var(--an-heat-' + i + ')"></i>'; }).join('') + '</span><span>highest ' + fig(mk(worst.medianCost, Object.assign({ samples: worst.samples }, src)), pct) + '</span><span class="an-muted">– no sample · bins are quintiles of these ' + cells.length + ' hours</span></div>';
    var n = cells.reduce(function (a, c) { return a + c.samples; }, 0);
    return '<div class="an-sec"><div class="an-tile"><div class="an-bhead">' + esc(id) + ' · sell cost at ' + esc(usd(h.notionalUsd)) + ', by hour of week</div>' +
      '<div class="an-kpi">' + fig(mk(worst.medianCost, Object.assign({ samples: worst.samples }, src)), pct) + '</div>' +
      '<div class="an-note" style="margin-bottom:8px">' + (h.notionalUsd !== S.size ? 'The hourly medians are kept at the curve\u2019s grid sizes; ' + esc(usd(S.size)) + ' is not one, so this shows ' + esc(usd(h.notionalUsd)) + '. ' : '') + 'Thinnest hour measured: ' + esc(when(worst.hourOfWeekEt)) + '. Lighter cells cost less to leave' + (ROOT.getAttribute('data-theme') === 'light' ? ' on dark; on paper, darker cells cost less' : '') + '.</div>' +
      '<div style="overflow-x:auto;position:relative">' + g + '</div>' + ramp +
      '<p class="an-meta" id="an-heat-sel" aria-live="polite" style="margin-top:8px">Move through the hours with the arrow keys.</p>' +
      '<p class="an-meta">USD · n=' + esc(num(n)) + ' · ' + esc(cells.length) + ' of 168 hours sampled · ' + esc(h.timezone || 'America/New_York') + ', ' + esc(h.hourOfWeek || 'Mon 00:00 = 0') + ' · ' + (S.mode === 'live' ? 'read ' : 'captured ') + esc(iso(ra)) + '</p></div></div>';
  }
  var HEAT = {};
  function wireHeat(box) {
    var grid = box.querySelector('#an-heatgrid'); if (!grid) return;
    var sel = box.querySelector('#an-heat-sel');
    function show(b) {
      var how = +b.getAttribute('data-how'), c = HEAT.cells[how];
      sel.innerHTML = c ? esc(HEAT.when(how)) + ' · ' + fig(mk(c.medianCost, Object.assign({ samples: c.samples }, HEAT.src)), pct) + ' at ' + esc(usd(HEAT.n)) + ' · n=' + esc(c.samples) : esc(HEAT.when(how)) + ' · no sample';
    }
    grid.addEventListener('focusin', function (e) { var b = e.target.closest('.c'); if (b) show(b); });
    grid.addEventListener('mouseover', function (e) { var b = e.target.closest('.c'); if (b) show(b); });
    grid.addEventListener('keydown', function (e) {
      var b = e.target.closest('.c'); if (!b) return;
      var how = +b.getAttribute('data-how'), d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 24, ArrowUp: -24, Home: -(how % 24), End: 23 - (how % 24) }[e.key];
      if (d == null) return;
      e.preventDefault();
      var nx = grid.querySelector('.c[data-how="' + Math.max(0, Math.min(167, how + d)) + '"]');
      if (nx) { b.tabIndex = -1; nx.tabIndex = 0; nx.focus(); }
    });
  }

  function lpSection(res, poolsRes) {
    if (!res.ok) return '<div class="an-sec"><h3>Who provides the liquidity</h3><p class="an-note">' + reason(res.reason) + '</p></div>';
    var pools = (poolsRes && poolsRes.ok && poolsRes.body.pools) || [], byAddr = {};
    pools.forEach(function (p) { byAddr[p.address] = p; });
    var lp = res.body.pools || [];
    if (!lp.length) return '<div class="an-sec"><h3>Who provides the liquidity</h3><p class="an-note">' + reason('not_collected') + '</p></div>';
    var n = lp[0].lpExitN;
    var heads = [['Pool'], ['Concentration'], ['Positions', 1], ['In band', 1], ['Top 1', 1], ['Top 3', 1], ['Top 10', 1], ['Sale cost at $50k now', 1], ['After the top ' + n + ' leave', 1], ['Sale cost at $250k now', 1], ['After the top ' + n + ' leave', 1]];
    function at(arr, size, p, after) {
      var x = (arr || []).filter(function (q) { return q.notionalUsd === size; })[0];
      if (!x) return reason('beyond_measured_size');
      var f = mk(x.costPct / 100, { source: p.source, fetchedAt: p.fetchedAt, sizeUsd: size, method: p.method + (after ? ': the top ' + p.lpExitN + ' positions removed, then the sale simulated on this pool alone' : ': the sale simulated on this pool alone') + ', band ±' + pct0(p.bandPct), methodVersion: p.methodVersion });
      return fig(f, pct) + (x.unfilledShare > 0 ? '<span class="an-sub">' + fig(mk(x.unfilledShare, { source: p.source, fetchedAt: p.fetchedAt, sizeUsd: size, method: 'share of the sale the pool cannot fill', methodVersion: p.methodVersion }), pct0) + ' unfilled</span>' : '');
    }
    function share(v, p) { return fig(mk(v, { source: p.source, fetchedAt: p.fetchedAt, method: p.method + ' (share of in-band liquidity by position)', methodVersion: p.methodVersion }), pct); }
    var rows = lp.map(function (p) {
      var meta = byAddr[p.pool];
      return tr(heads, [explorer(p.pool, 'pool ' + p.pool) + '<span class="an-sub">' + esc(meta ? venueW(meta.venue) + ' \u00b7 ' + meta.quoteSymbol : '') + '</span>', C.stack([{ share: p.top1, cls: 'k1' }, { share: Math.max(0, p.top3 - p.top1), cls: 'k2' }, { share: Math.max(0, p.top10 - p.top3), cls: 'k3' }, { share: Math.max(0, 1 - p.top10), cls: 'k4' }]), esc(num(p.positions)), esc(num(p.inBandPositions)),
        share(p.top1, p), share(p.top3, p), share(p.top10, p), at(p.sellBase, 50000, p), at(p.sellWithoutTopN, 50000, p, 1), at(p.sellBase, 250000, p), at(p.sellWithoutTopN, 250000, p, 1)]);
    });
    return '<div class="an-sec"><h3>Who provides the liquidity</h3><p style="margin:4px 0 8px">These are positions, not owners: one owner can hold several positions, so concentration by owner is the same or higher than shown. Owners behind the position NFTs are read from Monday Oct 5 (item 15 part 3).</p>' +
      '<div class="an-legend" aria-hidden="true" style="margin-bottom:6px"><span><i class="an-key s1"></i>largest position</span><span><i class="an-key s2"></i>positions 2\u20133</span><span><i style="background:var(--an-s3)"></i>positions 4\u201310</span><span><i style="background:var(--an-sunk);outline:1px solid var(--an-input);outline-offset:-1px"></i>the rest</span></div>' +
      table('an-lp-t', 'Liquidity positions by pool, latest hour', heads, rows, true) + '</div>';
  }

  function stabilitySection(s) {
    var ls = s.liquidityStability || {};
    var heads = [['Regime'], ['Capacity variation (sd ÷ mean)', 1], ['Large trades', 1], ['Minutes to 50% of depth', 1], ['Minutes to 90%', 1], ['Not back in 24 h', 1]];
    var cv = {}; (ls.capacityVariationByRegime || []).forEach(function (x) { cv[x.regime] = x.value; });
    var dr = {}; (ls.depthRecovery || []).forEach(function (x) { dr[x.regime] = x; });
    var rows = REGIMES.map(function (r) {
      var d = dr[r] || {};
      return tr(heads, [esc(RW[r]), fig(cv[r], function (v) { return ratio(v); }), fig(d.largeTrades, function (v) { return num(v); }), fig(d.hoursTo50, mins), fig(d.hoursTo90, mins), fig(d.notRecovered24h, pct)]);
    });
    return '<div class="an-sec"><h3>Stability</h3><dl class="an-stats" style="margin:8px 0">' +
      '<div class="an-stat"><dt>LP withdrawals, 7 days</dt><dd>' + fig(ls.lpWithdrawalEvents7d, function (v) { return num(v); }) + '</dd></div>' +
      '<div class="an-stat"><dt>Cost at ' + esc(usd((ls.lpExitCost && ls.lpExitCost.sizeUsd) || s.sizeUsd)) + ' if the top LPs leave, largest pool</dt><dd>' + fig(ls.lpExitCost, pct) + '</dd></div>' +
      '<div class="an-stat"><dt>Top-1 owner share</dt><dd>' + fig(ls.lpOwnerTop1Share, pct) + '</dd></div>' +
      '<div class="an-stat"><dt>Top 1 / 3 / 10 positions, largest pool</dt><dd>' + fig(ls.lpTop1Share, pct) + ' / ' + fig(ls.lpTop3Share, pct) + ' / ' + fig(ls.lpTop10Share, pct) + '</dd></div>' +
      '</dl>' + table('an-stab-t', 'Capacity variation and depth recovery after large trades', heads, rows, true) + '</div>';
  }

  /** The largest weekend gap with a measured zero frequency: "no move above 10% in 52 weekends". */
  function unseen(s) {
    var wf = (s.marketRisk && s.marketRisk.weekendGapFrequency) || [];
    for (var i = 0; i < wf.length; i++) {
      var f = wf[i].value;
      if (f.value === 0) return { gapPct: wf[i].gapPct, weekends: f.samples, fact: f, maxSeen: i > 0 ? wf[i - 1].gapPct : null };
    }
    return null;
  }
  function trackingSection(s, label) {
    var tk = s.tracking || [], against = [];
    tk.forEach(function (t) { if (against.indexOf(t.against) < 0) against.push(t.against); });
    var oName = { kamino_scope: 'Kamino oracle (Scope)', jupiter_lend_oracle: 'Jupiter Lend oracle' };
    var heads = [['Oracle']].concat(REGIMES.map(function (r) { return [RW[r], 1]; }));
    var rows = against.map(function (a) {
      return tr(heads, [esc(oName[a] || a)].concat(REGIMES.map(function (r) {
        var t = tk.filter(function (x) { return x.against === a && x.regime === r; })[0];
        if (!t) return reason('not_collected');
        if (t.gap.value == null) return fig(t.gap, pct);
        return fig(t.gap, function (v) { return pct(Math.abs(v)); }) + '<span class="an-sub">' + (t.gap.value > 0 ? 'pool above the oracle' : t.gap.value < 0 ? 'pool below the oracle' : 'at the oracle') + '</span>';
      })));
    });
    var mr = s.marketRisk || {}, wf = mr.weekendGapFrequency || [], u = unseen(s);
    var gh = [['Weekend move larger than'], ['Share of weekends', 1], ['Seen', 1]];
    var grows = wf.map(function (g) {
      var f = g.value;
      return tr(gh, [esc(g.gapPct + '%'), fig(f, pct), f.value != null && f.samples ? esc(Math.round(f.value * f.samples) + ' of ' + f.samples + ' weekends') : '']);
    });
    var unseenLine = u ? '<p style="margin-top:8px">The record has seen no weekend move above ' + esc(u.gapPct + '%') + ' for ' + esc(label) + ' in ' + esc(u.weekends) + ' weekends' + (u.maxSeen ? ' (moves above ' + esc(u.maxSeen + '%') + ' were seen)' : '') + '. A coverage ratio at a ' + esc(u.gapPct + '%') + ' gap or larger rests on a move the record has not seen.</p>' : '';
    return '<div class="an-sec"><h3>Tracking and market risk</h3><p class="an-note" style="margin:4px 0 8px">The pool mid against each lending oracle, median by regime over the last 7 days.</p>' +
      (rows.length ? table('an-trk-t', 'Pool mid against the lending oracles', heads, rows, true) : '<p class="an-note">' + reason('not_collected') + '</p>') +
      '<dl class="an-stats" style="margin:16px 0 8px"><div class="an-stat"><dt>Volatility, annualised</dt><dd>' + fig(mr.volatilityAnnual, pct) + '</dd></div><div class="an-stat"><dt>Largest drawdown, 1 year</dt><dd>' + fig(mr.maxDrawdown, pct) + '</dd></div></dl>' +
      (wf.length ? '<div class="an-figure" style="margin-top:12px"><h4>How often a weekend moved the price more than</h4>' + C.bars(wf.map(function (g) { var f = g.value; return { label: g.gapPct + '%', value: f.value, html: fig(f, pct) + (f.value != null && f.samples ? '<span class="an-sub">' + esc(Math.round(f.value * f.samples) + ' of ' + f.samples + ' weekends') + '</span>' : '') }; }), { max: Math.max(0.05, Math.max.apply(null, wf.map(function (g) { return g.value.value || 0; }))) }) + '</div>' : '') +
      '<details style="margin-top:8px"><summary class="an-btn" style="display:inline-block">The weekend gaps as a table</summary><div style="margin-top:8px">' + (grows.length ? table('an-gap-t', 'Weekend gaps in the reference price', gh, grows, false) : '') + '</div></details>' + unseenLine + '</div>';
  }

  function poolsSection(res) {
    if (!res.ok) return '<div class="an-sec"><h3>Pools</h3><p class="an-note">' + reason(res.reason) + '</p></div>';
    var ps = res.body.pools || [];
    var heads = [['Pool'], ['Venue'], ['Quote'], ['Exit path'], ['On-chain TVL', 1], ['Refresh tier'], ['Transfer fee', 1]];
    var rows = ps.map(function (p) {
      return tr(heads, [explorer(p.address, 'pool ' + p.address), esc(venueW(p.venue)), esc(p.quoteSymbol), esc(String(p.exitPath).replace(/_/g, ' ')),
        fig(mk(p.tvlUsd, { source: 'Solana RPC (pool vaults) via risk_pools', fetchedAt: p.fetchedAt, method: 'on-chain TVL of the pool', methodVersion: p.methodVersion }), usdC),
        esc('tier ' + p.tier + (p.status !== 'confirmed' ? ' · ' + p.status : '')), fig(mk((p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1) == null ? null : (p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1) / 10000, { source: 'mint account, Token-2022 transfer-fee extension (registry)', fetchedAt: p.fetchedAt, method: p.method, methodVersion: p.methodVersion }), pct)]);
    });
    var tv = ps.slice().sort(function (a, b) { return (b.tvlUsd || 0) - (a.tvlUsd || 0); }), topN = tv.slice(0, 10), rest = tv.slice(10).reduce(function (a, p) { return a + (p.tvlUsd || 0); }, 0);
    var tvRows = topN.map(function (p) { return { label: short(p.address), sub: venueW(p.venue) + ' \u00b7 ' + (p.quoteSymbol || 'quote not named') + ' \u00b7 ' + String(p.exitPath).replace(/_/g, ' '), value: p.tvlUsd, html: fig(mk(p.tvlUsd, { source: 'Solana RPC (pool vaults) via risk_pools', fetchedAt: p.fetchedAt, method: 'on-chain TVL of the pool', methodVersion: p.methodVersion }), usdC) }; });
    if (tv.length > 10) tvRows.push({ label: (tv.length - 10) + ' other pools', value: rest, html: fig(mk(rest, { source: 'Solana RPC (pool vaults) via risk_pools', fetchedAt: tv[10].fetchedAt, method: 'sum of on-chain TVL of the smaller pools', methodVersion: tv[10].methodVersion }), usdC) });
    var tvChart = '<div class="an-figure" style="margin-top:8px"><h4>Where the TVL sits</h4><p class="an-note">The largest pools by on-chain TVL. TVL is not exit capacity: a deep pool quoted in another token only helps a sale that can be routed back to dollars.</p>' + C.bars(tvRows) + '</div>';
    return '<div class="an-sec"><h3>Pools</h3><p class="an-note" style="margin:4px 0 8px">' + esc(ps.length) + ' pools in the registry. Pools are read every 5 minutes; cost curves are refitted hourly.</p>' + tvChart + '<div style="height:12px"></div>' + table('an-pools-t', 'Pools in the registry', heads, rows, true) + '</div>';
  }

  function coverageSection(s, row) {
    var c = s.coverage || {};
    var heads = [['Regime'], ['Samples', 1], ['From'], ['To'], ['Status']];
    var rows = REGIMES.map(function (r) {
      var cap = row && row.capacityAtTau[r];
      var miss = (c.regimesMissing || []).filter(function (m) { return (m.regime || m) === r; })[0];
      return tr(heads, [esc(RW[r]), cap ? esc(num(cap.samples)) : '', cap && cap.from ? esc(iso(cap.from)) : '', cap && cap.to ? esc(iso(cap.to)) : '',
        cap ? (cap.status === 'ok' ? status('on', 'measured') : status('watch', 'too few samples')) : miss ? status('off', REASON[miss.reason] || 'missing') : r === 'us_holiday' && (c.regimesMeasured || []).indexOf(r) >= 0 ? status('watch', 'weekend curve stands in') : status('off', 'no samples in this regime yet')]);
    });
    return '<div class="an-sec"><h3>Data coverage</h3><p class="an-meta" style="margin:4px 0 8px">' + (c.samples != null ? esc(num(c.samples)) : 'no') + ' snapshots · ' + (c.dataFrom ? esc(iso(c.dataFrom)) + ' to ' + esc(iso(c.dataTo)) : 'no snapshots') + ' · sheet ' + esc(s.methodVersion) + ' · regimes missing: ' + esc((c.regimesMissing || []).map(function (m) { return RW[m.regime || m] || m; }).join(', ') || 'none') + '</p>' +
      (row ? table('an-cov-t', 'Samples per regime behind the curves', heads, rows, true) : '') + '</div>';
  }

  /* ---------------- charts (assets/analytics-charts.js) ---------------- */
  var C = window.TF_CHARTS;
  var PREVIEW = Q.get('preview') === '1';
  /** The chart's data source, with its pin (source · fetched_at · method for the data drawn). */
  function chartSrc(f, what) {
    if (!f || f.value == null) return '';
    return '<p class="an-meta an-figsrc">' + esc(String(f.source || '').replace(/~\/[^,]*,\s*/g, '')) + ' · ' + esc(iso(f.fetchedAt)) + '<span class="an-fig"> ' + pin(f, what) + '</span></p>';
  }
  function card(inner) { return '<div class="an-card">' + inner + '</div>'; }
  function pctSigned(v) { return (v > 0 ? '+' : '') + pct(v); }
  function change(a, b, words) {   // the change over the visible range, sign and word, never colour alone
    if (a == null || b == null || !a) return '';
    var d = b / a - 1;
    return '<span class="cc-chg ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '▲ ' : '▼ ') + esc(pctSigned(d)) + '</span> ' + esc(words);
  }
  var H = 3600e3, D7 = 7 * 864e5;

  /** Exit capacity across all stocks, summed hour by hour from each stock's history (DefiLlama-style headline card). */
  function overviewChart(body) {
    var box = document.getElementById('an-overview'); if (!box) return;
    var ids = body.assets.map(function (a) { return a.symbol; });
    box.innerHTML = '<p class="an-loading">Reading each stock’s capacity history…</p>';
    Promise.all(ids.map(function (id) { return get(R.history(id, S.tau)); })).then(function (rs) {
      var ok = rs.filter(function (r) { return r.ok; });
      if (!ok.length) { box.innerHTML = card('<div class="cc-head"><div class="cc-title"><div class="t">Exit capacity, all stocks</div><div class="n">' + reason(rs[0] && rs[0].reason) + (rs[0] && rs[0].reason === 'not_served' ? ': this card reads GET /risk/assets/:id/history.' : '') + '</div></div></div>'); return; }
      var sum = {}, cnt = {};
      ok.forEach(function (r) { (r.body.points || []).forEach(function (p) { var t = Math.floor(new Date(p.t).getTime() / H) * H; if (p.sellCapacityUsd == null) return; sum[t] = (sum[t] || 0) + p.sellCapacityUsd; cnt[t] = (cnt[t] || 0) + 1; }); });
      var need = Math.ceil(ok.length * 0.9);   // an hour counts when at least 90% of the stocks have a reading in it
      var data = Object.keys(sum).map(Number).sort(function (a, b) { return a - b; }).filter(function (t) { return cnt[t] >= need; }).map(function (t) { return { t: t, v: sum[t] }; });
      var last = data[data.length - 1], h0 = ok[0].body;
      var f = last ? mk(last.v, { source: h0.source + ' (summed over ' + ok.length + ' stocks)', fetchedAt: new Date(last.t).toISOString(), method: 'sum of each stock’s exit capacity at τ = ' + pct(S.tau) + ' in the same UTC hour; an hour is drawn when at least 90% of the stocks have a reading', methodVersion: h0.methodVersion }) : null;
      var first = data[0];
      box.innerHTML = card(C.time({ title: 'Exit capacity, all stocks', value: f ? fig(f, usdC) : reason('no_samples_in_regime'),
        note: (first && last ? change(first.v, last.v, 'since ' + new Date(first.t).toISOString().slice(0, 13).replace('T', ' ') + ':00 UTC') + ' \u00b7 ' : '') + 'what can leave at a cost of ' + esc(pct(S.tau)) + ' or less, summed across ' + ok.length + ' stocks',
        ranges: [{ label: '24h', ms: 24 * H }, { label: '7d', ms: D7 }], range: 1, hourly: true,
        panes: [{ h: 200, fmt: usdC, series: [{ type: 'area', cls: 's1', label: 'exit capacity', data: data }] }],
        bands: regimeBandsT(ok[0].body.points || []), aria: 'Exit capacity summed across stocks, hourly', src: f ? chartSrc(f, 'the all-stocks capacity chart') : '' }));
      C.mount(box);
    });
  }
  function regimeBandsT(points) {
    var out = [], cur = null;
    points.forEach(function (p) {
      var t = Math.floor(new Date(p.t).getTime() / H) * H, on = p.regime === 'weekend' || p.regime === 'us_holiday';
      if (on && (!cur || cur.r !== p.regime)) { cur = { t0: t - H / 2, t1: t + H / 2, r: p.regime, label: RW[p.regime] }; out.push(cur); }
      if (on) cur.t1 = t + H / 2; else cur = null;
    });
    return out;
  }

  /** Price in candles (4-hour, from the hourly reference price) with exit capacity in the pane below (trading layout). */
  function priceCard(id, label, ph, pd, hist) {
    var out = '';
    if (ph && ph.ok && (ph.body.points || []).length) {
      var b = ph.body, buckets = {};
      b.points.forEach(function (p) { if (p.priceUsd == null) return; var t = new Date(p.t).getTime(), k = Math.floor(t / (4 * H)) * 4 * H; (buckets[k] = buckets[k] || []).push([t, p.priceUsd]); });
      var candles = Object.keys(buckets).map(Number).sort(function (x, y) { return x - y; }).map(function (k) {
        var q = buckets[k].sort(function (x, y) { return x[0] - y[0]; }), v = q.map(function (z) { return z[1]; });
        return { t: k + 2 * H, o: v[0], c: v[v.length - 1], h: Math.max.apply(null, v), l: Math.min.apply(null, v) };
      });
      var cap = hist && hist.ok ? (hist.body.points || []).map(function (p) { return { t: Math.floor(new Date(p.t).getTime() / H) * H, v: p.sellCapacityUsd }; }) : [];
      var lastC = candles[candles.length - 1], firstWeek = candles.filter(function (c) { return c.t >= lastC.t - D7; })[0];
      var f = mk(lastC.c, { source: b.source, fetchedAt: b.to, dataFrom: b.from, method: b.method + '; candles: open, high, low and close of the hourly reference prices in each 4-hour UTC window', methodVersion: b.methodVersion });
      out += card(C.time({ title: label + ' · reference price', value: fig(f, usd), note: change(firstWeek && firstWeek.o, lastC.c, 'over 7 days') + ' · 4-hour candles: hollow when the window closed up, filled when it closed down',
        ranges: [{ label: '7d', ms: D7 }, { label: '1m', ms: 31 * 864e5 }], range: 1, hourly: true,
        panes: [{ h: 240, zero: false, fmt: function (v) { return usd(v); }, series: [{ type: 'candle', cls: 's1', label: 'price', data: candles }] },
          { h: 80, title: 'exit capacity at τ = ' + pct(S.tau) + (cap.length ? '' : ': not served'), fmt: usdC, series: [{ type: 'area', cls: 's2', label: 'exit capacity', data: cap.filter(function (d) { return d.v != null; }) }] }],
        aria: label + ' price candles and exit capacity', src: chartSrc(f, 'the price chart') }));
    } else out += card('<div class="cc-head"><div class="cc-title"><div class="t">' + esc(label) + ' · reference price</div><div class="n">' + reason(ph ? ph.reason : 'not_served') + '</div></div></div>');
    if (pd && pd.ok && (pd.body.points || []).length) {
      var d = pd.body, pts = d.points.filter(function (p) { return p.priceUsd != null; }).map(function (p) { return { t: new Date(p.t).getTime(), v: p.priceUsd }; });
      var lp = pts[pts.length - 1], fp = pts[0], f2 = mk(lp.v, { source: d.source, fetchedAt: d.to, dataFrom: d.from, method: d.method, methodVersion: d.methodVersion });
      out += card(C.time({ title: label + ' · one year of daily closes', value: fig(f2, usd), note: change(fp.v, lp.v, 'over the year') + ' · the last market-hours price of each trading day',
        ranges: [{ label: '3m', ms: 91 * 864e5 }, { label: '6m', ms: 182 * 864e5 }, { label: '1y', ms: null }], range: 2,
        panes: [{ h: 180, zero: false, fmt: function (v) { return usd(v); }, series: [{ type: 'area', cls: 's1', label: 'close', data: pts }] }], aria: label + ' daily closes over a year', src: chartSrc(f2, 'the one-year price chart') }));
    }
    return '<div class="an-sec"><div class="an-cards">' + out + '</div></div>';
  }

  /** Exchange-style depth chart: cumulative size by average cost, sell left and buy right, one regime at a time. */
  var BS = {};
  function depthCard(id, sells, buys) {
    var have = REGIMES.filter(function (r, i) { return sells[i].ok && (sells[i].body.points || []).length && buys[i].ok && (buys[i].body.points || []).length; });
    if (!have.length) return card('<div class="cc-head"><div class="cc-title"><div class="t">Depth</div><div class="n">' + reason('no_samples_in_regime') + '</div></div></div>');
    var now = regimeAt(new Date()), def = have.indexOf(now) >= 0 ? now : have[0];
    BS[id] = { sells: sells, buys: buys, have: have };
    return '<div class="an-sec">' + card('<div data-depth>' + depthCfg(id, def) + '</div>') + '</div>';
  }
  function depthCfg(id, r) {
    var d = BS[id], i = REGIMES.indexOf(r), sd = d.sells[i].body, bd = d.buys[i].body;
    function side(c, sign) { var cut = c.insufficientFrom == null ? c.points.length : c.insufficientFrom; return c.points.map(function (p, j) { return { x: sign * Math.max(0, p.cost), n: p.notionalUsd, dashed: j >= cut }; }); }
    var sell = side(sd, -1), buy = side(bd, 1), all = sell.concat(buy);
    var xmax = Math.min(0.05, Math.max.apply(null, all.map(function (p) { return Math.abs(p.x); })));
    var at = function (side, n) { return side.filter(function (p) { return p.n === n; })[0]; }, s100 = at(sell, 250000), b100 = at(buy, 250000);
    var f = mk(1, { source: sd.source, fetchedAt: sd.dataTo, dataFrom: sd.dataFrom, samples: sd.samples, regime: r, method: sd.method + ' (sell) with the buy curve of the same regime; x is the average cost of the trade, not the end price', methodVersion: sd.methodVersion });
    var tabs = '<div class="an-seg cc-ranges" role="group" aria-label="Regime">' + d.have.map(function (x) { return '<button type="button" data-depthr="' + x + '" aria-pressed="' + (x === r) + '">' + esc(RW[x]) + '</button>'; }).join('') + '</div>';
    return C.depth({ title: 'Depth · ' + RW[r], tools: tabs, value: s100 ? fig(mk(s100.x * -1, { source: sd.source, fetchedAt: sd.dataTo, regime: r, sizeUsd: 250000, method: sd.method, methodVersion: sd.methodVersion }), pct) : '',
      note: (s100 ? 'to sell $250k' : '') + (b100 ? ' · ' + esc(pct(b100.x)) + ' to buy it' : '') + ' · squares are the measured sizes, steps run between them',
      sell: sell, buy: buy, xmax: xmax, fmtX: function (v) { return v === 0 ? '0' : pctSigned(v); }, fmtY: usdC, aria: 'Depth chart for ' + id + ' in ' + RW[r], src: chartSrc(f, 'the depth chart'),
      readIdle: '<span>Point at the chart: each step is a trade size and the average cost to fill it.</span>' });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-depthr]'); if (!b || !S.asset) return;
    var box = document.querySelector('#an-asset [data-depth]'); if (!box) return;
    box.innerHTML = depthCfg(S.asset, b.getAttribute('data-depthr')); C.mount(box);
  });

  /** Liquidity distribution of one pool around its price (CLMM style), from GET /risk/pools/:address/liquidity. */
  var FIXTURE_POOLS = ['Fae5dWVntUt6zbWu2voXxioDpMii7SqQwtsxBmoVCsHR', 'GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG'];
  function distCard(poolsRes) {
    var ps = poolsRes && poolsRes.ok ? (poolsRes.body.pools || []).filter(function (p) { return /clmm|whirlpool|dlmm/.test(p.venue); }) : [];
    if (!ps.length) return '';
    ps.sort(function (a, b) { return (b.tvlUsd || 0) - (a.tvlUsd || 0); });
    var def = PREVIEW ? (ps.filter(function (p) { return FIXTURE_POOLS.indexOf(p.address) >= 0; })[0] || ps[0]) : ps[0];
    return '<div class="an-sec">' + card('<label class="an-field cc-poolsel"><span>Pool</span><select data-distpool>' + ps.slice(0, 20).map(function (p) { return '<option value="' + esc(p.address) + '"' + (p === def ? ' selected' : '') + '>' + esc(short(p.address) + ' · ' + venueW(p.venue) + ' · ' + (p.quoteSymbol || 'quote not named') + ' · TVL ' + usdC(p.tvlUsd || 0)) + '</option>'; }).join('') + '</select></label><div data-dist><p class="an-loading">Reading the pool…</p></div>') + '</div>';
  }
  function wireDistribution(box) {
    var sel = box.querySelector('[data-distpool]'); if (!sel) return;
    function render(out, d, mock) {
      if (!d.bands || !d.bands.length) { out.innerHTML = '<div class="cc-head"><div class="cc-title"><div class="t">Liquidity distribution</div><div class="n">' + reason(d.reason || 'not_collected') + '</div></div></div>'; return; }
      var f = { value: 1, quality: 'measured', source: d.source, fetchedAt: d.fetchedAt, method: d.method, methodVersion: d.methodVersion, provenance: d.provenance };
      var total = (d.totalAssetUsd || 0) + (d.totalQuoteUsd || 0);
      var plate = mock ? '<div class="an-mockline"><span class="an-mockband" aria-hidden="true"></span><span class="an-mockplate">MOCK</span><span>Recorded pool bytes of 2026-10-01 drawn by the route’s own code, to show the chart. The live read waits on the API’s RPC and on DA3 (Mon Oct 5).</span></div>' : '';
      out.innerHTML = C.dist({ title: 'Liquidity distribution', value: mock ? '<span class="an-num">' + esc(usdC(total)) + '</span>' : fig(mk(total, f), usdC), note: 'held within \u00b130% of the price; the chart opens at \u00b115%, + and \u2212 zoom \u00b7 ' + esc(venueW(d.venue)) + ' ' + esc(short(d.pool)),
        bands: d.bands.map(function (b) { return { lo: b.priceLow, hi: b.priceHigh, usd: b.amountUsd, side: b.side }; }), mid: d.midPrice, unit: (d.quote || '') + '/' + (d.asset || ''),
        fmtP: function (v) { return num(v, v < 10 ? 4 : 2); }, fmtY: usdC, asset: d.asset || 'asset', quote: d.quote || 'quote', plate: plate,
        aria: 'Liquidity of pool ' + short(d.pool) + ' by price band around the pool price', src: mock ? '<p class="an-meta an-figsrc">' + esc(d.source) + '</p>' : chartSrc(f, 'the distribution chart') });
      C.mount(out); check();
    }
    function draw() {
      var out = box.querySelector('[data-dist]'), addr = sel.value;
      get(R.liquidity(addr)).then(function (r) {
        if (sel.value !== addr) return;
        if (r.ok) return render(out, r.body, false);
        if (PREVIEW && FIXTURE_POOLS.indexOf(addr) >= 0) return fetch(SNAP + 'preview/' + addr + '.json').then(function (x) { return x.json(); }).then(function (d) { render(out, d, true); });
        var why = r.body && r.body.error ? r.body.error : REASON[r.reason] || r.reason;
        out.innerHTML = '<div class="cc-head"><div class="cc-title"><div class="t">Liquidity distribution</div><div class="n">' + reason(r.reason) + ': ' + esc(why) + '.' + (FIXTURE_POOLS.length ? ' Add <code>?preview=1</code> and open SPYx or QQQx to see the chart on recorded pool bytes, marked MOCK.' : '') + '</div></div></div>';
      });
    }
    sel.addEventListener('change', draw); draw();
  }

  /** Exit and entry capacity over time (GET /risk/assets/:id/history). */
  function historyCard(res) {
    if (!res || !res.ok) return '';
    var h = res.body, pts = h.points || [];
    if (!pts.length) return '';
    var sell = pts.map(function (p) { return { t: Math.floor(new Date(p.t).getTime() / H) * H, v: p.sellCapacityUsd }; }), buy = pts.map(function (p) { return { t: Math.floor(new Date(p.t).getTime() / H) * H, v: p.buyCapacityUsd }; });
    var last = pts[pts.length - 1], f = mk(last.sellCapacityUsd, { source: h.source, fetchedAt: last.t, dataFrom: h.from, regime: last.regime, method: h.method, methodVersion: h.methodVersion, quality: last.sellLowerBound ? 'lower_bound' : 'measured' });
    return '<div class="an-sec">' + card(C.time({ title: 'Exit capacity over time', value: fig(f, usdC), note: change(sell[0].v, last.sellCapacityUsd, 'since ' + day(pts[0].t)) + ' · sell area, buy line · shaded hours are the weekend',
      ranges: [{ label: '24h', ms: 24 * H }, { label: '7d', ms: D7 }], range: 1, hourly: true,
      panes: [{ h: 200, fmt: usdC, series: [{ type: 'area', cls: 's2', label: 'sell (exit)', data: sell }, { type: 'line', cls: 's1', label: 'buy (entry)', data: buy }] }],
      legend: [{ cls: 's2', label: 'sell (exit)' }, { cls: 's1', label: 'buy (entry)' }], bands: regimeBandsT(pts), aria: 'Exit and entry capacity at tau, hourly',
      src: chartSrc(mk(1, { source: h.source, fetchedAt: h.to, dataFrom: h.from, method: h.method, methodVersion: h.methodVersion }), 'the capacity chart') })) + '</div>';
  }

  /* ---------------- 4. lending pools table ---------------- */
  var L = { list: null, sheets: {}, markets: null };
  function marketName(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.market) ? 'market ' + short(s.market) : s.market; }
  function lendingTable() {
    var box = els['an-lend'];
    box.innerHTML = '<header><h2 id="an-lend-h">Lending pools that take these stocks as collateral</h2><span class="an-meta">GET /risk/facts/lending</span></header><p class="an-loading" role="status">Reading the lending sheets…</p>';
    return Promise.all([get(R.lendingList()), get(R.markets())]).then(function (rs) {
      if (!rs[0].ok) { box.querySelector('.an-loading').outerHTML = '<p>' + reason(rs[0].reason) + '</p>'; return; }
      L.list = rs[0].body; L.markets = rs[1].ok ? rs[1].body : null;
      return pool(L.list.pools.map(function (p) { return p.account; }), 6, function (acc) { return get(R.lending(acc)).then(function (r) { L.sheets[acc] = r; }); }).then(function () {
        var heads = [['Market'], ['Venue'], ['Token'], ['Supplied', 1], ['Withdrawable now', 1], ['Share lent out', 1], ['Hours above the alarm', 1], ['Supply APY', 1], ['APY variation', 1], ['Top-1 lender', 1], ['Collateral assets', 1], ['Liquidations to date', 1], ['Socialised loss', 1]];
        var rows = L.list.pools.map(function (p) {
          var r = L.sheets[p.account];
          if (!r || !r.ok) return tr(heads, ['<button type="button" class="an-rowbtn" data-lend="' + esc(p.account) + '">' + esc(p.market) + '</button>', esc(venueW(p.venue)), esc(p.symbol), reason(r ? r.reason : 'api_error'), '', '', '', '', '', '', '', '', '']);
          var s = r.body, w = s.withdrawal, rt = s.rates, h = s.history;
          return '<tr data-lend="' + esc(p.account) + '"' + (S.lending === p.account ? ' class="sel"' : '') + '>' + [
            '<button type="button" class="an-rowbtn" aria-expanded="' + (S.lending === p.account) + '" aria-controls="an-lendp">' + esc(marketName(s)) + '</button><span class="an-sub">' + esc(short(s.account)) + '</span>',
            esc(venueW(s.venue)), esc(s.symbol), fig(w.suppliedUsd, usdC), fig(w.availableUsd, usdC), fig(w.shareLentOut, pct), fig(w.hoursAboveAlarmShare, pct),
            fig(rt.supplyApy, pct), fig(rt.supplyApyVariation, pct), fig(s.lenders.top1Share, pct), esc(num((s.collateral || []).length)), fig(h.liquidations, function (v) { return num(v); }), fig(h.socialisedLossUsd, usd)
          ].map(function (c, i) { return cell(heads[i][0], c, (i === 0 ? 'first' : '') + (heads[i][1] ? ' n' : '')); }).join('') + '</tr>';
        });
        box.innerHTML = '<header><h2 id="an-lend-h">Lending pools that take these stocks as collateral</h2><span class="an-meta">GET /risk/facts/lending · report ' + esc(iso(L.list.reportAt)) + '</span></header>' +
          '<p class="an-note" style="margin-bottom:8px">Each row is one supply pool: what lenders put in, what they can take out now, and what backs the loans. Supply APY is measured over the record, never promised.</p>' +
          '<div class="an-figure" style="margin:0 0 16px"><h4>How much of each pool is lent out</h4><p class="an-note">The line is the 95% alarm: above it, less than 5% of the supply can be withdrawn.</p>' +
          C.bars(L.list.pools.map(function (p) { var r = L.sheets[p.account]; var f = r && r.ok ? r.body.withdrawal.shareLentOut : { value: null, reason: r ? r.reason : 'api_error' }; return { label: r && r.ok ? marketName(r.body) : p.market, sub: venueW(p.venue) + ' \u00b7 ' + p.symbol, value: f.value, html: fig(f, pct) }; }), { max: 1, ref: 0.95, cls: 's2' }) + '</div>' +
          table('an-lend-t', 'Lending pools', heads, rows, true);
        box.querySelectorAll('tr[data-lend], button[data-lend]').forEach(function (el) {
          el.addEventListener('click', function (e) { if (e.target.closest('.an-pin')) return; e.stopPropagation(); var a = el.getAttribute('data-lend'); location.hash = S.lending === a ? '#analytics' : '#lending=' + a; });
        });
        check();
      });
    });
  }

  /* ---------------- 5. lending panel ---------------- */
  function gapWords(f) {
    if (!f || f.value == null) return fig(f, pct);
    return fig(f, function (v) { return pct(Math.abs(v)); }) + '<span class="an-sub">' + (f.value > 0 ? 'oracle above the pool mid' : f.value < 0 ? 'oracle below the pool mid' : 'at the pool mid') + '</span>';
  }
  var ROUTE_W = { routed_dex: 'sold on the routed pools', issuer_redemption: 'issuer redemption', two_hop: 'two hops through another token', wait_for_market_open: 'wait for market open, then sell' };
  function routesFor(col, regime) {
    var rs = (col.routes || []).filter(function (r) { return r.regime === regime; });
    var measured = rs.filter(function (r) { return r.recovered.value != null && r.recovered.quality === 'measured'; }).sort(function (a, b) { return b.recovered.value - a.recovered.value; });
    var rest = rs.filter(function (r) { return measured.indexOf(r) < 0; }).sort(function (a, b) { return (b.recovered.value == null ? -1 : b.recovered.value) - (a.recovered.value == null ? -1 : a.recovered.value); });
    return measured.concat(rest);
  }
  function openLending(acc, scroll) {
    S.lending = acc;
    var box = els['an-lendp'];
    document.querySelectorAll('#an-lend tr[data-lend]').forEach(function (r) { var on = r.getAttribute('data-lend') === acc; r.classList.toggle('sel', on); var b = r.querySelector('.an-rowbtn'); if (b) b.setAttribute('aria-expanded', String(on)); });
    box.innerHTML = '<div class="an-panel"><div class="an-pb"><p class="an-loading" role="status">Reading the lending sheet…</p></div></div>';
    if (scroll !== false) box.scrollIntoView({ block: 'start' });
    return get(R.lending(acc)).then(function (r) {
      if (S.lending !== acc) return;
      if (!r.ok) { box.querySelector('.an-pb').innerHTML = '<p>' + reason(r.reason) + '</p>'; return; }
      var s = r.body;
      return Promise.all((s.collateral || []).map(function (c) { return get(R.coverage(c.asset)); })).then(function (covs) {
        var assetSheets = (s.collateral || []).map(function (c) { return get(R.sheet(c.asset, 100000)); });
        return Promise.all(assetSheets).then(function (shs) {
          if (S.lending !== acc) return;
          box.innerHTML = '<div class="an-panel an-fade" aria-labelledby="an-lendp-h"><div class="an-ph"><h2 id="an-lendp-h">' + esc(marketName(s)) + ' · ' + esc(s.symbol) + '</h2><span class="an-meta">' + esc(venueW(s.venue)) + ' · ' + explorer(s.account, 'lending account') + ' · ' + esc(s.coverage.verification) + ' · ' + esc(s.methodVersion) + '</span></div><div class="an-pb">' +
            fundingBlock(s) + '<div data-lhist></div>' + collateralBlocks(s, covs, shs) + historyBlock(s) + '</div></div>';
          C.mount(box); lendHistory(acc, box.querySelector('[data-lhist]'));
          check();
        });
      });
    });
  }
  function fundingBlock(s) {
    var w = s.withdrawal, rt = s.rates, ln = s.lenders;
    var lent = w.shareLentOut.value;
    var am = /> ?(\d+(?:\.\d+)?)% lent out/.exec(w.hoursAboveAlarmShare.source || ''), alarm = am ? +am[1] : null;
    var util = lent != null ? '<div class="an-util" role="img" aria-label="' + esc(pct(lent) + ' lent out' + (alarm ? ', alarm at ' + alarm + '%' : '')) + '"><span class="fill" style="width:' + Math.min(100, lent * 100) + '%"></span>' + (alarm ? '<span class="alarm" style="left:calc(' + alarm + '% - 1px)"></span>' : '') + '</div>' +
      '<p class="an-meta">' + (alarm ? 'The line marks the alarm at ' + alarm + '% lent out; in an hour above it, less than ' + (100 - alarm) + '% of the supply could be withdrawn.' : 'Alarm level not given by the sheet.') + '</p>' : '';
    var top = ln.top1Share.value != null && ln.top1Share.value > 0.5
      ? '<p style="margin-top:8px">One supplier holds ' + (ln.top1Share.quality === 'lower_bound' ? 'at least ' : '') + fig(Object.assign({}, ln.top1Share, { quality: 'measured' }), pct) + ' of this pool: if they withdraw, what is left for everyone else is what the borrowers repay.</p>' : '';
    return '<div><h3>Funding</h3><dl class="an-stats" style="margin:8px 0">' +
      '<div class="an-stat"><dt>Supplied</dt><dd>' + fig(w.suppliedUsd, usd) + '</dd></div>' +
      '<div class="an-stat"><dt>Available to withdraw now</dt><dd>' + fig(w.availableUsd, usd) + '</dd></div>' +
      '<div class="an-stat"><dt>Share lent out</dt><dd>' + fig(w.shareLentOut, pct) + '</dd></div>' +
      '<div class="an-stat"><dt>Hours above the alarm</dt><dd>' + fig(w.hoursAboveAlarmShare, pct) + '</dd></div>' +
      '<div class="an-stat"><dt>Supply APY · variation</dt><dd>' + fig(rt.supplyApy, pct) + ' · ' + fig(rt.supplyApyVariation, pct) + '</dd></div>' +
      '<div class="an-stat"><dt>Borrow APY</dt><dd>' + fig(rt.borrowApy, pct) + '</dd></div>' +
      '<div class="an-stat"><dt>Lenders, top 1 / 3 / 10</dt><dd>' + fig(ln.top1Share, pct) + ' / ' + fig(ln.top3Share, pct) + ' / ' + fig(ln.top10Share, pct) + '</dd></div>' +
      '</dl>' + util + top + '</div>';
  }
  function coverageRows(col, cov, sheet) {
    var rows = (cov && cov.ok && cov.body.rows) || [], byGap = {};
    rows.forEach(function (r) { byGap[r.gapPct] = r; });
    var u = sheet && sheet.ok ? unseen(sheet.body) : null;
    var heads = [['Gap'], ['Earlier ratio', 1], ['Margin ratio', 1], ['Status'], ['Limiting regime'], ['Limiting oracle'], ['Regimes missing']];
    var out = GAPS.map(function (g) {
      var r = byGap[g];
      if (!r) return tr(heads, [esc(g + '%'), reason(cov && cov.ok ? 'not_collected' : (cov && cov.reason)), '', '', '', '', '']);
      var base = { source: r.source, fetchedAt: r.fetchedAt, method: r.method, methodVersion: r.methodVersion };
      var e = r.earlierRatio == null ? { value: null, reason: r.nullReason || 'not_collected' } : mk(r.earlierRatio, Object.assign({}, base, { method: 'earlier: ' + cov.body.definitions.earlier, regime: r.earlierRegime, quality: r.lowerBound ? 'lower_bound' : 'measured' }));
      var m = r.ratio == null ? { value: null, reason: r.nullReason || 'not_collected' } : mk(r.ratio, Object.assign({}, base, { method: 'margin: ' + cov.body.definitions.margin, regime: r.regime, quality: r.lowerBound ? 'lower_bound' : 'measured' }));
      var st = r.ratio == null ? '' : r.ratio >= 1 ? status('on', 'covered') : status('off', 'short') + '<span class="an-sub">the pools absorb ' + fig(m, pct0) + ' of what becomes liquidatable</span>';
      var note = u && g >= u.gapPct ? '<span class="an-sub">' + (g === GAPS.filter(function (x) { return x >= u.gapPct; })[0] ? 'no weekend move above ' + esc(u.gapPct + '%') + ' in ' + esc(u.weekends) + ' weekends: the record has not seen this gap' : 'not seen in the record') + '</span>' : '';
      return tr(heads, [esc(g + '%'), fig(e, ratio), fig(m, ratio), st + note, esc(RW[r.regime] || r.regime || ''), esc(r.limitingOracle || ''), esc((r.regimesMissing || []).map(function (x) { return RW[x.regime || x] || x; }).join(', ') || 'none')]);
    });
    var firstShort = GAPS.map(function (g) { return byGap[g]; }).filter(function (r) { return r && r.ratio != null && r.ratio < 1; })[0];
    var anyShort = GAPS.some(function (g) { var r = byGap[g]; return !r || r.ratio == null || r.earlierRatio == null || r.ratio < 1 || r.earlierRatio < 1; });
    var say = firstShort ? '<p style="margin-top:8px">At a ' + esc(firstShort.gapPct + '%') + ' gap the pools absorb ' + fig(mk(firstShort.ratio, { source: firstShort.source, fetchedAt: firstShort.fetchedAt, method: 'margin: ' + cov.body.definitions.margin, methodVersion: firstShort.methodVersion, regime: firstShort.regime }), pct0) + ' of what becomes liquidatable: the rest has no buyer at a margin a liquidator would take.' + (u && firstShort.gapPct >= u.gapPct ? ' The record has not seen a weekend move that large for ' + esc(col.asset) + '.' : '') + '</p>'
      : rows.length && !anyShort ? '<p style="margin-top:8px">At every gap up to 30% the pools absorb at least what becomes liquidatable, on both ratios.</p>' : '';
    var cvChart = rows.length ? '<div class="an-card" style="margin:8px 0">' + C.cols({ title: 'Coverage by price gap', note: 'capacity \u00f7 what becomes liquidatable; at or above the line the pools absorb it all',
      cats: GAPS.map(function (g) { return g + '%'; }), log: true, fmt: ratio, ref: { v: 1, label: 'covered' },
      series: [{ label: 'earlier ratio', cls: 's2', values: GAPS.map(function (g) { return byGap[g] ? byGap[g].earlierRatio : null; }) }, { label: 'margin ratio', cls: 's1', values: GAPS.map(function (g) { return byGap[g] ? byGap[g].ratio : null; }) }],
      aria: 'Coverage ratio by price gap for ' + col.asset, src: chartSrc(mk(1, { source: rows[0].source, fetchedAt: rows[0].fetchedAt, method: rows[0].method, methodVersion: rows[0].methodVersion }), 'the coverage chart') }) + '</div>' : '';
    return '<h4 style="margin-top:12px">How covered it is</h4><p class="an-note" style="margin:4px 0 8px">Coverage is capacity ÷ the collateral that becomes liquidatable at that gap, across every market that takes ' + esc(col.asset) + ' (the pools are shared). The earlier ratio counts sales that cost at most the bonus; the margin ratio counts sales a liquidator keeps a margin on, at each regime’s oracle gap.</p>' +
      cvChart + table('an-cv-' + col.asset, 'Coverage by gap, ' + col.asset, heads, out, true) + say;
  }
  function collateralBlocks(s, covs, shs) {
    var cols = s.collateral || [];
    if (!cols.length) return '<div class="an-sec"><h3>Collateral</h3><p class="an-note">' + reason('not_collected') + '</p></div>';
    return '<div class="an-sec"><h3>Collateral</h3><p class="an-note" style="margin-top:4px">' + esc(cols.length) + ' collateral asset' + (cols.length > 1 ? 's' : '') + ' back the loans in this pool. Oracle gap is the venue’s oracle against the routed pool mid, median by regime.</p>' +
      cols.map(function (c, i) {
        var og = {}; (c.oracleGap || []).forEach(function (g) { og[g.regime] = g.gap; });
        var rh = [['Regime'], ['Best route'], ['Recovered', 1], ['Liquidator margin', 1], ['Alternatives']];
        var rrows = REGIMES.map(function (r) {
          var rs = routesFor(c, r), b = rs[0];
          if (!b) return tr(rh, [esc(RW[r]), reason('not_collected'), '', '', '']);
          var alt = rs.slice(1).map(function (x) { return esc(ROUTE_W[x.route] || x.route) + ': ' + (x.recovered.value != null ? fig(x.recovered, pct) : reason(x.recovered.reason)); }).join('<br>');
          return tr(rh, [esc(RW[r]), esc(ROUTE_W[b.route] || b.route) + (b.recovered.quality !== 'measured' ? '<span class="an-sub">no measured route in this regime</span>' : ''), fig(b.recovered, pct), fig(b.liquidatorMargin, pct), alt]);
        });
        var ob = c.observed || {};
        var seized = rrows.length ? ((c.routes || [])[0] || {}).seizedUsd : null;
        return '<div class="an-tile" style="margin-top:12px"><div class="an-bhead">' + esc(c.asset) + ' as collateral</div>' +
          '<dl class="an-stats" style="margin:8px 0"><div class="an-stat"><dt>Collateral</dt><dd>' + fig(c.collateralUsd, usd) + '</dd></div><div class="an-stat"><dt>Liquidation threshold</dt><dd>' + fig(c.liquidationThreshold, pct) + '</dd></div><div class="an-stat"><dt>Liquidation bonus</dt><dd>' + fig(c.liquidationBonus, pct) + '</dd></div>' +
          REGIMES.map(function (r) { return '<div class="an-stat"><dt>Oracle gap, ' + esc(RW[r]) + '</dt><dd>' + gapWords(og[r]) + '</dd></div>'; }).join('') + '</dl>' +
          coverageRows(c, covs[i], shs[i]) +
          '<h4 style="margin-top:12px">The best path for a liquidation of ' + esc(usd(seized || 100000)) + '</h4><p class="an-note" style="margin:4px 0 8px">The route with the highest recovered value is chosen among measured routes. A route resting on an assumption, such as issuer redemption, is shown beside it and never chosen over a measured one.</p>' +
          table('an-rt-' + c.asset + i, 'Liquidation routes by regime, ' + c.asset, rh, rrows, true) +
          '<h4 style="margin-top:12px">What liquidations actually did</h4><dl class="an-stats" style="margin:8px 0"><div class="an-stat"><dt>Liquidations of ' + esc(c.asset) + ' here</dt><dd>' + fig(ob.liquidations, function (v) { return num(v); }) + '</dd></div><div class="an-stat"><dt>Sold in the same transaction</dt><dd>' + fig(ob.soldInSameTxShare, pct) + '</dd></div><div class="an-stat"><dt>Realised price against the pool mid</dt><dd>' + fig(ob.realisedVsMid, pct) + '</dd></div></dl>' +
          '<p class="an-note">The sheet does not carry the largest seizure or what happened to the stock after a liquidation that was not sold in the same transaction; large liquidations rest on the simulation below.</p></div>';
      }).join('') + '</div>';
  }
  function historyBlock(s) {
    var h = s.history, ms = (L.markets && L.markets.markets) || [];
    var mine = ms.filter(function (m) { return m.account === s.account || (m.venue === s.venue && m.market === s.market && m.asset !== s.symbol); });
    var mh = [['Asset'], ['LTV', 1], ['Liquidation threshold', 1], ['Bonus', 1], ['Close factor', 1], ['Other venues, LTV'], ['Read']];
    var disp = {}; ((L.markets && L.markets.dispersion) || []).forEach(function (d) { disp[d.asset] = d; });
    var mrows = mine.map(function (m) {
      var p = m.params || {}, base = { source: m.source, fetchedAt: m.fetchedAt, method: m.method, methodVersion: m.verification };
      var bonus = p.liquidationBonusMin != null ? mk(p.liquidationBonusMin, base) : { value: null, reason: 'not_served' };
      var d = disp[m.asset];
      return tr(mh, [esc(m.asset), fig(mk(p.ltv, base), pct), fig(mk(p.liquidationThreshold, base), pct),
        fig(bonus, pct) + (p.liquidationBonusMax != null && p.liquidationBonusMax !== p.liquidationBonusMin ? '<span class="an-sub">up to ' + fig(mk(p.liquidationBonusMax, base), pct) + '</span>' : ''),
        fig(p.closeFactor != null ? mk(p.closeFactor, base) : { value: null, reason: 'not_served', detail: 'the market route does not carry a close factor for this market' }, pct),
        d ? d.venues.map(function (v) { return esc(venueW(v.venue)) + ' ' + fig(mk(v.ltv, { source: 'GET /risk/markets dispersion (' + v.market + ')', fetchedAt: m.fetchedAt, method: 'reserve LTV as read', methodVersion: v.verification }), pct0); }).join(' \u00b7 ') : '', esc(m.verification)]);
    });
    return '<div class="an-sec"><h3>History</h3><dl class="an-stats" style="margin:8px 0">' +
      '<div class="an-stat"><dt>Liquidations</dt><dd>' + fig(h.liquidations, function (v) { return num(v); }) + '</dd></div>' +
      '<div class="an-stat"><dt>Liquidated</dt><dd>' + fig(h.liquidatedUsd, usd) + '</dd></div>' +
      '<div class="an-stat"><dt>Socialised loss</dt><dd>' + fig(h.socialisedLossUsd, usd) + '</dd></div>' +
      '<div class="an-stat"><dt>Parameter changes, 30 days</dt><dd>' + fig(h.parameterChanges30d, function (v) { return num(v); }) + '</dd></div></dl>' +
      '<p class="an-meta">record ' + esc(iso(s.coverage.dataFrom)) + ' to ' + esc(iso(s.coverage.dataTo)) + '</p>' +
      (mrows.length ? '<div style="margin-top:12px">' + table('an-mk-t', 'The market’s parameters (GET /risk/markets)', mh, mrows, true) + '</div>' : '') + '</div>';
  }

  /** Supplied, borrowed, utilisation and rates over time (GET /risk/facts/lending/:account/history), DefiLlama-style cards. */
  function lendHistory(acc, box) {
    if (!box) return;
    get(R.lendHistory(acc)).then(function (r) {
      if (S.lending !== acc) return;
      if (!r.ok) { box.innerHTML = '<p class="an-note">Over time: ' + reason(r.reason) + '</p>'; return; }
      var h = r.body, pts = h.points || [];
      if (!pts.length) { box.innerHTML = ''; return; }
      function ser(k) { return pts.map(function (p) { return { t: new Date(p.t).getTime(), v: p[k] }; }); }
      function f(k, p) { return mk(p[k], { source: h.source, fetchedAt: p.t, dataFrom: h.from, method: h.method, methodVersion: h.methodVersion }); }
      var last = pts[pts.length - 1], first = pts[0], hourly = h.resolution !== 'day';
      var ranges = [{ label: '30d', ms: 30 * 864e5 }, { label: '90d', ms: 90 * 864e5 }, { label: '1y', ms: null }];
      var src = chartSrc(mk(1, { source: h.source, fetchedAt: h.to, dataFrom: h.from, method: h.method, methodVersion: h.methodVersion }), 'the lending charts');
      var rates = pts.map(function (p) { return Math.max(p.supplyApy || 0, p.borrowApy || 0); }).sort(function (a, b) { return a - b; });
      var p95 = rates[Math.floor(rates.length * 0.95)] || 0, top = rates[rates.length - 1] || 0, cap = top > 2.5 * p95 && p95 > 0 ? Math.max(0.05, 2 * p95) : null;
      var spike = cap ? pts.filter(function (p) { return Math.max(p.supplyApy || 0, p.borrowApy || 0) === top; })[0] : null;
      box.innerHTML = '<div class="an-sec"><div class="an-cards">' +
        card(C.time({ title: 'Supplied', value: fig(f('suppliedUsd', last), usdC), note: change(first.suppliedUsd, last.suppliedUsd, 'since ' + day(first.t)) + ' · borrowed: ' + fig(f('borrowedUsd', last), usdC),
          ranges: ranges, range: 2, hourly: hourly, panes: [{ h: 200, fmt: usdC, series: [{ type: 'area', cls: 's1', label: 'supplied', data: ser('suppliedUsd') }, { type: 'line', cls: 's2', label: 'borrowed', data: ser('borrowedUsd') }] }],
          legend: [{ cls: 's1', label: 'supplied' }, { cls: 's2', label: 'borrowed' }], aria: 'Supplied and borrowed over time' })) +
        card(C.time({ title: 'Share lent out', value: fig(f('shareLentOut', last), pct), note: 'above the 95% line, less than 5% of the supply can be withdrawn',
          ranges: ranges, range: 2, hourly: hourly, panes: [{ h: 200, fmt: pct0, max: 1, refs: [{ v: 0.95, label: 'alarm 95%' }], series: [{ type: 'area', cls: 's2', label: 'lent out', data: ser('shareLentOut') }] }], aria: 'Share lent out over time' })) +
        card(C.time({ title: 'Supply APY', value: fig(f('supplyApy', last), pct), note: 'measured, not promised · borrow APY ' + fig(f('borrowApy', last), pct) + (spike ? ' · the axis stops at ' + esc(pct(cap)) + '; on ' + esc(day(spike.t)) + ' borrow APY read ' + fig(f('borrowApy', spike), pct) : ''),
          ranges: ranges, range: 2, hourly: hourly, panes: [{ h: 200, fmt: pct, max: cap || undefined, series: [{ type: 'area', cls: 's1', label: 'supply APY', data: ser('supplyApy') }, { type: 'line', cls: 's2', label: 'borrow APY', data: ser('borrowApy') }] }],
          legend: [{ cls: 's1', label: 'supply APY' }, { cls: 's2', label: 'borrow APY' }], aria: 'Supply and borrow APY over time' })) +
        '</div>' + src + '</div>';
      C.mount(box); check();
    });
  }

  /* ---------------- 6. liquidation simulator ---------------- */
  function simSection() {
    var box = els['an-sim'];
    var opts = [];
    Object.keys(L.sheets).forEach(function (acc) { var r = L.sheets[acc]; if (r && r.ok && (r.body.collateral || []).length) opts.push(r.body); });
    if (!opts.length) { box.innerHTML = '<header><h2 id="an-sim-h">If someone were liquidated now</h2></header><p>' + reason('api_error') + '</p>'; return; }
    var now = regimeAt(new Date());
    var def = opts.filter(function (s) { return s.market === 'xStocks Market' && s.symbol === 'USDC'; })[0] || opts[0];
    box.innerHTML = '<header><h2 id="an-sim-h">If someone were liquidated now</h2><span class="an-meta">computed in this page with the published method · POST /risk/markets/:account/gap</span></header>' +
      '<div class="an-panel"><div class="an-pb"><form id="an-simf" class="an-controls" style="margin:0" onsubmit="return false">' +
      '<label class="an-field"><span>Lending market</span><select id="sim-m">' + opts.map(function (s) { return '<option value="' + esc(s.account) + '"' + (s === def ? ' selected' : '') + '>' + esc(marketName(s) + ' · ' + s.symbol) + '</option>'; }).join('') + '</select></label>' +
      '<label class="an-field"><span>Collateral</span><select id="sim-a"></select></label>' +
      '<label class="an-field"><span>Seized, USD</span><input id="sim-n" type="number" inputmode="numeric" min="100" step="1000" value="100000" style="width:12ch"></label>' +
      '<label class="an-field"><span>Regime</span><select id="sim-r">' + REGIMES.map(function (r) { return '<option value="' + r + '"' + (r === now ? ' selected' : '') + '>' + esc(RW[r] + (r === now ? ' (now)' : '')) + '</option>'; }).join('') + '</select></label>' +
      '<label class="an-field"><span>Extra price gap</span><select id="sim-g"><option value="0">none</option>' + GAPS.map(function (g) { return '<option value="' + g + '">' + g + '%</option>'; }).join('') + '</select></label>' +
      '</form><p class="an-meta" style="margin-top:8px">Now is ' + esc(etParts(new Date()).label) + ', ' + esc(RW[now]) + ' by the API’s rule (weekend from Friday 20:00 to Sunday 20:00 ET; market hours 09:30–16:00 ET on trading days; holidays from the NYSE calendar).</p>' +
      '<div class="an-sim-out" id="sim-out" aria-live="polite"></div></div></div>';
    var m = document.getElementById('sim-m'), a = document.getElementById('sim-a');
    function fillAssets() {
      var s = L.sheets[m.value].body, cur = a.value;
      a.innerHTML = s.collateral.map(function (c) { return '<option' + (c.asset === cur ? ' selected' : '') + '>' + esc(c.asset) + '</option>'; }).join('');
    }
    fillAssets();
    m.addEventListener('change', function () { fillAssets(); runSim(); });
    ['sim-a', 'sim-r', 'sim-g'].forEach(function (id) { document.getElementById(id).addEventListener('change', runSim); });
    var t; document.getElementById('sim-n').addEventListener('input', function () { clearTimeout(t); t = setTimeout(runSim, 350); });
    runSim();
  }
  var simSeq = 0;
  function runSim() {
    var seq = ++simSeq, out = document.getElementById('sim-out');
    var s = L.sheets[document.getElementById('sim-m').value].body, asset = document.getElementById('sim-a').value;
    var n = Math.round(+document.getElementById('sim-n').value), regime = document.getElementById('sim-r').value, g = +document.getElementById('sim-g').value / 100;
    var col = s.collateral.filter(function (c) { return c.asset === asset; })[0];
    if (!(n > 0)) { out.innerHTML = '<p>Enter the seized size in dollars.</p>'; return; }
    out.innerHTML = '<p class="an-loading">Reading the exit cost for ' + esc(usd(n)) + ' of ' + esc(asset) + '…</p>';
    var mk2 = ((L.markets && L.markets.markets) || []).filter(function (x) { return x.asset === asset && (x.account === s.account || (x.venue === s.venue && x.market === s.market)); })[0];
    Promise.all([get(R.sheet(asset, n)), g > 0 && mk2 ? post(R.gap(mk2.account), { gapPct: g }) : Promise.resolve(null)]).then(function (rs) {
      if (seq !== simSeq) return;
      var b = col.liquidationBonus, og = (col.oracleGap.filter(function (x) { return x.regime === regime; })[0] || {}).gap;
      var cRow = rs[0].ok ? rs[0].body.costs.filter(function (x) { return x.regime === regime; })[0] : null, c = cRow ? cRow.exit.total : null;
      var lines = '<div class="an-inputs"><div>bonus b = ' + fig(b, pct) + ' (' + esc(asset) + ' in ' + esc(marketName(s)) + ')</div>' +
        '<div>oracle gap, ' + esc(RW[regime]) + ' = ' + fig(og, pct) + ' (oracle ÷ pool mid − 1, so P_m / P_o = 1 ÷ (1 + gap))</div>' +
        '<div>exit cost c(' + esc(usd(n)) + ', ' + esc(RW[regime]) + ') = ' + (c ? fig(c, pct) : reason(rs[0].reason)) + ' (routed pools, GET /risk/facts/assets/' + esc(asset) + '?sizeUsd=' + n + ')</div>' +
        (g > 0 ? '<div>extra price gap g = ' + esc(pct(g)) + ': the pool falls by g while the oracle has not moved, so P_m / P_o = (1 − g) ÷ (1 + gap). This step is this page’s assumption, not a measured fact.</div>' : '') +
        '<div>margin = (1 + b) × (P_m / P_o) × (1 − c) − 1 · the methodology’s “Liquidator margin”</div></div>';
      var gapView = gapBlock(rs[1], g, mk2, asset);
      if (!rs[0].ok) { out.innerHTML = '<p>The exit cost at ' + esc(usd(n)) + ' is ' + reason(rs[0].reason) + (S.mode === 'snapshot' ? ': the snapshot holds $10k, $50k, $100k and $250k.' : '.') + ' Nothing else is computed: the simulator never extrapolates a curve.</p>' + lines + gapView; return; }
      if (!c || c.value == null || !og || og.value == null || b.value == null) {
        var why = !c || c.value == null ? 'the exit cost at ' + usd(n) + ' in ' + RW[regime] + ' is ' + (REASON[c && c.reason] || 'not served') : og == null || og.value == null ? 'the oracle gap in ' + RW[regime] + ' is ' + (REASON[og && og.reason] || 'not served') : 'the bonus is ' + REASON[b.reason];
        out.innerHTML = '<p class="an-verdict">No margin for this row: ' + esc(why) + '. The simulator never extrapolates a curve.</p>' + lines + gapView; check(); return;
      }
      var x = (1 - g) / (1 + og.value), margin = (1 + b.value) * x * (1 - c.value) - 1;
      var proceeds = n * x * (1 - c.value), debt = n / (1 + b.value);
      var lb = c.quality === 'lower_bound' ? ' (a lower bound: the exit cost is one)' : '';
      var q = g > 0 ? 'assumption' : c.quality === 'lower_bound' ? 'lower_bound' : 'measured';
      var calc = { source: 'computed in this page from the inputs below', fetchedAt: c.fetchedAt, method: 'margin = (1 + b) \u00d7 (P_m / P_o) \u00d7 (1 \u2212 c) \u2212 1; dollars = margin \u00d7 the debt repaid, seized \u00f7 (1 + b)', methodVersion: s.methodVersion, quality: q, regime: regime, sizeUsd: n };
      var calcM = Object.assign({}, calc, { quality: g > 0 ? 'assumption' : 'measured' });   /* a margin on a lower-bound cost is an upper bound: said in words below */
      var verdict = margin >= 0
        ? 'A liquidator keeps ' + fig(mk(margin, calcM), pct) + ' (' + fig(mk(margin * debt, calcM), usd) + ' on ' + esc(usd(debt)) + ' of debt repaid) after selling ' + esc(usd(n)) + ' of ' + esc(asset) + ' on the routed pools in ' + esc(RW[regime]) + '.'
        : 'A liquidator loses ' + fig(mk(-margin, calcM), pct) + ' (' + fig(mk(-margin * debt, calcM), usd) + ' on ' + esc(usd(debt)) + ' of debt repaid): the bonus does not cover the sale. The position is not liquidated and the shortfall falls on the lenders.';
      var lender = margin < 0
        ? '<p style="margin-top:8px">Loss to the lenders, if they had to sell it themselves: the seized value at the oracle, ' + fig(mk(n, calcM), usd) + ', less what the sale returns, ' + fig(mk(proceeds, calcM), usd) + ', is ' + fig(mk(n - proceeds, calc), usd) + lb + '; against the debt it repays, ' + fig(mk(debt, calcM), usd) + ', the shortfall is ' + fig(mk(debt - proceeds, calc), usd) + '.</p>' : '';
      var alts = routesFor(col, regime).filter(function (r) { return r.route !== 'routed_dex'; });
      var altH = '<p class="an-note" style="margin-top:8px">Other routes, from the lending sheet at ' + esc(usd(((col.routes || [])[0] || {}).seizedUsd || 100000)) + ': ' + (alts.map(function (r) { return esc(ROUTE_W[r.route] || r.route) + ' ' + (r.liquidatorMargin.value != null ? fig(r.liquidatorMargin, pct) : reason(r.liquidatorMargin.reason)); }).join(' · ') || 'none') + '. A route resting on an assumption is never chosen over a measured one.</p>';
      out.innerHTML = '<p class="an-verdict">' + verdict + '</p>' + lender + '<p style="margin-top:8px">Routed pools: margin ' + fig(mk(margin, calcM), pct) + ' \u00b7 ' + fig(mk(margin * debt, calcM), usd) + ' on ' + esc(usd(n)) + ' seized, ' + esc(usd(debt)) + ' of debt repaid' + (c.quality === 'lower_bound' ? '; the exit cost is a lower bound, so the margin can only be lower' : '') + '.</p>' + altH + lines + gapView;
      check();
    });
  }
  function gapBlock(res, g, m, asset) {
    if (!(g > 0)) return '<p class="an-note" style="margin-top:12px">Pick an extra price gap to see what it does to every ' + esc(asset) + ' position in this market.</p>';
    if (!m) return '<p class="an-note" style="margin-top:12px">Market-wide view: ' + reason('not_served') + ' for this market.</p>';
    if (!res || !res.ok) return '<p class="an-note" style="margin-top:12px">Market-wide view at a ' + esc(pct0(g)) + ' gap: ' + reason(res ? res.reason : 'api_error') + (res && res.body && res.body.error ? ' (' + esc(res.body.error) + ')' : '') + '.</p>';
    var r = res.body, ag = r.aggregate || {};
    var base = { source: 'POST /risk/markets/:account/gap; ' + (r.assumptions[0] || ''), fetchedAt: ag.priceAt, method: 'gap simulator: one aggregate position at the average LTV', methodVersion: r.verification };
    var cov = r.seizedCollateralUsd > 0 ? fig(mk(r.recoverableOfSeizedUsd / r.seizedCollateralUsd, base), pct) + ' of the seized collateral can be sold' : 'nothing becomes liquidatable at this gap on the average position';
    return '<div style="margin-top:16px"><h4>The whole market at a ' + esc(pct0(g)) + ' gap</h4><dl class="an-stats" style="margin:8px 0">' +
      '<div class="an-stat"><dt>' + esc(asset) + ' collateral</dt><dd>' + fig(mk(ag.collateralUsd, base), usdC) + '</dd></div>' +
      '<div class="an-stat"><dt>Debt against it</dt><dd>' + fig(mk(ag.debtUsd, base), usdC) + '</dd></div>' +
      '<div class="an-stat"><dt>Becomes liquidatable (debt)</dt><dd>' + fig(mk(r.liquidatableDebtUsd, base), usdC) + '</dd></div>' +
      '<div class="an-stat"><dt>Collateral seized</dt><dd>' + fig(mk(r.seizedCollateralUsd, base), usdC) + '</dd></div>' +
      '<div class="an-stat"><dt>The pools can absorb</dt><dd>' + fig(mk(r.recoverableOfSeizedUsd, base), usdC) + '</dd></div>' +
      '<div class="an-stat"><dt>Not liquidatable while closed (debt)</dt><dd>' + fig(mk(r.unliquidatableWhileClosedDebtUsd, base), usdC) + '</dd></div></dl>' +
      '<p>Coverage: ' + cov + '.</p><ul class="an-list an-meta" style="margin-top:8px">' + r.assumptions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
  }

  /* ---------------- 7. methodology, disclaimer, freshness, what is coming ---------------- */
  function md(src) {
    var lines = src.split('\n'), out = '', depth = 0;
    function inline(t) { return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); }
    lines.forEach(function (l) {
      var m = /^(\s*)- (.*)$/.exec(l);
      if (m) {
        var d = Math.floor(m[1].length / 2) + 1;
        while (depth < d) { out += '<ul>'; depth++; }
        while (depth > d) { out += '</ul>'; depth--; }
        out += '<li>' + inline(m[2]) + '</li>'; return;
      }
      while (depth > 0) { out += '</ul>'; depth--; }
      if (/^## /.test(l)) out += '<h3 id="an-method-h">' + inline(l.slice(3)) + '</h3>';
      else if (l.trim()) out += '<p style="margin:8px 0">' + inline(l) + '</p>';
    });
    while (depth > 0) { out += '</ul>'; depth--; }
    return out;
  }
  function methodSection() {
    return get(R.methodology()).then(function (r) {
      var box = els['an-method'];
      box.innerHTML = '<div class="an-method">' + (r.ok ? md(r.body.markdown) : '<h3 id="an-method-h">Methods</h3><p>' + reason(r.reason) + '</p>') + '</div>' +
        '<aside class="an-disclaimer" aria-label="Disclaimer" lang="en"><h3>Not advice</h3><p>' + esc(DISCLAIMER) + '</p></aside>';
    });
  }
  function footer() {
    var sample = A.rows[0] ? get(R.sheet(A.rows[0].symbol, 100000)) : Promise.resolve({ ok: false });
    return sample.then(function (sr) {
      var s = sr.ok ? sr.body : null, lend = L.list;
      var lendTo = null; Object.keys(L.sheets).forEach(function (k) { var r = L.sheets[k]; if (r && r.ok && r.body.coverage.dataTo && (!lendTo || r.body.coverage.dataTo > lendTo)) lendTo = r.body.coverage.dataTo; });
      var fh = [['Source'], ['Last read'], ['Age'], ['Cadence']];
      function rowF(name, t, cad) { return tr(fh, [esc(name), t ? esc(iso(t)) : reason('not_served'), t ? esc(age(t).short) : '', esc(cad)]); }
      var rows = [
        rowF('Pool collectors (cost curves)', A.lastRun, 'pools every 5 minutes, curves hourly'),
        rowF('Lending import (pool snapshots)', lendTo, 'hourly'),
        rowF('Lending report (coverage, routes)', lend && lend.reportAt, 'hourly'),
        rowF('Reference prices (market risk)', s && s.marketRisk && s.marketRisk.volatilityAnnual.fetchedAt, 'hourly price, daily closes'),
        rowF('LP positions', s && s.liquidityStability && s.liquidityStability.lpExitCost.fetchedAt, 'hourly')
      ];
      var coming = [
        ['Volume per pool, turnover against depth, net sell pressure, holder concentration and where the token sits (wallets, lending, pools)', 'not_collected', 'item 16'],
        ['LP owners behind the position NFTs, so one owner in several pools is seen', 'not_collected', 'item 15 part 3, Mon Oct 5'],
        ['Issuer mint and burn history, replacing the issuer-route assumption', 'not_collected', 'item 14'],
        ['Measured exit cost for USDY, syrupUSDC, USDT, and the Kamino USDC supply leg as a lending sheet', 'not_collected', 'item 17'],
        ['Tracking against the real share price, and a gap history longer than one year', 'no_external_source', 'D19'],
        ['A plan’s facts for a set of positions: concentration, joint exit cost with shared routes flagged, stress table (POST /risk/facts/plan)', 'not_applicable', 'the plan view, not this page']
      ];
      els['an-foot'].innerHTML = '<h2>How fresh each source is</h2>' + '<div style="margin-top:8px">' + table('an-fresh-t', 'Freshness by source', fh, rows, true) + '</div>' +
        '<p class="an-meta" style="margin-top:8px">Method versions: curves risk-0.3 · sheets facts-0.1 · lending report lending-report-0.2 · pools pools-0.1 · prices prices-0.1 · recovery recovery-0.1 · network fee netfee-0.1. Cadence: 5-minute pools, hourly curves, hourly lending import.</p>' +
        '<h2 style="margin-top:32px">What is coming</h2><ul class="an-list" style="margin-top:8px">' + coming.map(function (c) { return '<li>' + esc(c[0]) + ' · ' + reason(c[1]) + ' <span class="an-meta">(' + esc(c[2]) + ')</span></li>'; }).join('') + '</ul>' +
        '<p class="an-meta" style="margin-top:24px">tenonfi · Bearing analytics · prototype on the design branch. Every figure on this view is measured by the collectors or computed from those measurements by a stated method; none is MOCK, and none is a promise.</p>';
      check();
    });
  }

  /* ---------------- DOM check (?check=1): every figure has a pin, nothing is hatched ---------------- */
  var checkT;
  function check() {
    if (!CHECK) return;
    clearTimeout(checkT);
    checkT = setTimeout(function () {
      var nums = view.querySelectorAll('.an-num'), noPin = 0;
      nums.forEach(function (n) { var nx = n.nextElementSibling; if (nx && nx.classList.contains('an-pin')) return; var m = n.closest('.an-cc'); if (m && m.querySelector('.an-mockplate')) return; noPin++; });   /* a MOCK figure has no pin, by the spec: its block carries the plate */
      var hatch = view.querySelectorAll('.tf-hatch, .hatch, .mock, .mock-band, [class*="hatch"]').length + [].filter.call(view.querySelectorAll('.an-mockband'), function (b) { return !b.parentNode.querySelector('.an-mockplate'); }).length;
      var reasons = view.querySelectorAll('.an-reason').length, stale = view.querySelectorAll('.an-pin.stale').length;
      console.log('[analytics check] figures ' + nums.length + ' · pins ' + view.querySelectorAll('.an-pin').length + ' · figures without a pin ' + noPin + ' · hatched elements ' + hatch + ' · reasons ' + reasons + ' · stale pins ' + stale + ' · mode ' + S.mode);
      if (noPin || hatch) console.error('[analytics check] FAILED');
    }, 400);
  }

  /* ---------------- routing: #analytics, #asset=X, #lending=ACCOUNT; #top returns to the landing ---------------- */
  var started = null;
  function start() {
    if (started) return started;
    shell();
    started = ready().then(function () {
      if (S.mode === 'none') { els['an-banner'].className = 'an-banner'; els['an-banner'].innerHTML = '<b>Neither the API at ' + esc(API) + ' nor the snapshot answered.</b><span>Start the API (docs/risk/PROMPT-BUILD-ANALYTICS-PAGE.md) or serve this folder over HTTP.</span>'; return; }
      return Promise.all([get(R.assets(S.tau)), get(R.pools())]).then(function (rs) {
        if (rs[1].ok) rs[1].body.pools.forEach(function (p) { A.nPools++; if (!A.poolTimes[p.assetMint] || p.fetchedAt > A.poolTimes[p.assetMint]) A.poolTimes[p.assetMint] = p.fetchedAt; });
        if (rs[0].ok) header(rs[0].body);
        return Promise.all([assetTable(), lendingTable().then(simSection), methodSection()]).then(footer);
      });
    });
    return started;
  }
  function route() {
    var h; try { h = decodeURIComponent(location.hash || ''); } catch (e) { h = location.hash || ''; }
    var open = h === '#analytics' || h.indexOf('#asset=') === 0 || h.indexOf('#lending=') === 0;
    var was = document.body.classList.contains('an-open');
    document.body.classList.toggle('an-open', open);
    view.hidden = !open;
    var link = document.querySelector('.menu a[href="#analytics"]'); if (link) { if (open) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
    if (!open) {
      closePop(false);
      if (was) { if (!h || h === '#top') window.scrollTo(0, 0); else { var t = document.getElementById(h.slice(1)); if (t) t.scrollIntoView(); } window.dispatchEvent(new Event('resize')); if (window.TF_RESUME_SCENE) { var f = window.TF_RESUME_SCENE; window.TF_RESUME_SCENE = null; requestAnimationFrame(f); } }
      window.dispatchEvent(new Event('scroll'));
      return;
    }
    window.dispatchEvent(new Event('scroll'));
    if (!was) window.scrollTo(0, 0);
    start().then(function () {
      if (h.indexOf('#asset=') === 0) { var id = h.slice(7); if (S.asset !== id) openAsset(id); }
      else if (h === '#analytics' && S.asset) { S.asset = null; els['an-asset'].innerHTML = ''; document.querySelectorAll('#an-at tr.sel').forEach(function (r) { r.classList.remove('sel'); var b = r.querySelector('.an-rowbtn'); if (b) b.setAttribute('aria-expanded', 'false'); }); }
      if (h.indexOf('#lending=') === 0) { var acc = h.slice(9); if (S.lending !== acc) openLending(acc); }
      else if (h === '#analytics' && S.lending) { S.lending = null; els['an-lendp'].innerHTML = ''; document.querySelectorAll('#an-lend tr.sel').forEach(function (r) { r.classList.remove('sel'); }); }
    });
  }
  /* One API detection for both views; Analytics 2.0 (analytics2.js) reads through the same cache and pins. */
  var modeP = null;
  function ready() { return modeP || (modeP = detectMode()); }
  window.TF_AN = { Q: Q, API: API, S: S, R: R, CAL: CAL, REASON: REASON, REGIMES: REGIMES, RW: RW, DISCLAIMER: DISCLAIMER,
    ready: ready, get: get, post: post, pool: pool, mk: mk, fig: fig, pin: pin, reason: reason, status: status, closePop: closePop,
    pct: pct, pct0: pct0, usd: usd, usdC: usdC, num: num, ratio: ratio, esc: esc, iso: iso, hhmm: hhmm, day: day, short: short, age: age,
    venueW: venueW, explorer: explorer, regimeAt: regimeAt, etParts: etParts, minus: minus, nf: nf };

  function boot() {
    view = document.getElementById('analytics');
    if (!view) return;
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
