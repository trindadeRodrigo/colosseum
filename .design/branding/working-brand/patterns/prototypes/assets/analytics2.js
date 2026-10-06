/* Bearing analytics 2.0 for the landing prototype (hero-3d.html, #analytics2/<page>).
   The same data as the first analytics view, laid out as pages behind a retractable side menu: stocks, commodities,
   stablecoins, lending and a simulation. Each page has one row of counters, one chart with a metric selector and
   24 h / 7 d / 30 d ranges, a pie of value by pool, and the table. Asset and pool filters (all selected by default)
   drive every block on the page.
   It reads through analytics.js (window.TF_AN): one API detection, one cache, the same pins, reasons and stale state.
   Nothing here is MOCK except the liquidity-distribution preview (?preview=1), which carries the plate.
   Derived figures (sums, the covered share, the best path) are computed in the browser from served facts; each one's
   pin names the facts and the formula. Counts and the person's own input carry no pin (class a2-count). */
(function () {
  'use strict';
  var T = window.TF_AN, C = window.TF_CHARTS;
  if (!T || !C) return;
  var esc = T.esc, fig = T.fig, mk = T.mk, reason = T.reason, get = T.get, pct = T.pct, usd = T.usd, num = T.num, iso = T.iso, RW = T.RW, REGIMES = T.REGIMES, S = T.S;
  var TAU = 0.01, H = 3600e3, DAY = 864e5;
  var CHECK = T.Q.get('check') === '1';
  var COMMODITIES = ['GLDx'];
  /* Stablecoins the registry lists but the collectors do not measure yet (item 17): shown with their reason. */
  var STABLE_OTHER = ['USDY', 'syrupUSDC', 'USDT'];
  var STABLE = /^(USDC|USDG|PYUSD|USDT|USDS|EURC|EUROP|JupUSD|USDe|USD1|FDUSD|DAI)$/;
  var RANGES = [{ label: '24 h', ms: DAY }, { label: '7 d', ms: 7 * DAY }, { label: '30 d', ms: 30 * DAY }];
  var PAGES = [
    { id: 'stocks', label: 'Stocks', mark: 'St', kind: 'dex', lede: 'What it costs to leave a stock, and how much the pools can take.' },
    { id: 'commodities', label: 'Commodities', mark: 'Co', kind: 'dex', lede: 'What it costs to leave gold, and how much the pools can take.' },
    { id: 'stablecoins', label: 'Stablecoins', mark: 'Sc', kind: 'stable', lede: 'How much of each stablecoin is lent out, and how much you could withdraw now.' },
    { id: 'lending', label: 'Lending', mark: 'Le', kind: 'lend', lede: 'If the collateral had to be sold today, how much of it the pools would take.' },
    { id: 'simulation', label: 'Simulation', mark: 'Si', kind: 'sim', lede: 'Sell a position now: what you would lose, and the best way out.' }
  ];

  /* ---------------- formatting: capacity and dollar columns at one decimal ---------------- */
  function usd1(v) { return Math.abs(v) < 1000 ? usd(v) : T.minus(T.nf({ style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v)); }
  function capW(v) { return v === 0 ? '< $100' : usd1(v); }
  function enc(s) { return encodeURIComponent(s); }
  function maxT(a, b) { return !a ? b : !b ? a : (a > b ? a : b); }
  function hourOf(t) { return Math.floor(new Date(t).getTime() / H) * H; }
  function nowAt() { return S.mode === 'snapshot' && S.manifest ? new Date(S.manifest.captured_at) : new Date(); }
  function count(v) { return '<span class="a2-count">' + esc(v) + '</span>'; }

  var R2 = {
    assets: function () { return '/risk/assets?tau=' + TAU; },
    pools: function () { return '/risk/pools'; },
    poolsOf: function (a) { return T.R.pools(a); },   // per asset: the unfiltered list stops at 500 rows
    sheet: function (a, n) { return '/risk/facts/assets/' + enc(a) + '?sizeUsd=' + Math.max(1, Math.round(n)); },
    hist: function (a) { return '/risk/assets/' + enc(a) + '/history?days=30&tau=' + TAU; },
    lendList: function () { return '/risk/facts/lending'; },
    lend: function (acc) { return '/risk/facts/lending/' + enc(acc); },
    lendH: function (acc, d) { return '/risk/facts/lending/' + enc(acc) + '/history?days=' + d; },
    liquidity: function (p) { return T.R.liquidity(p); },
    assetsAt: function (tau) { return '/risk/assets?tau=' + tau; },
    histAt: function (a, tau) { return '/risk/assets/' + enc(a) + '/history?days=30&tau=' + tau; },
    recorded: function () { return '/risk/pools/recorded'; },
    liqHist: function (p) { return '/risk/pools/' + enc(p) + '/liquidity/history?hours=720'; },
    split: function (a, n) { return '/risk/assets/' + enc(a) + '/split?side=sell&sizeUsd=' + Math.max(1, Math.round(n)); },
    recov: function (a, n, kyc) { return '/risk/recoverable?asset=' + enc(a) + '&notional=' + Math.round(n) + '&hours=168&holderKyc=' + !!kyc; }
  };

  /* ---------------- state ---------------- */
  var view, P = { page: null, sel: {}, metric: {}, range: 2, tol: TAU, sim: { asset: 'TSLAx', size: 100000, kyc: false } };
  var narrow = window.matchMedia('(max-width: 899px)').matches;   // on a phone the menu starts closed, as a drawer
  try { var saved = localStorage.getItem('tf-an2-side'); P.collapsed = saved == null || narrow ? narrow || saved === '1' : saved === '1'; } catch (e) { P.collapsed = narrow; }
  function sel(page) { return P.sel[page] || (P.sel[page] = { assets: null, pools: null }); }
  function picked(set, id) { return !set || set.indexOf(id) >= 0; }

  /* ---------------- data, read once and cached in analytics.js ---------------- */
  var D = { base: null, dex: {}, lend: null };
  function base() {
    if (D.base) return D.base;
    D.base = Promise.all([get(R2.assets()), get(R2.pools()), get(R2.lendList()), get(R2.recorded())]).then(function (rs) {
      var rec = {}; if (rs[3].ok) rs[3].body.pools.forEach(function (p) { rec[p.address] = p; });
      return { assets: rs[0], pools: rs[1].ok ? rs[1].body.pools : [], lendList: rs[2], recorded: rec, recordedRes: rs[3] };
    });
    return D.base;
  }
  /** Per asset: the sheet at $100k (volume, LP share, recovery) and 30 days of hourly capacity. */
  function dexData(ids) {
    var need = ids.filter(function (id) { return !D.dex[id]; });
    return T.pool(need, 6, function (id) {
      return Promise.all([get(R2.sheet(id, 100000)), get(R2.hist(id)), get(R2.poolsOf(id))]).then(function (rs) { D.dex[id] = { sheet: rs[0], hist: rs[1], pools: rs[2] }; });
    }).then(function () { var o = {}; ids.forEach(function (id) { o[id] = D.dex[id]; }); return o; });
  }
  /** Every lending sheet with its history: hourly for 7 days, daily for 30. */
  function lendData() {
    if (D.lend) return D.lend;
    D.lend = base().then(function (b) {
      var list = b.lendList.ok ? b.lendList.body.pools : [];
      return T.pool(list, 4, function (p) {
        return Promise.all([get(R2.lend(p.account)), get(R2.lendH(p.account, 7)), get(R2.lendH(p.account, 30))]).then(function (rs) {
          return { meta: p, sheet: rs[0], h7: rs[1], h30: rs[2] };
        });
      }).then(function (rows) {
        var order = list.map(function (p) { return p.account; });
        return rows.sort(function (a, b) { return order.indexOf(a.meta.account) - order.indexOf(b.meta.account); });
      });
    });
    return D.lend;
  }
  /** One lending pool's history: daily points older than the hourly window, hourly points inside it. */
  function lendSeries(row) {
    if (row._s) return row._s;
    var h7 = row.h7.ok ? row.h7.body.points || [] : [], h30 = row.h30.ok ? row.h30.body.points || [] : [];
    var cut = h7.length ? new Date(h7[0].t).getTime() : Infinity;
    row._s = h30.filter(function (p) { return new Date(p.t).getTime() < cut; }).concat(h7).map(function (p) { return Object.assign({}, p, { ms: new Date(p.t).getTime() }); });
    return row._s;
  }
  function lendSrc(row) { return (row.h7.ok && row.h7.body) || (row.h30.ok && row.h30.body) || null; }
  /** Sum one field over pools per UTC hour (hourly window) or per UTC day (older points). */
  function summed(rows, key) {
    var by = {}, cut = nowAt().getTime() - 8 * DAY, n = rows.length;
    rows.forEach(function (row) { var seen = {}; lendSeries(row).slice().reverse().forEach(function (p) { var k = p.ms >= cut ? hourOf(p.ms) : Math.floor(p.ms / DAY) * DAY; if (seen[k]) return; seen[k] = 1; var o = by[k] || (by[k] = { t: k, v: 0, n: 0 }); if (p[key] != null) { o.v += p[key]; o.n++; } }); });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (x, y) { return x.t - y.t; }).map(function (o) {
      return { t: o.t, v: o.n ? o.v : null, partial: o.n < n, show: o.n && o.n < n ? null : undefined, k: o.n, of: n };
    });
  }
  /** The newest summed point as a fact; a lower bound when some pools had no figure at that time. */
  function seriesFact(pts, src, label, fmt) {
    var lp = pts.filter(function (p) { return p.v != null; }).pop();
    if (!lp || !src) return { value: null, reason: 'not_collected' };
    lp.show = lp.partial ? fmt(lp.v) + ' (' + lp.k + ' of ' + lp.of + ' pools)' : null;
    return mk(lp.v, { quality: lp.partial ? 'lower_bound' : 'measured', source: src.source, fetchedAt: new Date(lp.t).toISOString(), method: label + (lp.partial ? '; ' + lp.k + ' of ' + lp.of + ' pools have a figure at this time, so this is a lower bound' : '') + '; ' + src.method, methodVersion: src.methodVersion });
  }
  function markPartial(pts, fmt) { pts.forEach(function (p) { if (p.v != null && p.partial) p.show = fmt(p.v) + ' (' + p.k + ' of ' + p.of + ' pools)'; }); return pts; }

  /* ---------------- shell: side menu, header, banner ---------------- */
  function shell() {
    view.innerHTML = '<div class="a2' + (P.collapsed ? ' collapsed' : '') + '">' +
      '<aside class="a2-side" aria-label="Analytics pages">' +
        '<button type="button" class="a2-toggle" aria-expanded="' + !P.collapsed + '" aria-controls="a2-nav"><span class="a2-tg-ico" aria-hidden="true"></span><span class="a2-tg-txt">' + (P.collapsed ? 'Show menu' : 'Hide menu') + '</span></button>' +
        '<nav id="a2-nav" aria-label="Analytics 2.0"><ul>' + PAGES.map(function (p) {
          return '<li><a href="#analytics2/' + p.id + '" data-page="' + p.id + '" title="' + esc(p.label) + '"><span class="a2-mark" aria-hidden="true">' + esc(p.mark) + '</span><span class="a2-lab">' + esc(p.label) + '</span></a></li>';
        }).join('') + '</ul>' +
        '<p class="a2-old"><a href="#analytics">The first analytics view</a></p></nav>' +
      '</aside>' +
      '<div class="a2-main"><div class="a2-head"><div class="an-bhead">Bearing · analytics 2.0</div><h1 class="an-lede" id="a2-lede"></h1>' +
      '<div class="an-banner" id="a2-banner" role="status"></div></div><div id="a2-page"></div>' +
      '<aside class="an-disclaimer" aria-label="Disclaimer" lang="en"><h3>Not advice</h3><p>' + esc(T.DISCLAIMER) + '</p></aside></div></div>';
    view.querySelector('.a2-toggle').addEventListener('click', function () {
      P.collapsed = !P.collapsed;
      try { localStorage.setItem('tf-an2-side', P.collapsed ? '1' : '0'); } catch (e) { /* the menu works without storage */ }
      view.querySelector('.a2').classList.toggle('collapsed', P.collapsed);
      this.setAttribute('aria-expanded', String(!P.collapsed));
      this.querySelector('.a2-tg-txt').textContent = P.collapsed ? 'Show menu' : 'Hide menu';
    });
    view.querySelectorAll('[data-page]').forEach(function (a) { a.addEventListener('click', function () { if (window.matchMedia('(max-width: 899px)').matches && !P.collapsed) view.querySelector('.a2-toggle').click(); }); });
  }
  function banner(assetsRes) {
    var b = document.getElementById('a2-banner'), last = null;
    if (assetsRes && assetsRes.ok) assetsRes.body.assets.forEach(function (a) { REGIMES.forEach(function (r) { var c = a.capacityAtTau[r]; if (c && c.to) last = maxT(last, c.to); }); });
    var r = T.regimeAt(nowAt()), et = T.etParts(nowAt()).label;
    if (S.mode === 'live') b.innerHTML = '<b>Live from the collectors, as of ' + esc(last ? T.hhmm(last) : 'an unknown time') + '.</b><span class="an-meta">now: ' + esc(RW[r]) + ' (' + esc(et) + ')</span>';
    else if (S.mode === 'snapshot') b.innerHTML = '<b>Snapshot captured ' + esc(iso(S.manifest.captured_at).replace('T', ' ').replace('Z', ' UTC')) + ', the API is not running.</b><span>Every figure is stale: measured, only old. Its age is beside it.</span>';
    else b.innerHTML = '<b>Neither the API at ' + esc(T.API) + ' nor the snapshot answered.</b><span>Start the API (docs/risk/PROMPT-BUILD-ANALYTICS-PAGE.md) or serve this folder over HTTP.</span>';
  }

  /* ---------------- building blocks ---------------- */
  function kpi(label, html, note) { return '<div class="a2-kpi"><div class="t">' + esc(label) + '</div><div class="v">' + html + '</div>' + (note ? '<div class="n">' + note + '</div>' : '') + '</div>'; }
  function th(t, n) { return '<th scope="col"' + (n ? ' class="n"' : '') + '>' + esc(t) + '</th>'; }
  function td(label, html, cls) { return '<td data-label="' + esc(label) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + html + '</td>'; }
  function table(id, caption, heads, rows) {
    return '<div class="an-scroll" role="region" tabindex="0" aria-label="' + esc(caption) + '"><table class="an-table stack a2-table" id="' + id + '"><caption class="an-sr">' + esc(caption) + '</caption><thead><tr>' +
      heads.map(function (h) { return th(h[0], h[1]); }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  function tr(heads, cells, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map(function (c, i) { return td(heads[i][0], c, (i === 0 ? 'first' : '') + (heads[i][1] ? ' n' : '')); }).join('') + '</tr>'; }
  function seg(items, cur) {
    return '<div class="an-seg a2-metric" role="group" aria-label="Metric">' + items.map(function (it) { return '<button type="button" data-metric="' + it[0] + '" aria-pressed="' + (it[0] === cur) + '">' + esc(it[1]) + '</button>'; }).join('') + '</div>';
  }
  /** A multi-select as a disclosure with checkboxes; null means all. */
  function multi(key, label, opts, cur) {
    var n = cur ? cur.length : opts.length;
    var summ = cur == null ? 'All (' + opts.length + ')' : n === 0 ? 'None' : n === 1 ? (opts.filter(function (o) { return o.id === cur[0]; })[0] || { label: cur[0] }).label : n + ' of ' + opts.length;
    return '<details class="a2-ms" data-ms="' + key + '"><summary><span class="k">' + esc(label) + '</span> <b>' + esc(summ) + '</b></summary><div class="a2-ms-pop" role="group" aria-label="' + esc(label) + '">' +
      '<div class="a2-ms-acts"><button type="button" class="an-btn" data-ms-all="1">All</button><button type="button" class="an-btn" data-ms-all="0">None</button></div>' +
      opts.map(function (o) { return '<label><input type="checkbox" value="' + esc(o.id) + '"' + (picked(cur, o.id) ? ' checked' : '') + '><span>' + esc(o.label) + '</span>' + (o.sub ? '<span class="an-sub">' + esc(o.sub) + '</span>' : '') + '</label>'; }).join('') + '</div></details>';
  }
  function wireMulti(root, key, opts, setCur) {
    var d = root.querySelector('[data-ms="' + key + '"]'); if (!d) return;
    function apply(ids) { setCur(ids.length === opts.length ? null : ids); reopen(key); }
    d.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () { apply([].map.call(d.querySelectorAll('input:checked'), function (x) { return x.value; })); });
    });
    d.querySelectorAll('[data-ms-all]').forEach(function (b) { b.addEventListener('click', function () { apply(b.getAttribute('data-ms-all') === '1' ? opts.map(function (o) { return o.id; }) : []); }); });
  }
  function reopen(key) { var d = view.querySelector('[data-ms="' + key + '"]'); if (d) { d.setAttribute('open', ''); var s = d.querySelector('summary'); if (s) s.focus(); } }
  document.addEventListener('click', function (e) {   // a click outside an open filter closes it
    document.querySelectorAll('.a2-ms[open]').forEach(function (d) { if (!d.contains(e.target) && document.contains(e.target)) d.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') document.querySelectorAll('.a2-ms[open]').forEach(function (d) { d.removeAttribute('open'); d.querySelector('summary').focus(); }); });
  /* Delegated: a time chart draws its header (with these buttons) when it mounts, after this runs. */
  function wireChart(chart, rerender, page) {
    chart.onclick = function (e) {
      var m = e.target.closest && e.target.closest('[data-metric]'), rg = e.target.closest && e.target.closest('[data-range]');
      if (m) { P.metric[page] = m.getAttribute('data-metric'); rerender(); }
      else if (rg) P.range = +rg.getAttribute('data-range');
    };
  }

  /* Hover for the pies (slice and legend row together, value in the ring) and the flows (one path forward, the rest dimmed). */
  function pieShow(pie, i) {
    var d; try { d = JSON.parse(pie.getAttribute('data-pie')); } catch (e) { return; }
    pie.querySelectorAll('[data-i]').forEach(function (x) { x.classList.toggle('on', i != null && x.getAttribute('data-i') === String(i)); });
    pie.classList.toggle('focus', i != null);
    var v = pie.querySelector('.a2-pc.v'), s2 = pie.querySelector('.a2-pc.s');
    if (v) v.textContent = i == null ? '' : d[i][1];
    if (s2) s2.textContent = i == null ? '' : d[i][2];
  }
  function flowFocus(svgEl, f) { if (svgEl) { if (f) svgEl.setAttribute('data-focus', f); else svgEl.removeAttribute('data-focus'); } }
  ['mouseover', 'focusin'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var pie = t.closest('.a2-pie'), it = t.closest('.a2-pie [data-i]');
      if (pie) pieShow(pie, it ? it.getAttribute('data-i') : null);
      var flow = t.closest('.a2-flow svg');
      if (flow) { var el = t.closest('[class*="f"]'), m = el && /\bf(\d)\b/.exec(el.getAttribute('class') || ''); flowFocus(flow, m ? 'f' + m[1] : null); }
    });
  });
  document.addEventListener('mouseout', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    var to = e.relatedTarget;
    var pie = t.closest('.a2-pie'); if (pie && !(to && pie.contains(to))) pieShow(pie, null);
    var flow = t.closest('.a2-flow svg'); if (flow && !(to && flow.contains(to))) flowFocus(flow, null);
  });

  /** Donut of value by pool: the four largest and the rest as one slice, 2px gaps, a legend with shares. */
  function pie(title, slices, total, totalHtml, note) {
    slices = slices.filter(function (s) { return s.value > 0; }).sort(function (a, b) { return b.value - a.value; });
    var top = slices.slice(0, 4), rest = slices.slice(4), restV = rest.reduce(function (s, x) { return s + x.value; }, 0);
    if (rest.length) top.push({ label: rest.length + ' other pool' + (rest.length > 1 ? 's' : ''), value: restV, other: true });
    var R = 64, r = 40, cx = 72, cy = 72, a0 = -Math.PI / 2, g = '';
    function pt(rad, a) { return (cx + rad * Math.cos(a)).toFixed(2) + ',' + (cy + rad * Math.sin(a)).toFixed(2); }
    top.forEach(function (s, i) {
      var sw = s.value / (total || 1) * Math.PI * 2, a1 = a0 + sw, big = sw > Math.PI ? 1 : 0, cls = s.other ? 'po' : 'p' + (i + 1);
      var tip = '<title>' + esc(s.label + ' · ' + usd1(s.value) + ' · ' + pct(s.value / total)) + '</title>';
      s.i = i;
      if (sw >= Math.PI * 2 - 1e-6) g += '<circle class="a2-ring ' + cls + '" data-i="' + i + '" cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" stroke-width="' + (R - r) + '">' + tip + '</circle>';
      else g += '<path class="a2-slice ' + cls + '" data-i="' + i + '" d="M' + pt(R, a0) + ' A' + R + ',' + R + ' 0 ' + big + ' 1 ' + pt(R, a1) + ' L' + pt(r, a1) + ' A' + r + ',' + r + ' 0 ' + big + ' 0 ' + pt(r, a0) + ' Z">' + tip + '</path>';
      s.cls = cls; a0 = a1;
    });
    return '<div class="cc-head"><div class="cc-title"><div class="t">' + esc(title) + '</div><div class="v">' + totalHtml + '</div>' + (note ? '<div class="n">' + esc(note) + '</div>' : '') + '</div></div>' +
      (top.length ? '<div class="a2-pie" data-pie="' + esc(JSON.stringify(top.map(function (s) { return [s.label, usd1(s.value), pct(s.value / total)]; }))) + '"><svg width="144" height="144" viewBox="0 0 144 144" role="img" aria-label="' + esc(title + ': ' + top.map(function (s) { return s.label + ' ' + pct(s.value / total); }).join(', ')) + '">' + g +
      '<text class="a2-pc v" x="72" y="70" text-anchor="middle"></text><text class="a2-pc s" x="72" y="86" text-anchor="middle"></text></svg>' +
      '<ul class="a2-pie-leg">' + top.map(function (s) { return '<li data-i="' + s.i + '" tabindex="0"><i class="' + s.cls + '" aria-hidden="true"></i><span class="l">' + esc(s.label) + '</span><span class="s">' + esc(pct(s.value / total)) + '</span></li>'; }).join('') + '</ul>' +
      '<p class="an-meta">Point at a slice or a row for its value.</p></div>'
        : '<p class="cc-empty">' + reason('not_collected') + '</p>');
  }
  function srcLine(f, what) {
    if (!f || f.value == null) return '';
    return '<p class="an-meta an-figsrc">' + esc(String(f.source || '').replace(/~\/[^,]*,\s*/g, '')) + ' · ' + esc(iso(f.fetchedAt)) + '<span class="an-fig"> ' + T.pin(f, what) + '</span></p>';
  }
  function emptyChart(title, html, tools) { return '<div class="cc-head"><div class="cc-title"><div class="t">' + esc(title) + '</div><div class="n a2-why">' + html + '</div></div>' + (tools || '') + '</div>'; }

  /* ---------------- facts ---------------- */
  function capFact(a, r, body) {   // the first view's rule
    var c = a && a.capacityAtTau && a.capacityAtTau[r];
    if (!c) return { value: null, reason: a ? 'no_samples_in_regime' : 'not_collected' };
    if (c.status !== 'ok' || c.capacityUsd == null) return { value: null, reason: c.status === 'insufficient_samples' ? 'insufficient_samples' : 'no_samples_in_regime' };
    return mk(c.capacityUsd, { quality: c.lowerBound ? 'lower_bound' : 'measured', source: 'risk_depth_curves (GET /risk/assets)', fetchedAt: c.to, dataFrom: c.from, samples: c.samples, regime: r,
      method: 'largest sale at cost ≤ τ = ' + pct(body.tau) + ' on the fitted sell curve', methodVersion: body.methodVersion });
  }
  /** A sum of facts as one fact: a lower bound if any part is one or has no figure; the newest time; the parts counted. */
  function sumFact(facts, o) {
    var have = facts.filter(function (f) { return f && f.value != null; });
    if (!facts.length) return { value: null, reason: 'nothing_selected' };
    if (!have.length) return { value: null, reason: o.reason || (facts[0] && facts[0].reason) || 'not_collected' };
    var v = have.reduce(function (s, f) { return s + f.value; }, 0), t = null, from = null;
    have.forEach(function (f) { t = maxT(t, f.fetchedAt); if (f.dataFrom && (!from || f.dataFrom < from)) from = f.dataFrom; });
    var lb = have.some(function (f) { return f.quality === 'lower_bound'; }) || have.length < facts.length;
    return mk(v, { quality: lb ? 'lower_bound' : 'measured', source: o.source || have[0].source, fetchedAt: t, dataFrom: from, regime: o.regime,
      method: (o.method || 'sum') + ' · ' + have.length + ' of ' + facts.length + ' with a figure' + (have.length < facts.length ? ' (the rest have none, so this is a lower bound)' : ''), methodVersion: o.methodVersion || have[0].methodVersion });
  }
  function vol24(sheetRes) {
    if (!sheetRes.ok) return { value: null, reason: sheetRes.reason };
    var w = (sheetRes.body.flow.byWindow || []).filter(function (x) { return x.window === '24h'; })[0];
    return w ? w.volumeUsd : { value: null, reason: 'not_collected' };
  }

  /* ================= DEX pages: stocks, commodities ================= */
  function dexIds(b, page) {
    return b.assets.body.assets.map(function (a) { return a.symbol; }).filter(function (s) { return (COMMODITIES.indexOf(s) >= 0) === (page === 'commodities'); });
  }
  function dexPage(pg) {
    var box = document.getElementById('a2-page');
    box.innerHTML = '<p class="an-loading">Reading the pools…</p>';
    return base().then(function (b) {
      if (!b.assets.ok) { box.innerHTML = '<p>' + reason(b.assets.reason) + '</p>'; return; }
      var ids = dexIds(b, pg.id);
      return dexData(ids).then(function (dd) { if (P.page === pg.id) dexRender(pg, b, ids, dd); });
    });
  }
  function poolLabel(p, withAsset) { return (withAsset ? p.assetSymbol + ' · ' : '') + T.venueW(p.venue) + ' · ' + (p.quoteSymbol || 'quote not named') + ' · ' + T.short(p.address); }
  function dexRender(pg, b, ids, dd) {
    var box = document.getElementById('a2-page'), st = sel(pg.id), body = b.assets.body, r = T.regimeAt(nowAt());
    var byId = {}; body.assets.forEach(function (a) { byId[a.symbol] = a; });
    var poolsOf = function (id) { var r0 = dd[id].pools; return r0 && r0.ok ? r0.body.pools || [] : []; };
    var assetOpts = ids.map(function (id) { return { id: id, label: id, sub: num(poolsOf(id).length) + ' pools' }; });
    var selIds = ids.filter(function (id) { return picked(st.assets, id); });
    var many = selIds.length > 1;
    var allPools = [].concat.apply([], selIds.map(poolsOf)).sort(function (x, y) { return (y.tvlUsd || 0) - (x.tvlUsd || 0); });
    var poolOpts = allPools.map(function (p) { return { id: p.address, label: poolLabel(p, many), sub: usd1(p.tvlUsd || 0) }; });
    var pools = allPools.filter(function (p) { return picked(st.pools, p.address); });
    var poolT = null; pools.forEach(function (p) { poolT = maxT(poolT, p.fetchedAt); });
    var rerender = function () { dexRender(pg, b, ids, dd); };

    /* counters */
    var noPools = selIds.some(function (id) { return !dd[id].pools.ok; });
    var tvlF = pools.length ? mk(pools.reduce(function (s, p) { return s + (p.tvlUsd || 0); }, 0), { source: 'risk_pools.tvl_usd (GET /risk/pools), read when each pool was registered', fetchedAt: poolT, quality: noPools ? 'lower_bound' : 'measured', method: 'sum of the TVL of the selected pools (GET /risk/pools?asset= per asset)' + (noPools ? '; some assets’ pool lists did not load, so this is a lower bound' : ''), methodVersion: 'registry-0.1' }) : { value: null, reason: !selIds.length || (st.pools && !st.pools.length) ? 'nothing_selected' : 'not_collected' };
    var capF = sumFact(selIds.map(function (id) { return capFact(byId[id], r, body); }), { regime: r, method: 'sum over the selected assets of the largest sale at cost ≤ 1% in ' + RW[r] + ', each asset routed across all its pools', methodVersion: body.methodVersion });
    var volF = sumFact(selIds.map(function (id) { return vol24(dd[id].sheet); }), { method: 'sum over the selected assets of the volume of successful swaps in the newest 24 h of the swap history' });
    var lpW = 0, lpS = 0, lpT = null, lpN = 0;
    selIds.forEach(function (id) { var s = dd[id].sheet; if (!s.ok) return; var f = s.body.liquidityStability.lpTop3Share; if (!f || f.value == null) return; var w = byId[id].poolTvlUsd || 0; lpW += w; lpS += w * f.value; lpT = maxT(lpT, f.fetchedAt); lpN++; });
    var lpF = lpW ? mk(lpS / lpW, { quality: 'lower_bound', source: 'risk_lp_concentration (GET /risk/facts/assets/:id, liquidityStability.lpTop3Share)', fetchedAt: lpT, method: 'TVL-weighted mean over ' + lpN + ' assets of the top-3 positions’ share of each asset’s largest pool; by position, not by owner', methodVersion: 'facts-0.1' }) : { value: null, reason: selIds.length ? 'not_collected' : 'nothing_selected' };
    var volTo = null; selIds.forEach(function (id) { var s = dd[id].sheet; if (!s.ok) return; var w = (s.body.flow.byWindow || []).filter(function (x) { return x.window === '24h'; })[0]; if (w && w.to) volTo = maxT(volTo, w.to); });

    var metric = P.metric[pg.id] || 'capacity';
    box.innerHTML =
      '<div class="a2-filters">' + multi('assets', 'Assets', assetOpts, st.assets) + multi('pools', 'Pools', poolOpts, st.pools) +
      '<span class="an-meta">' + esc(selIds.length + ' asset' + (selIds.length === 1 ? '' : 's') + ' · ' + pools.length + ' pool' + (pools.length === 1 ? '' : 's') + ' · now ' + RW[r]) + '</span></div>' +
      '<div class="a2-kpis">' +
        kpi('Pool TVL', fig(tvlF, usd1), 'selected pools, read at registration') +
        kpi('Pools', count(num(pools.length)), 'of ' + esc(num(allPools.length)) + ' on the selected assets') +
        kpi('Exit capacity now', fig(capF, usd1), 'sale at ≤ 1% cost, ' + esc(RW[r])) +
        kpi('Volume 24 h', fig(volF, usd1), volTo ? 'to ' + esc(iso(volTo).slice(0, 16).replace('T', ' ')) + ' UTC, the newest swap history' : '') +
        kpi('Top-3 LP share', fig(lpF, pct), 'largest pool, by position') +
      '</div>' +
      '<div class="a2-grid"><div class="an-card a2-piecard" id="a2-pie"></div><div class="an-card a2-chartcard" id="a2-chart"></div></div>' +
      '<section class="a2-sec" aria-labelledby="a2-t-h"><h2 id="a2-t-h">Assets</h2><p class="an-note">Capacity is the largest sale that costs at most 1%, by time of week. Exit capacity is that figure hour by hour. The pool filter narrows TVL, the pie, the pool count and the liquidity chart; capacity is routed across all of an asset’s pools, so it does not change with it. Open an asset for its full sheet in the first view.</p><div id="a2-table"></div></section>' +
      '<p class="an-meta a2-method">method ' + esc(body.methodVersion) + ' · τ = 1.00% · ' + esc(body.honesty.join(' ')) + '</p>';

    document.getElementById('a2-pie').innerHTML = pie('TVL by pool', pools.map(function (p) { return { label: poolLabel(p, many), value: p.tvlUsd || 0 }; }), tvlF.value || 0, fig(tvlF, usd1), 'read when each pool was registered');

    /* the chart */
    var chart = document.getElementById('a2-chart'), tools = seg([['capacity', 'Exit capacity'], ['tvl', 'TVL over time'], ['liquidity', 'Liquidity']], metric);
    if (metric === 'capacity') {
      var bucket = {}, n = selIds.length, last = null, src = null;
      selIds.forEach(function (id) {
        var h = dd[id].hist; if (!h.ok) return; src = src || h.body;
        (h.body.points || []).forEach(function (p) {
          var k = hourOf(p.t), o = bucket[k] || (bucket[k] = { t: k, s: 0, b: 0, ns: 0, nb: 0 });
          if (p.sellCapacityUsd != null) { o.s += p.sellCapacityUsd; o.ns++; if (p.sellLowerBound) o.lb = true; } if (p.buyCapacityUsd != null) { o.b += p.buyCapacityUsd; o.nb++; }
          last = maxT(last, p.t);
        });
      });
      var pts = Object.keys(bucket).map(function (k) { return bucket[k]; }).sort(function (x, y) { return x.t - y.t; });
      var part = function (v, k) { return k < n ? usd1(v) + ' (' + k + ' of ' + n + ' assets)' : usd1(v); };
      var lastP = pts.filter(function (q) { return q.ns; }).pop();
      var f = src && lastP ? mk(lastP.s, { source: src.source, fetchedAt: last, method: src.method + '; summed over the selected assets per UTC hour', methodVersion: src.methodVersion, quality: lastP.ns < n || lastP.lb ? 'lower_bound' : 'measured' }) : { value: null, reason: 'not_collected' };
      chart.innerHTML = C.time({ title: 'Exit capacity at ≤ 1% cost', tools: tools, value: fig(f, usd1), note: 'sell and buy side, summed over the selected assets, one point per UTC hour since ' + (src ? esc(iso(src.from).slice(0, 10)) : 'the first routed curve') + ', when the routed curves began',
        ranges: RANGES, range: P.range, hourly: true,
        panes: [{ h: 260, fmt: usd1, series: [
          { type: 'area', cls: 's1', label: 'sell (exit)', data: pts.map(function (q) { return { t: q.t, v: q.ns ? q.s : null, show: q.ns ? part(q.s, q.ns) : null }; }) },
          { type: 'line', cls: 's2', label: 'buy (entry)', data: pts.map(function (q) { return { t: q.t, v: q.nb ? q.b : null, show: q.nb ? part(q.b, q.nb) : null }; }) }] }],
        legend: [{ cls: 's1', label: 'sell (exit)' }, { cls: 's2', label: 'buy (entry)' }],
        aria: 'Exit and entry capacity over time for the selected assets', src: srcLine(f, 'the capacity chart'), empty: reason('not_collected') });
    } else if (metric === 'tvl') {
      var recP = pools.filter(function (p) { return b.recorded[p.address]; });
      var recTvl = recP.reduce(function (a, p) { return a + (p.tvlUsd || 0); }, 0), selTvl = tvlF.value || 0;
      if (!recP.length) chart.innerHTML = emptyChart('TVL over time', reason('not_collected') + ': the collector records the pool value hour by hour only for the concentrated-liquidity pools that make up the top 80% of registry TVL, and none of the selected pools is one of them. Today’s TVL of the selection is in the counters; exit capacity over time is measured for every asset.', tools);
      else {
        chart.innerHTML = '<p class="an-loading">Reading ' + recP.length + ' recorded pool' + (recP.length > 1 ? 's' : '') + '…</p>';
        var tok = {};
        P.tvlTok = tok;
        Promise.all(recP.map(function (p) { return get(R2.liqHist(p.address)); })).then(function (hs) {
          if (P.tvlTok !== tok || !document.body.contains(chart)) return;
          // Not every pool is recorded every hour: each pool keeps its last recorded value for up to 6 h, so the sum does
          // not jump with the set of pools recorded that hour; an hour still missing a pool is a lower bound.
          var n = recP.length, src = null, last = null, series = [], t0 = Infinity, t1 = -Infinity, CARRY = 6 * H;
          hs.forEach(function (h) {
            if (!h.ok) return; src = src || h.body;
            var ps = (h.body.points || []).filter(function (q) { return q.valueUsd != null; }).map(function (q) { return { t: hourOf(q.t), v: q.valueUsd, a: q.assetUsd }; });
            ps.forEach(function (q) { t0 = Math.min(t0, q.t); t1 = Math.max(t1, q.t); });
            if (ps.length) last = maxT(last, h.body.to);
            series.push(ps);
          });
          var pts = [];
          for (var t = t0; t <= t1; t += H) {
            var o = { t: t, v: 0, a: 0, k: 0 };
            series.forEach(function (ps) { var q = null; for (var i = ps.length - 1; i >= 0; i--) if (ps[i].t <= t) { q = ps[i]; break; } if (q && t - q.t <= CARRY) { o.v += q.v; o.a += q.a; o.k++; } });
            pts.push(o);
          }
          var lp = pts.filter(function (q) { return q.k; }).pop();
          var f = lp && src ? mk(lp.v, { quality: lp.k < n ? 'lower_bound' : 'measured', source: src.source, fetchedAt: last, method: 'summed over ' + lp.k + ' of ' + n + ' recorded pools in the selection, each at its newest recording within 6 h; ' + src.method, methodVersion: src.methodVersion }) : { value: null, reason: 'not_collected' };
          var share = selTvl ? recTvl / selTvl : null;
          chart.innerHTML = C.time({ title: 'TVL over time, recorded pools', tools: tools, value: fig(f, usd1),
            note: n + ' of ' + pools.length + ' selected pools are recorded hourly' + (share != null ? ', holding ' + esc(pct(share)) + ' of the selection’s TVL' : '') + '; the value of the tokens their liquidity holds, uncollected fees not counted. A pool not recorded in an hour keeps its last value for up to 6 h. Recordings began 2026-10-01.',
            ranges: RANGES, range: P.range, hourly: true,
            panes: [{ h: 260, fmt: usd1, series: [
              { type: 'area', cls: 's1', label: 'pool value', data: pts.map(function (q) { return { t: q.t, v: q.k ? q.v : null, show: q.k ? usd1(q.v) + (q.k < n ? ' (' + q.k + ' of ' + n + ' pools)' : '') : null }; }) },
              { type: 'line', cls: 's2', label: 'of which in the asset', data: pts.map(function (q) { return { t: q.t, v: q.k ? q.a : null }; }) }] }],
            legend: [{ cls: 's1', label: 'pool value (TVL)' }, { cls: 's2', label: 'of which held in the asset' }],
            aria: 'Value held by the recorded pools over time', src: srcLine(f, 'the TVL chart'), empty: reason('not_collected') });
          C.mount(chart); check();
        });
      }
    } else {
      var clmm = pools.filter(function (p) { return /clmm|whirlpool|dlmm/.test(p.venue); })
        .sort(function (x, y) { return (b.recorded[y.address] ? 1 : 0) - (b.recorded[x.address] ? 1 : 0) || (y.tvlUsd || 0) - (x.tvlUsd || 0); });
      if (!clmm.length) chart.innerHTML = emptyChart('Liquidity by price band', reason('not_applicable') + ': none of the selected pools is a concentrated-liquidity pool; a constant-product pool spreads its liquidity over every price.', tools);
      else {
        var def = clmm[0];
        chart.innerHTML = '<div class="a2-distbar">' + tools + '<label class="an-field cc-poolsel"><span>Pool</span><select data-a2pool>' + clmm.slice(0, 40).map(function (p) {
          return '<option value="' + esc(p.address) + '"' + (p === def ? ' selected' : '') + '>' + esc(poolLabel(p, many) + ' · TVL ' + usd1(p.tvlUsd || 0) + (b.recorded[p.address] ? '' : ' · not recorded')) + '</option>';
        }).join('') + '</select></label></div><div data-a2dist><p class="an-loading">Reading the pool…</p></div>';
        wireDist(chart);
      }
    }
    wireChart(chart, rerender, pg.id);

    /* the table */
    var heads = [['Asset'], ['Pools', 1], ['Capacity, market hours', 1], ['Capacity, off-hours', 1], ['Capacity, weekend', 1], ['Capacity, holiday', 1], ['Volume 24 h', 1], ['Top-3 LP share', 1], ['Exit capacity, 30 d']];
    var rows = selIds.map(function (id) {
      var a = byId[id], s = dd[id].sheet, h = dd[id].hist, np = pools.filter(function (p) { return p.assetSymbol === id; }).length;
      var sp = h.ok ? C.spark((h.body.points || []).map(function (p) { return p.sellCapacityUsd; }), 's1') : '';
      return tr(heads, [
        '<a href="#asset=' + esc(id) + '" class="a2-asset">' + esc(id) + '</a>',
        (dd[id].pools.ok ? count(num(np)) + (st.pools ? '<span class="an-sub">of ' + esc(num(poolsOf(id).length)) + '</span>' : '') : reason(dd[id].pools.reason)),
        fig(capFact(a, 'us_market_hours', body), capW), fig(capFact(a, 'us_offhours_weekday', body), capW), fig(capFact(a, 'weekend', body), capW), fig(capFact(a, 'us_holiday', body), capW),
        fig(vol24(s), usd1),
        s.ok ? fig(s.body.liquidityStability.lpTop3Share, pct) : reason(s.reason),
        sp || reason(h.ok ? 'insufficient_samples' : h.reason)
      ]);
    });
    document.getElementById('a2-table').innerHTML = rows.length ? table('a2-dex-t', 'Assets with pools, capacity, volume and LP share', heads, rows) : '<p>' + reason('nothing_selected') + '</p>';

    C.mount(box);
    wireMulti(box, 'assets', assetOpts, function (v) { st.assets = v; st.pools = null; rerender(); });
    wireMulti(box, 'pools', poolOpts, function (v) { st.pools = v; rerender(); });
    check();
  }

  function wireDist(root) {
    var selEl = root.querySelector('[data-a2pool]'), out = root.querySelector('[data-a2dist]');
    function render(d) {
      if (!d.bands || !d.bands.length) { out.innerHTML = emptyChart('Liquidity by price band', reason(d.reason || 'not_collected')); return; }
      var f = { value: 1, quality: 'measured', source: d.source, fetchedAt: d.fetchedAt, method: d.method, methodVersion: d.methodVersion, provenance: d.provenance };
      var total = (d.totalAssetUsd || 0) + (d.totalQuoteUsd || 0);
      var when = d.basis === 'recorded' ? 'the collector’s newest hourly recording, ' + iso(d.fetchedAt).slice(0, 16).replace('T', ' ') + ' UTC' : 'read live ' + iso(d.fetchedAt).slice(11, 16) + ' UTC';
      out.innerHTML = C.dist({ title: 'Liquidity by price band, both sides', value: fig(mk(total, f), usd1), note: 'held within ±30% of the price, from ' + esc(when) + '; the asset waits above the price (sold into as it rises), the quote below (bought with as it falls); + and − zoom',
        bands: d.bands.map(function (x) { return { lo: x.priceLow, hi: x.priceHigh, usd: x.amountUsd, side: x.side }; }), mid: d.midPrice, unit: (d.quote || '') + '/' + (d.asset || ''),
        fmtP: function (v) { return num(v, v < 10 ? 4 : 2); }, fmtY: usd1, asset: d.asset || 'asset', quote: d.quote || 'quote',
        aria: 'Liquidity of pool ' + T.short(d.pool) + ' by price band around the pool price', src: srcLine(f, 'the distribution chart') });
      C.mount(out); check();
    }
    function draw() {
      var addr = selEl.value;
      out.innerHTML = '<p class="an-loading">Reading the pool…</p>';
      get(R2.liquidity(addr)).then(function (r) {
        if (selEl.value !== addr) return;
        if (r.ok) return render(r.body);
        var why = r.body && r.body.error ? r.body.error : T.REASON[r.reason] || r.reason;
        out.innerHTML = emptyChart('Liquidity by price band, both sides', reason(r.reason) + ': ' + esc(why) + '. The collector records only the pools that make up the top 80% of registry TVL; pick one without “not recorded”, or wait for the live read (DA3 opens Mon Oct 5).');
      });
    }
    selEl.addEventListener('change', draw); draw();
  }

  /* ================= lending ================= */
  /** The cost tolerance of the lending page: a sale counts as covered when it costs at most this. 0.1% to 10%. */
  function tolW() { return T.minus(T.nf({ maximumFractionDigits: 2 }).format(P.tol * 100)) + '%'; }
  function tolBox() {
    return '<label class="a2-tol" title="A sale counts as covered when it costs at most this, fees and price impact included"><span>Tolerance</span>' +
      '<input type="text" inputmode="decimal" autocomplete="off" data-tol value="' + esc(T.nf({ maximumFractionDigits: 2 }).format(P.tol * 100)) + '" aria-describedby="a2-tol-err"><span aria-hidden="true">%</span>' +
      '<span class="a2-tol-err" id="a2-tol-err" role="alert"></span></label>';
  }
  /* Delegated: the box sits in a time chart's header, which the chart draws when it mounts. */
  function wireTol(root, pg) {
    function apply(inp) {
      var v = parseFloat(String(inp.value).replace(',', '.').replace('%', '')), err = root.querySelector('.a2-tol-err');
      if (!(v >= 0.1 && v <= 10)) { err.textContent = 'Between 0.1% and 10%'; return; }
      err.textContent = '';
      var t = Math.round(v * 100) / 10000;
      if (t === P.tol) return;
      P.tol = t; lendPage(pg);
    }
    root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-tol]')) { e.preventDefault(); apply(e.target); } });
    root.addEventListener('change', function (e) { if (e.target.matches && e.target.matches('[data-tol]')) apply(e.target); });
  }
  /** Per lending pool: each collateral position (a missing figure kept, with its reason) and the asset's routed capacity now. */
  function coverage(row, body, assetSel, r) {
    var byId = {}; body.assets.forEach(function (a) { byId[a.symbol] = a; });
    var coll = row.sheet.ok ? row.sheet.body.collateral.filter(function (c) { return c.collateralUsd && (c.collateralUsd.value == null || c.collateralUsd.value > 0) && picked(assetSel, c.asset); }) : [];
    var mkey = row.meta.venue === 'kamino' ? 'kamino:' + row.meta.market : row.meta.account;   // Kamino reports collateral per market: its reserves repeat it
    return { parts: coll.map(function (c) { return { key: mkey + '|' + c.asset, asset: c.asset, coll: c.collateralUsd, cap: capFact(byId[c.asset], r, body) }; }) };
  }
  /** Collateral grouped by asset, each market's position counted once: every position in one asset is sold into the same
      pools, so the asset's capacity and its sale loss apply to the sum of its positions, once. */
  function groupBy(covs) {
    var seen = {}, by = {}, out = [];
    covs.forEach(function (c) { c.parts.forEach(function (p) {
      if (seen[p.key]) return; seen[p.key] = 1;
      var g = by[p.asset] || (by[p.asset] = (out.push({ asset: p.asset, cap: p.cap, colls: [] }), out[out.length - 1]));
      g.colls.push(p.coll);
    }); });
    out.forEach(function (g) { g.collV = g.colls.reduce(function (a, f) { return a + (f.value || 0); }, 0); g.missing = g.colls.filter(function (f) { return f.value == null; }).length; });
    return out;
  }
  function priceGroups(groups, r) {   // each asset's sheet at its total collateral: the loss if all of it is sold at once now
    return Promise.all(groups.map(function (g) {
      if (!(g.collV > 0)) { g.loss = { value: null, reason: (g.colls[0] || {}).reason || 'not_collected' }; return null; }
      return get(R2.sheet(g.asset, g.collV)).then(function (sh) {
        if (!sh.ok) { g.loss = { value: null, reason: sh.reason }; return; }
        var c = sh.body.costs.filter(function (x) { return x.regime === r; })[0];
        g.loss = c ? c.exit.lossUsd : { value: null, reason: 'no_samples_in_regime' };
      });
    }));
  }
  function covFacts(groups, r, body) {
    var colls = [].concat.apply([], groups.map(function (g) { return g.colls; }));
    var total = groups.reduce(function (a, g) { return a + g.collV; }, 0), missingColl = groups.some(function (g) { return g.missing; });
    var priced = groups.filter(function (g) { return g.collV > 0; }), have = priced.filter(function (g) { return g.cap.value != null; }), t = null;
    groups.forEach(function (g) { t = maxT(t, g.cap.fetchedAt); g.colls.forEach(function (f) { t = maxT(t, f.fetchedAt); }); });
    var lb = missingColl || have.length < priced.length || have.some(function (g) { return g.cap.quality === 'lower_bound'; });
    var note = have.length + ' of ' + priced.length + ' assets with a capacity' + (missingColl ? '; some positions have no collateral figure' : '') + (lb ? ', so this is a lower bound' : '');
    var base = { source: 'collateral: risk_lending_positions (GET /risk/facts/lending/:account); capacity: risk_depth_curves (GET /risk/assets)', fetchedAt: t, regime: r, methodVersion: body.methodVersion, quality: lb ? 'lower_bound' : 'measured' };
    var covUsd = have.reduce(function (a, g) { return a + Math.min(g.cap.value, g.collV); }, 0);
    var none = { value: null, reason: !groups.length ? 'nothing_selected' : !priced.length ? (colls[0] || {}).reason || 'not_collected' : 'no_samples_in_regime' };
    var maxF = have.length ? mk(covUsd, Object.assign({ method: 'Σ over collateral assets of min(exit capacity at ≤ ' + pct(body.tau) + ' cost in ' + RW[r] + ', the asset’s collateral summed over the selected pools, each market once); ' + note }, base)) : none;
    var covF = have.length && total ? mk(covUsd / total, Object.assign({ method: 'largest sale within the tolerance (≤ ' + pct(body.tau) + ' cost) ÷ collateral posted (' + usd1(total) + '); ' + note }, base)) : none;
    var losses = priced.map(function (g) { return g.loss || { value: null, reason: 'not_served' }; }), lossHave = losses.filter(function (f) { return f.value != null; }), lt = null;
    lossHave.forEach(function (f) { lt = maxT(lt, f.fetchedAt); });
    var lossV = lossHave.reduce(function (a, f) { return a + f.value; }, 0);
    var lossM = { source: 'risk_asset_snapshots (GET /risk/facts/assets/:id?sizeUsd=<the asset’s collateral>, exit.lossUsd)', fetchedAt: lt, regime: r, methodVersion: 'facts-0.1',
      quality: missingColl || lossHave.length < losses.length || lossHave.some(function (f) { return f.quality === 'lower_bound'; }) ? 'lower_bound' : 'measured' };
    var lossF = lossHave.length ? mk(lossV, Object.assign({ method: 'Σ over collateral assets of the loss selling all of the asset’s collateral at once, routed across its pools, in ' + RW[r] + '; ' + lossHave.length + ' of ' + losses.length + ' assets priced' }, lossM)) : none;
    var lossPF = lossHave.length && total ? mk(lossV / total, Object.assign({ method: 'that loss ÷ collateral posted' }, lossM)) : { value: null, reason: lossF.reason };
    var collF = colls.length ? sumFact(colls, { method: 'sum of collateral posted in the selected pools, each market’s position once' }) : { value: null, reason: 'nothing_selected' };
    return { maxF: maxF, covF: covF, lossF: lossF, lossPF: lossPF, collF: collF };
  }
  /** Covered share hour by hour: today's collateral by asset against each hour's exit capacity at ≤ 1%; hours with any asset unmeasured are left out. */
  function coveredSeries(groups, histBy) {
    var missing = groups.some(function (g) { return g.missing; }), lbAt = {};
    groups = groups.filter(function (g) { return g.collV > 0; });
    if (!groups.length) return [];
    var byHour = {};
    groups.forEach(function (g) {
      var h = histBy[g.asset]; if (!h || !h.ok) return;
      (h.body.points || []).forEach(function (p) { if (p.sellCapacityUsd == null) return; var k = hourOf(p.t); (byHour[k] || (byHour[k] = {}))[g.asset] = p.sellCapacityUsd; if (p.sellLowerBound) lbAt[k] = true; });
    });
    var total = groups.reduce(function (a, g) { return a + g.collV; }, 0);
    return Object.keys(byHour).map(Number).sort(function (x, y) { return x - y; }).map(function (k) {
      var row = byHour[k];
      if (!groups.every(function (g) { return row[g.asset] != null; })) return { t: k, v: null };
      return { t: k, v: groups.reduce(function (a, g) { return a + Math.min(row[g.asset], g.collV); }, 0) / total, lb: missing || !!lbAt[k] };
    });
  }
  function poolName(m) { var mk2 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m.market) ? 'market ' + T.short(m.market) : m.market; return T.venueW(m.venue) + ' · ' + (m.venue === 'jupiter_lend' ? m.symbol : mk2 + ' · ' + m.symbol); }
  function lastPoint(row) { var s = lendSeries(row); return s.length ? s[s.length - 1] : null; }
  function histFact(row, key, label) {
    var p = lastPoint(row), src = lendSrc(row);
    if (!p || p[key] == null) return { value: null, reason: p && key === 'availableUsd' && p.availableNullReason ? (p.availableNullReason === 'not_applicable_vault' ? 'not_applicable' : p.availableNullReason) : (p && p.usdNullReason) || 'not_collected' };
    return mk(p[key], { source: src.source, fetchedAt: p.t, method: label + ' at the newest reading; ' + src.method, methodVersion: src.methodVersion });
  }
  function lendPage(pg) {
    var box = document.getElementById('a2-page');
    box.innerHTML = '<p class="an-loading">Reading the lending pools…</p>';
    var tol = P.tol;
    return Promise.all([base(), lendData(), get(R2.assetsAt(tol))]).then(function (rs) {
      var b = Object.assign({}, rs[0], { assets: rs[2] }), rows = rs[1];
      if (!b.lendList.ok || !b.assets.ok) { box.innerHTML = '<p>' + reason(b.lendList.ok ? b.assets.reason : b.lendList.reason) + '</p>'; return; }
      var list = {}; rows.forEach(function (row) { if (row.sheet.ok) row.sheet.body.collateral.forEach(function (c) { if (c.collateralUsd && (c.collateralUsd.value == null || c.collateralUsd.value > 0)) list[c.asset] = 1; }); });
      var assetIds = Object.keys(list).sort();
      var known = assetIds.filter(function (a) { return b.assets.body.assets.some(function (x) { return x.symbol === a; }); });
      return T.pool(known, 6, function (a) { return get(R2.histAt(a, tol)).then(function (h) { return [a, h]; }); }).then(function (hs) {
        if (P.page !== pg.id || P.tol !== tol) return;
        var dd = {}; hs.forEach(function (x) { dd[x[0]] = { hist: x[1] }; });
        return lendRender(pg, b, rows, assetIds, dd);
      });
    });
  }
  function lendRender(pg, b, rows, assetIds, dd) {
    var box = document.getElementById('a2-page'), st = sel(pg.id), r = T.regimeAt(nowAt()), body = b.assets.body;
    var poolOpts = rows.map(function (row) { return { id: row.meta.account, label: poolName(row.meta) }; });
    var assetOpts = assetIds.map(function (a) { return { id: a, label: a }; });
    var selRows = rows.filter(function (row) { return picked(st.pools, row.meta.account); });
    var covs = selRows.map(function (row) { return coverage(row, body, st.assets, r); });
    var histBy = {}; assetIds.forEach(function (a) { histBy[a] = dd[a] && dd[a].hist; });
    var rerender = function () { return lendRender(pg, b, rows, assetIds, dd); };
    var allG = groupBy(covs), rowG = covs.map(function (c) { return groupBy([c]); });
    return Promise.all([priceGroups(allG, r)].concat(rowG.map(function (g) { return priceGroups(g, r); }))).then(function () {
      if (P.page !== pg.id) return;
      var all = covFacts(allG, r, body);
      var supF = sumFact(selRows.map(function (row) { return histFact(row, 'suppliedUsd', 'supplied'); }), { method: 'sum of supplied over the selected pools (Kamino: the token supplied to lend; Jupiter Lend vaults: the collateral deposited)' });
      var borF = sumFact(selRows.map(function (row) { return histFact(row, 'borrowedUsd', 'borrowed'); }), { method: 'sum of borrowed over the selected pools' });
      var metric = P.metric[pg.id] || 'covered';
      box.innerHTML =
        '<div class="a2-filters">' + multi('pools', 'Lending pools', poolOpts, st.pools) + multi('assets', 'Collateral', assetOpts, st.assets) +
        '<span class="an-meta">' + esc(selRows.length + ' pool' + (selRows.length === 1 ? '' : 's') + ' · now ' + RW[r]) + '</span></div>' +
        '<div class="a2-kpis">' +
          kpi('Supplied', fig(supF, usd1)) + kpi('Borrowed', fig(borF, usd1)) +
          kpi('Collateral posted', fig(all.collF, usd1), 'selected assets') +
          kpi('Covered now', fig(all.covF, pct), 'sold at ≤ ' + esc(tolW()) + ' cost, ' + esc(RW[r])) +
          kpi('Largest sale within tolerance', fig(all.maxF, usd1), esc(tolW()) + ' tolerance') +
          kpi('Loss if all is sold', fig(all.lossF, usd1), all.lossPF.value != null ? esc(pct(all.lossPF.value)) + ' of the collateral' : '') +
        '</div>' +
        '<div class="a2-grid"><div class="an-card a2-piecard" id="a2-pie"></div><div class="an-card a2-chartcard" id="a2-chart"></div></div>' +
        '<section class="a2-sec" aria-labelledby="a2-t-h"><h2 id="a2-t-h">Lending pools</h2><p class="an-note">Covered is the share of a pool’s collateral the swap pools could buy at a cost of at most ' + esc(tolW()) + ' in the current time of week (' + esc(RW[r]) + '); the rest would sell at a deeper loss. The loss if all is sold is the routed sale of every collateral asset at its full size, at once. In a row, each lending pool is counted on its own; in the counters and the chart, every position in one stock is added up first and sold into that stock’s pools once, since they draw on the same depth. Kamino reports collateral per market, so reserves of one market show the same collateral; the counters and the chart count it once.</p><div id="a2-table"></div></section>';

      document.getElementById('a2-pie').innerHTML = pie('Supplied by pool', selRows.map(function (row) { return { label: poolName(row.meta), value: histFact(row, 'suppliedUsd', 'supplied').value || 0 }; }), supF.value || 0, fig(supF, usd1), 'Kamino: the token supplied; Jupiter Lend vaults: the collateral deposited');

      var chart = document.getElementById('a2-chart'), tools = seg([['covered', 'Covered'], ['tvl', 'TVL over time'], ['liquidity', 'Liquidity']], metric), src = selRows.map(lendSrc).filter(Boolean)[0];
      if (metric === 'covered') {
        var cs = coveredSeries(allG, histBy), lastC = cs.filter(function (p) { return p.v != null; }).pop(), from = null;
        Object.keys(histBy).forEach(function (a) { var h = histBy[a]; if (h && h.ok && h.body.from && (!from || h.body.from < from)) from = h.body.from; });
        var cf = lastC ? mk(lastC.v, { quality: lastC.lb ? 'lower_bound' : 'measured', source: 'collateral: risk_lending_positions (GET /risk/facts/lending/:account); capacity: risk_asset_snapshots (GET /risk/assets/:id/history)', fetchedAt: new Date(lastC.t).toISOString(), method: 'Σ min(that hour’s exit capacity at ≤ ' + tolW() + ', today’s collateral) ÷ today’s collateral, over the selected pools and assets', methodVersion: 'history-0.1' }) : { value: null, reason: 'not_collected' };
        chart.innerHTML = C.time({ title: 'Covered and not covered, ' + tolW() + ' tolerance', tools: tools, value: fig(cf, pct), note: 'today’s collateral against each hour’s exit capacity, as a share of 100%; hours where a collateral asset has no measurement are left out. The counter above reads the curve fitted over the whole time of week; this chart reads each hour’s own snapshot, so the two can differ. Hourly routed curves began ' + (from ? esc(iso(from).slice(0, 10)) : '2026-10-01') + '.',
          ranges: RANGES, range: P.range, hourly: true, rangeTools: tolBox(),
          panes: [{ h: 260, fmt: T.pct0, max: 1, tagSeries: 1, series: [
            { type: 'area', cls: 'un', label: 'not covered', noDot: true, data: cs.map(function (p) { return { t: p.t, v: p.v == null ? null : 1, show: p.v == null ? null : pct(1 - p.v) }; }) },
            { type: 'area', cls: 'cv', label: 'covered', data: cs.map(function (p) { return { t: p.t, v: p.v, show: p.v == null ? null : pct(p.v) }; }) }] }],
          legend: [{ cls: 'cv', label: 'covered: sold at ≤ ' + tolW() + ' cost' }, { cls: 'un', label: 'not covered: the sale would cost more' }],
          aria: 'Share of collateral covered by pool depth at ' + tolW() + ' cost, over time', src: srcLine(cf, 'the covered chart'), empty: reason('not_collected') });
      } else if (metric === 'tvl') {
        var sup = markPartial(summed(selRows, 'suppliedUsd'), usd1), tf = seriesFact(sup, src, 'supplied summed over the selected pools', usd1);
        chart.innerHTML = C.time({ title: 'Supplied and borrowed', tools: tools, value: fig(tf, usd1), note: 'summed over the selected pools: hourly for the last 7 days, the day’s last reading before that',
          ranges: RANGES, range: P.range, hourly: true, rangeTools: tolBox(),
          panes: [{ h: 260, fmt: usd1, series: [{ type: 'area', cls: 's1', label: 'supplied', data: sup }, { type: 'line', cls: 's2', label: 'borrowed', data: markPartial(summed(selRows, 'borrowedUsd'), usd1) }] }],
          legend: [{ cls: 's1', label: 'supplied' }, { cls: 's2', label: 'borrowed' }], aria: 'Supplied and borrowed over time', src: srcLine(tf, 'the supplied chart'), empty: reason('not_collected') });
      } else chart.innerHTML = availChart(selRows, tools, src, 'a Jupiter Lend vault has no figure here (its lent token sits in a shared liquidity layer)', tolBox());
      wireChart(chart, rerender, pg.id);
      wireTol(chart, pg);

      var heads = [['Pool'], ['Supplied', 1], ['Available now', 1], ['Share lent out', 1], ['Top-1 lender share', 1], ['Collateral', 1], ['Covered', 1], ['Largest sale within tolerance', 1], ['Loss if all is sold', 1], ['Covered, 30 d']];
      var trs = selRows.map(function (row, i) {
        var c = covs[i], f = covFacts(rowG[i], r, body), sh = row.sheet.ok ? row.sheet.body : null;
        var sp = C.spark(coveredSeries(rowG[i], histBy).map(function (p) { return p.v; }), 'cv');
        return tr(heads, [
          '<span class="a2-pool">' + esc(poolName(row.meta)) + '</span> ' + T.explorer(row.meta.account, poolName(row.meta)),
          fig(histFact(row, 'suppliedUsd', 'supplied'), usd1),
          sh ? (row.meta.venue === 'jupiter_lend' ? reason('not_applicable', 'the vault’s lent token sits in the shared Jupiter Lend liquidity layer') : fig(sh.withdrawal.availableUsd, usd1)) : reason(row.sheet.reason),
          sh ? fig(sh.withdrawal.shareLentOut, pct) : reason(row.sheet.reason),
          sh ? fig(sh.lenders.top1Share, pct) : reason(row.sheet.reason),
          fig(f.collF, usd1) + (c.parts.length ? '<span class="an-sub" title="' + esc(c.parts.map(function (p) { return p.asset; }).join(', ')) + '">' + esc(c.parts.length === 1 ? c.parts[0].asset : c.parts.length + ' assets') + '</span>' : ''),
          fig(f.covF, pct), fig(f.maxF, usd1),
          fig(f.lossF, usd1) + (f.lossPF.value != null ? '<span class="an-sub">' + esc(pct(f.lossPF.value)) + ' of it</span>' : ''),
          sp || reason('insufficient_samples')
        ]);
      });
      document.getElementById('a2-table').innerHTML = table('a2-lend-t', 'Lending pools with coverage of their collateral', heads, trs);
      C.mount(box);
      wireMulti(box, 'pools', poolOpts, function (v) { st.pools = v; rerender(); });
      wireMulti(box, 'assets', assetOpts, function (v) { st.assets = v; rerender(); });
      check();
    });
  }
  /** Available to withdraw over time, with the share lent out in a pane below (one axis per pane). */
  function availChart(rows, tools, src, note, rangeTools) {
    var av = markPartial(summed(rows, 'availableUsd'), usd1), s2 = summed(rows, 'suppliedUsd'), b2 = summed(rows, 'borrowedUsd'), af = seriesFact(av, src, 'available to withdraw, summed over the selection', usd1);
    if (af.value == null) af = { value: null, reason: 'not_applicable' };
    return C.time({ title: 'Available to withdraw', tools: tools, value: fig(af, usd1), note: 'cash a lender could take out, and the share lent out below; ' + note, ranges: RANGES, range: P.range, hourly: true, rangeTools: rangeTools || '',
      panes: [{ h: 200, fmt: usd1, series: [{ type: 'area', cls: 's1', label: 'available', data: av }] },
        { h: 90, fmt: T.pct0, max: 1, title: 'share lent out', series: [{ type: 'line', cls: 's2', label: 'share lent out', data: s2.map(function (p, i) { return { t: p.t, v: p.v && b2[i] && b2[i].v != null && !p.partial && !b2[i].partial ? b2[i].v / p.v : null }; }) }] }],
      aria: 'Available to withdraw and share lent out over time', src: srcLine(af, 'the liquidity chart'), empty: reason('not_applicable') });
  }

  /* ================= stablecoins ================= */
  function stablePage(pg) {
    var box = document.getElementById('a2-page');
    box.innerHTML = '<p class="an-loading">Reading the stablecoin reserves…</p>';
    return Promise.all([base(), lendData()]).then(function (rs) {
      if (P.page === pg.id) stableRender(pg, rs[0], rs[1].filter(function (row) { return row.meta.venue === 'kamino' && STABLE.test(row.meta.symbol); }));
    });
  }
  function stableRender(pg, b, rows) {
    var box = document.getElementById('a2-page'), st = sel(pg.id), rerender = function () { stableRender(pg, b, rows); };
    var tokens = []; rows.forEach(function (row) { if (tokens.indexOf(row.meta.symbol) < 0) tokens.push(row.meta.symbol); });
    var assetOpts = tokens.map(function (t) { return { id: t, label: t }; });
    var r1 = rows.filter(function (row) { return picked(st.assets, row.meta.symbol); });
    var poolOpts = r1.map(function (row) { return { id: row.meta.account, label: poolName(row.meta) }; });
    var selRows = r1.filter(function (row) { return picked(st.pools, row.meta.account); });
    var supF = sumFact(selRows.map(function (row) { return histFact(row, 'suppliedUsd', 'supplied'); }), { method: 'sum of supplied over the selected reserves' });
    var borF = sumFact(selRows.map(function (row) { return histFact(row, 'borrowedUsd', 'borrowed'); }), { method: 'sum of borrowed over the selected reserves' });
    var avF = sumFact(selRows.map(function (row) { return row.sheet.ok ? row.sheet.body.withdrawal.availableUsd : { value: null, reason: row.sheet.reason }; }), { method: 'sum of what lenders could withdraw now over the selected reserves' });
    var both = selRows.map(function (row) { return [histFact(row, 'suppliedUsd', 'supplied'), histFact(row, 'borrowedUsd', 'borrowed')]; }).filter(function (x) { return x[0].value != null && x[1].value != null; });
    var sS = both.reduce(function (a, x) { return a + x[0].value; }, 0), sB = both.reduce(function (a, x) { return a + x[1].value; }, 0);
    var shF = sS ? mk(sB / sS, { source: supF.source, fetchedAt: supF.fetchedAt, method: 'borrowed ÷ supplied over the ' + both.length + ' of ' + selRows.length + ' selected reserves with both figures', methodVersion: supF.methodVersion }) : { value: null, reason: selRows.length ? 'not_collected' : 'nothing_selected' };
    var metric = P.metric[pg.id] === 'liquidity' ? 'liquidity' : 'tvl';
    box.innerHTML =
      '<div class="a2-filters">' + multi('assets', 'Stablecoins', assetOpts, st.assets) + multi('pools', 'Reserves', poolOpts, st.pools) + '<span class="an-meta">' + esc(selRows.length + ' reserve' + (selRows.length === 1 ? '' : 's')) + '</span></div>' +
      '<div class="a2-kpis">' + kpi('Supplied', fig(supF, usd1)) + kpi('Borrowed', fig(borF, usd1)) + kpi('Available now', fig(avF, usd1), 'what lenders could withdraw') + kpi('Share lent out', fig(shF, pct)) +
        kpi('Reserves', count(num(selRows.length)), 'Kamino lending reserves') + '</div>' +
      '<div class="a2-grid"><div class="an-card a2-piecard" id="a2-pie"></div><div class="an-card a2-chartcard" id="a2-chart"></div></div>' +
      '<section class="a2-sec" aria-labelledby="a2-t-h"><h2 id="a2-t-h">Stablecoins</h2><p class="an-note">Measured where the collectors read them today: the Kamino lending reserves that lend them. A lender exits by withdrawing, so “available now” takes the place of exit capacity. Swap pools for stablecoins and the yield-bearing ones (USDY, syrupUSDC) are measured once item 17 lands.</p><div id="a2-table"></div></section>';
    document.getElementById('a2-pie').innerHTML = pie('Supplied by reserve', selRows.map(function (row) { return { label: poolName(row.meta), value: histFact(row, 'suppliedUsd', 'supplied').value || 0 }; }), supF.value || 0, fig(supF, usd1), '');
    var chart = document.getElementById('a2-chart'), tools = seg([['tvl', 'TVL over time'], ['liquidity', 'Liquidity']], metric), src = selRows.map(lendSrc).filter(Boolean)[0];
    if (metric === 'tvl') {
      var sup = markPartial(summed(selRows, 'suppliedUsd'), usd1), tf = seriesFact(sup, src, 'supplied summed over the selected reserves', usd1);
      chart.innerHTML = C.time({ title: 'Supplied and borrowed', tools: tools, value: fig(tf, usd1), note: 'hourly for the last 7 days, the day’s last reading before that', ranges: RANGES, range: P.range, hourly: true,
        panes: [{ h: 260, fmt: usd1, series: [{ type: 'area', cls: 's1', label: 'supplied', data: sup }, { type: 'line', cls: 's2', label: 'borrowed', data: markPartial(summed(selRows, 'borrowedUsd'), usd1) }] }],
        legend: [{ cls: 's1', label: 'supplied' }, { cls: 's2', label: 'borrowed' }], aria: 'Stablecoin supplied and borrowed over time', src: srcLine(tf, 'the supplied chart'), empty: reason('not_collected') });
    } else chart.innerHTML = availChart(selRows, tools, src, 'summed over the selected reserves');
    wireChart(chart, rerender, pg.id);

    var heads = [['Asset'], ['Reserves', 1], ['Supplied', 1], ['Available now', 1], ['Share lent out', 1], ['Volume 24 h', 1], ['Top-1 lender share', 1], ['Available, 30 d']];
    var trs = tokens.filter(function (t) { return picked(st.assets, t); }).map(function (t) {
      var rs = selRows.filter(function (row) { return row.meta.symbol === t; }); if (!rs.length) return '';
      var sup = sumFact(rs.map(function (row) { return histFact(row, 'suppliedUsd', 'supplied'); }), { method: 'sum of supplied over the reserves' });
      var av = sumFact(rs.map(function (row) { return row.sheet.ok ? row.sheet.body.withdrawal.availableUsd : { value: null, reason: row.sheet.reason }; }), { method: 'sum of available over the reserves' });
      var big = rs.slice().sort(function (x, y) { return (histFact(y, 'suppliedUsd', '').value || 0) - (histFact(x, 'suppliedUsd', '').value || 0); })[0];
      var sh = big.sheet.ok ? big.sheet.body : null, note = rs.length > 1 ? '<span class="an-sub">largest reserve</span>' : '';
      return tr(heads, [esc(t), count(num(rs.length)), fig(sup, usd1), fig(av, usd1), sh ? fig(sh.withdrawal.shareLentOut, pct) + note : reason(big.sheet.reason),
        reason('not_collected'), sh ? fig(sh.lenders.top1Share, pct) + note : reason(big.sheet.reason), C.spark(lendSeries(big).map(function (p) { return p.availableUsd; }), 's1') || reason('insufficient_samples')]);
    }).concat(st.assets ? [] : STABLE_OTHER.filter(function (t) { return tokens.indexOf(t) < 0; }).map(function (t) {
      return tr(heads, [esc(t)].concat([0, 1, 2, 3, 4, 5, 6].map(function () { return reason('not_collected'); })), 'a2-dim');
    }));
    document.getElementById('a2-table').innerHTML = table('a2-stable-t', 'Stablecoins by lending reserve', heads, trs);
    C.mount(box);
    wireMulti(box, 'assets', assetOpts, function (v) { st.assets = v; st.pools = null; rerender(); });
    wireMulti(box, 'pools', poolOpts, function (v) { st.pools = v; rerender(); });
    check();
  }

  /* ================= simulation ================= */
  var simSeq = 0;
  function nextOpen(from) {   // the next half hour in market hours, by the API's regime rule
    var t = new Date(Math.ceil(from.getTime() / 18e5) * 18e5);
    for (var i = 0; i < 48 * 12; i++) { if (T.regimeAt(t) === 'us_market_hours') return t; t = new Date(t.getTime() + 18e5); }
    return null;
  }
  function wait(ms) { var h = ms / H; return h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? T.nf({ maximumFractionDigits: 1 }).format(h) + ' h' : T.nf({ maximumFractionDigits: 1 }).format(h / 24) + ' days'; }
  /* ---------------- the paths as a flow: position → path → pools → payout token → dollars received ----------------
     Columns: the position; each path; the pools a routed sale is split across (from the hourly split snapshot, at the
     simulated size nearest the sale, its shares applied to the sale); the token each pool pays out; what you receive.
     Paths are alternatives, not one flow: each has its colour, the best one is drawn strongest. */
  function flowChart(o) {
    var nodes = [], edges = [], byId = {}, seq = 0;
    function node(id, col, label, sub, cls, title) { if (byId[id]) return byId[id]; var nd = { id: id, col: col, label: label, sub: sub, cls: cls || '', title: title || '' }; byId[id] = nd; nodes.push(nd); return nd; }
    function edge(a, b, path, label, w, tip) { edges.push({ a: a, b: b, path: path, label: label, w: w, tip: tip || label, n: ++seq }); }
    var start = node('start', 0, o.id + ' · ' + usd(o.n), 'your position, ' + RW[o.r], 'pos');
    var recv = node('recv', 4, 'Dollars received', 'USDC or USD', 'recv');
    var notes = [];
    var rank = 1;   // the best path takes the strongest colour; the others follow in their order
    o.paths.forEach(function (p) {
      var cls = 'f' + (p === o.best ? 1 : ++rank) + (p === o.best ? ' best' : '') + (p.assumption ? ' assume' : '');
      var pn = node('path:' + p.key, 1, p.name, p.when, 'path ' + cls);
      edge(start, pn, cls, '', 2.5, usd(o.n) + ' of ' + o.id + ' into: ' + p.name);
      var sp = p.key === 'now' ? o.splitNow : p.key === 'split' ? o.splitChunk : null;
      var lossTxt = p.loss && p.loss.value != null ? usd1(o.n - p.loss.value) : p.assumption ? 'assumption' : 'not measured';
      var lossTip = p.loss && p.loss.value != null ? p.name + ': you receive ' + usd(o.n - p.loss.value) + ', a loss of ' + usd(p.loss.value) + ' (' + pct(p.loss.value / o.n) + ')' : p.name + ': ' + lossTxt;
      if (sp && sp.ok && sp.body.legs.length) {
        var sb = sp.body, per = p.key === 'split' ? o.n / o.chunks : o.n, quotes = {};
        var when = iso(sb.fetchedAt).slice(0, 16).replace('T', ' ') + ' UTC, ' + (RW[sb.regime] || sb.regime);
        notes.push(p.name + ': ' + (sb.notionalUsd !== Math.round(per) ? 'shares from the ' + usd(sb.notionalUsd) + ' simulation, the nearest simulated size, ' : 'split simulated at this size, ') + when + '.');
        sb.legs.forEach(function (l) {
          var pool = node('pool:' + l.pool, 2, T.venueW(l.venue) + ' · ' + (l.quote || 'quote not named'), T.short(l.pool) + (l.feeRate != null ? ' · fee ' + pct(l.feeRate) : ''), 'pool', l.pool);
          var k = p.key === 'split' ? o.chunks : 1, amt = l.share * per, tok = sb.refMidUsd ? amt * k / sb.refMidUsd : null;
          edge(pn, pool, cls, T.pct0(l.share) + ' · ' + usd1(amt) + (k > 1 ? ' ×' + k : ''), 1 + 5 * l.share,
            p.name + ': ' + pct(l.share) + ' of each sale, ' + usd(amt) + (k > 1 ? ' in each of ' + k + ' sales' : '') + (tok != null ? ', ' + num(tok, tok < 10 ? 2 : 1) + ' ' + o.id + ' in all' : '') + ', into ' + T.venueW(l.venue) + ' ' + T.short(l.pool));
          var qk = l.exitPath === 'via_sol' || l.quote === 'SOL' ? 'sol' : 'usd';
          var qn = qk === 'sol' ? node('q:sol', 3, 'SOL, swapped to USDC', 'a second hop', 'quote') : node('q:usd', 3, 'USDC / USDT', 'paid out by the pool', 'quote');
          edge(pool, qn, cls, l.costPct != null ? 'cost ' + pct(l.costPct) : 'cost not given', 1 + 5 * l.share,
            p.name + ': this leg costs ' + (l.costPct != null ? pct(l.costPct) : 'an amount not given') + ' (pool fee ' + (l.feeRate != null ? pct(l.feeRate) : 'not given') + ', the rest price impact and basis), paid out in ' + (l.quote || 'the quote token'));
          quotes[qk] = (quotes[qk] || 0) + l.share;
        });
        var qs = Object.keys(quotes);
        qs.forEach(function (qk) { edge(byId['q:' + qk], recv, cls, qk === 'usd' ? lossTxt : T.pct0(quotes[qk]) + ' of it', 1 + 5 * quotes[qk], qk === 'usd' ? lossTip : p.name + ': ' + pct(quotes[qk]) + ' of the sale is paid in SOL and swapped to USDC'); });
      } else if (p.assumption) {
        var iss = node('issuer', 3, 'Issuer redemption', 'settles T+5, KYC', 'quote assume');
        edge(pn, iss, cls, usd1(o.n), 2, 'redeem ' + usd(o.n) + ' with the issuer');
        edge(iss, recv, cls, 'assumption', 2, 'what the issuer pays rests on its published terms, a scenario input');
      } else {
        var why = sp && sp.ok && sp.body.reason ? (T.REASON[sp.body.reason] || sp.body.reason) : p.key === 'open' ? 'no split simulated in market hours yet' : 'no split for this path';
        var same = node('samepools', 2, 'The same pools', why, 'pool muted');
        edge(pn, same, cls, 'routed', 2, p.name + ': the same routed sale; ' + why);
        edge(same, recv, cls, lossTxt, 2, lossTip);
      }
    });
    // layout: fixed columns with wide gaps; labels live in the gaps, pushed apart so none overlaps another or a node
    var NW = [140, 180, 200, 150, 130], GAPW = [92, 168, 120, 112], NH = 48, GAP = 34, PAD = 28, X = [], x = 0;
    NW.forEach(function (w, c) { X.push(x); x += w + (GAPW[c] || 0); });
    var cols = [0, 1, 2, 3, 4].map(function (c) { return nodes.filter(function (nd) { return nd.col === c; }); });
    var Hmax = Math.max.apply(null, cols.map(function (cl) { return cl.length * (NH + GAP) - GAP; }));
    cols.forEach(function (cl, c) { var top = PAD + 24 + (Hmax - (cl.length * (NH + GAP) - GAP)) / 2; cl.forEach(function (nd, i) { nd.x = X[c]; nd.w = NW[c]; nd.y = top + i * (NH + GAP); }); });
    nodes.forEach(function (nd) {   // ports spread along the node's side, ordered by where the other end sits
      var outs = edges.filter(function (e) { return e.a === nd; }).sort(function (p, q) { return p.b.y - q.b.y; });
      var ins = edges.filter(function (e) { return e.b === nd; }).sort(function (p, q) { return p.a.y - q.a.y; });
      outs.forEach(function (e, i) { e.y0 = nd.y + 6 + (NH - 12) * (i + 0.5) / outs.length; });
      ins.forEach(function (e, i) { e.y1 = nd.y + 6 + (NH - 12) * (i + 0.5) / ins.length; });
    });
    var g = '<defs><marker id="a2-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"/></marker></defs>', labels = '';
    var byGap = {};
    edges.forEach(function (e) {
      var x0 = e.a.x + e.a.w, x1 = e.b.x - 2, y0 = e.y0, y1 = e.y1, mx = (x0 + x1) / 2;
      var d = 'M' + x0 + ',' + y0.toFixed(1) + ' C' + mx + ',' + y0.toFixed(1) + ' ' + mx + ',' + y1.toFixed(1) + ' ' + x1 + ',' + y1.toFixed(1);
      g += '<path class="a2-fe ' + e.path + '" d="' + d + '" stroke-width="' + e.w.toFixed(1) + '" marker-end="url(#a2-arrow)"><title>' + esc('[' + e.n + '] ' + e.tip) + '</title></path>';
      if (e.b.col - e.a.col === 1) { e.lx = (x0 + x1) / 2; e.ly = (y0 + y1) / 2; (byGap[e.a.col] || (byGap[e.a.col] = [])).push(e); }
    });
    var H = Hmax + 2 * PAD + 34;
    Object.keys(byGap).forEach(function (k) {   // one column of labels per gap: sorted by height, at least 16px apart
      var list = byGap[k].sort(function (p, q) { return p.ly - q.ly; }), last = -Infinity;
      list.forEach(function (e) { e.ly = Math.max(e.ly, last + 16); last = e.ly; });
      var over = last - (H - 8); if (over > 0) list.forEach(function (e) { e.ly -= over; });
      list.forEach(function (e) {
        var txt = '[' + e.n + ']' + (e.label ? ' ' + e.label : ''), tw = txt.length * 6.1 + 8;
        labels += '<g class="a2-fl ' + e.path + '"><title>' + esc('[' + e.n + '] ' + e.tip) + '</title><rect x="' + (e.lx - tw / 2).toFixed(1) + '" y="' + (e.ly - 8).toFixed(1) + '" width="' + tw.toFixed(1) + '" height="15"/><text x="' + e.lx.toFixed(1) + '" y="' + (e.ly + 3.5).toFixed(1) + '" text-anchor="middle">' + esc(txt) + '</text></g>';
      });
    });
    var W = X[4] + NW[4] + 4;
    nodes.forEach(function (nd) {
      g += '<g class="a2-fn ' + nd.cls + '"><rect x="' + nd.x + '" y="' + nd.y.toFixed(1) + '" width="' + nd.w + '" height="' + NH + '"/>' +
        '<text class="l" x="' + (nd.x + 10) + '" y="' + (nd.y + 19).toFixed(1) + '">' + esc(nd.label.length > 32 ? nd.label.slice(0, 31) + '…' : nd.label) + '</text>' +
        '<text class="s" x="' + (nd.x + 10) + '" y="' + (nd.y + 35).toFixed(1) + '">' + esc(nd.sub.length > 38 ? nd.sub.slice(0, 37) + '…' : nd.sub) + '</text>' +
        (nd.cls.indexOf('best') >= 0 ? '<text class="b" x="' + (nd.x + nd.w - 8) + '" y="' + (nd.y + 35).toFixed(1) + '" text-anchor="end">best</text>' : '') +
        '<title>' + esc(nd.label + ' · ' + nd.sub + (nd.title ? ' · ' + nd.title : '')) + '</title></g>';
    });
    ['Position', 'Path', 'Pools the sale is split across', 'Paid out in', 'You receive'].forEach(function (t, c) { g += '<text class="a2-fh" x="' + X[c] + '" y="16">' + esc(t) + '</text>'; });
    var sn = o.splitNow && o.splitNow.ok && o.splitNow.body.fetchedAt ? o.splitNow.body : null;
    var src = sn ? srcLine(mk(1, { source: sn.source, fetchedAt: sn.fetchedAt, method: sn.method, methodVersion: sn.methodVersion }), 'the flow chart') : '';
    return '<div class="a2-flow an-scroll" role="region" tabindex="0" aria-label="The paths as a flow, scrolls sideways"><svg viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" width="100%" role="img" aria-label="' + esc('Flow of a ' + usd(o.n) + ' sale of ' + o.id + ' through each path, its pools and payout token, to the dollars received') + '">' + g + labels + '</svg></div>' +
      '<p class="an-note a2-flownote">Each colour is one path; they are alternatives, not one sale. The best path is drawn strongest; issuer redemption is dashed because it rests on the issuer’s terms. Line width follows each pool’s share of the sale. ' + esc(notes.join(' ')) + ' Received amounts and losses are the table’s, the fitted cost at the exact size; the split shows where the sale goes.</p>' + src;
  }

  function simPage(pg) {
    var box = document.getElementById('a2-page');
    return base().then(function (b) {
      if (P.page !== pg.id) return;
      if (!b.assets.ok) { box.innerHTML = '<p>' + reason(b.assets.reason) + '</p>'; return; }
      var ids = b.assets.body.assets.map(function (a) { return a.symbol; }).sort();
      if (ids.indexOf(P.sim.asset) < 0) P.sim.asset = ids[0];
      box.innerHTML = '<form class="a2-simform an-card" novalidate>' +
        '<label class="an-field"><span>Asset to sell</span><select name="asset">' + ids.map(function (id) { return '<option' + (id === P.sim.asset ? ' selected' : '') + '>' + esc(id) + '</option>'; }).join('') + '</select></label>' +
        '<label class="an-field"><span>Amount, USD</span><input name="size" inputmode="decimal" autocomplete="off" value="' + esc(String(P.sim.size)) + '" aria-describedby="a2-size-err"></label>' +
        '<button type="submit" class="an-btn primary">Simulate</button><p class="an-meta a2-err" id="a2-size-err" role="alert"></p></form>' +
        '<div id="a2-simout" aria-live="polite"></div>';
      var form = box.querySelector('form');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var raw = String(form.size.value).trim().replace(/[$,\s]/g, ''), mult = /k$/i.test(raw) ? 1e3 : /m$/i.test(raw) ? 1e6 : 1, v = parseFloat(raw.replace(/[km]$/i, '')) * mult;
        var err = document.getElementById('a2-size-err');
        if (!(v >= 100) || v > 1e9) { err.textContent = 'Enter an amount between $100 and $1,000,000,000, for example 250000 or 250k.'; form.size.focus(); return; }
        err.textContent = ''; P.sim = { asset: form.asset.value, size: Math.round(v), kyc: false }; simRun(b);
      });
      form.asset.addEventListener('change', function () { form.requestSubmit(); });
      simRun(b);
    });
  }
  function simRun(b) {
    var seq = ++simSeq, out = document.getElementById('a2-simout'), id = P.sim.asset, n = P.sim.size, at = nowAt(), r = T.regimeAt(at), body = b.assets.body;
    var a = body.assets.filter(function (x) { return x.symbol === id; })[0];
    out.innerHTML = '<p class="an-loading">Pricing ' + esc(usd(n)) + ' of ' + esc(id) + '…</p>';
    var cap = capFact(a, r, body), split = cap.value && cap.value > 0 && n > cap.value ? Math.ceil(n / cap.value) : 0;
    if (split > 48) split = 0;   // more than two days of hourly sales is not a path worth printing
    var reads = [get(R2.sheet(id, n)), get(R2.recov(id, n, P.sim.kyc)), split ? get(R2.sheet(id, n / split)) : Promise.resolve(null), get(R2.split(id, n)), split ? get(R2.split(id, n / split)) : Promise.resolve(null)];
    Promise.all(reads).then(function (rs) {
      if (seq !== simSeq || P.page !== 'simulation') return;
      var s = rs[0], rec = rs[1], sc = rs[2], fNow = rs[3], fSplit = rs[4];
      if (!s.ok) { out.innerHTML = '<p>' + reason(s.reason) + '</p>'; return; }
      var cost = function (sheet, g) { var c = sheet.costs.filter(function (x) { return x.regime === g; })[0]; return c ? c.exit : null; };
      var miss = { value: null, reason: 'no_samples_in_regime' };
      var paths = [], now = cost(s.body, r);
      paths.push({ key: 'now', name: 'Sell now across the pools', how: 'one routed sale, split across the asset’s dollar pools', when: 'now · ' + RW[r], total: now ? now.total : miss, loss: now ? now.lossUsd : miss, ex: now });
      if (r !== 'us_market_hours') {
        var mh = cost(s.body, 'us_market_hours'), op = nextOpen(at);
        paths.push({ key: 'open', name: 'Wait for market hours', how: 'the same routed sale at the next US open; the price can move while you wait', when: op ? 'in ' + wait(op - at) + ' · ' + T.etParts(op).label : 'next open not found', total: mh ? mh.total : miss, loss: mh ? mh.lossUsd : miss, ex: mh, waits: true });
      }
      if (split && sc && sc.ok) {
        var ce = cost(sc.body, r), dr = (s.body.liquidityStability.depthRecovery || []).filter(function (x) { return x.regime === r; })[0];
        var h90 = dr && dr.hoursTo90 && dr.hoursTo90.value != null ? dr.hoursTo90.value : null;
        var lossS = ce && ce.lossUsd.value != null ? mk(ce.lossUsd.value * split, { quality: ce.lossUsd.quality, source: ce.lossUsd.source, fetchedAt: ce.lossUsd.fetchedAt, regime: r, sizeUsd: n / split, method: split + ' × the loss of one sale of ' + usd(n / split) + ' (exit.lossUsd at that size), assuming the pools refill between sales', methodVersion: ce.lossUsd.methodVersion }) : miss;
        paths.push({ key: 'split', name: 'Split into ' + split + ' hourly sales', how: split + ' sales of ' + usd(n / split) + ', each within the 1% capacity, one an hour; it assumes the pools refill between sales' + (h90 != null ? ' (after large trades they recovered 90% of depth in a median ' + num(h90 * 60, 0) + ' min)' : ''), when: 'over ' + split + ' h · ' + RW[r], total: ce ? ce.total : miss, loss: lossS, ex: ce, waits: true });
      }
      var pr = rec.ok ? rec.body.primary : null;
      if (pr) paths.push({ key: 'issuer', name: 'Redeem with the issuer', how: (pr.issuer || 'the issuer') + ': ' + String(pr.status || 'status not given').replace(/_/g, ' ') + '; ' + (pr.settlementHours != null ? 'settles in ' + num(pr.settlementHours / 24, 0) + ' days' : 'settlement time not given') + '; needs KYC with the issuer', when: pr.openHoursInHorizon ? pr.openHoursInHorizon + ' open hours in the next 7 days' : 'no open window in the next 7 days', assumption: true,
        capF: mk(pr.capacityUsd, { quality: 'assumption', source: pr.source, fetchedAt: rec.body.at, method: 'issuer model: redemption capacity in the open hours of the next 7 days (GET /risk/recoverable)', methodVersion: rec.body.methodVersion }) });
      var measured = paths.filter(function (p) { return !p.assumption && p.loss && p.loss.value != null; });
      var best = measured.slice().sort(function (x, y) { return x.loss.value - y.loss.value || (x.waits ? 1 : 0) - (y.waits ? 1 : 0); })[0];
      var verdict;
      if (!best) verdict = 'No measured route prices ' + usd(n) + ' of ' + id + ' right now: ' + (T.REASON[(now ? now.total : miss).reason] || 'no figure') + '. The simulation never extends a curve past what was measured.';
      else verdict = 'Best path for ' + usd(n) + ' of ' + id + ' now: ' + best.name.toLowerCase() + '. It loses ' + (best.loss.quality === 'lower_bound' ? 'at least ' : '') + usd(best.loss.value) + ' (' + pct(best.loss.value / n) + ')' +
        (best.key === 'now' ? '.' : paths[0].loss.value != null ? ', against ' + usd(paths[0].loss.value) + ' selling all of it now.' : '.') + (best.waits ? ' Waiting carries price risk this loss does not count.' : '');
      var heads = [['Path'], ['How'], ['When'], ['Cost', 1], ['Loss', 1]];
      var trs = paths.map(function (p) {
        return tr(heads, [(p === best ? T.status('on', 'best') + ' ' : '') + '<b>' + esc(p.name) + '</b>', esc(p.how), esc(p.when),
          p.assumption ? fig(p.capF, usd1) + '<span class="an-sub">capacity, not a cost</span>' : fig(p.total, pct),
          p.assumption ? '<span class="an-note">never chosen over a measured route</span>' : fig(p.loss, usd)], p === best ? 'sel' : '');
      });
      var ex = best && best.ex, comps = [['poolFee', 'pool fee'], ['transferFee', 'transfer fee'], ['impact', 'price impact'], ['basis', 'basis against the reference'], ['platformFee', 'platform fee']];
      var parts = ex ? '<dl class="a2-split">' + comps.map(function (k) { return ex[k[0]] ? '<div><dt>' + esc(k[1]) + '</dt><dd>' + fig(ex[k[0]], pct) + '</dd></div>' : ''; }).join('') + (ex.networkFeeUsd ? '<div><dt>network fee</dt><dd>' + fig(ex.networkFeeUsd, usd) + '</dd></div>' : '') + '</dl>' : '';
      var rh = [['Time of week'], ['Cost', 1], ['Loss', 1]];
      var byReg = REGIMES.map(function (g) { var e = cost(s.body, g); return tr(rh, [esc(RW[g]) + (g === r ? ' <span class="an-sub">now</span>' : ''), e ? fig(e.total, pct) : reason('no_samples_in_regime'), e ? fig(e.lossUsd, usd) : reason('no_samples_in_regime')]); });
      out.innerHTML = '<div class="a2-kpis">' + kpi('Sale', count(usd(n)), esc(id) + ', your input') + kpi('Time of week now', '<span class="a2-word">' + esc(RW[r]) + '</span>', esc(T.etParts(at).label)) +
        kpi('Exit capacity now', fig(cap, usd1), 'sale at ≤ 1% cost') + kpi('Loss on the best path', best ? fig(best.loss, usd) : reason('no_samples_in_regime'), best ? esc(pct(best.loss.value / n)) + ' of the sale' : '') + '</div>' +
        '<p class="a2-verdict">' + esc(verdict) + '</p>' +
        '<section class="a2-sec"><h2>Paths, as a flow</h2>' + flowChart({ id: id, n: n, r: r, paths: paths, best: best, splitNow: fNow, splitChunk: fSplit, chunks: split }) + '</section>' +
        '<section class="a2-sec"><h2>Paths</h2>' + table('a2-sim-t', 'Ways to sell, with cost and loss', heads, trs) +
        '<p class="an-note">The best path is the measured one with the smallest loss; on a tie, the one that does not wait. Issuer redemption rests on the issuer’s published terms, a scenario input, so it is shown but never chosen over a measured route.</p></section>' +
        (ex ? '<section class="a2-sec"><h2>What the best path pays</h2>' + parts + '</section>' : '') +
        '<section class="a2-sec"><h2>The same sale by time of week</h2>' + table('a2-sim-r', 'Cost by time of week', rh, byReg) + '</section>';
      check();
    });
  }

  /* ---------------- DOM check (?check=1): every figure has a pin ---------------- */
  var checkT;
  function check() {
    if (!CHECK) return;
    clearTimeout(checkT);
    checkT = setTimeout(function () {
      var nums = view.querySelectorAll('.an-num'), noPin = 0;
      nums.forEach(function (n) { var nx = n.nextElementSibling; if (nx && nx.classList.contains('an-pin')) return; var m = n.closest('.an-cc'); if (m && m.querySelector('.an-mockplate')) return; noPin++; });
      console.log('[analytics2 check] page ' + P.page + ' · figures ' + nums.length + ' · pins ' + view.querySelectorAll('.an-pin').length + ' · figures without a pin ' + noPin + ' · counts and inputs (no pin by design) ' + view.querySelectorAll('.a2-count').length + ' · reasons ' + view.querySelectorAll('.an-reason').length + ' · mode ' + S.mode);
      if (noPin) console.error('[analytics2 check] FAILED');
    }, 400);
  }

  /* ---------------- routing: #analytics2 and #analytics2/<page>; analytics.js handles every other hash ---------------- */
  var booted = null;
  function route() {
    var m = /^#analytics2(?:\/([a-z]+))?$/.exec(location.hash || '');
    var link = document.querySelector('.menu a[href="#analytics2"]');
    if (!m) { view.hidden = true; if (link) link.removeAttribute('aria-current'); return; }
    var pg = PAGES.filter(function (p) { return p.id === m[1]; })[0] || PAGES[0];
    var was = !view.hidden;
    document.body.classList.add('an-open');   // the first view's switch: landing hidden, scene paused, compact bar
    document.getElementById('analytics').hidden = true;
    view.hidden = false;
    if (link) link.setAttribute('aria-current', 'page');
    if (!was) window.scrollTo(0, 0);
    window.dispatchEvent(new Event('scroll'));
    if (!booted) { shell(); booted = T.ready(); }
    booted.then(function () {
      base().then(function (b) { banner(b.assets); });
      if (P.page === pg.id && was) return;
      P.page = pg.id; T.closePop(false);
      view.querySelectorAll('[data-page]').forEach(function (a) { if (a.getAttribute('data-page') === pg.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      document.getElementById('a2-lede').textContent = pg.lede;
      if (was) window.scrollTo(0, 0);
      ({ dex: dexPage, lend: lendPage, stable: stablePage, sim: simPage })[pg.kind](pg);
    });
  }
  function boot() {
    view = document.getElementById('analytics2');
    if (!view) return;
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
