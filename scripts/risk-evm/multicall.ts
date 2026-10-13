// Many read-only calls in few eth_call requests, through Multicall3, in the order asked.
import { type Call, decodeAggregate3, encodeAggregate3 } from './abi';
import type { Rpc } from './rpc';

export type Reply = { success: boolean; data: string };

/** Calls sent in one eth_call. 400 small reads stay well under the public RPC's 50M gas per call. */
export const MULTICALL_CHUNK = 400;

/**
 * The answers to `calls` at `blockTag`, one per call, in order. A call that reverts answers
 * `success: false`; an error of the endpoint itself (rate, a block it no longer has) is thrown.
 */
export async function multicall(
  rpc: Rpc,
  multicall3: string,
  calls: Call[],
  blockTag: string,
  chunk = MULTICALL_CHUNK,
): Promise<Reply[]> {
  const out: Reply[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    const replies = decodeAggregate3(
      await rpc.call<string>('eth_call', [
        { to: multicall3, data: encodeAggregate3(part) },
        blockTag,
      ]),
    );
    if (replies.length !== part.length)
      throw new Error(`multicall: ${part.length} calls, ${replies.length} answers`);
    out.push(...replies);
  }
  return out;
}
