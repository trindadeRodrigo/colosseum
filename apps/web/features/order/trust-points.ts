import { type ChainId, TRUST_STATUS } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n';

// What the trust notice says, as two lists: the short points and the whole notice. Pure, so that what a
// person reads on a live network is held by a test. On a test network or the mock the text is the one
// it always was. On mainnet (`live`) it states that chain's own facts from TRUST_STATUS.mainnet: who can
// change the contracts and how long a change waits, the guardian, no keeper, no deposit cap, the checks
// on a trade, and what the issuers can do. A chain with no mainnet facts has no live notice: `null`, and
// nothing is offered for signing without one.

export type TrustPoints = { short: string[]; items: string[] };

export function trustPoints(
  t: Dictionary,
  chain: ChainId,
  o: {
    /** The chain's figures are live: it runs on mainnet. */
    live: boolean;
    /** The keeper may trade the vault this is shown for (a test network's short points only). */
    keeperTrades: boolean;
    /** The keeper's two limits as text, for a test network; null where none are set. */
    limits: readonly [string, string] | null;
  },
): TrustPoints | null {
  const unaudited = TRUST_STATUS.audited ? [] : [t.trust.unaudited];
  const unauditedShort = TRUST_STATUS.audited ? [] : [t.trust.short.unaudited];
  const tail = [
    ...(TRUST_STATUS.usPersons === 'blocked' ? [t.trust.notUnitedStates] : []),
    ...(TRUST_STATUS.passkeyLoss ? [t.trust.passkey] : []),
    ...(TRUST_STATUS.openChecks.length
      ? [t.trust.openChecks(TRUST_STATUS.openChecks.map((c) => t.trust.checks[c]).join('; '))]
      : []),
  ];
  if (o.live) {
    const facts = TRUST_STATUS.mainnet[chain];
    if (!facts) return null;
    const m = t.trust.mainnet;
    // The checks listed as not run are a test network's list, written about an admin key. The one that
    // names it is left out here: there is no such key on this chain, and the others are still not run.
    const checks = TRUST_STATUS.openChecks.filter((c) => c !== 'second_rehearsal');
    return {
      // What must be read before the tick, in sight and not behind "Read the full list": that it is real
      // money and can be lost, who can change the code, who can pause, and what checks a trade.
      short: [
        m.real,
        m.loss,
        ...unauditedShort,
        m.short.governance(facts.delayHours, facts.safeSignatures),
        m.guardian,
        ...(facts.tradesChecked ? [m.trades] : []),
        ...(facts.keeper ? [] : [m.short.noKeeper]),
        ...(facts.depositCap ? [] : [m.short.noCap]),
        ...(facts.issuerCanUpgradeStocks || facts.cashCanBeFrozen ? [m.short.issuers] : []),
      ],
      items: [
        m.real,
        m.loss,
        ...unaudited,
        m.governance(facts.delayHours, facts.safeSignatures),
        m.safe(facts.safe),
        m.guardian,
        m.withdraw,
        ...(facts.keeper ? [] : [m.noKeeper]),
        ...(facts.depositCap ? [] : [m.noCap]),
        ...(facts.tradesChecked ? [m.trades] : []),
        ...(facts.issuerCanUpgradeStocks || facts.cashCanBeFrozen ? [m.issuers] : []),
        ...(TRUST_STATUS.usPersons === 'blocked' ? [t.trust.notUnitedStates] : []),
        ...(TRUST_STATUS.passkeyLoss ? [t.trust.passkey] : []),
        ...(checks.length
          ? [t.trust.openChecks(checks.map((c) => t.trust.checks[c]).join('; '))]
          : []),
      ],
    };
  }
  const admin = TRUST_STATUS.admin[chain];
  return {
    short: [
      ...unauditedShort,
      t.trust.short.keys,
      ...(o.keeperTrades
        ? [o.limits ? t.trust.short.keeper(...o.limits) : t.trust.short.keeperUnset]
        : []),
      ...(TRUST_STATUS.issuersCanFreeze ? [t.trust.short.issuers] : []),
    ],
    items: [
      ...unaudited,
      t.trust.keys,
      ...(admin ? [t.trust.admin(admin)] : []),
      o.limits ? t.trust.keeper(...o.limits) : t.trust.keeperUnset,
      ...(TRUST_STATUS.issuersCanFreeze ? [t.trust.issuers] : []),
      ...tail,
    ],
  };
}
