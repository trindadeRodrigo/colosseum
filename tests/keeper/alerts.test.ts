import { describe, expect, it } from 'vitest';
import { lowGasFromEnv, notifierFromEnv } from '../../apps/keeper/src/alerts';

// The keeper's alerts beyond its log: a Discord webhook and a health-check ping, both optional, their
// URLs never in anything it says.

const HOOK = 'https://discord.example/api/webhooks/1/secret-token';
const HEALTH = 'https://hc.example/ping/uuid';

function recorder(status = 200, fail = false) {
  const calls: { url: string; body?: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (fail) throw new Error(`connect failed to ${url}`);
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('the keeper’s notifier', () => {
  it('posts the round’s alerts as one message, and nothing for a round with none', async () => {
    const r = recorder(204);
    const n = notifierFromEnv(
      { KEEPER_DISCORD_WEBHOOK: HOOK },
      { fetch: r.fetch, label: 'keeper x' },
    );
    await n.alert([]);
    expect(r.calls).toEqual([]);
    await n.alert(['0xvault: leg reverted', 'the keeper’s gas is low']);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.url).toBe(HOOK);
    const content = JSON.parse(r.calls[0]?.body ?? '{}').content as string;
    expect(content).toContain('**keeper x**: 2 alerts');
    expect(content).toContain('- 0xvault: leg reverted');
    // Discord takes 2,000 characters
    await n.alert(
      Array.from({ length: 200 }, (_, i) => `vault ${i}: something long enough to fill`),
    );
    expect(JSON.parse(r.calls[1]?.body ?? '{}').content.length).toBeLessThanOrEqual(2_000);
  });

  it('pings the health check after a round, and its fail address after a failed one', async () => {
    const r = recorder();
    const n = notifierFromEnv({ KEEPER_HEALTHCHECK_URL: `${HEALTH}/` }, { fetch: r.fetch });
    await n.ping(true);
    await n.ping(false);
    expect(r.calls.map((c) => c.url)).toEqual([`${HEALTH}/`, `${HEALTH}/fail`]);
  });

  it('does nothing with no URL set, and never repeats a URL when a post fails', async () => {
    const quiet = recorder();
    const none = notifierFromEnv({}, { fetch: quiet.fetch });
    await none.alert(['x']);
    await none.ping(true);
    expect(quiet.calls).toEqual([]);
    const said: string[] = [];
    for (const r of [recorder(500), recorder(200, true)]) {
      const n = notifierFromEnv(
        { KEEPER_DISCORD_WEBHOOK: HOOK, KEEPER_HEALTHCHECK_URL: HEALTH },
        { fetch: r.fetch, warn: (l) => said.push(l) },
      );
      await n.alert(['x']);
      await n.ping(true);
    }
    expect(said).toEqual([
      'the alert webhook answered 500',
      'the health check answered 500',
      'the alert webhook could not be reached',
      'the health check could not be reached',
    ]);
    expect(said.join(' ')).not.toContain('secret-token');
    expect(said.join(' ')).not.toContain('hc.example');
  });
});

describe('the low-gas threshold', () => {
  it('is read once at start: a whole number, the default when unset, and anything else refused', () => {
    expect(lowGasFromEnv({}, 7n)).toBe(7n);
    expect(lowGasFromEnv({ KEEPER_LOW_GAS: ' 1000 ' }, 7n)).toBe(1000n);
    for (const bad of ['0.0005', '1e15', '-1', 'lots'])
      expect(() => lowGasFromEnv({ KEEPER_LOW_GAS: bad }, 7n)).toThrow(/not a whole number/);
  });
});
