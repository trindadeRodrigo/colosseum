// A plan's own page (/portfolio/plan/<chain>/<address>), in English: one plan in one vault, over time.
// The goal first, then the vault's value over time, each part against its target, what leaving would
// cost, where the risk sits, the latest trades and the person's own steps. The goal's sentence and the
// two figures of the head are said in the words of the overview's card (overview.ts), the table's
// columns in the monitor's and the kinds of asset in the plan screen's (i18n/en.ts): this file holds
// what only this page says.

export const plan = {
  /** The browser tab's name for the page. */
  label: 'A plan',
  /** The page's title until its plan is read; from then on the title is the plan's goal. */
  title: 'This plan over time.',
  /** The way back to the overview. */
  back: 'All your plans',
  /** The address names no vault of the person's: said the same whether or not such a vault exists. */
  notFound: 'There is no plan of yours to show at this address.',
  /** The chain the address names could not be read: the plan may be on it. */
  chainOut: (chain: string) =>
    `Your plans on ${chain} couldn’t be read, so I can’t show this one now.`,
  head: {
    /** The name of the block under the goal: the status, the two figures, when the vault was read. */
    label: 'Where this plan stands',
  },
  /** In place of every figure of a vault that was never read. */
  unread:
    'Once this vault has been read, its value over time, its parts, what leaving would cost and where its risk sits appear here. We read each vault about every ten minutes.',

  /** The vault's value over time. */
  history: {
    heading: 'Value over time',
    lead: 'What this vault was worth at each snapshot we kept. The line is measured, not projected.',
    reading: 'Reading this vault’s history…',
    window: {
      label: 'How far back',
      day: '24 hours',
      week: '7 days',
      month: '30 days',
      quarter: '90 days',
    },
    /** The plot's name for a screen reader. */
    plot: (from: string, to: string) =>
      `This vault’s value from ${from} to ${to}, one point for each snapshot kept.`,
    hint: 'Point at the figure, tap it or use the arrow keys to read one point.',
    /** Before the time of the newest point, in the line that reads a point out. */
    newest: 'Newest snapshot',
    legend: {
      label: 'What the figure draws',
      value: 'Value at each snapshot, measured',
      deposit: 'A deposit of yours',
    },
    /** No point in the window: a sentence, never an empty frame. */
    none: (when: string) =>
      `No snapshot of this vault falls in this window: its newest is from ${when}. We take a snapshot about every ten minutes.`,
    /** One point: a sentence too. */
    one: 'One snapshot falls in this window so far. A line needs two, and we take a snapshot about every ten minutes.',
    /** Before the one point's figure. */
    oneAt: (when: string) => `On ${when}:`,
    deposits: {
      label: 'Your deposits in this window',
      name: (n: number) => `Deposit ${n}`,
      /** After a deposit's amount: the time is when the server learned of it. */
      recorded: (when: string) => `recorded on ${when}`,
      note: 'A deposit is marked at the time our server learned it had confirmed, which can be a little after it reached the chain.',
      outside: (n: number) =>
        n === 1
          ? '1 deposit of yours falls outside this window.'
          : `${n} deposits of yours fall outside this window.`,
    },
  },

  /** Each part against its target. */
  parts: {
    heading: 'Each part against its target',
    /** The table's name for a screen reader. */
    caption: 'What this vault held at its newest snapshot, against its plan',
    band: (band: string) =>
      `A part may sit up to ${band} from its planned share before it counts as outside the band. Cash counts only when it is over its share.`,
    /** A part that is held has no price: nothing is held to the band. */
    unweighed:
      'A part held here has no price, so each share is a share of what could be valued, and nothing is held to the band.',
    /** The header of the column that says where a part is against the band. */
    status: 'Band',
    outside: 'Outside the band',
    /** In place of a value, a share or a difference. */
    noPrice: 'No price',
    noneHeld: 'None held',
    notWeighed: 'Not weighed',
    priceNotKept: 'Price not kept',
    empty: 'This vault holds nothing, so there are no parts to show.',
  },

  /** What leaving would cost. */
  exit: {
    heading: 'What leaving would cost',
    lead: 'Each cost is Bearing’s measure of selling this vault’s whole holding of one asset, alone, at the size shown. It is not the cost of selling everything at once, which these figures can’t say. A basis point is a hundredth of a percent.',
    reading: 'Reading what leaving would cost…',
    holding: 'Holding',
    costLabel: 'Selling it alone',
    cost: (bps: number, shown: string) =>
      bps === 1 ? `${shown} basis point` : `${shown} basis points`,
    /** Measured, and this size is beyond what was measured. */
    beyond: 'This holding is larger than the largest sale measured, so no cost is stated.',
    /** A measured cost whose stamp lacks its time: no number. */
    notDated: 'A cost was measured, but the measurement is not dated, so no number is shown.',
    /** A measured cost whose stamp lacks its source, its method or its label: no number. */
    noSource: 'A cost was measured, but it came with no source, so no number is shown.',
    /** Not measured: the tier is the fallback, and a tier states no cost. */
    tier: (tier: string) =>
      `Not measured. Its tier, ${tier}, is only a ceiling on its share of a plan and states no cost.`,
    notMeasured: 'Not measured, so no cost is stated.',
    /** The vault has a value, and nothing in it would have to be sold. */
    none: 'Nothing this vault holds would have to be sold: it holds only cash, or nothing with a price.',
    /** The vault holds nothing with a value. */
    nothing: 'This vault holds nothing with a value, so there is no selling cost to show.',
    unvalued: (n: number, names: string) =>
      n === 1
        ? `${names} is held with no price, so it is in none of these figures.`
        : `${names} are held with no price, so they are in none of these figures.`,
  },

  /** The risk roll-up. */
  risk: {
    heading: 'Where the risk sits',
    lead: 'This vault’s holdings by who issues them and by kind of asset, and what the figures flag.',
    reading: 'Reading where the risk sits…',
    /** Before the vault's value: what the shares are shares of. */
    of: 'Shares of what this vault held with a value:',
    nothing: 'This vault holds nothing with a value, so there is no split to show.',
    /** On the mock every issuer is the mock. */
    standIn:
      'On our sample chain every issuer is a stand-in, so this split says nothing about real issuers.',
    flags: {
      heading: 'What these figures flag',
      none: 'Nothing is flagged for this vault.',
      /** A flag this page has no sentence for: shown by its own name, never dropped. */
      unknown: (name: string) => `One more flag, which I have no sentence for yet: ${name}.`,
      /** One sentence for each flag `rollUp` of packages/basket can raise. */
      known: {
        issuer_concentration: 'More than half of this vault is with one issuer.',
        asset_not_on_shelf: 'A holding isn’t on our list of assets, so it couldn’t be classed.',
        exit_not_measured: 'No holding that would have to be sold has a measured selling cost yet.',
        exit_partly_measured:
          'Only some of the holdings that would have to be sold have a measured selling cost.',
        exit_beyond_measured_size:
          'A holding is larger than the largest sale measured for it, so no cost is stated for it.',
        exit_capacity_short:
          'A holding is larger than what can be sold for 1% or less at the worst time measured.',
        exit_quote_missing: 'No quote for selling a holding is on record yet.',
        exit_quote_partial: 'Only some holdings have a quote for selling them on record.',
        exit_quote_stale: 'A quote for selling a holding is more than three hours old.',
        exit_quote_far_from_size:
          'A quote for selling a holding is for a size far from the size held here.',
      },
      /** `quoted_provenance:<label>` and `measured_provenance:<label>`. */
      quoted: (kind: string) =>
        `A quote behind these figures comes from ${kind}, not from a live market.`,
      measured: (kind: string) =>
        `A measured cost behind these figures comes from ${kind}, not from a live market.`,
      /** How a label that is not live is said in those two sentences. */
      kinds: {
        mock: 'sample data',
        sandbox: 'a test network',
        fixture: 'a fixture',
        prior_dataset: 'an earlier dataset',
      },
      otherKind: 'a source that is not live',
    },
  },

  /** The latest steps that traded for the vault. */
  trades: {
    heading: 'Latest trades',
    lead: 'The newest steps that traded for this vault or changed the version it follows: your own, and our keeper’s rebalances.',
    reading: 'Reading the latest trades…',
    none: 'No trade of this vault is on record yet.',
    /** The link to the rebalancing page. */
    all: 'See every trade and rebalance',
    by: {
      owner: 'You',
      keeper: 'Our keeper',
    },
    trade: (sell: string, buy: string) => `${sell} → ${buy}`,
    /** A version accepted or adopted: it trades nothing. */
    version: 'A new version of the portfolio it follows',
    noTrade: 'A step with no trade',
    /** A step of the person's: the time is when it was built. */
    built: (when: string) => `built on ${when}`,
    /** A trade of the keeper's: the time is the chain's. */
    traded: (when: string) => `traded on ${when}`,
    derived: 'worked out from two snapshots of the vault',
    more: (n: number) =>
      n === 1 ? '1 older step is not shown here.' : `${n} older steps are not shown here.`,
    /** The section reads the newest steps only: an older one of this vault may not be among them. */
    cut: (n: number) =>
      `Only the newest ${n} steps of your vaults are read here, so an older one may be missing.`,
  },

  /** The person's own steps, from the order record. */
  activity: {
    note: 'Below are the steps of your own orders for this vault that reached the chain, as this app recorded them. Our keeper’s trades are not among them.',
    none: 'No step of an order of yours for this vault has reached the chain yet.',
  },
};

export type Plan = typeof plan;
