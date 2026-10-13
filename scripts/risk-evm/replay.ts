// Answers recorded from an endpoint, and a client that gives them back: how the discovery fixture is
// recorded (record-discovery-fixture.ts) and replayed (tests). Nothing here reaches the network.
import { createHash } from 'node:crypto';
import type { Rpc, RpcReply, RpcRequest } from './rpc';

/** The key an answer is stored under: a request's method and parameters, hashed to keep the file small. */
export const requestKey = (r: RpcRequest) =>
  createHash('sha256')
    .update(JSON.stringify([r.method, r.params]))
    .digest('hex')
    .slice(0, 24);

/** A client over any `batch`: `call` throws on an RPC error, as the real client's does. */
export function rpcOver(batch: Rpc['batch'], stats: Rpc['stats']): Rpc {
  return {
    batch,
    call: async <T>(method: string, params: unknown[]) => {
      const [reply] = await batch([{ method, params }]);
      if (!reply || reply.error || reply.result === undefined)
        throw new Error(`${method}: ${reply?.error?.message ?? 'no result'}`);
      return reply.result as T;
    },
    stats,
  };
}

/**
 * A client that answers from a recording. `override` answers first when it returns something. A
 * request that was never recorded throws: a replay must ask what the recording was asked.
 */
export function replayRpc(
  answers: Record<string, RpcReply>,
  override?: (r: RpcRequest) => RpcReply | undefined,
): Rpc & { asked: RpcRequest[] } {
  const asked: RpcRequest[] = [];
  let batches = 0;
  const batch = async (requests: RpcRequest[]) => {
    batches++;
    return requests.map((r) => {
      asked.push(r);
      const reply = override?.(r) ?? answers[requestKey(r)];
      if (!reply) throw new Error(`not in the recording: ${r.method}`);
      return reply;
    });
  };
  return {
    ...rpcOver(batch, () => ({ httpRequests: batches, rpcCalls: asked.length })),
    asked,
  };
}
