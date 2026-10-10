import { writeFileSync } from 'node:fs';
import type { Price } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { FIGURE_PROBES } from '../testing/figure-probes';
import type { ChainEntry } from './chains';
import { createRelaxedGoalAgent } from './relaxed-goal-agent';
import {
  type AgentAnalyticsResult,
  buildGoalAgentContext,
  FIGURE_CUT,
  type GoalAgentContext,
} from './vault-agent';

// Every input the reviews of #216 and #227 probed the vault conversation with, run through the goal
// path: the same model reply on both attempts, so the repair call never helps. A new goal has no
// vault, so the keys that stood for a holding's value, amount or share stand here for a measured
// figure of the same unit (its price, its traded volume, its exit cost); the vault's own value has
// no counterpart and names nothing.

const shelf = launchShelf();
const assets = shelf.assets.filter((asset) => asset.chain === 'solana');
const id = (symbol: string) => {
  const asset = assets.find((item) => item.symbol === symbol);
  if (!asset) throw new Error(`no ${symbol}`);
  return asset.id;
};
const [cash, nv, ts, reserve] = ['USDC', 'NVDAx', 'TSLAx', 'jlUSDC'].map(id) as [
  string,
  string,
  string,
  string,
];
const pin = {
  unit: 'fraction' as const,
  source: 'sheet',
  method: 'fixture',
  fetchedAt: '2026-10-07T19:00:00.000Z',
  provenance: 'mock' as const,
};
const figs = (x: number) => [
  { metric: 'exit_worst' as const, regime: 'us_offhours_weekday' as const, value: x, ...pin },
  { metric: 'weekend' as const, value: null, reason: 'no_samples_in_regime' as const },
  { metric: 'lp_top1' as const, value: 0.3, ...pin },
  { metric: 'volume_28d' as const, value: 1000, ...pin, unit: 'usd' as const },
  { metric: 'volatility' as const, value: 0.35, ...pin },
  { metric: 'drawdown' as const, value: 0.4, ...pin },
];
const sheet: AgentAnalyticsResult = {
  sizeUsd: 10_000,
  basis: 'reference',
  tau: 0.01,
  assets: [
    { assetId: nv, modelledOn: null, figures: figs(0.004) },
    { assetId: ts, modelledOn: null, figures: figs(0.006) },
  ],
};
const context = {
  ...buildGoalAgentContext({
    chain: 'solana',
    observedAt: '2026-10-07T20:00:00.000Z',
    entry: { source: 'offline adapter', provenance: 'mock' } as unknown as ChainEntry,
    prices: [cash, nv, ts, reserve].map((asset) => ({
      asset,
      usdPerToken: asset === cash || asset === reserve ? '1' : asset === nv ? '100' : '200',
      ageSeconds: 0,
      maxAgeSeconds: 300,
      market: 'open',
      source: 'fixture',
      method: 'fixture',
      fetchedAt: '2026-10-07T19:59:00.000Z',
      provenance: 'mock',
    })) as Price[],
    prepared: {
      shelf,
      figures: {
        yields: [
          {
            assetId: reserve,
            quotedYield: 0.05,
            haircutYield: 0.04,
            source: 'y',
            method: 'fixture',
            fetchedAt: '2026-10-07T20:00:00.000Z',
            provenance: 'mock',
          },
        ],
      },
    } as unknown as Parameters<typeof buildGoalAgentContext>[0]['prepared'],
    person: 'p',
    analytics: sheet,
  }),
  stockAttributes: {
    stocks: [
      { symbol: 'NVDAx', company: 'NVIDIA Corporation' },
      { symbol: 'TSLAx', company: 'Tesla, Inc.' },
    ].map((row) => ({
      ...row,
      kind: 'company',
      sector: '',
      industry: '',
      keywords: [],
      sources: [],
    })),
  },
} as unknown as GoalAgentContext;
const yieldAt = context.evidence
  .find((source) => source.id.startsWith(`yield:${reserve}:`))
  ?.id.split(':')
  .at(-2);
