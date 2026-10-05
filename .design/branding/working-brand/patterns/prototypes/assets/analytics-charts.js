/* Chart engine for the Bearing analytics view (window.TF_CHARTS), inline SVG, no library.
   Cards in the DefiLlama manner (headline value, range tabs, one filled area), trading panes (candles, a pane
   under the price, value axis on the right, crosshair with axis tags and an OHLC readout), an exchange depth chart,
   the CLMM liquidity distribution (bars by price around the pool price, zoom), and sparklines.
   Charts draw at their real pixel width and redraw on resize, so type stays 11–12px at every width.
   Brand: wood only (two series at most: hinoki / wood-400 on dark, heartwood / wood-400 on paper), flat fills,
   square marks, hairline grid, solid = measured, dashed = too few samples. Up candles hollow, down candles
   filled, so direction never rests on colour. Callers mount placeholders: markup first, then mount(root). */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg', CFG = {}, seq = 0;
  var FONT = 11, AX = 64, XA = 22;   // right value axis width, bottom time axis height
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
  function nice(d0, d1, n) {
    if (d1 === d0) { d1 = d0 + (Math.abs(d0) || 1); }
    var span = d1 - d0, step = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var lo = Math.floor(d0 / step) * step, hi = Math.ceil(d1 / step) * step, t = [];
    for (var v = lo; v <= hi + step / 2; v += step) t.push(+v.toFixed(12));
    return { lo: lo, hi: hi, ticks: t };
  }
  var DAY = 864e5;
  function timeTicks(t0, t1, maxN) {
    var span = t1 - t0, steps = [3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30.44 * DAY, 91.3 * DAY, 182.6 * DAY, 365.25 * DAY];
    var step = steps.filter(function (s) { return span / s <= maxN; })[0] || 365.25 * DAY, out = [];
    if (step >= 30 * DAY) { var d = new Date(t0); d = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); var m = Math.round(step / (30.44 * DAY));
      for (; d <= t1; d = Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth() + m, 1)) out.push(d); }
    else for (var v = Math.ceil(t0 / step) * step; v <= t1; v += step) out.push(v);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return { ticks: out, fmt: function (v) { var d = new Date(v); return step < DAY ? ('0' + d.getUTCHours()).slice(-2) + ':00' : step < 30 * DAY ? d.getUTCDate() + ' ' + M[d.getUTCMonth()] : d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : M[d.getUTCMonth()]; } };
  }
  function fullDate(t, hourly) { var s = new Date(t).toISOString(); return hourly ? s.slice(0, 16).replace('T', ' ') + ' UTC' : s.slice(0, 10); }
  function svg(w, h, inner) { return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" xmlns="' + NS + '">' + inner + '</svg>'; }
  function tag(x, y, text, cls, anchor) {   // an axis tag: a small solid plate with mono text (the crosshair and last-value labels)
    var w = text.length * 6.7 + 10, h = 18, x0 = anchor === 'middle' ? x - w / 2 : x, y0 = y - h / 2;
    return '<g class="tag ' + (cls || '') + '"><rect x="' + x0.toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h + '"/><text x="' + (x0 + 5).toFixed(1) + '" y="' + (y0 + 13).toFixed(1) + '">' + esc(text) + '</text></g>';
  }
  function place(id, kind, cfg) { var k = 'tfc' + (++seq); cfg.kind = kind; CFG[k] = cfg; return '<div class="an-cc ' + (cfg.cls || '') + '" data-cc="' + k + '" data-kind="' + kind + '"></div>'; }

  /* ================= time chart: card header, range tabs, panes ================= */
  /**
   * time({ title, value (html, pinned, from the caller), note, ranges:[{label, ms|null}], range (index),
   *        panes:[{ h, series:[{ type:'area'|'line'|'candle'|'bar', cls:'s1'|'s2', label, data:[{t, v}|{t,o,h,l,c}], dashedKey }], fmt, zero, refs:[{v,label}] }],
   *        hourly (readout format), bands:[{t0,t1,label}], aria, src (html), empty (html when no data), rangeTools (html beside the ranges) })
 *   A point may carry `show` (the readout text in place of fmt(v)); a pane may set `tagSeries` (the series whose last value
 *   tags the axis) and a series `noDot` (no hover square), which together draw a 100% stack as two areas, top one first.
   */
  function time(cfg) { return place(null, 'time', cfg); }
  function drawTime(el, c) {
    var W = Math.max(280, el.clientWidth), r = c.ranges && c.ranges[c.range || 0], all = [];
    c.panes.forEach(function (p) { p.series.forEach(function (s) { s.data.forEach(function (d) { all.push(d.t); }); }); });
    if (!all.length) { el.innerHTML = head(c) + '<div class="cc-empty">' + (c.empty || 'No data') + '</div>' + (c.src || ''); return; }
    var tMax = Math.max.apply(null, all), tMin = Math.min.apply(null, all), t0 = r && r.ms ? Math.max(tMin, tMax - r.ms) : tMin;
    var vis = function (d) { return d.t >= t0 && d.t <= tMax; };
    // bar width for candles/bars from the data spacing
    var spacing = Infinity; c.panes.forEach(function (p) { p.series.forEach(function (s) { var ts = s.data.filter(vis).map(function (d) { return d.t; }); for (var i = 1; i < ts.length; i++) spacing = Math.min(spacing, ts[i] - ts[i - 1]); }); });
    if (!isFinite(spacing)) spacing = 3600e3;
    var pad = c.panes.some(function (p) { return p.series.some(function (s) { return s.type === 'candle' || s.type === 'bar'; }); }) ? spacing * 0.6 : 0;
    var plotW = W - AX - 8, X = function (t) { return 8 + (t - (t0 - pad)) / ((tMax + pad) - (t0 - pad) || 1) * plotW; };
    var g = '', y = 8, panesGeo = [];
    (c.bands || []).forEach(function (b) { var a = Math.max(8, X(b.t0)), z = Math.min(8 + plotW, X(b.t1)); if (z > a) g += '<rect class="cc-band" x="' + a.toFixed(1) + '" y="0" width="' + (z - a).toFixed(1) + '" height="__H__"><title>' + esc(b.label) + '</title></rect>'; });
    c.panes.forEach(function (p, pi) {
      var vals = [];
      p.series.forEach(function (s) { s.data.filter(vis).forEach(function (d) { if (s.type === 'candle') { vals.push(d.h, d.l); } else if (d.v != null) vals.push(d.v); }); });
      (p.refs || []).forEach(function (rf) { vals.push(rf.v); });
      if (!vals.length) vals = [0, 1];
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (p.zero !== false) lo = Math.min(0, lo);
      if (p.max != null) hi = Math.min(hi, p.max);
      var n = nice(lo, hi + (hi - lo) * 0.06, Math.max(2, Math.round(p.h / 48)));
      if (p.zero === false) { n.lo = Math.max(n.lo, lo - (hi - lo) * 0.08); }
      if (p.max != null && n.hi > p.max) n.hi = p.max;   // a share never draws past 100%
      var Y = (function (top, h, a, b) { return function (v) { return top + h - (v - a) / ((b - a) || 1) * h; }; })(y, p.h, n.lo, n.hi);
      n.ticks.forEach(function (t) { if (t < n.lo - 1e-12 || t > n.hi + 1e-12) return; g += '<line class="cc-grid" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/><text class="cc-ax" x="' + (W - AX + 6) + '" y="' + (Y(t) + 4).toFixed(1) + '">' + esc(p.fmt(t)) + '</text>'; });
      (p.refs || []).forEach(function (rf) { g += '<line class="cc-ref" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(rf.v).toFixed(1) + '" y2="' + Y(rf.v).toFixed(1) + '"/><text class="cc-reflab" x="12" y="' + (Y(rf.v) - 4).toFixed(1) + '">' + esc(rf.label) + '</text>'; });
      g += '<clipPath id="' + el.dataset.cc + 'p' + pi + '"><rect x="8" y="' + y + '" width="' + plotW + '" height="' + p.h + '"/></clipPath><g clip-path="url(#' + el.dataset.cc + 'p' + pi + ')">';
      p.series.forEach(function (s) {
        var d = s.data.filter(vis);
        if (s.type === 'area' || s.type === 'line') {
          var segs = [], cur = null;
          d.forEach(function (q) { if (q.v == null) { cur = null; return; } var dash = !!q.dashed; if (!cur || cur.dash !== dash) { var prev = cur && cur.pts[cur.pts.length - 1]; cur = { dash: dash, pts: prev ? [prev] : [] }; segs.push(cur); } cur.pts.push([X(q.t), Y(q.v)]); });
          segs.forEach(function (sg) {
            var pts = sg.pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ');
            if (s.type === 'area' && !sg.dash && sg.pts.length > 1) g += '<polygon class="cc-area ' + s.cls + '" points="' + sg.pts[0][0].toFixed(1) + ',' + Y(Math.max(n.lo, 0)).toFixed(1) + ' ' + pts + ' ' + sg.pts[sg.pts.length - 1][0].toFixed(1) + ',' + Y(Math.max(n.lo, 0)).toFixed(1) + '"/>';
            g += '<polyline class="cc-line ' + s.cls + (sg.dash ? ' dash' : '') + '" points="' + pts + '"/>';
          });
        } else if (s.type === 'candle') {
          var bw = Math.max(1, Math.min(14, (X(t0 + spacing) - X(t0)) * 0.7));
          d.forEach(function (q) {
            var x = X(q.t), up = q.c >= q.o, top = Y(Math.max(q.o, q.c)), bot = Y(Math.min(q.o, q.c));
            g += '<line class="cc-wick" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + Y(q.h).toFixed(1) + '" y2="' + Y(q.l).toFixed(1) + '"/>';
            g += '<rect class="cc-candle ' + (up ? 'up' : 'down') + '" x="' + (x - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, bot - top).toFixed(1) + '"/>';
          });
        } else if (s.type === 'bar') {
          var bw2 = Math.max(1, (X(t0 + spacing) - X(t0)) * 0.7);
          d.forEach(function (q) { if (q.v == null) return; g += '<rect class="cc-bar ' + s.cls + '" x="' + (X(q.t) - bw2 / 2).toFixed(1) + '" y="' + Y(Math.max(0, q.v)).toFixed(1) + '" width="' + bw2.toFixed(1) + '" height="' + Math.abs(Y(q.v) - Y(0)).toFixed(1) + '"/>'; });
        }
      });
      g += '</g>';
      // last value tag on the axis for the first series
      var s0 = p.series[p.tagSeries || 0], lastD = s0.data.filter(vis).filter(function (q) { return s0.type === 'candle' ? q.c != null : q.v != null; }).pop();
      if (lastD) { var lv = s0.type === 'candle' ? lastD.c : lastD.v; g += '<line class="cc-last" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(lv).toFixed(1) + '" y2="' + Y(lv).toFixed(1) + '"/>' + tag(W - AX + 2, Y(lv), p.fmt(lv), 'last ' + s0.cls); }
      if (pi > 0) g += '<line class="cc-sep" x1="0" x2="' + W + '" y1="' + (y - 4) + '" y2="' + (y - 4) + '"/>';
      if (p.title) g += '<text class="cc-panetitle" x="12" y="' + (y + 13) + '">' + esc(p.title) + '</text>';
      panesGeo.push({ top: y, h: p.h, Y: Y, lo: n.lo, hi: n.hi, fmt: p.fmt, series: p.series });
      y += p.h + 12;
    });
    var plotH = y - 12, H = plotH + XA;
    g = g.replace(/__H__/g, String(plotH));
    var tt = timeTicks(t0, tMax, Math.max(2, Math.floor(plotW / 90)));
    tt.ticks.forEach(function (t) { var px = X(t); if (px < 20 || px > 8 + plotW - 10) return; g += '<line class="cc-tick" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + plotH + '" y2="' + (plotH + 4) + '"/><text class="cc-ax" x="' + px.toFixed(1) + '" y="' + (plotH + 16) + '" text-anchor="middle">' + esc(tt.fmt(t)) + '</text>'; });
    g += '<line class="cc-axis" x1="8" x2="' + (8 + plotW) + '" y1="' + plotH + '" y2="' + plotH + '"/>';
    g += '<g class="cc-hover"></g><rect class="cc-hit" x="8" y="0" width="' + plotW + '" height="' + plotH + '"/>';
    el.innerHTML = head(c) + '<div class="cc-read" aria-live="polite"></div><div class="cc-plot" tabindex="0" role="img" aria-label="' + esc(c.aria || c.title || '') + '">' + svg(W, H, g) + '</div>' + (c.legend ? legend(c) : '') + (c.src || '');
    // hover: the nearest timestamp across panes
    var ts = []; c.panes.forEach(function (p) { p.series.forEach(function (s) { s.data.filter(vis).forEach(function (d) { if (ts.indexOf(d.t) < 0) ts.push(d.t); }); }); });
    ts.sort(function (a, b) { return a - b; });
    var root = el.querySelector('.cc-plot > svg'),   /* the plot's svg: the header's pin is an svg too */ hov = root.querySelector('.cc-hover'), read = el.querySelector('.cc-read'), idx = ts.length - 1;
    function readout(t) {
      var parts = ['<span class="d">' + esc(fullDate(t, c.hourly)) + '</span>'];
      c.panes.forEach(function (p) { p.series.forEach(function (s) {
        var q = s.data.filter(function (d) { return d.t === t; })[0]; if (!q) return;
        if (s.type === 'candle') parts.push('<span>O <b>' + esc(p.fmt(q.o)) + '</b> H <b>' + esc(p.fmt(q.h)) + '</b> L <b>' + esc(p.fmt(q.l)) + '</b> C <b>' + esc(p.fmt(q.c)) + '</b></span>');
        else parts.push('<span><i class="' + s.cls + '"></i>' + esc(s.label) + ' <b>' + (q.v == null ? 'no value' : esc(q.show != null ? q.show : p.fmt(q.v))) + '</b>' + (q.dashed ? ' too few samples' : '') + '</span>');
      }); });
      read.innerHTML = parts.join('');
    }
    function at(i, py) {
      idx = Math.max(0, Math.min(ts.length - 1, i)); var t = ts[idx], px = X(t), h = '<line class="cc-cross" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="0" y2="' + plotH + '"/>' + tag(px, plotH + 11, fullDate(t, c.hourly).replace(' UTC', ''), 'x', 'middle');
      var pg = panesGeo.filter(function (g2) { return py != null && py >= g2.top && py <= g2.top + g2.h; })[0];
      if (pg) { var v = pg.lo + (pg.top + pg.h - py) / pg.h * (pg.hi - pg.lo); h += '<line class="cc-cross" x1="8" x2="' + (8 + plotW) + '" y1="' + py.toFixed(1) + '" y2="' + py.toFixed(1) + '"/>' + tag(W - AX + 2, py, pg.fmt(v), 'y'); }
      panesGeo.forEach(function (g2) { g2.series.forEach(function (s) { var q = s.data.filter(function (d) { return d.t === t; })[0]; if (!q || s.noDot || s.type === 'candle' || s.type === 'bar' || q.v == null) return; h += '<rect class="cc-dot ' + s.cls + '" x="' + (px - 3.5).toFixed(1) + '" y="' + (g2.Y(q.v) - 3.5).toFixed(1) + '" width="7" height="7"/>'; }); });
      hov.innerHTML = h; readout(t);
    }
    function pt(ev) { var p = root.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(root.getScreenCTM().inverse()); }
    root.addEventListener('mousemove', function (ev) { var p = pt(ev), best = 0, bd = Infinity; ts.forEach(function (t, i) { var dd = Math.abs(X(t) - p.x); if (dd < bd) { bd = dd; best = i; } }); at(best, p.y); });
    root.addEventListener('mouseleave', function () { hov.innerHTML = ''; readout(ts[ts.length - 1]); });
    var plot = el.querySelector('.cc-plot');
    plot.addEventListener('keydown', function (ev) { var d = { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 }[ev.key]; if (d == null) return; ev.preventDefault(); at(idx + d, null); });
    plot.addEventListener('blur', function () { hov.innerHTML = ''; });
    readout(ts[ts.length - 1]);
    el.querySelectorAll('[data-range]').forEach(function (b) { b.addEventListener('click', function () { c.range = +b.getAttribute('data-range'); drawTime(el, c); }); });
  }
  function head(c) {
    return '<div class="cc-head"><div class="cc-title"><div class="t">' + esc(c.title) + '</div>' + (c.value ? '<div class="v">' + c.value + '</div>' : '') + (c.note ? '<div class="n">' + c.note + '</div>' : '') + '</div>' +
      '<div class="cc-rangebar">' + (c.ranges && c.ranges.length > 1 ? '<div class="an-seg cc-ranges" role="group" aria-label="Range">' + c.ranges.map(function (r, i) { return '<button type="button" data-range="' + i + '" aria-pressed="' + (i === (c.range || 0)) + '">' + esc(r.label) + '</button>'; }).join('') + '</div>' : '') + (c.rangeTools || '') + '</div>' + (c.tools || '') + '</div>';
  }
  function legend(c) { return '<div class="an-legend cc-legend">' + c.legend.map(function (l) { return '<span><i class="' + l.cls + '"></i>' + esc(l.label) + '</span>'; }).join('') + '</div>'; }

  /* ================= depth chart (exchange style): cumulative size by cost, both sides ================= */
  /** depth({ title, value, note, sell:[{x:cost, n, dashed}], buy:[...], xmax, fmtX, fmtY, src, aria }) */
  function depth(cfg) { return place(null, 'depth', cfg); }
  function drawDepth(el, c) {
    var W = Math.max(280, el.clientWidth), H = c.h || 260, plotW = W - AX - 8, plotH = H - XA, xm = c.xmax;
    var X = function (x) { return 8 + (x + xm) / (2 * xm) * plotW; };
    var pts = c.sell.concat(c.buy).filter(function (p) { return Math.abs(p.x) <= xm + 1e-12; });
    var ny = nice(0, Math.max.apply(null, pts.map(function (p) { return p.n; }).concat([1])) * 1.06, 4), Y = function (v) { return 8 + (plotH - 8) - v / ny.hi * (plotH - 8); };
    var g = '';
    ny.ticks.forEach(function (t) { g += '<line class="cc-grid" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/><text class="cc-ax" x="' + (W - AX + 6) + '" y="' + (Y(t) + 4).toFixed(1) + '">' + esc(c.fmtY(t)) + '</text>'; });
    function stepPath(side, sign) {   // step-after from the mid outwards, then down to the axis
      var p = side.slice().sort(function (a, b) { return Math.abs(a.x) - Math.abs(b.x); }), d = 'M' + X(0).toFixed(1) + ',' + Y(0).toFixed(1), prevN = 0;
      for (var k = 0; k < p.length; k++) { var q = p[k]; if (Math.abs(q.x) > xm) break;   // the step stops at the chart edge: nothing past it is drawn
        var x = X(q.x); d += ' L' + x.toFixed(1) + ',' + Y(prevN).toFixed(1) + ' L' + x.toFixed(1) + ',' + Y(q.n).toFixed(1); prevN = q.n; }
      d += ' L' + X(sign * xm).toFixed(1) + ',' + Y(prevN).toFixed(1);
      return { line: d, area: d + ' L' + X(sign * xm).toFixed(1) + ',' + Y(0).toFixed(1) + ' Z' };
    }
    var sP = stepPath(c.sell, -1), bP = stepPath(c.buy, 1);
    g += '<clipPath id="' + el.dataset.cc + 'd"><rect x="8" y="0" width="' + plotW + '" height="' + plotH + '"/></clipPath><g clip-path="url(#' + el.dataset.cc + 'd)">' +
      '<path class="cc-area s2" d="' + sP.area + '"/><path class="cc-line s2" d="' + sP.line + '"/><path class="cc-area s1" d="' + bP.area + '"/><path class="cc-line s1" d="' + bP.line + '"/></g>';
    pts.forEach(function (p) { g += '<rect class="cc-dot ' + (p.x < 0 ? 's2' : 's1') + '" x="' + (X(p.x) - 3).toFixed(1) + '" y="' + (Y(p.n) - 3).toFixed(1) + '" width="6" height="6"/>'; });
    g += '<line class="cc-mid" x1="' + X(0) + '" x2="' + X(0) + '" y1="4" y2="' + plotH + '"/>' + tag(X(0), 10, 'pool mid', 'mid', 'middle');
    [-1, -0.5, 0.5, 1].forEach(function (f) { var x = X(f * xm); g += '<text class="cc-ax" x="' + x.toFixed(1) + '" y="' + (plotH + 16) + '" text-anchor="middle">' + esc(c.fmtX(f * xm)) + '</text>'; });
    g += '<text class="cc-ax" x="' + (X(0)).toFixed(1) + '" y="' + (plotH + 16) + '" text-anchor="middle">0</text><line class="cc-axis" x1="8" x2="' + (8 + plotW) + '" y1="' + plotH + '" y2="' + plotH + '"/>';
    g += '<text class="cc-side" x="14" y="' + (plotH - 8) + '">sell ←</text><text class="cc-side" x="' + (8 + plotW - 6) + '" y="' + (plotH - 8) + '" text-anchor="end">→ buy</text>';
    g += '<g class="cc-hover"></g><rect class="cc-hit" x="8" y="0" width="' + plotW + '" height="' + plotH + '"/>';
    el.innerHTML = head(c) + '<div class="cc-read" aria-live="polite"></div><div class="cc-plot" tabindex="0" role="img" aria-label="' + esc(c.aria || '') + '">' + svg(W, H, g) + '</div>' + legend({ legend: [{ cls: 's2', label: 'sell (exit)' }, { cls: 's1', label: 'buy (entry)' }] }) + (c.src || '');
    var root = el.querySelector('.cc-plot > svg'),   /* the plot's svg: the header's pin is an svg too */ hov = root.querySelector('.cc-hover'), read = el.querySelector('.cc-read'), sorted = pts.slice().sort(function (a, b) { return a.x - b.x; }), idx = -1;
    function show(i) {
      idx = Math.max(0, Math.min(sorted.length - 1, i)); var p = sorted[idx], px = X(p.x);
      hov.innerHTML = '<line class="cc-cross" x1="' + px + '" x2="' + px + '" y1="0" y2="' + plotH + '"/><line class="cc-cross" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(p.n) + '" y2="' + Y(p.n) + '"/>' + tag(W - AX + 2, Y(p.n), c.fmtY(p.n), 'y') + tag(px, plotH + 11, c.fmtX(p.x), 'x', 'middle');
      read.innerHTML = '<span><i class="' + (p.x < 0 ? 's2' : 's1') + '"></i>' + (p.x < 0 ? 'sell ' : 'buy ') + '<b>' + esc(c.fmtY(p.n)) + '</b> at an average cost of <b>' + esc(c.fmtX(Math.abs(p.x)).replace('+', '').replace('−', '')) + '</b>' + (p.dashed ? ' (too few samples)' : '') + '</span>';
    }
    function pt(ev) { var q = root.createSVGPoint(); q.x = ev.clientX; q.y = ev.clientY; return q.matrixTransform(root.getScreenCTM().inverse()); }
    root.addEventListener('mousemove', function (ev) { var q = pt(ev), best = 0, bd = Infinity; sorted.forEach(function (p, i) { var d = Math.abs(X(p.x) - q.x); if (d < bd) { bd = d; best = i; } }); show(best); });
    root.addEventListener('mouseleave', function () { hov.innerHTML = ''; read.innerHTML = c.readIdle || ''; });
    el.querySelector('.cc-plot').addEventListener('keydown', function (ev) { var d = { ArrowRight: 1, ArrowLeft: -1 }[ev.key]; if (d == null) return; ev.preventDefault(); show(idx < 0 ? Math.floor(sorted.length / 2) : idx + d); });
    read.innerHTML = c.readIdle || '';
  }

  /* ================= liquidity distribution (CLMM style) ================= */
  /** dist({ title, bands:[{lo,hi,usd,side:'asset'|'quote'}], mid, unit, fmtP, fmtY, asset, quote, src, plate (html, e.g. MOCK) }) */
  function dist(cfg) { cfg.zoom = cfg.zoom == null ? 1 : cfg.zoom; return place(null, 'dist', cfg); }
  function drawDist(el, c) {
    var W = Math.max(280, el.clientWidth), H = c.h || 280, plotW = W - AX - 8, plotH = H - XA;
    var lo0 = c.bands[0].lo, hi0 = c.bands[c.bands.length - 1].hi, half = Math.max(c.mid - lo0, hi0 - c.mid) / Math.pow(2, c.zoom);
    var lo = c.mid - half, hi = c.mid + half, bs = c.bands.filter(function (b) { return b.hi > lo && b.lo < hi; });
    var X = function (p) { return 8 + (p - lo) / (hi - lo) * plotW; };
    var ny = nice(0, Math.max.apply(null, bs.map(function (b) { return b.usd || 0; }).concat([1])) * 1.08, 4), Y = function (v) { return 30 + (plotH - 30) - v / ny.hi * (plotH - 30); };
    var g = '';
    ny.ticks.forEach(function (t) { g += '<line class="cc-grid" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/><text class="cc-ax" x="' + (W - AX + 6) + '" y="' + (Y(t) + 4).toFixed(1) + '">' + esc(c.fmtY(t)) + '</text>'; });
    bs.forEach(function (b, i) {
      var a = Math.max(8, X(b.lo)) + 1, z = Math.min(8 + plotW, X(b.hi)) - 1, w = Math.max(1, z - a);
      g += '<rect class="cc-col ' + (b.side === 'asset' ? 's1' : 's2') + '" data-i="' + i + '" x="' + a.toFixed(1) + '" y="' + Y(b.usd || 0).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, plotH - Y(b.usd || 0)).toFixed(1) + '"/>';
    });
    g += '<line class="cc-mid" x1="' + X(c.mid).toFixed(1) + '" x2="' + X(c.mid).toFixed(1) + '" y1="22" y2="' + plotH + '"/>';
    var ticks = nice(lo, hi, Math.max(3, Math.floor(plotW / 110))).ticks.filter(function (t) { return t > lo && t < hi; });
    ticks.forEach(function (t) { g += '<text class="cc-ax" x="' + X(t).toFixed(1) + '" y="' + (plotH + 16) + '" text-anchor="middle">' + esc(c.fmtP(t)) + '</text>'; });
    g += '<line class="cc-axis" x1="8" x2="' + (8 + plotW) + '" y1="' + plotH + '" y2="' + plotH + '"/>';
    g += '<g class="cc-hover"></g><rect class="cc-hit" x="8" y="0" width="' + plotW + '" height="' + plotH + '"/>';
    var tools = '<div class="cc-zoom" role="group" aria-label="Zoom"><button type="button" class="an-btn" data-z="1" aria-label="Zoom in"' + (c.zoom >= 3 ? ' disabled' : '') + '>+</button><button type="button" class="an-btn" data-z="-1" aria-label="Zoom out"' + (c.zoom <= 0 ? ' disabled' : '') + '>−</button></div>';
    el.innerHTML = head(Object.assign({}, c, { tools: tools })) + (c.plate || '') +
      '<div class="cc-plot cc-distplot" tabindex="0" role="img" aria-label="' + esc(c.aria || '') + '"><div class="cc-pricetag" style="left:' + X(c.mid).toFixed(1) + 'px"><span>Pool price</span><b>' + esc(c.fmtP(c.mid) + ' ' + c.unit) + '</b></div>' + svg(W, H, g) + '</div>' +
      legend({ legend: [{ cls: 's2', label: c.quote + ' (below the price)' }, { cls: 's1', label: c.asset + ' (above the price)' }] }) + '<div class="cc-read" aria-live="polite"></div>' + (c.src || '');
    var root = el.querySelector('.cc-plot > svg'),   /* the plot's svg: the header's pin is an svg too */ read = el.querySelector('.cc-read'), cols = root.querySelectorAll('.cc-col'), idx = -1;
    function show(i) { idx = Math.max(0, Math.min(bs.length - 1, i)); cols.forEach(function (r) { r.classList.toggle('on', +r.getAttribute('data-i') === idx); }); var b = bs[idx];
      read.innerHTML = '<span><i class="' + (b.side === 'asset' ? 's1' : 's2') + '"></i>' + esc(c.fmtP(b.lo) + '–' + c.fmtP(b.hi) + ' ' + c.unit) + ' · <b>' + esc(b.usd == null ? 'no USD price' : c.fmtY(b.usd)) + '</b> in ' + esc(b.side === 'asset' ? c.asset : c.quote) + '</span>'; }
    function pt(ev) { var q = root.createSVGPoint(); q.x = ev.clientX; q.y = ev.clientY; return q.matrixTransform(root.getScreenCTM().inverse()); }
    root.addEventListener('mousemove', function (ev) { var q = pt(ev), best = -1; bs.forEach(function (b, i) { if (q.x >= X(b.lo) && q.x <= X(b.hi)) best = i; }); if (best >= 0) show(best); });
    root.addEventListener('mouseleave', function () { cols.forEach(function (r) { r.classList.remove('on'); }); read.innerHTML = ''; });
    el.querySelector('.cc-plot').addEventListener('keydown', function (ev) { var d = { ArrowRight: 1, ArrowLeft: -1 }[ev.key]; if (d == null) return; ev.preventDefault(); show(idx < 0 ? Math.floor(bs.length / 2) : idx + d); });
    el.querySelectorAll('[data-z]').forEach(function (b) { b.addEventListener('click', function () { c.zoom = Math.max(0, Math.min(3, c.zoom + +b.getAttribute('data-z'))); drawDist(el, c); }); });
  }

  /* ================= sparkline ================= */
  function spark(vals, cls) {
    var v = vals.filter(function (x) { return x != null; }); if (v.length < 2) return '';
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), w = 88, h = 22;
    var pts = vals.map(function (x, i) { return x == null ? null : (i / (vals.length - 1) * (w - 2) + 1).toFixed(1) + ',' + (h - 2 - (x - lo) / ((hi - lo) || 1) * (h - 4)).toFixed(1); }).filter(Boolean).join(' ');
    return '<svg class="an-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><polyline class="' + (cls || 's1') + '" points="' + pts + '"/></svg>';
  }

  /* ================= mount and resize ================= */
  var DRAW = { time: drawTime, depth: drawDepth, dist: drawDist };
  var ro = window.ResizeObserver ? new ResizeObserver(function (es) { es.forEach(function (e) { var el = e.target, c = CFG[el.dataset.cc]; if (!c) return; var w = Math.round(e.contentRect.width); if (w && w !== el._w) { el._w = w; DRAW[c.kind](el, c); } }); }) : null;
  function mount(root) {
    (root || document).querySelectorAll('.an-cc[data-cc]').forEach(function (el) {
      if (el._mounted) return; var c = CFG[el.dataset.cc]; if (!c) return;
      el._mounted = true; el._w = el.clientWidth; DRAW[c.kind](el, c); if (ro) ro.observe(el);
    });
  }
  /* ================= bars (ranked, DefiLlama style), stacks, grouped columns ================= */
  /** Ranked horizontal bars: rows [{label, sub, value, html}]; o.max, o.ref (a line at that value), o.cls. */
  function bars(rows, o) {
    o = o || {};
    var max = o.max || Math.max.apply(null, rows.map(function (r) { return r.value || 0; })) || 1;
    return '<div class="an-hbars">' + rows.map(function (r) {
      var w = r.value == null ? 0 : Math.max(0, Math.min(100, r.value / max * 100));
      return '<div class="row"><div class="l">' + esc(r.label) + (r.sub ? '<span class="an-sub">' + esc(r.sub) + '</span>' : '') + '</div>' +
        '<div class="b">' + (r.value == null ? '' : '<span class="fill ' + (o.cls || 's1') + '" style="width:' + w + '%"></span>') + (o.ref != null ? '<span class="refl" style="left:' + (o.ref / max * 100) + '%"></span>' : '') + '</div>' +
        '<div class="v">' + r.html + '</div></div>';
    }).join('') + '</div>';
  }
  function stack(parts) { return '<div class="an-stack">' + parts.map(function (p) { return p.share > 0 ? '<span class="' + p.cls + '" style="flex-grow:' + p.share + '"></span>' : ''; }).join('') + '</div>'; }
  /** cols({ title, note, cats:[label], series:[{label, cls, values:[v|null]}], log, fmt, ref:{v,label}, src, aria }) */
  function cols(cfg) { return place(null, 'cols', cfg); }
  function drawCols(el, c) {
    var W = Math.max(280, el.clientWidth), H = c.h || 220, plotW = W - AX - 8, plotH = H - XA, vals = [];
    c.series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && v > 0) vals.push(v); }); });
    if (c.ref) vals.push(c.ref.v);
    var lo = c.log ? Math.pow(10, Math.floor(Math.log10(Math.min.apply(null, vals)))) : 0, hi = c.log ? Math.pow(10, Math.ceil(Math.log10(Math.max.apply(null, vals)))) : nice(0, Math.max.apply(null, vals), 4).hi;
    var Y = c.log ? function (v) { return 8 + (plotH - 8) - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo) || 1) * (plotH - 8); } : function (v) { return 8 + (plotH - 8) - v / hi * (plotH - 8); };
    var ticks = c.log ? (function () { var t = []; for (var e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e++) t.push(Math.pow(10, e)); return t; })() : nice(0, hi, 4).ticks;
    var g = '', n = c.cats.length, slot = plotW / n, bw = Math.min(28, slot * 0.8 / c.series.length);
    ticks.forEach(function (t) { g += '<line class="cc-grid" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/><text class="cc-ax" x="' + (W - AX + 6) + '" y="' + (Y(t) + 4).toFixed(1) + '">' + esc(c.fmt(t)) + '</text>'; });
    c.cats.forEach(function (cat, i) {
      var x0 = 8 + i * slot + (slot - bw * c.series.length - 2 * (c.series.length - 1)) / 2;
      c.series.forEach(function (s, j) { var v = s.values[i]; if (v == null) return; var y = Y(v);
        g += '<rect class="cc-col ' + s.cls + '" data-i="' + i + '" x="' + (x0 + j * (bw + 2)).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, plotH - y).toFixed(1) + '"/>'; });
      g += '<text class="cc-ax" x="' + (8 + i * slot + slot / 2).toFixed(1) + '" y="' + (plotH + 16) + '" text-anchor="middle">' + esc(cat) + '</text>';
    });
    if (c.ref) g += '<line class="cc-mid" x1="8" x2="' + (8 + plotW) + '" y1="' + Y(c.ref.v).toFixed(1) + '" y2="' + Y(c.ref.v).toFixed(1) + '"/>' + tag(12, Y(c.ref.v) - 11, c.ref.label, 'mid');
    g += '<line class="cc-axis" x1="8" x2="' + (8 + plotW) + '" y1="' + plotH + '" y2="' + plotH + '"/><rect class="cc-hit" x="8" y="0" width="' + plotW + '" height="' + plotH + '"/>';
    el.innerHTML = head(c) + '<div class="cc-read" aria-live="polite"></div><div class="cc-plot" tabindex="0" role="img" aria-label="' + esc(c.aria || '') + '">' + svg(W, H, g) + '</div>' + (c.series.length > 1 ? legend({ legend: c.series }) : '') + (c.src || '');
    var root = el.querySelector('.cc-plot > svg'),   /* the plot's svg: the header's pin is an svg too */ read = el.querySelector('.cc-read'), idx = -1;
    function show(i) { idx = Math.max(0, Math.min(n - 1, i)); root.querySelectorAll('.cc-col').forEach(function (r) { r.classList.toggle('on', +r.getAttribute('data-i') === idx); });
      read.innerHTML = '<span class="d">' + esc(c.cats[idx]) + '</span>' + c.series.map(function (s) { return '<span><i class="' + s.cls + '"></i>' + esc(s.label) + ' <b>' + (s.values[idx] == null ? 'no value' : esc(c.fmt(s.values[idx]))) + '</b></span>'; }).join(''); }
    function pt(ev) { var q = root.createSVGPoint(); q.x = ev.clientX; q.y = ev.clientY; return q.matrixTransform(root.getScreenCTM().inverse()); }
    root.addEventListener('mousemove', function (ev) { show(Math.floor((pt(ev).x - 8) / slot)); });
    root.addEventListener('mouseleave', function () { root.querySelectorAll('.cc-col').forEach(function (r) { r.classList.remove('on'); }); read.innerHTML = ''; });
    el.querySelector('.cc-plot').addEventListener('keydown', function (ev) { var d = { ArrowRight: 1, ArrowLeft: -1 }[ev.key]; if (d == null) return; ev.preventDefault(); show(idx < 0 ? 0 : idx + d); });
  }
  DRAW.cols = drawCols;
  window.TF_CHARTS = { time: time, depth: depth, dist: dist, cols: cols, spark: spark, bars: bars, stack: stack, mount: mount };
})();
