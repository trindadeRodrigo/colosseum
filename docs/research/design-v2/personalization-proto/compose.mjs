// Throwaway prototype of the two-stage personal-basket engine (exposure -> placement -> packaging).
// Pure: no clock, no network. Shelf comes from docs/research/open-questions/launch-shelf.seed.json.
// All parameter values are placeholders for Rodrigo to set.
import { readFileSync } from 'node:fs';

const seed = JSON.parse(
  readFileSync(new URL('../../open-questions/launch-shelf.seed.json', import.meta.url), 'utf8'),
);

// ---------- shelf ----------
const GROUP = {
  stock: 'growth',
  'stock-index': 'growth',
  'crypto-major': 'growth',
  'solana-native': 'growth',
  'base-native': 'growth',
  meme: 'growth',
  'dollar-yield': 'yield',
  gold: 'hedge',
  commodity: 'hedge',
};
const STOCK_ISSUER = { solana: 'Backed (xStocks)', base: 'Coinbase', robinhood: 'Robinhood' };
const YIELD_ISSUER = { jlUSDC: 'Jupiter Lend', syrupUSDC: 'Maple', SGOV: 'Robinhood' };
const underlyingOf = (chain, sym, cls) => {
  if (!['stock', 'stock-index', 'gold', 'commodity'].includes(cls)) return sym;
  if (chain === 'solana') return sym.replace(/x$/, '');
  if (chain === 'base') return sym.replace(/c$/, '');
  return sym;
};
export const ASSETS = [];
for (const [chain, list] of Object.entries(seed.assets))
  for (const a of list) {
    if (a.tier === 'X' || a.cls === 'meme') continue;
    ASSETS.push({
      id: `${chain}:${a.symbol}`,
      chain,
      symbol: a.symbol,
      cls: a.cls,
      group: GROUP[a.cls],
      tier: a.tier,
      underlying: underlyingOf(chain, a.symbol, a.cls),
      issuer:
        YIELD_ISSUER[a.symbol] ??
        (GROUP[a.cls] === 'growth' && !['stock', 'stock-index'].includes(a.cls)
          ? a.symbol
          : STOCK_ISSUER[chain]),
      blocked: [], // ISO country codes; filled from the risk sheet's "who can hold it"
    });
  }
const BY_ID = new Map(ASSETS.map((a) => [a.id, a]));
export const FAMILIES = seed.indexes
  .filter((i) => i.mvp !== false)
  .map((i) => ({
    slug: i.slug,
    name: i.name,
    recipes: Object.fromEntries(
      Object.entries(i.recipes).map(([chain, r]) => [
        chain,
        Object.entries(r).map(([s, bps]) => ({ assetId: `${chain}:${s}`, bps })),
      ]),
    ),
  }));
const FAM = new Map(FAMILIES.map((f) => [f.slug, f]));

// ---------- parameters (policy, not facts) ----------
export const P = {
  version: 'basket-0.1-proto',
  sleeves: {
    grow: { low: [6000, 3000, 1000], medium: [8000, 1500, 500], high: [9500, 500, 0] },
    income: { low: [1000, 8500, 500], medium: [2500, 7000, 500], high: [4000, 5500, 500] },
    protect: { low: [2000, 5500, 2500], medium: [3500, 4000, 2500], high: [5000, 2500, 2500] },
  }, // [growth, yield, hedge] bps
  glide: [
    [6, 8000],
    [12, 6000],
    [24, 4000],
    [36, 2000],
    [60, 1000],
  ], // months <= m -> min yield bps
  singleNameCap: { low: 1000, medium: 2000, high: 3500 },
  issuerCap: { low: 5000, medium: 7000, high: 10000 },
  tierCeilUsd: { A: 50_000, B: 10_000, C: 1_500 },
  shareOfDepth: 0.25,
  tau: 0.01,
  minLineBps: 50,
  minLineUsd: 5,
  defaultTheme: { grow: 'the-500', income: 'the-500', protect: 'storm-cellar' },
  holdingMinShare: 0.01,
};
const CHAIN_ORDER = ['solana', 'robinhood', 'base'];
const TIER_RANK = { A: 0, B: 1, C: 2 };

