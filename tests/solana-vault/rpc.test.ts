import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChainError } from '@colosseum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { ask, createVaultRpc } from '../../packages/chain-solana/src/vault/rpc';

// The Solana client's own time limit: a node that takes the request and never answers fails the call
// after the limit, so a keeper round waiting on it goes on to its next round instead of hanging.

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

/** A node that answers getGenesisHash after `delayMs`, or never. */
async function node(delayMs: number | null): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (delayMs === null) return;
      const { id } = JSON.parse(body) as { id: unknown };
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: 'G3n3sis' }));
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the Solana client's time limit", () => {
  it('fails a call the node never answers, after the limit, as one it did not answer', async () => {
    const rpc = createVaultRpc(await node(null), 300);
    const started = Date.now();
    const error = await ask('getGenesisHash', () => rpc.getGenesisHash().send()).catch(
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe('Unavailable');
    expect((error as ChainError).message).toBe('the Solana RPC did not answer getGenesisHash');
  });

  it('lets a call that answers within the limit through', async () => {
    const rpc = createVaultRpc(await node(50), 2_000);
    expect(await rpc.getGenesisHash().send()).toBe('G3n3sis');
  });

  it("still ends a call on the caller's own signal, before the limit", async () => {
    const rpc = createVaultRpc(await node(null), 60_000);
    const started = Date.now();
    await expect(
      rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
