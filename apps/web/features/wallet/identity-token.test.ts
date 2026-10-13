import { describe, expect, it, vi } from 'vitest';
import { identityTokens, QUIET_MS, readIdentityToken, walletKey } from './identity-token';

// The identity token for each API call, on a clock the test moves: when Privy is asked for a new one,
// when it is left alone, and which token is sent meanwhile.

const T0 = 1_800_000_000_000;
const A = walletKey('solana', 'So11111111111111111111111111111111111111112');
const B = walletKey('ethereum', '0x204faca1764b154221e35c0d20abb3c525710498');

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An identity token as Privy's payload has it, unsigned: whose, until when (seconds), which wallets. */
function token(sub: string, exp: number, wallets: string[]): string {
  const linked = wallets.map((key) => {
    const [chain_type, address] = key.split(':');
    return { type: 'wallet', chain_type, address };
  });
  const payload = { sub, exp, linked_accounts: JSON.stringify(linked) };
  return `${base64url({ alg: 'ES256' })}.${base64url(payload)}.signature`;
}

function setup() {
  const clock = { now: T0 };
  const fetch = vi.fn<() => Promise<string | null>>();
  const identity = identityTokens(fetch, () => clock.now);
  const inAnHour = () => Math.floor(clock.now / 1000) + 3600;
  return { clock, fetch, identity, inAnHour };
}

const walletsOf = (t: string | null) => [...(readIdentityToken(t ?? '')?.wallets ?? [])].sort();

describe('a token that does not list a wallet linked since', () => {
  it('is asked for again after Privy refused, once the quiet window has passed', async () => {
    const { clock, fetch, identity, inAnHour } = setup();
    const held = token('did:a', inAnHour(), [A]);
    fetch.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { status: 429 }));
    const ask = { userId: 'did:a', held, wallets: [A, B] };
    // Privy refuses: the token held is sent meanwhile
    expect(await identity(ask)).toBe(held);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now += QUIET_MS + 1;
    fetch.mockResolvedValueOnce(token('did:a', inAnHour(), [A, B]));
    const next = await identity(ask);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(walletsOf(next)).toEqual([A, B].sort());
  });

  it('is asked for once when Privy’s new token does not list it either', async () => {
    const { fetch, identity, inAnHour } = setup();
    const held = token('did:a', inAnHour(), [A]);
    fetch.mockResolvedValue(token('did:a', inAnHour(), [A]));
    const ask = { userId: 'did:a', held, wallets: [A, B] };
    for (let i = 0; i < 5; i += 1) await identity(ask);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('whose token is sent', () => {
  it('is never the token of someone else Privy still holds', async () => {
    const { fetch, identity, inAnHour } = setup();
    const theirs = token('did:a', inAnHour(), [A]);
    fetch.mockResolvedValueOnce(token('did:b', inAnHour(), [B]));
    const sent = await identity({ userId: 'did:b', held: theirs, wallets: [B] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readIdentityToken(sent ?? '')?.sub).toBe('did:b');
    // and when Privy cannot give one, nothing is sent rather than theirs
    const other = setup();
    other.fetch.mockRejectedValue(new Error('Too many requests'));
    expect(
      await other.identity({
        userId: 'did:b',
        held: token('did:a', other.inAnHour(), [A]),
        wallets: [],
      }),
    ).toBeNull();
  });
});

describe('a token near its end', () => {
  it('is replaced a minute before it ends, and not while more is left', async () => {
    const { clock, fetch, identity } = setup();
    const now = Math.floor(clock.now / 1000);
    fetch.mockResolvedValue(token('did:a', now + 3600, [A]));
    const lasting = token('did:a', now + 120, [A]);
    expect(await identity({ userId: 'did:a', held: lasting, wallets: [A] })).toBe(lasting);
    expect(fetch).toHaveBeenCalledTimes(0);
    const ending = token('did:a', now + 30, [A]);
    const sent = await identity({ userId: 'did:a', held: ending, wallets: [A] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent).not.toBe(ending);
  });
});

describe('Privy refusing while the token held has ended', () => {
  it('is asked once per quiet window, not once per call, and the ended token is not sent', async () => {
    const { clock, fetch, identity } = setup();
    fetch.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));
    const ended = token('did:a', Math.floor(clock.now / 1000) - 10, [A]);
    const ask = { userId: 'did:a', held: ended, wallets: [A] };
    for (let i = 0; i < 10; i += 1) {
      expect(await identity(ask)).toBeNull();
      clock.now += 1_000;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now = T0 + QUIET_MS + 1;
    await identity(ask);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('still sends a token that has not ended, whatever Privy says', async () => {
    const { clock, fetch, identity } = setup();
    fetch.mockRejectedValue(new Error('Too many requests'));
    const ending = token('did:a', Math.floor(clock.now / 1000) + 30, [A]);
    expect(await identity({ userId: 'did:a', held: ending, wallets: [A] })).toBe(ending);
  });
});