const INPUTS = {
  GLIDE: ['horizon'],
  SLEEVE: ['goal', 'risk'],
  SLEEVE_YIELD: ['goal', 'risk'],
  SLEEVE_DEFAULT: ['goal', 'risk'],
  FROM_THEME: ['themes', 'goal', 'risk'],
  ALREADY_HELD: ['holdings'],
  SINGLE_NAME_CAP: ['risk'],
  ISSUER_CAP: ['risk'],
  EXIT_CAPACITY: ['amount'],
  NOT_ELIGIBLE_IN_COUNTRY: ['country'],
  NOT_ON_YOUR_CHAINS: ['chains'],
  THEME_NOT_ON_YOUR_CHAINS: ['chains', 'themes'],
  EXPANDED: ['themes'],
  BELOW_MINIMUM: ['amount'],
  BY_HAIRCUT_YIELD: [],
  OVERFLOW_FROM: ['amount'],
  REPLACES: ['country'],
  ONLY_ON_CHAIN: ['themes'],
};
const reason = (rule, params) => ({ rule, inputs: INPUTS[rule] ?? [], params });

// ---------- stage 1: exposure ----------
function sleeves(sheet, R) {
  let [g, y, h] = P.sleeves[sheet.goal][sheet.risk];
  const floor =
    sheet.rules?.glide === false ? 0 : (P.glide.find(([m]) => sheet.horizonMonths <= m)?.[1] ?? 0);
  if (y < floor) {
    let need = floor - y;
    const fromG = Math.min(g, need);
    g -= fromG;
    need -= fromG;
    const fromH = Math.min(h, need);
    h -= fromH;
    y = floor;
    R.push(reason('GLIDE', { months: sheet.horizonMonths, yieldBps: floor }));
  }
  return { growth: g, yield: y, hedge: h };
}

function pickRecipe(fam, sheet) {
  for (const c of CHAIN_ORDER)
    if (sheet.chains.includes(c) && fam.recipes[c]) return { chain: c, comps: fam.recipes[c] };
  return null;
}

