import { METHODOLOGY } from '../../../../features/bearing/pages';

// How Bearing measures (method risk-0.3): what is measured, what a number means and what it is not.
// Generated from docs/risk/PLAN-RISK.md §4 and Appendix A; keep the two in step. It was /risk/methodology.

export const metadata = { title: 'Methodology, Bearing analytics', description: METHODOLOGY.lede };

export default function Methodology() {
  return (
    <article className="mt-6 max-w-[72ch] text-body-sm">
      <h2 className="mt-8 mb-2 text-b-section font-semibold">What is measured</h2>
      <p>
        Every 5 minutes we read the on-chain state of each DEX pool that trades a tokenized stock
        (Raydium CLMM, Orca Whirlpool, Meteora DLMM, Raydium CPMM) and simulate selling and buying
        the stock for dollars at sizes from $100 to $5M. The simulation reproduces each venue's swap
        math from the pool's own accounts: liquidity at every price level, fees, and Token-2022
        transfer fees. It is checked against Jupiter quotes routed through the same pool; the
        tolerance per venue is part of the test suite.
      </p>
      <h2 className="mt-8 mb-2 text-b-section font-semibold">What a number means</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <b>Cost</b> = 1 − dollars received ÷ (size × the pool's mid price before the trade). It
          includes the pool fee.
        </li>
        <li>
          <b>Capacity at τ</b> = the largest sale whose cost stays at or below τ (default 1%), from
          a curve fitted per time-of-week regime: the median cost per size across snapshots, made
          non-decreasing, interpolated on a log scale. No extrapolation beyond the largest measured
          size.
        </li>
        <li>
          <b>Regimes</b> (US Eastern time, daylight saving handled): market hours Mon–Fri
          09:30–16:00; weekday off-hours; weekend Fri 20:00 → Sun 20:00; NYSE holidays. A holiday
          with no data uses the weekend curve.
        </li>
        <li>
          <b>Weekend ratio</b> = weekend capacity ÷ market-hours capacity at the same τ. Measured,
          not assumed.
        </li>
        <li>
          <b>LP concentration</b> = share of liquidity within ±2% of the price held by the largest
          1, 3 and 10 positions. The <b>LP-exit stress</b> recomputes the pool without the largest
          3.
        </li>
        <li>
          <b>Recoverable value</b> = the better of selling on a DEX in the best regime inside the
          horizon, and the issuer's redemption where the window opens and settlement fits inside the
          horizon. Redemption capacity is a scenario input, labelled{' '}
          <em className="not-italic underline decoration-1 underline-offset-[3px]">assumption</em>
          {'; '}a redemption that settles after the horizon is listed but not counted.
        </li>
        <li>
          <b>Liquidity score</b> = capacity at τ in the worst regime a horizon can contain, divided
          by a reference size, capped at 1. A number with its inputs beside it, not a grade.
        </li>
        <li>
          <b>Breach</b>: for each upcoming withdrawal, what must come from stock after cash and
          liquid legs, against a share (default 25%) of the worst-regime capacity inside the
          withdrawal's window.{' '}
          <em className="not-italic underline decoration-1 underline-offset-[3px]">
            Likely breach
          </em>{' '}
          applies the dry stress: capacity × max(25%, weekend ratio).
        </li>
      </ul>
      <h2 className="mt-8 mb-2 text-b-section font-semibold">What a number is not</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          Depth measured in calm markets overstates depth in stress. Every curve shows its regime,
          sample count and dates.
        </li>
        <li>
          Curves simulate the best split of a sale across the asset's dollar-exit pools (USDC, USDT,
          SOL pools), allocated in 32 chunks to whichever pool pays most for the next chunk. Jupiter
          quotes are collected every 15 minutes as an independent check; the gap is reported.
        </li>
        <li>
          Pools quoted in other tokens (not USDC, USDT or SOL) are not counted as exit routes.
        </li>
        <li>
          Published numbers are asset- and market-level aggregates. No wallet's positions are
          published.
        </li>
      </ul>
    </article>
  );
}
