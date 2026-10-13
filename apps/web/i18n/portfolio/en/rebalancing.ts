// The rebalancing page (/portfolio/rebalancing), in English: the steps that traded in a person's
// vaults or adopted a version, newest first, vault by vault. It says what GET /v1/portfolio/rebalances
// answers and no more: a step of the person's own carries a quote, never what the trade paid, and a
// trade of the keeper's is worked out from two snapshots. From "The portfolio section's routes" in
// DESIGN-VAULT section 3.3: keep the two in step.

export const rebalancing = {
  /** The side menu's label. */
  label: 'Rebalancing',
  /** The page's title. */
  title: 'What rebalancing did.',
  lead: 'The steps that traded in your vaults, or adopted a new version of the portfolio a vault follows. Newest first, vault by vault. Nothing here signs or moves anything.',
  /** Signed in, every chain read, and no step to list. */
  empty: 'There are no steps to list yet. They appear here once one of your plans has traded.',
  /** No step on the chains that were read, while another chain could not be read. */
  noneRead: 'There are no steps to list on the chains that were read.',
  /** A chain's list holds the most one answer has: older steps are not in it. */
  capped: (limit: number, chain: string) =>
    `Only the newest ${limit} steps on ${chain} are listed. Older ones are not shown.`,
  /** At the foot of the page, beside "Read again". */
  refresh:
    'A step of yours shows here as soon as our server has it. A trade of our keeper’s shows after the vault is next read.',
  group: {
    /** A vault the plans do not name: by its chain, with its address under it. */
    unnamed: (chain: string) => `Your vault on ${chain}`,
    /** How many steps are listed for the vault. */
    count: (steps: number) => (steps === 1 ? '1 step' : `${steps} steps`),
    /** The last group: steps our server filed under no vault. */
    unknown: (chain: string) => `Steps on ${chain} with no vault named`,
    unknownWhy:
      'Our server hasn’t matched these steps to one of your vaults, so this list can’t say which vault they were for.',
  },
  /** After a step's time: what kind of time it is. */
  when: {
    built: 'when the step was built',
    chain: 'the chain’s time of the trade',
  },
  /** Whose step it is, beside its mark. */
  by: {
    owner: 'Your step',
    keeper: 'Our keeper’s step',
  },
  /** How the step ended, beside its shape. */
  outcome: {
    confirmed: 'Confirmed',
    failed: 'Failed',
  },
  /** Why a step was made, one sentence for each reason an order can carry. */
  why: {
    manual: 'You made this step yourself.',
    index_update: 'The portfolio this vault follows published a new version.',
    drift: 'A part had moved too far from its planned share.',
    liquidity_breach:
      'A part that is hard to sell was cut back, so that cash can be reached in time.',
    /** No reason is recorded: every trade of the keeper's, for now. */
    none: 'No reason is on record for this step.',
    /** After the reason, for a step that adopts a version. */
    version: 'It adopted a new version of the portfolio the vault follows.',
  },
  /** A step with no trade in it. */
  noTrade: 'This step traded nothing.',
  /** A step of the person's own with no transaction on record. */
  noTx: 'No transaction is on record for this step.',
  trade: {
    /** One side of a trade is the chain's cash token, named in the brackets. */
    bought: (asset: string, cash: string) => `Swapped cash (${cash}) into ${asset}.`,
    sold: (asset: string, cash: string) => `Sold ${asset} for cash (${cash}).`,
    /** The same trades in a step that failed. */
    triedBuy: (asset: string, cash: string) => `Tried to swap cash (${cash}) into ${asset}.`,
    triedSell: (asset: string, cash: string) => `Tried to sell ${asset} for cash (${cash}).`,
    /** A trade that names no cash side. */
    swapped: (sold: string, bought: string) => `Sold ${sold} for ${bought}.`,
    triedSwap: (sold: string, bought: string) => `Tried to sell ${sold} for ${bought}.`,
    /** An amount of a token: "18,000" and "USDC". */
    tokens: (amount: string, token: string) => `${amount} ${token}`,
    /** What a step of the person's own put into the trade. */
    paid: 'Paid',
    soldAmount: 'Sold',
    /** The same amount in a step that failed, which paid and sold nothing. */
    amount: 'Amount in the step',
    /** What the vault held of the asset in the two readings a keeper's trade lies between. */
    heldBefore: 'Held before',
    heldAfter: 'Held after',
    /** A token this app holds no units for: its raw amounts are not written as figures. */
    noUnits: (token: string) =>
      `This app has no units for ${token}, so the amounts before and after aren’t shown.`,
    quoted: 'Quoted cost',
    /** A cost in basis points: the number, then the unit. */
    bps: (cost: string) => `${cost} bps`,
    quoteZero: 'A quote can read as zero where there was no reference price.',
    /** The traded asset against its planned share, in the readings nearest each side of the step. */
    before: 'Before',
    after: 'After',
    over: (by: string) => `${by} over its planned share`,
    under: (by: string) => `${by} under its planned share`,
    at: 'at its planned share',
    /** When the reading was taken. */
    read: (when: string) => `read ${when}`,
  },
  /** Once in a step that carries a quote: what the quoted cost is. */
  quoteNote:
    'The quoted cost is from the quote this step was built with. It is not what the trade paid.',
  /** The quiet line of a trade worked out from snapshots. */
  derived: 'Worked out from two readings of the vault. It is not a record of the trade.',
  /** After a transaction id on the sample chain, in place of a link. */
  noExplorer: 'on our sample chain, so no explorer shows it',
  /** Once on the page: what the list cannot tell yet. */
  note: {
    heading: 'What this list can’t tell yet',
    items: [
      'When a step of yours confirmed on the chain. The time shown is when the step was built.',
      'What a trade paid. The cost shown is a quote, in basis points: 100 bps is 1%.',
      'Our keeper’s trades one by one. Each is worked out from two readings of a vault in the last thirty days, so it has no transaction, no quote and no reason, and several trades of one asset between two readings show as one.',
      'A version our keeper adopted for you, and your own rebalances, withdrawals and changes of settings: those orders aren’t built yet.',
    ],
    more: 'Read how these pages work, and what else they can’t say yet',
  },
};

export type Rebalancing = typeof rebalancing;