function exposure(sheet, holdings) {
  const notes = [];
  const S = sleeves(sheet, notes);
  const themes = sheet.themes.length ? sheet.themes : [P.defaultTheme[sheet.goal]];
  const A = sheet.amountUsd;
  const held = new Map();
  if (sheet.rules?.useHoldings !== false)
    for (const h of holdings) held.set(h.underlying, (held.get(h.underlying) ?? 0) + h.valueUsd);
  const H = [...held.values()].reduce((s, x) => s + x, 0);
  const cap = P.singleNameCap[sheet.risk];
  const capped = (cls) => !['stock-index', 'gold', 'commodity', 'dollar-yield'].includes(cls);
  const comp = { growth: new Map(), yield: new Map(), hedge: new Map() };
  const removed = [];
  const indexUnits = [];
  const live = themes.map((slug) => ({
    slug,
    fam: FAM.get(slug),
    rec: FAM.get(slug) && pickRecipe(FAM.get(slug), sheet),
  }));
  for (const t of live.filter((t) => !t.rec))
    removed.push({ ref: t.slug, reasons: [reason('THEME_NOT_ON_YOUR_CHAINS', { index: t.slug })] });
  const ok = live.filter((t) => t.rec);
  for (const t of ok) {
    const share = 1 / ok.length;
    const as = t.rec.comps.map((c) => ({ ...c, a: BY_ID.get(c.assetId) }));
    const clean = as.every((c) => c.a.group === 'growth');
    const w = S.growth * share;
    const heldHit = as.find((c) => (held.get(c.a.underlying) ?? 0) >= P.holdingMinShare * A);
    const capHit = as.find((c) => capped(c.a.cls) && (c.bps / 10000) * w > cap + 1e-6);
    if (clean && !heldHit && !capHit) {
      indexUnits.push({
        kind: 'index',
        slug: t.slug,
        group: 'growth',
        w,
        reasons: [
          reason('FROM_THEME', {
            themes: t.slug,
            goal: sheet.goal,
            risk: sheet.risk,
            sleeveBps: S.growth,
          }),
        ],
      });
      continue;
    }
    const why = !clean
      ? 'mixes asset classes'
      : heldHit
        ? `you already hold ${heldHit.a.underlying}`
        : `${capHit.a.underlying} would pass your single-stock cap`;
    for (const c of as) {
      const m = comp[c.a.group];
      const cur = m.get(c.a.underlying) ?? { w: 0, from: new Set(), cls: c.a.cls, why };
      cur.w += c.bps * share;
      cur.from.add(t.slug);
      m.set(c.a.underlying, cur);
    }
  }
  const growthLeft = S.growth - indexUnits.reduce((s, u) => s + u.w, 0);
  if (comp.growth.size === 0 && growthLeft > 1e-6)
    comp.growth.set('SPY', { w: 1, from: new Set(['default']), cls: 'stock-index' });
  if (comp.hedge.size === 0)
    comp.hedge.set('GLD', { w: 1, from: new Set(['default']), cls: 'gold' });
  const units = [];
  for (const [g, total] of [
    ['growth', growthLeft],
    ['hedge', S.hedge],
  ]) {
    const tot = [...comp[g].values()].reduce((s, x) => s + x.w, 0);
    for (const [u, x] of comp[g]) {
      const rs = [
        reason([...x.from][0] === 'default' ? 'SLEEVE_DEFAULT' : 'FROM_THEME', {
          themes: [...x.from].join('+'),
          goal: sheet.goal,
          risk: sheet.risk,
          sleeveBps: S[g],
        }),
      ];
      if (x.why && g === 'growth')
        rs.push(reason('EXPANDED', { index: [...x.from].join('+'), why: x.why }));
      units.push({
        kind: 'underlying',
        underlying: u,
        group: g,
        cls: x.cls,
        w: (total * x.w) / tot,
        reasons: rs,
      });
    }
  }
  units.push({
    kind: 'underlying',
    underlying: '*yield*',
    group: 'yield',
    cls: 'dollar-yield',
    w: S.yield,
    reasons: [
      reason('SLEEVE_YIELD', { goal: sheet.goal, risk: sheet.risk, sleeveBps: S.yield }),
      ...notes,
    ],
  });

  // holdings: fill gaps, avoid doubling up (underlying units only; index units were expanded if they overlap)
  if (H > 0) {
    const free = units.reduce((s, u) => s + u.w, 0);
    const buys = units.map((u) => {
      const target = (u.w / 10000) * (A + H);
      const h = held.get(u.underlying) ?? 0;
      const buy = Math.max(0, target - h);
      if (h >= P.holdingMinShare * A && target > 0) {
        const r = reason('ALREADY_HELD', {
          asset: u.underlying,
          heldUsd: Math.round(h),
          wasBps: Math.round(u.w),
        });
        if (buy <= 0) removed.push({ ref: u.underlying, reasons: [r] });
        else u.reasons.push(r);
      }
      return buy;
    });
    const tot = buys.reduce((s, x) => s + x, 0);
    units.forEach((u, i) => {
      u.w = (buys[i] / tot) * free;
    });
  }
  for (let k = 0; k < 20; k++) {
    const over = units.filter((u) => capped(u.cls) && u.w > cap + 1e-6);
    if (!over.length) break;
    let excess = 0;
    for (const u of over) {
      excess += u.w - cap;
      u.reasons.push(
        reason('SINGLE_NAME_CAP', {
          asset: u.underlying,
          capBps: cap,
          risk: sheet.risk,
          wasBps: Math.round(u.w),
        }),
      );
      u.w = cap;
      u.atCap = true;
    }
    const room = units.filter((u) => u.group === 'growth' && !u.atCap && u.w > 0);
    const rt = room.reduce((s, u) => s + u.w, 0);
    if (rt > 0) for (const u of room) u.w += (excess * u.w) / rt;
    else units.find((u) => u.group === 'yield').w += excess;
  }
  return { units: [...indexUnits, ...units.filter((u) => u.w > 1e-9)], S, removed, themes };
}

