// The exposure page (/portfolio/exposure), in English: what a person's vaults hold, added up chain by
// chain by underlying and by issuer, with what selling each holding would cost. It says what
// GET /v1/portfolio/exposure answers and no more: a selling cost is Bearing's measured number for one
// asset sold alone, a tier states no cost, and nothing is added across chains. From "The portfolio
// section's routes" in DESIGN-VAULT section 3.3: keep the two in step.

export const exposure = {
  /** The side menu's label. */
  label: 'Exposure',
  /** The page's title. */
  title: 'What your plans add up to.',
  lead: 'What your vaults hold, added up by what each asset tracks and by who issues it, and what selling each holding would cost. Nothing here signs or moves anything.',
  /** Said once, above the chains. */
  notes: {
    chains: 'Each chain is added up on its own. Chains are never added together.',
    vaults: 'A vault counts once it has been read. One that hasn’t been read yet adds nothing.',
    exit: 'A selling cost is for one asset sold alone, at the size of your whole holding of it on that chain. It is not the cost of selling everything at once.',
    bps: 'Costs are in basis points: 100 bps is 1%.',
  },
  /** Signed in, every chain read, and nothing held on any of them. */
  empty:
    'Your vaults hold nothing yet. What they hold appears here once a vault with something in it has been read.',
  chain: {
    /** Before the figure: what the vaults that were read hold together. */
    total: (vaults: number) =>
      vaults === 1 ? 'The 1 vault that was read holds' : `The ${vaults} vaults that were read hold`,
    /** When the oldest of the readings behind the sums was taken. */
    oldest: (when: string) =>
      `The oldest reading behind these sums was taken on ${when}. The sums are no fresher than that.`,
    /** Sums that came with no time: no figure is drawn. */
    undated: 'These sums came without the time they were read, so no figure is shown.',
    /** Something is held, and none of it has a price. */
    noPriced: 'Nothing held here has a price, so there is no sum to show.',
    /** A chain that was read, where no vault of the person's has a reading. */
    noneRead: (chain: string) =>
      `No vault of yours on ${chain} has been read yet, so there is nothing to add up.`,
    /** A chain whose vaults were read and hold nothing. */
    none: (vaults: number, chain: string) =>
      vaults === 1
        ? `Your vault on ${chain} holds nothing yet.`
        : `Your ${vaults} vaults on ${chain} hold nothing yet.`,
  },
  shares: {
    byUnderlying: 'By what each asset tracks',
    byIssuer: 'By who issues it',
    /** On the sample chain, in place of the split by issuer. */
    standIns:
      'On our sample chain every issuer and tier is a stand-in, so there is no split by issuer to show.',
    /** A test network's own tokens, as an issuer. */
    testNetwork: 'The test network’s own tokens',
  },
  exit: {
    heading: 'What selling would cost',
    /** Before the size a cost is for: the person's whole holding of the asset on the chain. */
    holding: 'Your holding',
    /** Before a measured cost. */
    measured: 'Measured cost of selling all of it',
    /** A cost in basis points: the number, then the unit. */
    bps: (cost: string) => `${cost} bps`,
    undated: 'It was measured, but the measurement came with no date, so no cost is shown.',
    unsourced: 'It was measured, but the measurement came without its source, so no cost is shown.',
    beyond: 'Your holding is larger than the largest sale that was measured, so no cost is stated.',
    /** Not measured: the tier is named, and a tier states no cost. */
    tier: (tier: string) =>
      `Not measured. Its tier, ${tier}, is only a ceiling on its share of a plan, and states no cost.`,
    unmeasured: 'Not measured, so no cost is shown.',
  },
  flags: {
    heading: 'What to know about these holdings',
    /** Before the name of a flag this page has no sentence for. */
    unnamed: 'A note we have no words for yet:',
    /** One sentence for each flag the risk roll-up can raise (packages/basket/src/roll-up.ts). */
    say: {
      issuer_concentration: 'More than half of what you hold here is with one issuer.',
      asset_not_on_shelf: 'A holding isn’t on the list of assets, so it couldn’t be classed.',
      exit_not_measured: 'No holding here has a measured selling cost yet.',
      exit_partly_measured: 'Only some of the holdings here have a measured selling cost.',
      exit_beyond_measured_size:
        'A holding here is larger than the largest sale that was measured, so selling it may cost more.',
      exit_capacity_short:
        'A holding here is larger than what can be sold for 1% or less at the worst time measured.',
      exit_quote_missing:
        'There is no recent quote for selling these holdings, so only measured costs are shown.',
      exit_quote_partial: 'Only some of these holdings have a recent quote for selling them.',
      exit_quote_stale: 'A quote for selling a holding here is more than three hours old.',
      exit_quote_far_from_size:
        'A quote for selling a holding here is for a size far from yours, so it may understate the cost.',
      quoted_provenance: 'The quoted selling cost rests on figures that are not live.',
      measured_provenance: 'The measured selling cost rests on figures that are not live.',
    },
  },
  unvalued: {
    heading: 'Holdings with no price',
    note: 'These have no price, or aren’t on the list of assets, so they are in no sum above.',
    /** Before the vault that holds it. */
    vault: 'in vault',
    /** The name of the link on a vault's shortened address. */
    open: (address: string) => `See the plan in vault ${address} over time`,
  },
  /** The way to the methodology. */
  more: 'Read how these figures are made, and what they can’t say yet',
};

export type Exposure = typeof exposure;
