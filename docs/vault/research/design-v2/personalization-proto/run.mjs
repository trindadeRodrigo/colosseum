import assert from 'node:assert/strict';
import { ASSETS, compose } from './compose.mjs';

// fixture yields (the only place literals live); haircuts as in packages/engine/src/assets/haircuts.ts
const obs = (id, quoted, haircut) => [
  id,
  { assetId: id, quotedYield: quoted, haircutYield: quoted * (1 - haircut), provenance: 'fixture' },
];
const yields = new Map([
  obs('solana:jlUSDC', 0.0414, 0.25),
  obs('solana:syrupUSDC', 0.052, 0.1),
  obs('robinhood:SGOV', 0.04, 0.3),
]);
// fixture liquidity provider: GLDx thin (matches solana-liquidity.md: gold only works to about $10k)
const cap = { 'solana:GLDx': 40_000, 'solana:SPYx': 2_000_000, 'solana:NVDAx': 1_500_000 };
const liquidity = {
  exitCapacity: (id) => (cap[id] ? { capacityUsd: cap[id], regime: 'weekend', samples: 40 } : null),
  exitCost: (id, usd) =>
    cap[id]
      ? Math.min(0.05, (0.01 * usd) / cap[id])
      : ASSETS.find((a) => a.id === id)?.group === 'yield'
        ? 0.0005
        : null,
};
const all = ['solana', 'robinhood', 'base'];
const base = { rules: { useHoldings: true, glide: true }, country: 'BR', chains: all, themes: [] };
const profiles = {
  ana: {
    sheet: {
      ...base,
      goal: 'grow',
      amountUsd: 2_000,
      horizonMonths: 120,
      risk: 'high',
      themes: ['sand-to-server'],
    },
    holdings: [],
  },
  bruno: {
    sheet: { ...base, goal: 'protect', amountUsd: 50_000, horizonMonths: 18, risk: 'low' },
    holdings: [{ underlying: 'NVDA', valueUsd: 4_000 }],
  },
  carla: {
    sheet: {
      ...base,
      goal: 'income',
      amountUsd: 80_000,
      horizonMonths: 60,
      risk: 'medium',
      themes: ['the-seven'],
      incomeTargetUsdMonthly: 300,
    },
    holdings: [{ underlying: 'SOL', valueUsd: 20_000 }],
  },
};
const out = {};
for (const [k, p] of Object.entries(profiles)) {
  const r = compose({ ...p, yields, liquidity });
  out[k] = r;
  console.log(
    `\n== ${k}: ${p.sheet.goal} $${p.sheet.amountUsd} ${p.sheet.horizonMonths}m ${p.sheet.risk} themes=${p.sheet.themes}`,
  );
  for (const l of r.lines)
    console.log(
      `  ${String(l.weightBps).padStart(5)} bps  ${l.assetId.padEnd(22)} ${(l.viaIndex ? '[' + l.viaIndex + '] ' : '') + l.reasons.map((x) => x.rule).join(', ')}`,
    );
  for (const rc of r.recipes)
    console.log(
      `  recipe ${rc.chain} $${rc.amountUsd}: ${rc.components.map((c) => `${c.kind === 'index' ? c.index : c.asset}=${c.weightBps}`).join(' ')}`,
    );
  console.log('  removed', JSON.stringify(r.removed), 'flags', r.flags);
  console.log('  card', JSON.stringify(r.card));
  if (r.verdict) console.log('  verdict', JSON.stringify(r.verdict));
  // invariants
  assert.equal(
    r.lines.reduce((s, l) => s + l.weightBps, 0),
    10000,
  );
  for (const rc of r.recipes)
    assert.equal(
      rc.components.reduce((s, c) => s + c.weightBps, 0),
      10000,
    );
  for (const l of r.lines) assert.ok(l.reasons.length >= 1);
  assert.deepEqual(compose({ ...p, yields, liquidity }), r); // deterministic
}
// pairwise distance at class-group level and asset level (L1 / 2, in bps)
const vec = (r, key) => {
  const m = new Map();
  for (const l of r.lines) m.set(l[key], (m.get(l[key]) ?? 0) + l.weightBps);
  return m;
};
const dist = (a, b) => {
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()]))
    d += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return d / 2;
};
const ks = Object.keys(out);
console.log('\n== pairwise distance (bps moved): group / asset');
for (let i = 0; i < ks.length; i++)
  for (let j = i + 1; j < ks.length; j++)
    console.log(
      `  ${ks[i]} vs ${ks[j]}: ${dist(vec(out[ks[i]], 'group'), vec(out[ks[j]], 'group'))} / ${dist(vec(out[ks[i]], 'assetId'), vec(out[ks[j]], 'assetId'))}`,
    );
console.log('  card shapes:', ks.map((k) => out[k].card.cashFlow.kind).join(' | '));

// one-input sensitivity from a base person: each input alone must move the basket and add its own reason
const b0 = {
  sheet: {
    ...base,
    goal: 'grow',
    amountUsd: 10_000,
    horizonMonths: 120,
    risk: 'medium',
    themes: ['the-seven'],
  },
  holdings: [],
};
const r0 = compose({ ...b0, yields, liquidity });
const variants = {
  goal: { sheet: { ...b0.sheet, goal: 'protect' } },
  amount: { sheet: { ...b0.sheet, amountUsd: 400_000 } },
  horizon: { sheet: { ...b0.sheet, horizonMonths: 12 } },
  risk: { sheet: { ...b0.sheet, risk: 'low' } },
  holdings: { holdings: [{ underlying: 'NVDA', valueUsd: 4_000 }] },
  themes: { sheet: { ...b0.sheet, themes: ['sand-to-server'] } },
  country: { sheet: { ...b0.sheet, country: 'XX' }, block: true },
};
console.log(
  '\n== one-input sensitivity vs base (grow $10k 120m medium the-seven): bps moved, new rules',
);
console.log(
  '  base:',
  r0.recipes
    .map(
      (rc) =>
        `${rc.chain}: ${rc.components.map((c) => `${c.kind === 'index' ? c.index : c.asset}=${c.weightBps}`).join(' ')}`,
    )
    .join(' | '),
);
for (const [name, v] of Object.entries(variants)) {
  if (v.block)
    for (const a of ASSETS) if (a.chain === 'solana' && a.cls === 'stock') a.blocked = ['XX']; // fixture rule, not a legal claim
  const r = compose({ ...b0, ...v, yields, liquidity });
  const moved = dist(vec(r0, 'assetId'), vec(r, 'assetId'));
  const key = (x) => x.rule + JSON.stringify(x.params);
  const allR = (q) => [
    ...q.lines.flatMap((l) => l.reasons),
    ...q.removed.flatMap((x) => x.reasons),
  ];
  const rules0 = new Set(allR(r0).map(key));
  const input = name === 'horizon' ? 'horizon' : name;
  const changed = allR(r).filter((x) => !rules0.has(key(x)));
  const newRules = [...new Set(changed.filter((x) => x.inputs.includes(input)).map((x) => x.rule))];
  assert.ok(newRules.length > 0, `${name} changed the basket without a reason that names it`);
  console.log(
    `  ${name.padEnd(9)} moved ${String(moved).padStart(5)} bps; new rules: ${newRules.join(', ') || '-'}; recipes: ${r.recipes.map((rc) => `${rc.chain}: ${rc.components.map((c) => `${c.kind === 'index' ? c.index : c.asset.split(':')[1]}=${c.weightBps}`).join(' ')}`).join(' | ')}; flags ${r.flags}`,
  );
  assert.ok(moved > 0, `${name} did not change the basket`);
}