// ---------- stage 2: placement ----------
function place(sheet, ex, yields, liquidity) {
  const A = sheet.amountUsd;
  const issuerUsed = new Map();
  const issuerCapUsd = (P.issuerCap[sheet.risk] / 10000) * A;
  const lines = [];
  const removed = [...ex.removed];
  const used = [];
  const pref = () => [...used, ...sheet.chains.filter((c) => !used.includes(c))];
  const touch = (c) => {
    if (!used.includes(c)) used.push(c);
  };
  const onChains = (a) => sheet.chains.includes(a.chain);
  const allowed = (a) => !a.blocked.includes(sheet.country);
  const ceil = (a) => {
    const c = liquidity?.exitCapacity(a.id, P.tau);
    return Math.min(P.tierCeilUsd[a.tier], c ? P.shareOfDepth * c.capacityUsd : Infinity);
  };
  const order = (xs) =>
    [...xs].sort(
      (p, q) => pref().indexOf(p.chain) - pref().indexOf(q.chain) || p.id.localeCompare(q.id),
    );
  const room = (a) => Math.min(ceil(a), issuerCapUsd - (issuerUsed.get(a.issuer) ?? 0));
  const put = (a, usd, reasons, group, exposure, viaIndex) => {
    issuerUsed.set(a.issuer, (issuerUsed.get(a.issuer) ?? 0) + usd);
    touch(a.chain);
    lines.push({
      assetId: a.id,
      chain: a.chain,
      cls: a.cls,
      group,
      exposure,
      usd,
      reasons,
      viaIndex,
    });
  };
  let spill = 0;
  const spillReasons = [];
  const fill = (cands, usd, reasons, group, exposure) => {
    let left = usd;
    const carry = [];
    for (const a of cands) {
      if (left <= 0.005) break;
      if (!allowed(a)) {
        carry.push(reason('NOT_ELIGIBLE_IN_COUNTRY', { asset: a.symbol, country: sheet.country }));
        continue;
      }
      const take = Math.min(left, Math.max(0, room(a)));
      if (take <= 0.005) continue;
      const rs = [...reasons, ...carry];
      if (take < left - 0.005) {
        const byIssuer = issuerCapUsd - (issuerUsed.get(a.issuer) ?? 0) < ceil(a);
        const r = byIssuer
          ? reason('ISSUER_CAP', {
              issuer: a.issuer,
              capBps: P.issuerCap[sheet.risk],
              risk: sheet.risk,
            })
          : reason('EXIT_CAPACITY', { asset: a.symbol, maxUsd: Math.round(ceil(a)), tier: a.tier });
        rs.push(r);
        carry.push(r);
      }
      put(a, take, rs, group, exposure);
      left -= take;
    }
    return { left, carry };
  };
  const placeUnderlying = (u) => {
    const all = ASSETS.filter(
      (a) => a.underlying === u.underlying && a.group === u.group && onChains(a),
    );
    const usd = (u.w / 10000) * A;
    if (!all.length) {
      removed.push({
        ref: u.underlying,
        reasons: [reason('NOT_ON_YOUR_CHAINS', { asset: u.underlying })],
      });
      spill += usd;
      return;
    }
    const rs = [...u.reasons];
    const chains = new Set(ASSETS.filter((a) => a.underlying === u.underlying).map((a) => a.chain));
    if (chains.size === 1)
      rs.push(reason('ONLY_ON_CHAIN', { asset: u.underlying, chain: [...chains][0] }));
    const { left, carry } = fill(order(all), usd, rs, u.group, u.underlying);
    if (left > 0.005) {
      if (left > usd - 0.005)
        removed.push({
          ref: u.underlying,
          reasons: carry.length ? carry : [reason('EXIT_CAPACITY', { asset: u.underlying })],
        });
      spill += left;
      spillReasons.push(reason('OVERFLOW_FROM', { asset: u.underlying, usd: Math.round(left) }));
    }
  };
  for (const u of ex.units.filter((u) => u.kind === 'index')) {
    const fam = FAM.get(u.slug);
    const usd = (u.w / 10000) * A;
    let left = usd;
    const why = [];
    for (const chain of pref()) {
      if (left <= 0.005) break;
      const rec = fam.recipes[chain];
      if (!rec) continue;
      const as = rec.map((c) => ({ a: BY_ID.get(c.assetId), share: c.bps / 10000 }));
      const bad = as.find((x) => !allowed(x.a));
      if (bad) {
        why.push(
          reason('NOT_ELIGIBLE_IN_COUNTRY', { asset: bad.a.symbol, country: sheet.country }),
        );
        continue;
      }
      // the most this chain's recipe can take: every component within its exit ceiling, every issuer within its cap
      const byIssuer = new Map();
      for (const x of as) byIssuer.set(x.a.issuer, (byIssuer.get(x.a.issuer) ?? 0) + x.share);
      const thin = as
        .map((x) => ({ x, max: ceil(x.a) / x.share }))
        .sort((p, q) => p.max - q.max)[0];
      const iss = [...byIssuer]
        .map(([i, sh]) => ({ i, max: (issuerCapUsd - (issuerUsed.get(i) ?? 0)) / sh }))
        .sort((p, q) => p.max - q.max)[0];
      const take = Math.min(left, thin.max, iss.max);
      if (take < Math.max(P.minLineUsd * as.length, 0.02 * A)) continue;
      const rs = [...u.reasons, ...why];
      if (take < left - 0.005) {
        const r =
          iss.max < thin.max
            ? reason('ISSUER_CAP', {
                issuer: iss.i,
                capBps: P.issuerCap[sheet.risk],
                risk: sheet.risk,
              })
            : reason('EXIT_CAPACITY', {
                asset: thin.x.a.symbol,
                maxUsd: Math.round(ceil(thin.x.a)),
                tier: thin.x.a.tier,
              });
        rs.push(r);
        why.push(r);
      }
      if (Object.keys(fam.recipes).length === 1)
        rs.push(reason('ONLY_ON_CHAIN', { asset: u.slug, chain }));
      for (const x of as)
        put(x.a, take * x.share, rs, 'growth', x.a.underlying, `${u.slug}@${chain}`);
      left -= take;
    }
    if (left > 0.005) {
      // what no chain's recipe can take whole: hold its parts where they fit
      const rec = pickRecipe(fam, sheet).comps;
      for (const c of rec) {
        const a = BY_ID.get(c.assetId);
        placeUnderlying({
          underlying: a.underlying,
          group: a.group,
          cls: a.cls,
          w: ((left / A) * 10000 * c.bps) / 10000,
          reasons: [
            ...u.reasons,
            reason('EXPANDED', {
              index: u.slug,
              why: 'no single chain can take it at this size or in your country',
            }),
            ...why,
          ],
        });
      }
    }
  }
  for (const u of ex.units
    .filter((u) => u.kind === 'underlying' && u.group !== 'yield')
    .sort((a, b) => b.w - a.w || a.underlying.localeCompare(b.underlying)))
    placeUnderlying(u);
  const yu = ex.units.find((u) => u.group === 'yield');
  const yc = ASSETS.filter((a) => a.group === 'yield' && onChains(a)).sort(
    (p, q) =>
      (yields.get(q.id)?.haircutYield ?? -1) - (yields.get(p.id)?.haircutYield ?? -1) ||
      p.id.localeCompare(q.id),
  );
  const want = ((yu?.w ?? 0) / 10000) * A + spill;
  const { left } = fill(
    yc,
    want,
    [...(yu?.reasons ?? []), ...spillReasons, reason('BY_HAIRCUT_YIELD', {})],
    'yield',
    'dollar yield',
  );
  const flags = [];
  if (left > 0.005) flags.push(`UNPLACED:${Math.round(left)}`);
  return { lines, removed, flags, unplacedUsd: left };
}

