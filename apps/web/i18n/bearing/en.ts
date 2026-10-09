// Bearing's analytics (/analytics/*), in English: Rodrigo's words from his Analytics 2.0, as he wrote
// them. A dictionary of its own, so the routes that do not show Bearing do not ship its sentences;
// pt.ts holds the same keys in Brazilian Portuguese. The voice is the product's (i18n/en.ts). The
// sources and methods in a pin's popover are the API's, in English, in both languages.

export const bearingEn = {
  head: 'Bearing · analytics',
  notAdvice: 'Not licensed advice',
  menu: {
    region: 'Analytics pages',
    nav: 'Analytics',
    show: 'Show menu',
    hide: 'Hide menu',
  },
  pages: {
    stocks: {
      label: 'Stocks',
      lede: 'What it costs to leave a stock, and how much the pools can take.',
    },
    commodities: {
      label: 'Commodities',
      lede: 'What it costs to leave gold, and how much the pools can take.',
    },
    stablecoins: {
      label: 'Stablecoins',
      lede: 'How much of each stablecoin is lent out, and how much you could withdraw now.',
    },
    lending: {
      label: 'Lending',
      lede: 'If the collateral had to be sold today, how much of it the pools would take.',
    },
    simulation: {
      label: 'Simulation',
      lede: 'Sell a position now: what you would lose, and the best way out.',
    },
    methodology: {
      label: 'Methodology',
      lede: 'How every figure on these pages is measured, and what it is not.',
    },
  },
  banner: {
    loading: 'Reading the risk API…',
    live: (time: string) => `Newest reading from the collectors: ${time}.`,
    unknownTime: 'an unknown time',
    now: (regime: string, et: string) => `now: ${regime} (${et})`,
    stale: (when: string, age: string) =>
      `The collectors’ newest reading is from ${when}, ${age} old.`,
    unknownAge: 'of an unknown age',
    noReading: 'The collectors have no reading yet.',
    staleAll: 'Every figure is stale: measured, only old. Its age is beside it.',
    down: (api: string) => `The risk API at ${api} did not answer.`,
    downAll: 'Every figure on this page waits for it; none is made up in its place.',
  },
  chain: {
    label: 'Chain',
    pageNotCollected: (chain: string) =>
      `Not collected yet on ${chain}: Bearing measures this page on Solana only for now.`,
    sideBySide: {
      title: 'Chains side by side',
      note: 'Each chain as Bearing measures it now. Exit capacity is read in the time of week it is now.',
      caption: 'Assets tracked, pool TVL, exit capacity and 24 h volume per chain',
      chain: 'Chain',
      assets: 'Assets tracked',
      tvl: 'Pool TVL',
      capacity: 'Exit capacity at ≤ 1% cost',
      volume: 'Volume 24 h',
    },
  },
  regimes: {
    us_market_hours: 'market hours',
    us_offhours_weekday: 'off-hours',
    weekend: 'weekend',
    us_holiday: 'holiday',
  },
  reasons: {
    no_samples_in_regime: 'not measured yet',
    insufficient_samples: 'too few samples to fit',
    not_a_number: 'the stored value could not be used',
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
    api_error: 'the API returned no answer',
    nothing_selected: 'nothing selected',
    no_price_source: 'no price source',
    no_quote_price: 'no USD price for the quote token',
  },
  filter: {
    all: (n: number) => `All (${n})`,
    none: 'None',
    some: (n: number, of: number) => `${n} of ${of}`,
    selectAll: 'All',
    selectNone: 'None',
  },
  /** Beside a figure made of parts when some have no figure: it is of the measured ones only. */
  partial: (n: number) => `of the ${n} measured`,
  pie: {
    /** Under the legend: the pools with no figure, which get no slice. */
    missing: (n: number) =>
      n === 1
        ? '1 pool has no figure and is not drawn.'
        : `${n} pools have no figure and are not drawn.`,
    others: (n: number) => `${n} other pool${n === 1 ? '' : 's'}`,
    point: 'Point at a slice or a row for its value.',
  },
  chart: {
    range: 'Range',
    metric: 'Metric',
    noData: 'No data',
    noValue: 'no value',
    fewSamples: 'too few samples',
    zoom: 'Zoom',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    poolPrice: 'Pool price',
    below: (quote: string) => `${quote} (below the price)`,
    above: (asset: string) => `${asset} (above the price)`,
    noUsd: 'no USD price',
    held: (token: string) => `in ${token}`,
    sourceOf: (what: string) => `the ${what}`,
  },
  heat: {
    head: (asset: string, size: string) => `${asset} · sell cost at ${size}, by hour of week`,
    thinnest: (when: string) => `thinnest: ${when}`,
    note: 'Lighter cells cost less to leave on warm black; on paper, darker cells cost less.',
    what: (size: string) => `to sell ${size}`,
    aria: (asset: string, size: string) =>
      `Median sell cost of ${asset} at ${size} by hour of week, Eastern time`,
    meta: (n: string, hours: number, zone: string, at: string) =>
      `USD · n=${n} · ${hours} of 168 hours sampled · ${zone} · method risk-0.3 · as of ${at}`,
    reading: 'Reading the hours…',
    table: 'View as table',
    deepFirst: 'Deepest day first',
    least: 'least depth',
    most: 'most depth',
    legend: (n: number) => `– no sample · bins are quintiles of these ${n} hours`,
    move: 'Move through the hours with the arrow keys.',
    noSample: 'no sample',
    day: 'Day',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  dex: {
    reading: 'Reading the pools…',
    assets: 'Assets',
    pools: 'Pools',
    poolsSub: (n: string) => `${n} pools`,
    summary: (assets: number, pools: number, regime: string) =>
      `${assets} asset${assets === 1 ? '' : 's'} · ${pools} pool${pools === 1 ? '' : 's'} · now ${regime}`,
    metrics: { capacity: 'Exit capacity', tvl: 'TVL over time', liquidity: 'Liquidity' },
    kpi: {
      tvl: 'Pool TVL',
      tvlNote: 'selected pools, read at registration',
      pools: 'Pools',
      poolsNote: (n: string) => `of ${n} on the selected assets`,
      capacity: 'Exit capacity now',
      capacityNote: (regime: string) => `sale at ≤ 1% cost, ${regime}`,
      volume: 'Volume 24 h',
      volumeNote: (to: string) => `to ${to}, the newest swap history`,
      volumeDexNote: 'DexScreener’s figure: Bearing’s swap history is not collected here yet.',
      lp: 'Top-3 LP share',
      lpNote: 'largest pool, by position',
    },
    pie: { title: 'TVL by pool', note: 'read when each pool was registered' },
    table: {
      title: 'Assets',
      note: 'Capacity is the largest sale that costs at most 1%, by time of week. Exit capacity is that figure hour by hour. The pool filter narrows TVL, the pie, the pool count and the liquidity chart; capacity is routed across all of an asset’s pools, so it does not change with it. Open an asset to simulate selling it.',
      caption: 'Assets with pools, capacity, volume and LP share',
      asset: 'Asset',
      pools: 'Pools',
      poolsOf: (n: string) => `of ${n}`,
      capacity: {
        us_market_hours: 'Capacity, market hours',
        us_offhours_weekday: 'Capacity, off-hours',
        weekend: 'Capacity, weekend',
        us_holiday: 'Capacity, holiday',
      },
      volume: 'Volume 24 h',
      lp: 'Top-3 LP share',
      spark: 'Exit capacity, 30 d',
    },
    capacity: {
      title: 'Exit capacity at ≤ 1% cost',
      note: (from: string) =>
        `exit and entry side, summed over the selected assets, one point per UTC hour since ${from}, when the routed curves began`,
      firstCurve: 'the first routed curve',
      sell: 'exit (the asset sold)',
      buy: 'entry (dollars in)',
      aria: 'Exit and entry capacity over time for the selected assets',
      src: 'capacity chart',
      partial: (k: number, n: number) => `(${k} of ${n} assets)`,
    },
    tvl: {
      title: 'TVL over time',
      none: 'the pool value over time is recorded only for some of the concentrated-liquidity pools, and none of the selected pools is one of them. Today’s TVL of the selection is in the counters; exit capacity over time is measured for every asset.',
      reading: (n: number) => `Reading ${n} recorded pool${n === 1 ? '' : 's'}…`,
      recorded: 'TVL over time, recorded pools',
      // n and share count the pools in the sum; noUsd, the recorded ones left out for want of a price;
      // failed, the ones whose history did not load, with why in the reader's words; behind, the ones
      // whose newest recording is too old to count in the hour the figure is taken from
      note: (
        n: number,
        of: number,
        share: string | null,
        noUsd: number,
        failed = 0,
        why = '',
        behind = 0,
      ) =>
        `${n} of ${of} selected pools ${n === 1 ? 'is' : 'are'} recorded and in the sum${share ? `, holding ${share} of the selection’s TVL` : ''}; the value of the tokens ${n === 1 ? 'its' : 'their'} liquidity holds, uncollected fees not counted.${
          noUsd
            ? ` ${noUsd}${n ? ' more' : ''} ${noUsd === 1 ? 'is recorded and has' : 'are recorded and have'} no USD price for the quote token, so ${noUsd === 1 ? 'it is' : 'they are'} not in the sum.`
            : ''
        }${
          failed
            ? ` ${failed}${n || noUsd ? ' more' : ''} did not load (${why}), so ${failed === 1 ? 'it is' : 'they are'} not in the sum.`
            : ''
        }${
          behind
            ? ` ${behind}${n || noUsd || failed ? ' more' : ''} ${behind === 1 ? 'has' : 'have'} no recording within 6 h of the newest hour, so ${behind === 1 ? 'it is' : 'they are'} not in the sum.`
            : ''
        } A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.`,
      value: 'pool value',
      valueLegend: 'pool value (TVL)',
      held: 'of which in the asset',
      heldLegend: 'of which held in the asset',
      aria: 'Value held by the recorded pools over time',
      src: 'TVL chart',
      partial: (k: number, n: number) => `(${k} of ${n} pools)`,
    },
    liquidity: {
      title: 'Liquidity by price band',
      none: 'none of the selected pools is a concentrated-liquidity pool; a constant-product pool spreads its liquidity over every price.',
      reading: 'Reading the pool…',
      both: 'Liquidity by price band, both sides',
      failed: (error: string) =>
        `${error}. Only some pools are recorded; pick one without “not recorded”, or wait for the live read.`,
      // each carries its own preposition (Portuguese joins it to the article); `note` sets it in whole
      recordedAt: (at: string) => `from the pool’s newest recording, ${at}`,
      liveAt: (at: string) => `from a live read at ${at} UTC`,
      note: (when: string) =>
        `held within ±30% of the price, ${when}; the asset waits above the price (sold into as it rises), the quote below (spent on the asset as it falls); + and − zoom`,
      aria: (pool: string) => `Liquidity of pool ${pool} by price band around the pool price`,
      src: 'distribution chart',
      pool: 'Pool',
      option: (label: string, tvl: string, recorded: boolean) =>
        `${label} · TVL ${tvl}${recorded ? '' : ' · not recorded'}`,
      quoteNotNamed: 'quote not named',
      asset: 'asset',
      quote: 'quote',
    },
  },
  lending: {
    reading: 'Reading the lending pools…',
    pricing: 'Pricing the collateral…',
    pools: 'Lending pools',
    collateral: 'Collateral',
    summary: (n: number, regime: string) => `${n} pool${n === 1 ? '' : 's'} · now ${regime}`,
    tolerance: 'Tolerance',
    toleranceTitle:
      'A sale counts as covered when it costs at most this, fees and price impact included',
    toleranceError: 'Between 0.1% and 10%',
    metrics: { covered: 'Covered', tvl: 'TVL over time', liquidity: 'Liquidity' },
    kpi: {
      supplied: 'Supplied',
      borrowed: 'Borrowed',
      collateral: 'Collateral posted',
      collateralNote: 'selected assets',
      covered: 'Covered now',
      coveredNote: (tol: string, regime: string) => `sold at ≤ ${tol} cost, ${regime}`,
      largest: 'Largest sale within tolerance',
      largestNote: (tol: string) => `${tol} tolerance`,
      loss: 'Loss if all is sold',
      lossNote: (share: string) => `${share} of the collateral`,
    },
    pie: {
      title: 'Supplied by pool',
      note: 'Kamino: the token supplied; Jupiter Lend vaults: the collateral deposited',
    },
    covered: {
      title: (tol: string) => `Covered and not covered, ${tol} tolerance`,
      note: (from: string) =>
        `today’s collateral against each hour’s exit capacity, as a share of 100%; hours where a collateral asset has no measurement are left out. The counter above reads the curve fitted over the whole time of week; this chart reads each hour’s own snapshot, so the two can differ. Hourly routed curves began ${from}.`,
      notCovered: 'not covered',
      covered: 'covered',
      coveredLegend: (tol: string) => `covered: sold at ≤ ${tol} cost`,
      notCoveredLegend: 'not covered: the sale would cost more',
      aria: (tol: string) => `Share of collateral covered by pool depth at ${tol} cost, over time`,
      src: 'covered chart',
    },
    supplied: {
      title: 'Supplied and borrowed',
      note: 'summed over the selected pools: hourly for the last 7 days, the day’s last reading before that',
      supplied: 'supplied',
      borrowed: 'borrowed',
      aria: 'Supplied and borrowed over time',
      src: 'supplied chart',
      partial: (k: number, n: number) => `(${k} of ${n} pools)`,
    },
    avail: {
      title: 'Available to withdraw',
      note: (more: string) => `cash a lender could take out, and the share lent out below; ${more}`,
      jupiter:
        'a Jupiter Lend vault has no figure here (its lent token sits in a shared liquidity layer)',
      available: 'available',
      lent: 'share lent out',
      aria: 'Available to withdraw and share lent out over time',
      src: 'liquidity chart',
    },
    table: {
      title: 'Lending pools',
      note: (tol: string, regime: string) =>
        `Covered is the share of a pool’s collateral the swap pools could absorb at a cost of at most ${tol} in the current time of week (${regime}); the rest would sell at a deeper loss. The loss if all is sold is the routed sale of every collateral asset at its full size, at once. In a row, each lending pool is counted on its own; in the counters and the chart, every position in one stock is added up first and sold into that stock’s pools once, since they draw on the same depth. Kamino reports collateral per market, so reserves of one market show the same collateral; the counters and the chart count it once.`,
      caption: 'Lending pools with coverage of their collateral',
      pool: 'Pool',
      explorer: (pool: string) => `View ${pool} on Solscan`,
      supplied: 'Supplied',
      available: 'Available now',
      jupiterAvailable: 'the vault’s lent token sits in the shared Jupiter Lend liquidity layer',
      lent: 'Share lent out',
      top1: 'Top-1 lender share',
      collateral: 'Collateral',
      assets: (n: number) => `${n} assets`,
      covered: 'Covered',
      largest: 'Largest sale within tolerance',
      loss: 'Loss if all is sold',
      lossShare: (share: string) => `${share} of it`,
      spark: 'Covered, 30 d',
    },
    market: (id: string) => `market ${id}`,
  },
  stable: {
    reading: 'Reading the stablecoin reserves…',
    coins: 'Stablecoins',
    reserves: 'Reserves',
    summary: (n: number) => `${n} reserve${n === 1 ? '' : 's'}`,
    metrics: { tvl: 'TVL over time', liquidity: 'Liquidity' },
    kpi: {
      supplied: 'Supplied',
      borrowed: 'Borrowed',
      available: 'Available now',
      availableNote: 'what lenders could withdraw',
      lent: 'Share lent out',
      reserves: 'Reserves',
      reservesNote: 'Kamino lending reserves',
    },
    pie: 'Supplied by reserve',
    supplied: {
      title: 'Supplied and borrowed',
      note: 'hourly for the last 7 days, the day’s last reading before that',
      aria: 'Stablecoin supplied and borrowed over time',
    },
    availNote: 'summed over the selected reserves',
    table: {
      title: 'Stablecoins',
      note: 'Measured where the collectors read them today: the Kamino lending reserves that lend them. A lender exits by withdrawing, so “available now” takes the place of exit capacity. Swap pools for stablecoins and the yield-bearing ones (USDY, syrupUSDC) are measured once item 17 lands.',
      caption: 'Stablecoins by lending reserve',
      asset: 'Asset',
      reserves: 'Reserves',
      supplied: 'Supplied',
      available: 'Available now',
      lent: 'Share lent out',
      volume: 'Volume 24 h',
      top1: 'Top-1 lender share',
      spark: 'Available, 30 d',
      largest: 'largest reserve',
    },
  },
  sim: {
    reading: 'Reading the assets…',
    asset: 'Asset to sell',
    amount: 'Amount, USD',
    simulate: 'Simulate',
    amountError: 'Enter an amount between $100 and $1,000,000,000, for example 250000 or 250k.',
    pricing: (n: string, id: string) => `Pricing ${n} of ${id}…`,
    kpi: {
      sale: 'Sale',
      saleNote: (id: string) => `${id}, your input`,
      now: 'Time of week now',
      capacity: 'Exit capacity now',
      capacityNote: 'sale at ≤ 1% cost',
      loss: 'Loss on the best path',
      lossNote: (share: string) => `${share} of the sale`,
    },
    verdict: {
      none: (n: string, id: string, why: string) =>
        `No measured route prices ${n} of ${id} right now: ${why}. The simulation never extends a curve past what was measured.`,
      best: (n: string, id: string, path: string, atLeast: boolean, loss: string, share: string) =>
        `Best path for ${n} of ${id} now: ${path}. It loses ${atLeast ? 'at least ' : ''}${loss} (${share})`,
      against: (loss: string) => `, against ${loss} selling all of it now.`,
      end: '.',
      waits: ' Waiting carries price risk this loss does not count.',
    },
    paths: {
      now: {
        name: 'Sell now across the pools',
        how: 'one routed sale, split across the asset’s dollar pools',
        when: (regime: string) => `now · ${regime}`,
      },
      open: {
        name: 'Wait for market hours',
        how: 'the same routed sale at the next US open; the price can move while you wait',
        when: (wait: string, at: string) => `in ${wait} · ${at}`,
        notFound: 'next open not found',
      },
      split: {
        name: (k: number) => `Split into ${k} hourly sales`,
        how: (k: number, each: string, minutes: string | null) =>
          `${k} sales of ${each}, each within the 1% capacity, one an hour; it assumes the pools refill between sales${
            minutes
              ? ` (after large trades they recovered 90% of depth in a median ${minutes} min)`
              : ''
          }`,
        when: (k: number, regime: string) => `over ${k} h · ${regime}`,
      },
      issuer: {
        name: 'Redeem with the issuer',
        how: (issuer: string, status: string, settles: string) =>
          `${issuer}: ${status}; ${settles}; needs KYC with the issuer`,
        theIssuer: 'the issuer',
        noStatus: 'status not given',
        settles: (days: string) => `settles in ${days} days`,
        noSettle: 'settlement time not given',
        when: (hours: number) => `${hours} open hours in the next 7 days`,
        never: 'no open window in the next 7 days',
      },
    },
    wait: {
      min: (n: string) => `${n} min`,
      h: (n: string) => `${n} h`,
      days: (n: string) => `${n} days`,
    },
    flowTitle: 'Paths, as a flow',
    pathsTitle: 'Paths',
    pathsCaption: 'Ways to sell, with cost and loss',
    head: { path: 'Path', how: 'How', when: 'When', cost: 'Cost', loss: 'Loss' },
    best: 'best',
    capacityNotCost: 'capacity, not a cost',
    neverChosen: 'never chosen over a measured route',
    pathsNote:
      'The best path is the measured one with the smallest loss; on a tie, the one that does not wait. Issuer redemption rests on the issuer’s published terms, a scenario input, so it is shown but never chosen over a measured route.',
    paysTitle: 'What the best path pays',
    parts: {
      poolFee: 'pool fee',
      transferFee: 'transfer fee',
      impact: 'price impact',
      basis: 'basis against the reference',
      platformFee: 'platform fee',
      networkFee: 'network fee',
    },
    byRegimeTitle: 'The same sale by time of week',
    byRegimeCaption: 'Cost by time of week',
    regime: 'Time of week',
    now: 'now',
  },
  flow: {
    region: 'The paths as a flow, scrolls sideways',
    aria: (n: string, id: string) =>
      `Flow of a ${n} sale of ${id} through each path, its pools and payout token, to the dollars received`,
    columns: ['Position', 'Path', 'Pools the sale is split across', 'Paid out in', 'You receive'],
    position: (regime: string) => `your position, ${regime}`,
    received: 'Dollars received',
    receivedSub: 'USDC or USD',
    solHop: 'SOL, swapped to USDC',
    solHopSub: 'a second hop',
    usdOut: 'USDC / USDT',
    usdOutSub: 'paid out by the pool',
    issuer: 'Issuer redemption',
    issuerSub: 'settles T+5, KYC',
    samePools: 'The same pools',
    routed: 'routed',
    noOpenSplit: 'no split simulated in market hours yet',
    noSplit: 'no split for this path',
    assumption: 'assumption',
    notMeasured: 'not measured',
    cost: (c: string) => `cost ${c}`,
    noCost: 'cost not given',
    ofIt: (share: string) => `${share} of it`,
    best: 'best',
    note: (notes: string) =>
      `Each colour is one path; they are alternatives, not one sale. The best path is drawn strongest; issuer redemption is dashed because it rests on the issuer’s terms. Line width follows each pool’s share of the sale. ${notes} Received amounts and losses are the table’s, the fitted cost at the exact size; the split shows where the sale goes.`,
    nearest: (path: string, size: string, when: string) =>
      `${path}: shares from the ${size} simulation, the nearest simulated size, ${when}.`,
    exact: (path: string, when: string) => `${path}: split simulated at this size, ${when}.`,
    fee: (fee: string) => ` · fee ${fee}`,
    tips: {
      into: (n: string, id: string, path: string) => `${n} of ${id} into: ${path}`,
      receive: (path: string, got: string, loss: string, share: string) =>
        `${path}: you receive ${got}, a loss of ${loss} (${share})`,
      leg: (
        path: string,
        share: string,
        amount: string,
        sales: number,
        tokens: string | null,
        pool: string,
      ) =>
        `${path}: ${share} of each sale, ${amount}${sales > 1 ? ` in each of ${sales} sales` : ''}${
          tokens ? `, ${tokens} in all` : ''
        }, into ${pool}`,
      legCost: (path: string, cost: string | null, fee: string | null, quote: string | null) =>
        `${path}: this leg costs ${cost ?? 'an amount not given'} (pool fee ${fee ?? 'not given'}, the rest price impact and basis), paid out in ${quote ?? 'the quote token'}`,
      sol: (path: string, share: string) =>
        `${path}: ${share} of the sale is paid in SOL and swapped to USDC`,
      redeem: (n: string) => `redeem ${n} with the issuer`,
      issuerPays: 'what the issuer pays rests on its published terms, a scenario input',
      same: (path: string, why: string) => `${path}: the same routed sale; ${why}`,
    },
    src: 'flow chart',
  },
  methodology: {
    measured: 'What is measured',
    measuredText:
      'Every 5 minutes we read the on-chain state of each DEX pool that trades a tokenized stock (Raydium CLMM, Orca Whirlpool, Meteora DLMM, Raydium CPMM) and simulate swapping the stock for dollars, and dollars for the stock, at sizes from $100 to $5M. The simulation reproduces each venue’s swap math from the pool’s own accounts: liquidity at every price level, fees, and Token-2022 transfer fees. It is checked against Jupiter quotes routed through the same pool; the tolerance per venue is part of the test suite.',
    means: 'What a number means',
    meansItems: [
      [
        'Cost',
        '= 1 − dollars received ÷ (size × the pool’s mid price before the trade). It includes the pool fee.',
      ],
      [
        'Capacity at τ',
        '= the largest sale whose cost stays at or below τ (default 1%), from a curve fitted per time-of-week regime: the median cost per size across snapshots, made non-decreasing, interpolated on a log scale. No extrapolation beyond the largest measured size.',
      ],
      [
        'Regimes',
        '(US Eastern time, daylight saving handled): market hours Mon–Fri 09:30–16:00; weekday off-hours; weekend Fri 20:00 → Sun 20:00; NYSE holidays. A holiday with no data uses the weekend curve.',
      ],
      [
        'Weekend ratio',
        '= weekend capacity ÷ market-hours capacity at the same τ. Measured, not assumed.',
      ],
      [
        'LP concentration',
        '= share of liquidity within ±2% of the price held by the largest 1, 3 and 10 positions. The LP-exit stress recomputes the pool without the largest 3.',
      ],
      [
        'Recoverable value',
        '= the better of selling on a DEX in the best regime inside the horizon, and the issuer’s redemption where the window opens and settlement fits inside the horizon. Redemption capacity is a scenario input, labelled assumption; a redemption that settles after the horizon is listed but not counted.',
      ],
      [
        'Liquidity score',
        '= capacity at τ in the worst regime a horizon can contain, divided by a reference size, capped at 1. A number with its inputs beside it, not a grade.',
      ],
      [
        'Breach',
        ': for each upcoming withdrawal, what must come from stock after cash and liquid legs, against a share (default 25%) of the worst-regime capacity inside the withdrawal’s window. Likely breach applies the dry stress: capacity × max(25%, weekend ratio).',
      ],
    ],
    isNot: 'What a number is not',
    isNotItems: [
      'Depth measured in calm markets overstates depth in stress. Every curve shows its regime, sample count and dates.',
      'Curves simulate the best split of a sale across the asset’s dollar-exit pools (USDC, USDT, SOL pools), allocated in 32 chunks to whichever pool pays most for the next chunk. Jupiter quotes are collected every 15 minutes as an independent check; the gap is reported.',
      'Pools quoted in other tokens (not USDC, USDT or SOL) are not counted as exit routes.',
      'Published numbers are asset- and market-level aggregates. No wallet’s positions are published.',
    ],
  },
};

export type BearingDictionary = typeof bearingEn;
