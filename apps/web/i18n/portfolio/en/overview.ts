// The overview of the portfolio section (/portfolio), in English: what a person's plans are worth chain
// by chain, then one card a plan. Sums are a chain's own: plans on different chains are counted, never
// added together.

export const overview = {
  /** The side menu's label. */
  label: 'Overview',
  /** The page's title. */
  title: 'Your plans over time.',
  lead: 'Each plan sits in a vault of its own. We read every vault about every ten minutes and keep what we read. This page shows where each plan stands, and what stands behind every figure. Nothing here signs or moves anything.',
  /** How many plans there are: counted, and never added across chains. */
  count: (plans: number, chains: number) =>
    chains > 1
      ? `You have ${plans} plans on ${chains} chains. Each chain’s plans are added up on their own, never across chains.`
      : plans === 1
        ? 'You have 1 plan.'
        : `You have ${plans} plans.`,
  chain: {
    /** Before the figure: what a chain's plans are worth together. */
    worth: (plans: number, chain: string) =>
      plans === 1 ? `Your plan on ${chain} is worth` : `Your ${plans} plans on ${chain} are worth`,
    /** The method line in the pin of that figure. `vaults` are those the sum holds: the ones read. */
    method: (vaults: number, chain: string) =>
      vaults === 1
        ? `your vault on ${chain}, at its newest snapshot`
        : `your ${vaults} vaults on ${chain}, each at its newest snapshot, added up`,
    /** Vaults the sum leaves out, because nothing was read of them yet. */
    unread: (vaults: number) =>
      vaults === 1
        ? '1 vault hasn’t been read yet, so it is not in that sum.'
        : `${vaults} vaults haven’t been read yet, so they are not in that sum.`,
    /** No vault on the chain has a snapshot: no figure is shown. */
    noneRead: (plans: number, chain: string) =>
      plans === 1
        ? `Your plan on ${chain} hasn’t been read yet, so no value is shown.`
        : `Your ${plans} plans on ${chain} haven’t been read yet, so no value is shown.`,
    /** A chain that was read and holds no plan of the person's. */
    none: (chain: string) => `You have no plan on ${chain} yet.`,
    /** When a pass of the reader last went through on the chain. */
    answered: (chain: string, when: string) => `${chain} was last read on ${when}.`,
    neverAnswered: (chain: string) => `${chain} hasn’t been read yet.`,
  },
  card: {
    /** A vault the chain shows following a shared portfolio. */
    follows: (name: string) => `Your vault follows ${name}.`,
    /** A vault opened to follow one, where the chain's own word is not known. */
    openedFor: (name: string) => `Your vault was opened to follow ${name}.`,
    followsShared: 'Your vault follows a shared portfolio.',
    /** Under the sentence, where the vault was opened as one portfolio and the chain shows another. */
    openedAs: (name: string) => `It was opened to follow ${name}.`,
    /** A vault with no goal, no shared portfolio and no name of its own. */
    unknown: (chain: string) => `Your vault on ${chain}.`,
    value: 'Value now',
    putIn: 'You put in',
    /** No deposit of the person's through this app is confirmed for the vault. */
    noPutIn: 'No deposit of yours through this app is confirmed for this vault yet.',
    /** A vault the reader has not read: no value is shown. */
    neverRead: 'This vault hasn’t been read yet, so no value is shown.',
    unpriced: (n: number) =>
      n === 1
        ? '1 holding has no price, so the value leaves it out.'
        : `${n} holdings have no price, so the value leaves them out.`,
    /** How long ago the newest snapshot was taken, then when. */
    read: (age: string, when: string) => `Read ${age} ago, on ${when}.`,
    /** The card's one action. */
    open: 'See this plan over time',
  },
  /** The board at the top of the page: the figures beside the chart. */
  board: {
    total: 'Total portfolio value',
    vaults: 'Vaults',
    netIn: 'Net deposited',
    /** The method line of the net deposited figure. */
    netInMethod:
      'Confirmed deposits through this app, less confirmed withdrawals at their value when ordered.',
    allTime: 'All-time PnL',
    allTimeMethod:
      'The value at the newest snapshot, less what went in: deposits less withdrawals.',
    periodMethod:
      'The change in value over the period, from the snapshots kept, less what was deposited or withdrawn in it.',
    chartMethod: 'Your vaults added up at each snapshot kept.',
    pnl: 'PnL',
    gaining: 'Vaults gaining',
    best: 'Best vault',
    /** Under the PnL, where no vault has two readings in the period. */
    noPnl: 'Not enough readings in this period yet.',
    /** Where the sums hold one kind of figure and the person also holds another. */
    leftOut: (kind: string) => `Vaults on a ${kind} are not added in.`,
    kinds: {
      sandbox: 'test network',
      mock: 'sample chain',
      live: 'live chain',
      fixture: 'sample chain',
      prior_dataset: 'sample chain',
    },
    /** Withdrawals of a token that had no price when ordered. */
    unvalued: (n: number) =>
      n === 1
        ? '1 withdrawal had no price when ordered, so the net deposited leaves it out.'
        : `${n} withdrawals had no price when ordered, so the net deposited leaves them out.`,
    chart: {
      label: 'Chart',
      line: 'Line',
      byVault: 'By vault',
      byAsset: 'By asset',
      period: 'Period',
      periods: { '1d': '1D', '7d': '7D', '30d': '30D', '1y': '1Y', ytd: 'This year', all: 'All' },
      /** The plot's name for a screen reader. */
      plot: (from: string, to: string) => `Value of your vaults from ${from} to ${to}`,
      bars: (from: string, to: string) => `Value of your vaults, stacked, from ${from} to ${to}`,
      up: 'Above what you put in',
      down: 'Below what you put in',
      cash: 'Cash',
      empty: 'No readings in this period yet. A reading is taken about every ten minutes.',
      reading: 'Reading the history…',
      hint: 'Point at the chart, or use the arrow keys, to read a day.',
    },
  },
  /** The table of vaults under the board. */
  table: {
    heading: 'Your vaults',
    vault: 'Vault',
    chain: 'Chain',
    value: 'Value',
    netIn: 'Net deposited',
    allTime: 'All-time PnL',
    period: (period: string) => `PnL ${period}`,
    status: 'Status',
    open: (vault: string) => `Open ${vault}`,
    newPlan: 'New plan',
    neverRead: 'Not read yet',
  },
  /** At the foot of the page, beside "Read again". */
  refresh: 'A new snapshot is taken about every ten minutes.',
};

export type Overview = typeof overview;