const r = (key: string) => `{{fact:${key}}}`;
const F: Record<string, string> = {
  // as in the reviews
  NP: r(`price:${nv}`),
  NX: r(`exit:${nv}:worst`),
  TX: r(`exit:${ts}:worst`),
  NW: r(`weekend:${nv}`),
  ND: r(`drawdown:${nv}`),
  NVOL: r(`vol:${nv}`),
  Y: r(`yield:${reserve}:${yieldAt}:quoted`),
  YH: r(`yield:${reserve}:${yieldAt}:haircut`),
  // a holding's value: the asset's price; its amount: its traded volume; its share or target: its
  // exit cost or its largest provider's share
  NV: r(`price:${nv}`),
  TV: r(`price:${ts}`),
  RV: r(`price:${reserve}`),
  CV: r(`price:${cash}`),
  NA: r(`volume:${nv}`),
  NS: r(`exit:${nv}:worst`),
  NT: r(`lp:${nv}:top1`),
  // of a vault only: nothing on /goal answers to them
  CS: r(`holding:${cash}:share`),
  W: r('vault:value'),
  // the review of #230's own keys
  TP: r(`price:${ts}`),
  NL: r(`lp:${nv}:top1`),
  NVM: r(`volume:${nv}`),
  RP: r(`price:${reserve}`),
};
const fill = (text: string) => text.replace(/\[(\w+)\]/g, (whole, key: string) => F[key] ?? whole);
const CUT = FIGURE_CUT.en;

async function probe(text: string) {
  const say = fill(text);
  const agent = createRelaxedGoalAgent({
    apiKey: 'placeholder',
    log: () => {},
    create: async () => ({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            say,
            shape: 'pick',
            lines: [],
            buckets: null,
            stated: {
              amount: null,
              currency: null,
              when: null,
              need_by: null,
              monthly: null,
              withdraw_months: null,
              withdraw_start: null,
              weights: null,
              risk: null,
            },
            not_available: [],
            open: [],
          }),
          citations: null,
        },
      ],
    }),
  });
  const result = await agent.reply(
    {
      version: 1,
      language: 'en',
      messageId: 'm',
      messages: [{ who: 'person', text: 'Tell me about Nvidia, Tesla, jlUSDC and USDC.' }],
    },
    context,
  );
  if (result.kind !== 'reply') return { kind: 'failed' as const, message: result.reason };
  const { message } = result.reply;
  // every number served is a figure's: with the figures taken out, what is left passes for words
  let rest = message;
  for (const fact of result.reply.figures?.facts ?? []) rest = rest.replaceAll(fact.text, '');
  return {
    kind:
      message === CUT
        ? ('refused' as const)
        : message.endsWith(`\n${CUT}`)
          ? ('trimmed' as const)
          : ('served' as const),
    message,
    figures: result.reply.figures?.facts.length ?? 0,
    stray: /[\p{N}%$]|\{\{|\}\}/u.test(rest.replaceAll('NVDAx', '').replaceAll('TSLAx', '')),
  };
}