// ---------- stage 3: packaging ----------
function largestRemainder(ws, total = 10000) {
  const s = ws.reduce((a, b) => a + b, 0);
  const raw = ws.map((w) => (w / s) * total);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const idx = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rem > 0; k++, rem--) out[idx[k % idx.length][1]]++;
  return out;
}

function packageUp(sheet, ex, pl) {
  const A = sheet.amountUsd;
  // merge duplicates, drop dust
  const m = new Map();
  for (const l of pl.lines) {
    const key = l.assetId + '|' + (l.viaIndex ?? '');
    const cur = m.get(key);
    if (cur) {
      cur.usd += l.usd;
      cur.reasons.push(...l.reasons);
    } else m.set(key, { ...l, reasons: [...l.reasons] });
  }
  let lines = [...m.values()];
  const dust = lines.filter(
    (l) => !l.viaIndex && (l.usd < P.minLineUsd || (l.usd / A) * 10000 < P.minLineBps),
  );
  const removed = [...pl.removed];
  if (dust.length && lines.length > dust.length) {
    lines = lines.filter((l) => !dust.includes(l));
    const big = lines.reduce((a, b) => (b.usd > a.usd ? b : a));
    for (const d of dust) {
      big.usd += d.usd;
      removed.push({
        ref: d.assetId,
        reasons: [reason('BELOW_MINIMUM', { asset: d.assetId, usd: Math.round(d.usd) })],
      });
    }
  }
  lines.sort((a, b) => b.usd - a.usd || a.assetId.localeCompare(b.assetId));
  const bps = largestRemainder(lines.map((l) => l.usd));
  lines.forEach((l, i) => {
    l.weightBps = bps[i];
    l.amountUsd = Math.round(l.usd * 100) / 100;
    delete l.usd;
    l.reasons = dedupe(l.reasons);
  });
  // per-chain recipes; a clean, untouched theme index is re-packed as one index component
  const recipes = [];
  for (const chain of sheet.chains) {
    const cl = lines.filter((l) => l.chain === chain);
    if (!cl.length) continue;
    const comps = [];
    const idx = new Map();
    for (const l of cl) {
      if (l.viaIndex && !l.mixed) idx.set(l.viaIndex, (idx.get(l.viaIndex) ?? 0) + l.weightBps);
      else comps.push({ kind: 'asset', asset: l.assetId, w: l.weightBps });
    }
    for (const [index, w] of idx) comps.push({ kind: 'index', index, mode: 'follow', w });
    const cb = largestRemainder(comps.map((c) => c.w));
    recipes.push({
      chain,
      amountUsd: Math.round(cl.reduce((s, l) => s + l.amountUsd, 0) * 100) / 100,
      components: comps.map((c, i) => ({ ...c, w: undefined, weightBps: cb[i] })),
    });
  }
  return { lines, recipes, removed };
}
const dedupe = (rs) => {
  const seen = new Set();
  return rs.filter((r) => {
    const k = r.rule + JSON.stringify(r.params);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// ---------- card ----------
function card(sheet, lines, yields, liquidity) {
  const A = sheet.amountUsd;
  const y = lines.filter((l) => l.group === 'yield');
  const lo = y.reduce((s, l) => s + l.amountUsd * (yields.get(l.assetId)?.haircutYield ?? 0), 0);
  const hi = y.reduce((s, l) => s + l.amountUsd * (yields.get(l.assetId)?.quotedYield ?? 0), 0);
  const yieldBps = y.reduce((s, l) => s + l.weightBps, 0);
  const growthUsd = lines.filter((l) => l.group === 'growth').reduce((s, l) => s + l.amountUsd, 0);
  let worst = 0;
  let known = true;
  for (const l of lines) {
    const c = liquidity?.exitCost(l.assetId, l.amountUsd);
    if (c == null) {
      if (l.group !== 'yield') known = false;
    } else worst += c * l.amountUsd;
  }
  const c = {
    moneyNeededToday: {
      totalUsd: A,
      byChain: Object.fromEntries(
        sheet.chains
          .map((ch) => [
            ch,
            Math.round(lines.filter((l) => l.chain === ch).reduce((s, l) => s + l.amountUsd, 0)),
          ])
          .filter(([, v]) => v > 0),
      ),
    },
    expectedReturn: {
      basis: 'yield_only',
      lowPctOfBasket: +((100 * lo) / A).toFixed(2),
      highPctOfBasket: +((100 * hi) / A).toFixed(2),
      coversBps: yieldBps,
      stress: { id: 'equity_drawdown_20', lossUsd: Math.round(growthUsd * 0.2) },
    },
    totalTerm: {
      months: sheet.horizonMonths,
      nextGlideStep: P.glide.filter(([m]) => m < sheet.horizonMonths).slice(-1)[0] ?? null,
    },
    cashFlow:
      sheet.goal === 'income'
        ? { kind: 'monthly_estimate', lowUsd: Math.round(lo / 12), highUsd: Math.round(hi / 12) }
        : yieldBps >= 3000
          ? { kind: 'accrues_in_price', lowUsdYear: Math.round(lo), highUsdYear: Math.round(hi) }
          : { kind: 'none' },
    whenYouCanGetOut: {
      withdrawTokens: 'any time',
      sellCostWorstPct: known ? +((100 * worst) / A).toFixed(2) : null,
    },
  };
  let verdict;
  if (sheet.goal === 'income' && sheet.incomeTargetUsdMonthly) {
    const got = lo / 12;
    const t = sheet.incomeTargetUsdMonthly;
    verdict =
      got >= t
        ? { met: true }
        : {
            met: false,
            gapUsdMonthly: Math.round(t - got),
            ways: [
              { way: 'amount', amountUsd: Math.ceil((A * t) / got / 100) * 100 },
              { way: 'target', incomeTargetUsdMonthly: Math.floor(got) },
            ],
          };
  }
  return { card: c, verdict };
}

export function compose(input) {
  const { sheet, holdings = [], yields, liquidity } = input;
  const ex = exposure(sheet, holdings);
  const pl = place(sheet, ex, yields, liquidity);
  const pk = packageUp(sheet, ex, pl);
  const { card: c, verdict } = card(sheet, pk.lines, yields, liquidity);
  return {
    engineVersion: P.version,
    sheet,
    lines: pk.lines,
    recipes: pk.recipes,
    removed: pk.removed,
    card: c,
    verdict,
    flags: pl.flags,
  };
}
