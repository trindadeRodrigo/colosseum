import { describe, expect, it } from 'vitest';
import {
  nodeFailure,
  retryDelayMs,
  urlList,
  withFailover,
} from '../programs/tests/src/testnet/failover';

// How the Solana price copier gets past a node that does not answer (TNET-5): which errors send it to
// the next node, and how soon a failed round is tried again.

const fetchFailed = () => Object.assign(new TypeError('fetch failed'), {});
const http = (statusCode: number) =>
  Object.assign(new Error(`HTTP error (${statusCode})`), { context: { statusCode } });

describe('a node that fails', () => {
  it('is one that did not answer, timed out, limited the rate or broke; nothing else', () => {
    expect(nodeFailure(fetchFailed())).toBe('fetch failed');
    expect(nodeFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timed out');
    expect(nodeFailure(http(429))).toBe('HTTP 429');
    expect(nodeFailure(http(503))).toBe('HTTP 503');
    expect(
      nodeFailure(Object.assign(new TypeError('other'), { cause: { code: 'ECONNRESET' } })),
    ).toBe('ECONNRESET');
    // The cluster's own refusal is the same on every node.
    expect(nodeFailure(http(400))).toBeNull();
    expect(nodeFailure(new Error('transaction failed: custom program error 0x1771'))).toBeNull();
    expect(nodeFailure('fetch failed')).toBeNull();
  });

  it('never puts an address in what it says', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND', hostname: 'private.example', message: 'private.example?key=1' },
    });
    expect(nodeFailure(error)).toBe('ENOTFOUND');
  });
});

describe('fail-over', () => {
  const node = (answers: (string | Error)[]) => {
    let call = 0;
    return async (asked: string) => {
      const answer = answers[Math.min(call++, answers.length - 1)] as string | Error;
      if (answer instanceof Error) throw answer;
      return `${answer}:${asked}`;
    };
  };

  it('goes to the next node on a failure, says so by number, and stays there', async () => {
    const switches: string[] = [];
    const ask = withFailover([node(['a', fetchFailed()]), node(['b'])], (from, to, why) =>
      switches.push(`${from}>${to} ${why}`),
    );
    expect(await ask('1')).toBe('a:1');
    expect(await ask('2')).toBe('b:2');
    expect(await ask('3')).toBe('b:3');
    expect(switches).toEqual(['1>2 fetch failed']);
  });

  it('comes back round to the first node when the last fails', async () => {
    const ask = withFailover([node([fetchFailed(), 'a']), node(['b', http(503)])]);
    expect(await ask('1')).toBe('b:1');
    expect(await ask('2')).toBe('a:2');
  });

  it('throws the last error when every node fails, and asks each once', async () => {
    let asked = 0;
    const down = async () => {
      asked += 1;
      throw http(502);
    };
    await expect(withFailover([down, down, down])()).rejects.toThrow('HTTP error (502)');
    expect(asked).toBe(3);
  });

  it('does not ask another node about an error that is not the node’s', async () => {
    let second = 0;
    const ask = withFailover([
      async () => {
        throw new Error('transaction failed');
      },
      async () => {
        second += 1;
        return 'b';
      },
    ]);
    await expect(ask()).rejects.toThrow('transaction failed');
    expect(second).toBe(0);
  });

  it('with one node, throws what it throws', async () => {
    await expect(withFailover([node([fetchFailed()])])('1')).rejects.toThrow('fetch failed');
    expect(() => withFailover([])).toThrow('no node to ask');
  });
});

describe('the round after a failed one', () => {
  it('starts after 2 s, then twice as long each time, never longer than the interval', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => retryDelayMs(n, 30_000))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(retryDelayMs(0, 30_000)).toBe(30_000);
    expect(retryDelayMs(1, 1_000)).toBe(1_000);
  });

  it('reads a list of nodes from one variable', () => {
    expect(urlList(' https://a.example , https://b.example,, ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
