// How the price copier (TNET-5) gets past a node that does not answer: the next node of its list, and
// a failed round tried again soon. Nothing here touches a chain or names a URL: a node is a number in
// every message, since a URL may carry a key. tests/testnet-solana-failover.test.ts runs it.

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * What went wrong with the node, in words that hold nothing of its address, or null when the failure
 * is not the node's: a transaction the cluster refused fails the same on every node and is not asked
 * of another.
 */
export function nodeFailure(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as {
    name?: string;
    message?: string;
    cause?: { code?: string };
    context?: { statusCode?: number };
  };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
  const status = e.context?.statusCode;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return `HTTP ${status}`;
  const code = e.cause?.code;
  if (code && NETWORK_CODES.has(code)) return code;
  if (e.name === 'TypeError' && e.message === 'fetch failed') return 'fetch failed';
  return null;
}

/**
 * One call over a list of nodes. It stays with the node that last answered; when that one fails as
 * `nodeFailure` says, the next is asked, once round the list, and `onSwitch` is told (nodes counted
 * from 1). When every node has failed, the last error is thrown. Any other error is thrown at once.
 */
export function withFailover<A extends unknown[], R>(
  nodes: readonly ((...args: A) => Promise<R>)[],
  onSwitch: (from: number, to: number, why: string) => void = () => {},
): (...args: A) => Promise<R> {
  if (nodes.length === 0) throw new Error('no node to ask');
  let current = 0;
  return async (...args: A) => {
    for (let tried = 1; ; tried++) {
      const node = nodes[current] as (...args: A) => Promise<R>;
      try {
        return await node(...args);
      } catch (error) {
        const why = nodeFailure(error);
        if (why === null || tried >= nodes.length) throw error;
        const from = current;
        current = (current + 1) % nodes.length;
        onSwitch(from + 1, current + 1, why);
      }
    }
  };
}

/** A list of URLs from one variable, comma separated. */
export function urlList(text: string): string[] {
  return text
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

/** How long after a failed round the next one starts: 2 s, then twice that each time, and never
 * longer than a round's own interval. `failures` is how many rounds in a row have failed. */
export function retryDelayMs(failures: number, intervalMs: number): number {
  if (failures < 1) return intervalMs;
  return Math.min(intervalMs, 2_000 * 2 ** Math.min(failures - 1, 10));
}
