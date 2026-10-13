import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { registerV1Routes } from '.';

// The conversations' analytics are read from the server's start, for every chain that is not the mock,
// and stop with the server. A test's reader is never warmed unless it asks.
const db = new Proxy({}, { get: () => () => undefined }) as unknown as Db;

async function serve(warm: boolean, mockOnly = false) {
  const registry = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'warm' });
  // The registry runs every chain on the mock here; all but the mock flag is the real entry.
  const chains = mockOnly
    ? registry
    : {
        ...registry,
        active: () => registry.active().map((entry) => ({ ...entry, mock: undefined })),
      };
  const analytics = Object.assign(vi.fn(), {
    warm: vi.fn(),
    stop: vi.fn(),
  }) as unknown as AgentAnalytics & {
    warm: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerV1Routes(
    app,
    {},
    {
      db,
      chains,
      testFunds: [],
      agentAnalytics: analytics,
      warmAgentAnalytics: warm,
    },
  );
  await app.ready();
  return { app, analytics, registry };
}

describe("the conversations' analytics are warmed from the start", () => {
  it('warms each live chain with its catalog and label, and stops on close', async () => {
    const { app, analytics, registry } = await serve(true);
    const active = registry.active();
    await vi.waitFor(() => expect(analytics.warm).toHaveBeenCalledTimes(active.length));
    for (const entry of active) {
      const call = analytics.warm.mock.calls.find(([q]) => q.chain === entry.chain)?.[0];
      expect(call?.db).toBe(db);
      expect(call?.provenance).toBe(entry.provenance);
      expect(call?.assets.map((asset: { id: string }) => asset.id)).toEqual(
        (await entry.adapter.listAssets()).map((asset) => asset.id),
      );
    }
    expect(analytics).not.toHaveBeenCalled();
    await app.close();
    expect(analytics.stop).toHaveBeenCalledOnce();
  });

  it('warms nothing when not asked, or on the mock', async () => {
    for (const [warm, mockOnly] of [
      [false, false],
      [true, true],
    ] as const) {
      const { app, analytics } = await serve(warm, mockOnly);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(analytics.warm).not.toHaveBeenCalled();
      await app.close();
    }
  });
});
