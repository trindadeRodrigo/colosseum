// A plan's status in English (gate ON-TRACK-V1): the three words, and one sentence for each line of
// the rule, made from the figures the line names. The status and its line are the server's; nothing
// here decides one. `features/portfolio-section/status.ts` picks the sentence.

export const status = {
  words: {
    on_track: 'On track',
    watch: 'Watch',
    off_track: 'Off track',
  },
  /** In place of the word, where the rule gives no status yet. */
  none: 'No status yet',
  /** The rule that gave the status, printed beside it. */
  rule: (name: string) => `Rule ${name}`,
  /** A line that came without the figures its sentence names. */
  noFigures: 'Our server gave this status without the figures behind it.',
  lines: {
    /** A verdict on the goal was handed in: it wins over every other line. */
    verdict: {
      coveredBoth: 'Your goal is covered now, and under the stress cases too.',
      coveredNoStress: 'Your goal is covered now. No stress case was run.',
      coveredNotStress: 'Your goal is covered now, but not under the stress cases.',
      notCovered: 'Your goal is not covered now.',
      /** After any of the four, when the verdict names its day. */
      observedOn: (day: string) => `Observed on ${day}.`,
    },
    never_read: 'This vault hasn’t been read yet, so there is no status to give.',
    empty:
      'The vault holds nothing yet. A deposit counts once the chain shows the vault holding it.',
    chain_silent: (hours: number) =>
      `Nothing has been read from this plan’s chain for ${hours} hours, a day or more, so I can’t say where it stands.`,
    loss_half: (used: string) =>
      `Our keeper’s losses have used ${used} of their budget, half or more.`,
    unpriced: {
      one: (asset: string) => `${asset} is held and has no price, so the plan can’t be weighed.`,
      many: (count: number, asset: string) =>
        `${count} parts you hold have no price, ${asset} first, so the plan can’t be weighed.`,
    },
    no_band:
      'This chain doesn’t state how far a part may drift from its planned share, so there is nothing to hold the parts to.',
    outside_band: {
      over: (asset: string, by: string, band: string) =>
        `${asset} is ${by} over its planned share, more than the ${band} it may drift.`,
      under: (asset: string, by: string, band: string) =>
        `${asset} is ${by} under its planned share, more than the ${band} it may drift.`,
    },
    cash_over: (by: string, band: string) =>
      `Cash is ${by} over its share of the plan, more than the ${band} it may drift.`,
    loss_quarter: (used: string) =>
      `Our keeper’s losses have used ${used} of their budget, a quarter or more.`,
    stale: (minutes: number) =>
      `The vault was last read ${minutes} minutes ago, more than an hour.`,
    inside: (band: string, used: string) =>
      `Every part is within ${band} of its planned share, and our keeper’s losses have used ${used} of their budget.`,
    inside_no_budget: (band: string) =>
      `Every part is within ${band} of its planned share. This chain keeps no loss budget.`,
  },
};

export type Status = typeof status;
