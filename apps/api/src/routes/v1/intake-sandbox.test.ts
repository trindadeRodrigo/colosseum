import { EvmDeploymentRecord, deploymentAssets as evmAssets } from '@colosseum/chain-evm/vault';
import {
  SolanaDeploymentRecord,
  deploymentAssets as solanaAssets,
} from '@colosseum/chain-solana/vault';
import type { Db } from '@colosseum/db';
import { riskForMix, riskForSleeves } from '@colosseum/engine/personal';
import type { BasketAsset, ChainId } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import robinhoodRecord from '../../../../../deployments/robinhood-testnet.json';
import solanaRecord from '../../../../../deployments/solana-devnet.json';
import { fixtureLiquidity } from '../../../../../packages/engine/src/personal/testing';
import { asSandbox } from '../../model-exits';
import type { ChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { type PlanInputs, personalize } from '../../orders/personalize';
import { bearingPlanInputs } from '../../plan-inputs';
import { IntakeResponse, registerIntakeRoute } from './intake';

// Offline route tests: identity and family storage are fixtures; the real API plan-input loader sees
// an empty database answer. No socket, read of an environment file, or stored row is involved.
const current = vi.hoisted(() => ({ chain: 'solana' as ChainId }));
vi.mock('../../orders/person', () => ({ personChain: async () => ({ chain: current.chain }) }));
vi.mock('../../orders/store', () => ({ loadFamilies: async () => [] }));
vi.mock('./orders', () => ({ signedIn: () => ({ userId: 'fixture', ip: '127.0.0.1' }) }));
vi.mock('@colosseum/engine/personal', async (original) => {
  const engine = await original<typeof import('@colosseum/engine/personal')>();
  return {
    ...engine,
    riskForMix: vi.fn(engine.riskForMix),
    riskForSleeves: vi.fn(engine.riskForSleeves),
  };
});
const cases = [
  { chain: 'solana' as const, assets: solanaAssets(SolanaDeploymentRecord.parse(solanaRecord)) },
  { chain: 'robinhood' as const, assets: evmAssets(EvmDeploymentRecord.parse(robinhoodRecord)) },
];
const now = new Date('2026-10-07T12:00:00.000Z');
const emptyDb = (): Db => {
  const query = Object.assign(Promise.resolve([] as never[]), {
    from: (): Promise<never[]> => query,
    where: (): Promise<never[]> => query,
    innerJoin: (): Promise<never[]> => query,
    orderBy: (): Promise<never[]> => query,
    limit: async () => [],
  });
  return { select: () => query } as unknown as Db;
};
const registry = (chain: ChainId, assets: BasketAsset[], off = false): ChainRegistry =>
  ({
    name: () => chain,
    get: () => {
      if (off) throw new Refusal(503, 'fixture chain off');
      return { chain, provenance: 'sandbox', adapter: { listAssets: async () => assets } };
    },
  }) as unknown as ChainRegistry;

describe.each(cases)(
  'intake and construction on the committed $chain shelf',
  ({ chain, assets }) => {
    it.each([false, true])(
      'uses sandbox model inputs in the route and builds the confirmed risk, measured: %s',
      async (measured) => {
        current.chain = chain;
        vi.mocked(riskForMix).mockClear();
        vi.mocked(riskForSleeves).mockClear();
        const provider = asSandbox(
          fixtureLiquidity(
            Object.fromEntries(
              assets.filter((a) => a.cls !== 'cash').map((a) => [a.id, 1_000_000]),
            ),
          ),
        );
        const inputs = vi.fn(async (q: Parameters<PlanInputs>[0]) => {
          const figures = await bearingPlanInputs(q);
          return measured
            ? {
                ...figures,
                tiers: [],
                liquidity: { provider, source: 'sample measurements on a test network' },
              }
            : figures;
        });
        const db = emptyDb();
        const chains = registry(chain, assets);
        const app = Fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerIntakeRoute(app, { db, chains, now: () => now } as OrderDeps, null, inputs);
        const answers = { goal: 'grow', amountUsd: 10_000, horizonMonths: 60 };
        try {
          const ai = await app.inject({
            method: 'POST',
            url: '/v1/baskets/intake',
            payload: {
              text: 'I want to invest $10,000 in AI for 5 years',
              answers,
              followUps: ['yes'],
              answersThen: [answers],
            },
          });
          expect(ai.statusCode, ai.body).toBe(200);
          const read = IntakeResponse.parse(ai.json());
          expect(read.sheet, ai.body).not.toBeNull();
          if (!read.sheet) throw new Error('intake did not finish the fixture sheet');
          expect(read.sheet?.sleeves).toEqual([{ kind: 'theme', theme: 'ai', shareBps: 10_000 }]);
          const handed = vi.mocked(riskForSleeves).mock.calls.at(-1);
          expect(
            handed?.[1].assets
              .filter((a) => a.cls === 'stock')
              .every((a) => a.issuer !== 'test network'),
          ).toBe(true);
          expect(
            handed?.[2].themes
              ?.find((list) => list.slug === 'ai')
              ?.members.some((m) => m.symbol === 'tNVDAx' || m.symbol === 'tNVDA'),
          ).toBe(true);
          expect(inputs).toHaveBeenCalledWith(
            expect.objectContaining({ chain, assets, provenance: 'sandbox' }),
          );
          const built = await personalize(read.sheet, {
            chains,
            homeChain: async () => chain,
            loadFamilies: async () => [],
            now: now.toISOString(),
            inputs: (chain, assets, provenance) => inputs({ db, chain, assets, provenance }),
          });
          expect(built.proposal.sheet.risk).toBe(read.sheet?.risk);
          expect(
            built.proposal.lines.some(
              (line) => assets.find((a) => a.id === line.assetId)?.cls === 'stock',
            ),
          ).toBe(true);
          expect(
            built.proposal.lines.every((line) => assets.some((a) => a.id === line.assetId)),
          ).toBe(true);
          expect(built.proposal.flags.some((flag) => flag.startsWith('issuer_from_model:'))).toBe(
            true,
          );
          const observations = built.proposal.observations.filter((o) => o.kind === 'liquidity');
          expect(observations.length).toBeGreaterThan(0);
          expect(observations.every((o) => o.provenance === 'sandbox')).toBe(true);

          const matched = await app.inject({
            method: 'POST',
            url: '/v1/baskets/intake',
            payload: {
              text: 'Grow my savings.',
              answers: {
                ...answers,
                sleeves: [
                  {
                    kind: 'theme',
                    theme: 'matched-sector-information-technology',
                    shareBps: 10_000,
                  },
                ],
              },
            },
          });
          expect(matched.statusCode, matched.body).toBe(200);
          const matchedRead = IntakeResponse.parse(matched.json());
          expect(matchedRead.sheet, matched.body).not.toBeNull();
          if (!matchedRead.sheet)
            throw new Error('matched intake did not finish the fixture sheet');
          const matchedBuilt = await personalize(matchedRead.sheet, {
            chains,
            homeChain: async () => chain,
            loadFamilies: async () => [],
            now: now.toISOString(),
            inputs: (chain, assets, provenance) => inputs({ db, chain, assets, provenance }),
          });
          expect(matchedBuilt.proposal.sheet.risk).toBe(matchedRead.sheet?.risk);
          expect(
            matchedBuilt.proposal.lines.some(
              (line) => assets.find((a) => a.id === line.assetId)?.cls === 'stock',
            ),
          ).toBe(true);
        } finally {
          await app.close();
        }
      },
    );
  },
);

it('keeps the intake’s unknown-shelf behavior when the chain registry refuses', async () => {
  current.chain = 'solana';
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const inputs = vi.fn<PlanInputs>(async () => ({}));
  registerIntakeRoute(
    app,
    {
      db: emptyDb(),
      chains: registry('solana', solanaAssets(SolanaDeploymentRecord.parse(solanaRecord)), true),
      now: () => now,
    } as OrderDeps,
    null,
    inputs,
  );
  try {
    const got = await app.inject({
      method: 'POST',
      url: '/v1/baskets/intake',
      payload: { text: 'Invest $10,000 in AI for 5 years' },
    });
    expect(got.statusCode, got.body).toBe(200);
    expect(IntakeResponse.parse(got.json()).sheet).toBeNull();
    expect(inputs).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
