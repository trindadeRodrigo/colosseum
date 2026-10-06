// A small JSON-RPC client: one HTTP request per batch, a timeout, and a retry when the endpoint is busy.
// Errors never include the URL, which may carry a key.

export type RpcRequest = { method: string; params: unknown[] };
export type RpcReply = { result?: unknown; error?: { code?: number; message?: string } };

export type Rpc = {
  /** Sends the requests as one JSON-RPC batch. Replies come back in request order. */
  batch: (requests: RpcRequest[]) => Promise<RpcReply[]>;
  /** One request; throws on an RPC error. */
  call: <T>(method: string, params: unknown[]) => Promise<T>;
  stats: () => { httpRequests: number; rpcCalls: number };
};

/** The endpoint could not be reached at all: no DNS, no route, timeouts. Nothing about the chain is known. */
export class RpcUnreachable extends Error {}

/**
 * Refused for rate, or asked of a node that has not caught up to a block another node just reported:
 * worth asking again after a short wait. The wordings are the ones the two Robinhood Chain endpoints
 * use (fixtures/risk-evm/rpc-errors.json).
 */
export const isTransient = (r: RpcReply) =>
  r.error?.code === 429 ||
  /rate limit|too many requests|header not found|block not found|unknown block|unsupported block number/i.test(
    r.error?.message ?? '',
  );

export type RpcOptions = {
  timeoutMs?: number;
  retries?: number;
  /** For tests: the collector itself uses the global fetch and a real wait. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
};

export function createRpc(url: string, opts: RpcOptions = {}): Rpc {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let httpRequests = 0;
  let rpcCalls = 0;

  async function post(body: unknown): Promise<unknown> {
    let last = 'no attempt';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(1_500 * attempt);
      httpRequests++;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          last = `HTTP ${res.status}`;
          continue;
        }
        if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('RPC answered')) throw e;
        // the name and the system code only: a fetch error's message can repeat the URL
        const code = (e as { cause?: { code?: string } })?.cause?.code;
        last = `${e instanceof Error ? e.name : 'network error'}${code ? ` ${code}` : ''}`;
      }
    }
    throw new RpcUnreachable(`RPC unreachable after ${retries + 1} tries (${last})`);
  }

  async function send(requests: RpcRequest[]): Promise<RpcReply[]> {
    rpcCalls += requests.length;
    const body = requests.map((r, id) => ({ jsonrpc: '2.0', id, ...r }));
    const json = await post(body);
    if (!Array.isArray(json)) {
      // one error object for the whole batch: every call gets it, so a refusal for rate is asked again
      const error = (json as RpcReply | null)?.error ?? { message: 'not a batch reply' };
      return requests.map(() => ({ error }));
    }
    const byId = new Map<number, RpcReply>(
      (json as Array<RpcReply & { id: number }>).map((r) => [r.id, r]),
    );
    return requests.map(
      (_, id) => byId.get(id) ?? { error: { message: 'no reply for this call' } },
    );
  }

  async function batch(requests: RpcRequest[]): Promise<RpcReply[]> {
    if (requests.length === 0) return [];
    const replies = await send(requests);
    // a free endpoint may refuse part of a batch: ask again for those calls only, slowly
    for (let attempt = 1; attempt <= retries; attempt++) {
      const again = replies.flatMap((r, i) => (isTransient(r) ? [i] : []));
      if (again.length === 0) break;
      await sleep(3_000 * attempt);
      const retried = await send(again.map((i) => requests[i] as RpcRequest));
      for (const [k, i] of again.entries()) replies[i] = retried[k] as RpcReply;
    }
    return replies;
  }

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const [reply] = await batch([{ method, params }]);
    if (!reply || reply.error || reply.result === undefined)
      throw new Error(`${method}: ${reply?.error?.message ?? 'no result'}`);
    return reply.result as T;
  }

  return { batch, call, stats: () => ({ httpRequests, rpcCalls }) };
}
