import { TRUST_STATUS } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../i18n/en';
import { pt } from '../../i18n/pt';
import { acceptTrust, trustAccepted } from './order-record';
import { trustPoints } from './trust-points';

// What a person reads before a first deposit, on a test network and on mainnet. The mainnet text is
// for real money: it is read by a person before it ships, and this holds it to the facts it states.

const limits = ['1.25%', '1%'] as const;

describe('the trust notice’s points', () => {
  it('on a test network, says what it always said: the team’s key, by its address, and the keeper’s limits', () => {
    const points = trustPoints(en, 'robinhood', { live: false, keeperTrades: true, limits });
    expect(points?.short).toEqual([
      en.trust.short.unaudited,
      en.trust.short.keys,
      en.trust.short.keeper(...limits),
      en.trust.short.issuers,
    ]);
    expect(points?.items).toContain(en.trust.admin(TRUST_STATUS.admin.robinhood ?? ''));
    expect(points?.items.join(' ')).not.toContain('Safe');
  });

  it('on mainnet, states the timelock, the Safe, the guardian, no keeper, no cap, the trade checks and the issuers', () => {
    const facts = TRUST_STATUS.mainnet.robinhood;
    if (!facts) throw new Error('no mainnet facts for Robinhood Chain');
    const points = trustPoints(en, 'robinhood', { live: true, keeperTrades: true, limits });
    const m = en.trust.mainnet;
    const checks = TRUST_STATUS.openChecks.filter((c) => c !== 'second_rehearsal');
    expect(points?.items).toEqual([
      m.real,
      m.loss,
      en.trust.unaudited,
      m.governance(48, 2),
      m.safe(facts.safe),
      m.guardian,
      m.withdraw,
      m.noKeeper,
      m.noCap,
      m.trades,
      m.issuers,
      en.trust.notUnitedStates,
      en.trust.passkey,
      en.trust.openChecks(checks.map((c) => en.trust.checks[c]).join('; ')),
    ]);
    // In sight above the tick, not behind "Read the full list": real money, that it can be lost, who can
    // change the code, who can pause, and what checks a trade.
    expect(points?.short).toEqual([
      m.real,
      m.loss,
      en.trust.short.unaudited,
      m.short.governance(48, 2),
      m.guardian,
      m.trades,
      m.short.noKeeper,
      m.short.noCap,
      m.short.issuers,
    ]);
    // Nothing of the test network's notice: not its admin key, not a keeper's limits.
    const all = [...(points?.items ?? []), ...(points?.short ?? [])].join(' ');
    expect(all).not.toContain(TRUST_STATUS.admin.robinhood ?? 'x');
    expect(all).not.toContain(en.trust.keeper(...limits));
    expect(all).not.toMatch(/test network/i);
    // It says plainly what can be lost and what a withdrawal is, and nothing of an admin key.
    expect(m.loss).toBe('You can lose money, including all of it.');
    expect(all).not.toContain('at any time');
    expect(all).toContain('the vault contracts never block it');
    expect(all).toContain('checked by this app');
    expect(all).not.toContain(en.trust.checks.second_rehearsal);
  });

  it('on mainnet, promises no return and names no licence', () => {
    for (const t of [en, pt]) {
      const points = trustPoints(t, 'robinhood', { live: true, keeperTrades: false, limits: null });
      const all = [...(points?.items ?? []), ...(points?.short ?? [])].join(' ');
      expect(all).not.toMatch(/guarantee|garant|will earn|vai render/i);
      expect(points?.items[0]).toBe(t.trust.mainnet.real);
    }
  });

  it('an acceptance of the test network’s notice is not an acceptance of the live one', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    const v = TRUST_STATUS.textVersion;
    acceptTrust('user', v, true, false);
    expect(trustAccepted('user', v, true, false)).toBe(true);
    expect(trustAccepted('user', v, true, true)).toBe(false);
    acceptTrust('user', v, true, true);
    expect(trustAccepted('user', v, true, true)).toBe(true);
    // A later acceptance on a test network does not take the live one back.
    acceptTrust('user', v, true, false);
    expect(trustAccepted('user', v, true, true)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('has no live notice for a chain with no mainnet facts: nothing is said that is not known', () => {
    expect(trustPoints(en, 'solana', { live: true, keeperTrades: true, limits })).toBeNull();
    expect(trustPoints(en, 'base', { live: true, keeperTrades: true, limits })).toBeNull();
  });
});
