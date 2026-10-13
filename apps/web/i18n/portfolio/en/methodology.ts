import type { TrackLine } from '@colosseum/schemas';

// How the portfolio section reads a person's plans (/portfolio/methodology), in English: what a
// snapshot is, what each status means and the lines of its rule in order, where each figure comes
// from, and what the pages cannot say yet. From gates ON-TRACK-V1 and SNAPSHOT-WORKER in docs/GATES.md
// and "The portfolio section's routes" in DESIGN-VAULT section 3.3: keep the three in step. Plain
// text, with no figure in it. The rule's name is the constant's, handed in.

/** One sentence for each line of the rule: what has to hold for the line to give the status. */
const lines: Record<TrackLine, string> = {
  verdict:
    'Our engine has handed in a verdict on your goal. It wins over every line below, and the status then names the engine’s rule. Nothing hands one in yet.',
  never_read: 'The vault has no snapshot yet.',
  empty: 'The vault holds nothing. A deposit counts once the chain shows the vault holding it.',
  chain_silent: 'A day or more has passed since the chain was last read.',
  loss_half:
    'Our keeper’s losses have used half or more of the loss budget. This is the line our keeper raises an alert on.',
  unpriced: 'A part that is held and planned has no price, so the plan can’t be weighed.',
  no_band: 'The chain states no band, so there is nothing to hold the parts to.',
  outside_band:
    'A part is further from its planned share than the band. Exactly at the band counts as inside.',
  cash_over:
    'Cash is over its share by more than the band. Cash under its share is no line of its own.',
  loss_quarter: 'Our keeper’s losses have used a quarter or more of the loss budget.',
  stale: 'The newest snapshot is more than an hour old.',
  inside:
    'None of the lines above holds. The share of the loss budget used is said beside the status.',
  inside_no_budget:
    'None of the lines above holds, on a chain that keeps no loss budget. Such a chain skips the two loss lines.',
};

export const methodology = {
  /** The side menu's label. */
  label: 'Methodology',
  /** The page's title. */
  title: 'How these pages read your plans.',
  lead: 'What a snapshot is, what each status means, where each figure comes from, and what these pages can’t say yet.',
  snapshot: {
    heading: 'What a snapshot is',
    body: [
      'A snapshot is one read of a vault, kept whole: what it held, what each part was worth, its share and its planned share, and every price the values stood on. Each price keeps its source, its time and its method.',
      'We read every vault we know about every ten minutes, from its own chain, and keep each read. A vault made outside this app is found within the hour.',
      'The reader holds no key. It reads and keeps: it can’t sign, trade or move anything.',
      'For now it reads test networks and our sample chain only. Every figure here carries that label, and none is shown as live.',
      'A snapshot more than an hour old is called stale, with its age beside it.',
    ],
  },
  status: {
    heading: 'What each status means',
    /** `rule` is the rule's name and version. */
    intro: (rule: string) =>
      `A plan’s status comes from our server. It is worked out from the newest snapshot of the plan’s vault by one fixed rule, named ${rule}, and printed with the line of the rule that gave it.`,
    notForecast:
      'The rule estimates nothing. It reads what the snapshot kept, and it is not a forecast.',
    /** Under each of the three words, and under "No status yet". */
    means: {
      on_track:
        'None of the lines below holds: every part and the cash are inside the band, our keeper’s losses are under a quarter of the loss budget, and the newest snapshot is no more than an hour old.',
      watch:
        'A part is outside the band, or cash is over its share by more than the band, or a part that is held and planned has no price, or our keeper’s losses have used a quarter or more of the loss budget, or the newest snapshot is more than an hour old.',
      off_track:
        'Our keeper’s losses have used half or more of the loss budget, or the chain hasn’t been read for a day or more.',
      none: 'There is nothing to hold the vault to yet: it hasn’t been read, it holds nothing, or its chain states no band.',
    },
    /** What the status does not say. */
    goal: 'The status says how a vault stands against its plan and its chain’s limits. It doesn’t say yet whether your goal’s amount or date will be met: that verdict is our engine’s, and it isn’t connected yet.',
    terms: [
      [
        'Band',
        'how far a part may sit from its planned share before it counts as outside. It is the chain’s setting, kept with each snapshot.',
      ],
      [
        'Loss budget',
        'the most our keeper may lose of a vault in a week when it rebalances. It is the chain’s setting too, kept with each snapshot.',
      ],
    ],
    order: 'The lines of the rule, in the order they are tried',
    first: 'The first line that holds gives the status.',
    /** In place of a status word, beside the one line that hands the status over. */
    asVerdict: 'The verdict’s own status',
    lines,
  },
  sources: {
    heading: 'Where each figure comes from',
    items: [
      [
        'A vault’s value',
        'the newest snapshot of the vault: what it held as the chain’s reader gave it, each part at the price kept with the snapshot, and cash at one dollar.',
      ],
      [
        'A chain’s total',
        'the values in the newest snapshot of each of your vaults on that chain, added up. Vaults on different chains are counted, never added together.',
      ],
      [
        'What you put in',
        'the cash of each of your deposits through this app that confirmed, counted once an order. It is gross: a withdrawal is not taken off, and money that reached the vault another way is not in it.',
      ],
      [
        'The status',
        'our server’s reading of the newest snapshot by the rule above, with the line that gave it and the rule’s name.',
      ],
      [
        'A value over time',
        'one point for each step of the time shown: the last snapshot taken in that step.',
      ],
      [
        'A rebalance',
        'a step of yours comes from this app’s record of your orders, with the quote it was last built with. A trade of our keeper’s is worked out from two snapshots between which the chain shows it traded an asset.',
      ],
      [
        'Exposure',
        'what the newest snapshot of each vault held, added up by what each asset tracks and by who issues it, chain by chain.',
      ],
      [
        'A selling cost',
        'Bearing’s measured cost of selling your whole holding of one asset on one chain. Where Bearing doesn’t measure the asset, its tier is named as a fallback, and a tier states no cost.',
      ],
    ],
    pin: 'Every figure carries its source, its time and its method: open the mark beside it to read them.',
  },
  cannot: {
    heading: 'What these pages can’t say yet',
    items: [
      'When a step of yours confirmed on the chain. The time beside a step is when it was built: nothing records the moment it confirmed.',
      'What a trade paid. The cost beside a step is the quote it was built with, and it can read as zero where there was no reference price.',
      'Our keeper’s trades one by one. Its own log isn’t in our records, so each of its lines is worked out from snapshots, with no transaction id, no quote and no reason. Several trades of one asset between two snapshots show as one.',
      'A version of a shared portfolio that our keeper adopted for you.',
      'Your own rebalances, withdrawals and changes of settings. Those orders aren’t built yet, so your steps here are deposits and versions you accepted by hand.',
      'What you took out. What you put in is gross, and the time of a deposit is when our server learned of it.',
      'The cost of selling everything at once. Each selling cost is one asset sold alone.',
      'Which pools, or which hour of the week, a selling cost came from.',
      'A selling cost across chains: each is measured on one chain.',
      'Real issuers and tiers on our sample chain: every issuer there is a stand-in.',
    ],
  },
  /** Before the disclaimer, which is the one constant and is not said here. */
  boundary:
    'These pages show what was read and how it was worked out. They don’t tell you what to do: the statement below applies to all of it.',
};

export type Methodology = typeof methodology;