describe('the reviews’ probes on the goal path', () => {
  it('counts what is served, trimmed and refused, and serves no number that is not a figure’s', async () => {
    const lines: string[] = [];
    const counts: Record<string, Record<string, number>> = {};
    for (const [label, inputs] of FIGURE_PROBES) {
      const tally = { served: 0, trimmed: 0, refused: 0, failed: 0 };
      for (const input of inputs) {
        const out = await probe(input);
        tally[out.kind] += 1;
        if (out.kind !== 'failed') expect(out.stray, `${input} -> ${out.message}`).toBe(false);
        lines.push(
          `${out.kind.padEnd(8)} ${label} | ${JSON.stringify(input)}\n          -> ${JSON.stringify(out.message)}`,
        );
      }
      counts[label] = tally;
    }
    if (process.env.PROBE_OUT)
      writeFileSync(
        process.env.PROBE_OUT,
        `${JSON.stringify(counts, null, 1)}\n${lines.join('\n')}\n`,
      );
    expect(counts).toMatchInlineSnapshot(`
      {
        "1 meaning-changers": {
          "failed": 0,
          "refused": 21,
          "served": 0,
          "trimmed": 0,
        },
        "2 splits": {
          "failed": 0,
          "refused": 7,
          "served": 0,
          "trimmed": 4,
        },
        "3 sentinel / invisible": {
          "failed": 0,
          "refused": 9,
          "served": 1,
          "trimmed": 0,
        },
        "4 languages": {
          "failed": 0,
          "refused": 8,
          "served": 0,
          "trimmed": 0,
        },
        "5 yield promises": {
          "failed": 0,
          "refused": 14,
          "served": 1,
          "trimmed": 0,
        },
        "6 wrong asset": {
          "failed": 0,
          "refused": 11,
          "served": 0,
          "trimmed": 1,
        },
        "8 natural answers": {
          "failed": 0,
          "refused": 9,
          "served": 12,
          "trimmed": 3,
        },
        "G1 legit shapes": {
          "failed": 0,
          "refused": 8,
          "served": 13,
          "trimmed": 0,
        },
        "G2 optional parts / trailing owner": {
          "failed": 0,
          "refused": 26,
          "served": 3,
          "trimmed": 0,
        },
        "G3 subject-verb clause": {
          "failed": 0,
          "refused": 22,
          "served": 4,
          "trimmed": 0,
        },
        "G4 remainder carries the promise": {
          "failed": 0,
          "refused": 24,
          "served": 4,
          "trimmed": 1,
        },
        "G5 Portuguese": {
          "failed": 0,
          "refused": 15,
          "served": 1,
          "trimmed": 0,
        },
        "G6 self-describing ignores the sentence before": {
          "failed": 0,
          "refused": 4,
          "served": 0,
          "trimmed": 19,
        },
      }
    `);
  });

  // The review of #230: a figure called what it is not. The model is handed ids with no values, so
  // the wrong id is its likely mistake; every one of these names the right asset.
  const MISMATCHES = [
    'Nvidia is nearly [NX] of the vault.',
    'Nvidia is [NX] of your vault.',
    'Nvidia’s share is [NX].',
    'Nvidia’s target is [NL].',
    'Your Nvidia holding is worth [NP].',
    'Tesla is worth [TP], more than Nvidia.',
    'Nvidia is worth [NVM].',
    'Nvidia’s price is [NVM].',
    'Nvidia trades at [NVM].',
    'Nvidia’s price is [NX].',
    'Nvidia’s volatility is [ND].',
    'Nvidia’s largest drawdown was [NVOL].',
    'Nvidia’s exit cost is [NL].',
    'Selling Nvidia costs about [NVOL].',
    'Selling Nvidia costs about [NP].',
    'Nvidia’s volume is [NP].',
    'Nvidia’s weekend capacity is [NX].',
    'Nvidia’s largest provider holds [NX] of the pool.',
    'Nvidia: [NX].',
    'Nvidia: [NVOL].',
    'Nvidia’s quoted yield is [NX] a year.',
    'Nvidia’s yield is currently [NVOL].',
    'The reserve’s quoted yield is [RP] a year.',
    'The reserve’s price is [Y].',
    'The reserve is [Y].',
    'jlUSDC: [Y].',
    'You hold [NVM] units of Nvidia.',
    'Nvidia’s pool is [NVM] deep.',
    'Nvidia’s pool holds [NVM].',
    'Nvidia’s market cap is [NVM].',
    'Nvidia’s spread is [NX].',
    'Nvidia’s fee is [NX].',
    'Nvidia’s dividend is [NX].',
    'Nvidia’s return is [NVOL].',
    'Nvidia’s beta is [NVOL].',
    'Nvidia’s liquidity is [NVM].',
    'Nvidia’s P/E is [NVOL].',
    'Nvidia’s Sharpe is [NVOL].',
    'Nvidia’s upside is [ND].',
    'Nvidia’s cap is [NL].',
    'Nvidia’s weight is [NL].',
    'Nvidia’s allocation is [NL].',
    'Nvidia is [NL] of the draft.',
    'Nvidia gets [NL] of your money.',
    'Put [NL] in Nvidia.',
    'I would put about [NL] of the deposit in Nvidia.',
    'Nvidia’s cap is [NX], so stay under it.',
    'Nvidia can be at most [NL] of the vault.',
  ];
  it('refuses a figure its sentence calls something else', async () => {
    const out = await Promise.all(MISMATCHES.map(probe));
    const served = MISMATCHES.filter((_, at) => out[at]?.kind !== 'refused');
    if (process.env.PROBE_OUT)
      writeFileSync(
        `${process.env.PROBE_OUT}.kinds`,
        out.map((o, i) => `${o.kind} ${MISMATCHES[i]}\n   -> ${o.message}`).join('\n'),
      );
    expect(served).toMatchInlineSnapshot(`[]`);
  });

  // What a person asks on Invest, where there is no vault: depth, cost to sell, price, how much
  // trades, how it moves, what a reserve yields. The review's ten, then eighteen natural answers
  // (twelve of them this branch's own).
  const LEGITIMATE = [
    'Selling Nvidia at the reference size costs about [NX] in the worst measured regime.',
    'Nvidia’s price is [NP].',
    'Nvidia trades at [NP].',
    'Nvidia: about [NP] per unit at the reference price.',
    'Traded volume for Nvidia over the last four weeks is [NVM].',
    'For Nvidia, the largest liquidity provider holds [NL] of the main dollar pool.',
    'Nvidia’s annualised volatility is [NVOL].',
    'Nvidia’s largest measured drawdown was [ND].',
    'Here are the exit costs:\n- Nvidia: [NX]\n- Tesla: [TX]',
    'Nvidia costs about [NX] to sell; Tesla costs about [TX].',
  ];
  const NATIVE = [
    'For Nvidia, the largest liquidity provider holds [NT] of the main dollar pool. Selling Nvidia at the reference size costs about [NX] in the worst measured regime.',
    'Selling Nvidia at the reference size costs about [NX] in the worst measured regime, and selling Tesla about [TX].',
    'Selling Nvidia costs about [NX]. Selling Tesla costs about [TX]. I can’t rank them for you: both are measured at the reference size.',
    'Nvidia trades at [NP] and Tesla at [TV], at the last reference price.',
    'Traded volume for Nvidia over the last four weeks is [NA].',
    'Nvidia’s annualised volatility is [NVOL]. Its largest measured drawdown was [ND].',
    'Nvidia’s largest measured drawdown was [ND], and its annualised volatility is [NVOL].',
    'Weekend exit capacity for Nvidia is [NW], so I can’t say how weekends compare yet.',
    'The reserve’s quoted yield is [Y] a year. After the haircut, its quoted yield is [YH] a year.',
    'jlUSDC currently yields [Y] a year. That is a past observation, not a promise.',
    'How deep is the pool? For Nvidia, selling at the reference size costs about [NX] in the worst measured regime.',
    'Tesla is the more volatile name to hold. Its annualised volatility is [NVOL].',
    'Nvidia’s pool: the largest provider holds [NL], and about [NVM] traded over the last four weeks.',
    'Nvidia has fallen as much as [ND] from a peak.',
    'Exit costs at the reference size:\n- Nvidia: [NX]\n- Tesla: [TX]',
    'Prices:\n- Nvidia: [NP]\n- Tesla: [TP]',
    'Nvidia is at [NP] right now.',
    'Nvidia goes for about [NP] a unit.',
  ];
  it('serves what a person asks on Invest', async () => {
    const legit = await Promise.all(LEGITIMATE.map(probe));
    expect(legit.map((o) => o.kind)).toEqual(LEGITIMATE.map(() => 'served'));
    const out = await Promise.all(NATIVE.map(probe));
    if (process.env.PROBE_OUT)
      writeFileSync(
        `${process.env.PROBE_OUT}.native`,
        out.map((o, i) => `${o.kind} ${NATIVE[i]}\n   -> ${o.message}`).join('\n'),
      );
    expect(out.map((o, at) => `${o.kind}: ${NATIVE[at]?.slice(0, 48)}`)).toMatchInlineSnapshot(`
      [
        "served: For Nvidia, the largest liquidity provider holds",
        "served: Selling Nvidia at the reference size costs about",
        "served: Selling Nvidia costs about [NX]. Selling Tesla c",
        "served: Nvidia trades at [NP] and Tesla at [TV], at the ",
        "served: Traded volume for Nvidia over the last four week",
        "trimmed: Nvidia’s annualised volatility is [NVOL]. Its la",
        "served: Nvidia’s largest measured drawdown was [ND], and",
        "served: Weekend exit capacity for Nvidia is [NW], so I c",
        "served: The reserve’s quoted yield is [Y] a year. After ",
        "served: jlUSDC currently yields [Y] a year. That is a pa",
        "served: How deep is the pool? For Nvidia, selling at the",
        "trimmed: Tesla is the more volatile name to hold. Its ann",
        "served: Nvidia’s pool: the largest provider holds [NL], ",
        "served: Nvidia has fallen as much as [ND] from a peak.",
        "served: Exit costs at the reference size:
      - Nvidia: [NX]",
        "served: Prices:
      - Nvidia: [NP]
      - Tesla: [TP]",
        "served: Nvidia is at [NP] right now.",
        "served: Nvidia goes for about [NP] a unit.",
      ]
    `);
  });
});
