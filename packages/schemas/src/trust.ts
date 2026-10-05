import type { ChainId } from './chain';

/**
 * What the app tells a person about the trust they place in it, before their first deposit and
 * wherever the vault's terms are shown (DESIGN-VAULT section 13, "What the app says"). One constant,
 * next to `DISCLAIMER`: the screens word it, and never state a fact about the vaults that is not here.
 *
 * `textVersion` names this text. A person's acceptance is kept with it, so a change to anything below
 * that a person must read again comes with a new version.
 */
export const TRUST_STATUS = {
  textVersion: '2026-10-05',
  /** No outside audit of the vault programs or contracts has been made. */
  audited: false,
  /** Who holds the keys that upgrade the vault code. The team: it could change the code, so it could move funds. */
  upgradeKeys: 'team',
  /**
   * The admin of each chain's deployment, as its deploy recorded it: the key that upgrades and
   * changes parameters. Only deployed chains are listed. Solana: `roles.admin` of
   * `deployments/solana-devnet.json` (trust.test.ts holds the two together).
   */
  admin: { solana: '32AQhayMMrQFW3DgdmwW6EBwjQE8Ek8HeB4ixL55boWC' } as Partial<
    Record<ChainId, string>
  >,
  /**
   * What the keeper may do in a vault with auto-follow on, per deployed chain, as the deploy set it:
   * a trade is refused when it receives less than the reference price minus `toleranceBps`, and a leg
   * that loses is refused once the week's losses would pass `weeklyLossCapBps` of the vault's value.
   * Solana: `params.toleranceBps` and `params.lossCapBps` of `deployments/solana-devnet.json`.
   */
  keeper: { solana: { toleranceBps: 75, weeklyLossCapBps: 100 } } as Partial<
    Record<ChainId, { toleranceBps: number; weeklyLossCapBps: number }>
  >,
  /** Issuers of stock tokens can pause, freeze or seize them. */
  issuersCanFreeze: true,
  /** The product is not offered to people in the United States. */
  usPersons: 'blocked',
  /** A passkey that is lost and not synced loses the wallet it opens. */
  passkeyLoss: true,
  /**
   * The checks of tier 2 (DESIGN-VAULT section 13) not yet run and recorded. Each leaves the notice when
   * docs/vault/SECURITY.md records it run; A1 and A11 on a replayed route are done for the owner's swap
   * (Oct 3) and are not listed.
   */
  openChecks: [
    'evm_invariants',
    'solana_sequences',
    'static_analysis',
    'robinhood_fork',
    'second_rehearsal',
  ] as readonly (
    | 'evm_invariants'
    | 'solana_sequences'
    | 'static_analysis'
    | 'robinhood_fork'
    | 'second_rehearsal'
  )[],
  /** Set during an incident (docs/INCIDENT.md): a banner, and reads and withdrawals only. */
  incident: null as null | { since: string; text: string },
} as const;
export type TrustStatus = typeof TRUST_STATUS;
