import { createHash } from 'node:crypto';
import type { AssetClass } from '@colosseum/schemas';
import { z } from 'zod';
import { PERSONAL_PARAMS } from '../../packages/engine/src/personal/params';
import { eligibleForGoal } from '../../packages/engine/src/personal/registry';

export const LIMITS = {
  textChars: 2000,
  turns: 12,
  replyChars: 16000,
  outputTokens: 1200,
} as const;
const Goal = z.enum(['pick', 'grow', 'income', 'protect']);
const Line = z.object({ id: z.string().max(160), why: z.string().max(400) });
const Weights = z.union([z.string().max(1000), z.record(z.string(), z.number().finite())]);
export const Reply = z.object({
  say: z.string().min(1).max(2000),
  understood: z.string().max(2000).nullish(),
  shape: z.enum(['pick', 'grow', 'income', 'protect', 'split', 'discussion']),
  lines: z
    .array(Line)
    .max(32)
    .nullish()
    .transform((v) => v ?? []),
  buckets: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        goal: Goal.nullish(),
        share: z.number().finite().min(0).max(1).nullish(),
        weights: Weights.nullish(),
        lines: z
          .array(Line)
          .max(32)
          .nullish()
          .transform((v) => v ?? []),
      }),
    )
    .max(8)
    .nullish(),
  stated: z
    .object({
      amount: z.number().finite().positive().nullish(),
      currency: z.string().max(8).nullish(),
      when: z.union([z.string().max(160), z.number().finite()]).nullish(),
      monthly: z.number().finite().positive().nullish(),
      weights: Weights.nullish(),
      risk: z.enum(['low', 'medium', 'high']).nullish(),
    })
    .nullish()
    .transform((v) => v ?? {}),
  not_available: z
    .array(
      z.union([
        z.string().max(200),
        z.object({ name: z.string().max(200), why: z.string().max(400).nullish() }),
      ]),
    )
    .max(32)
    .nullish()
    .transform((v) => v ?? []),
  question: z.string().max(400).nullish(),
  questions: z.array(z.string().max(400)).max(2).nullish(),
  open: z
    .array(z.enum(['amount', 'currency', 'when', 'monthly', 'shares', 'intent']))
    .max(6)
    .nullish()
    .transform((v) => v ?? []),
});
export type Reply = z.infer<typeof Reply>;
export type Row = {
  id: string;
  symbol: string;
  cls: AssetClass;
  text: string;
  maxWeightBps: number;
  provenance: 'fixture';
  warnings: string[];
};
export type Shelf = {
  chain: string;
  rows: Row[];
  hash: string;
  text: string;
  provenance: 'fixture';
};
export type Seed = { assets: Record<string, { symbol: string; cls: string; tier: string }[]> };
export type Stock = {
  symbol: string;
  underlying: string;
  company: string;
  keywords: string[];
  sector: string | null;
  industry: string | null;
};
export type Theme = { slug: string; status: string; members: { symbol: string }[] };
export type YieldRow = {
  asset: {
    id: string;
    chain: string;
    symbol: string;
    cls: AssetClass;
    underlying: string;
    issuer: string;
    maxWeightBps: number;
  };
  verdict: string;
  heldOut?: string;
  unverified?: string[];
};
const CLASSES: Record<string, AssetClass> = {
  stock: 'stock',
  'stock-index': 'etf',
  gold: 'gold',
  commodity: 'commodity',
  'dollar-yield': 'dollar_yield',
  'crypto-major': 'crypto',
  'solana-native': 'crypto',
};

/** Pure static catalog projection. Research attributes enrich listed assets; they do not list them. */
export function buildShelf(
  chain: string,
  seed: Seed,
  stocks: Stock[],
  themes: Theme[],
  yields: YieldRow[],
): Shelf {
  const rows: Row[] = (seed.assets[chain] ?? []).flatMap((asset) => {
    const cls = CLASSES[asset.cls];
    if (!cls || !['A', 'B', 'C'].includes(asset.tier)) return [];
    const symbol = asset.symbol;
    const stock = stocks.find(
      (s) => s.symbol === symbol || s.underlying === symbol.replace(/x$/, ''),
    );
    const id = `${chain}:${symbol.toLowerCase()}`;
    const labels = themes
      .filter((t) => t.status === 'confirmed' && t.members.some((m) => m.symbol === stock?.symbol))
      .map((t) => t.slug)
      .sort();
    return [
      {
        id,
        symbol,
        cls,
        maxWeightBps: 5000,
        provenance: 'fixture' as const,
        warnings: [
          'Static fixture catalog; wallet, country, route and measured exit availability unverified',
        ],
        text: [
          id,
          symbol,
          stock?.company,
          cls,
          stock?.sector,
          stock?.industry,
          stock?.keywords.join(', '),
          labels.join(', '),
        ]
          .filter(Boolean)
          .join(' | '),
      },
    ];
  });
  for (const row of yields) {
    if (row.asset.chain !== chain || row.heldOut || row.verdict === 'hold') continue;
    if (rows.some((r) => r.id === row.asset.id)) continue;
    rows.push({
      ...row.asset,
      text: `${row.asset.id} | ${row.asset.symbol} | ${row.asset.cls} | ${row.asset.underlying} by ${row.asset.issuer}`,
      provenance: 'fixture',
      warnings: ['Static fixture catalog; availability unverified', ...(row.unverified ?? [])],
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const text = rows.map((r) => `${r.text} | fixture; ${r.warnings.join('; ')}`).join('\n');
  return {
    chain,
    rows,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
    provenance: 'fixture',
  };
}

export function equalSplit(n: number): number[] {
  if (!Number.isInteger(n) || n < 1) return [];
  const base = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10000 - base * n ? 1 : 0));
}
const pct = (bps: number) => `${bps / 100}%`;
const numbers = (text: string): number[] =>
  Array.from(text.matchAll(/\d+(?:[,.]\d+)*(?:\s*[kK])?/g), (m) => {
    let word = m[0].replace(/\s/g, '');
    const kilo = /k$/i.test(word);
    word = word.replace(/k$/i, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
    return Number(word.replace(',', '.')) * (kilo ? 1000 : 1);
  });
const normalized = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER_TEXT = '\\d+(?:[,.]\\d+)*(?:\\s*[kK])?';
const FINANCIAL_METRIC =
  '(?:yields?|apy|apr|cagr|returns?|prices?|profit|performance|growth|roi|lucro|ganho|desempenho|rendimento|retorno|preco|exchange|fx|exit|cost|fee|spread|volatility|drawdown|liquidity|capacity|impact|tax|custo|taxa|liquidez|cotacao)';
const UNSOURCED_METRIC = new RegExp(
  `\\b${FINANCIAL_METRIC}\\b[^.!?]{0,60}(?:\\d|percent|por cento)|(?:\\d|percent|por cento)[^.!?]{0,60}\\b${FINANCIAL_METRIC}\\b`,
  'i',
);
const UNSUPPORTED_PREFERENCE =
  /\b(?:mostly|mainly|majority|at least|at most|minimum|maximum|more than|less than|between|maioria|pelo menos|no minimo|no maximo|mais de|menos de|entre)\b/i;
/** Conservative evidence for budget terms; it deliberately leaves complex sums unresolved. */
function budgetEvidence(messages: string[]): { amount: number; currency?: string } | undefined {
  let last: { amount: number; currency?: string } | undefined;
  for (const message of messages) {
    for (const clause of message.split(/[;\n]/)) {
      if (/month|mensal|\bmes\b|price|yield|preco|rendimento/i.test(normalized(clause))) continue;
      const clean = clause.replace(/\d+(?:[.,]\d+)?\s*%/g, '');
      const literal = new RegExp(
        `(USD|BRL|R\\$|\\$)\\s*(${NUMBER_TEXT})|(${NUMBER_TEXT})\\s*(USD|BRL|dollars?|reais)\\b`,
        'gi',
      );
      const matches = [...clean.matchAll(literal)];
      if (matches.length === 1) {
        const match = matches[0];
        const currency = (match?.[1] ?? match?.[4] ?? '').toUpperCase();
        last = {
          amount: numbers(match?.[2] ?? match?.[3] ?? '')[0] as number,
          currency: /BRL|REAIS|R\$/.test(currency) ? 'BRL' : 'USD',
        };
      } else if (matches.length > 1) last = undefined;
      else {
        const match =
          new RegExp(
            `(?:have|budget|capital|amount|tenho|invest(?:ir)?|aporte|aplicar)\\s*(?:of |de )?(${NUMBER_TEXT})\\b`,
            'i',
          ).exec(clean) ?? new RegExp(`^\\s*(${NUMBER_TEXT})\\s*$`).exec(clean);
        if (match) last = { amount: numbers(match[1] ?? '')[0] as number };
      }
    }
  }
  return last;
}
function monthlyEvidence(text: string): { amount: number; currency?: string } | undefined {
  const currencyWords =
    '(?:USD|BRL|EUR|GBP|JPY|CAD|AUD|CHF|CNY|ARS|MXN|COP|CLP|R\\$|\\$|dollars?|reais)';
  const money = `${currencyWords}?\\s*(${NUMBER_TEXT})\\s*${currencyWords}?`;
  const pattern = new RegExp(
    `${money}\\s*(?:per month|a month|monthly|por mes|mensais|mensal)|(?:monthly|mensal)\\s*(?:income|target|goal|renda)?\\s*[:=]?\\s*${money}`,
    'gi',
  );
  const matches = [...normalized(text).matchAll(pattern)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const currency = new RegExp(currencyWords, 'i').exec(last[0])?.[0].toUpperCase();
  return {
    amount: numbers(last[1] ?? last[2] ?? '')[0] as number,
    ...(currency
      ? {
          currency: /BRL|REAIS|R\$/.test(currency)
            ? 'BRL'
            : /USD|DOLLAR|\$/.test(currency)
              ? 'USD'
              : currency,
        }
      : {}),
  };
}
function groundedWhen(value: string | number, messages: string[]): boolean {
  if (typeof value !== 'string') return false;
  const quote = normalized(value.trim());
  if (!quote) return false;
  // A bare number is not a date. Keep the person's actual date/horizon words rather than treating
  // their budget as a year, or expanding a horizon into a model-invented calendar date.
  if (
    !/\b(?:day|days|week|weeks|month|months|year|years|tomorrow|today|dia|dias|semana|semanas|mes|meses|ano|anos|amanha|hoje|january|february|march|april|may|june|july|august|september|october|november|december)\b|\d{4}-\d{2}-\d{2}/.test(
      quote,
    )
  )
    return false;
  return messages.some((message) =>
    new RegExp(`(?:^|\\W)${escapePattern(quote)}(?:$|\\W)`, 'i').test(normalized(message)),
  );
}

/** Only exact percentages for every holding are supported; ranges/floors remain unresolved intent. */
export function statedWeights(
  value: Reply['stated']['weights'],
  rows: Row[],
  userText: string,
): number[] | null {
  if (value == null) return equalSplit(rows.length);
  if (UNSUPPORTED_PREFERENCE.test(normalized(userText))) return null;
  if (typeof value === 'object' && Object.keys(value).length !== rows.length) return null;
  if (
    typeof value === 'string' &&
    /at least|at most|minimum|maximum|pelo menos|no minimo|between|entre/i.test(normalized(value))
  )
    return null;
  const out = rows.map((row) => {
    const labels = [
      row.id,
      row.symbol,
      row.symbol.replace(/x$/, ''),
      row.symbol === 'TSLA' ? 'Tesla' : '',
    ].filter(Boolean);
    const text = typeof value === 'string' ? value : userText;
    const matches: { percent: number; index: number }[] = [];
    const groundedMatches: { percent: number; index: number }[] = [];
    for (const label of labels) {
      const pattern = new RegExp(
        `(\\d+(?:[.,]\\d+)?)\\s*%\\s*(?:in |em |of |de )?${escapePattern(label)}(?:\\b|$)|${escapePattern(label)}\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)\\s*%`,
        'gi',
      );
      for (const match of text.matchAll(pattern))
        matches.push({
          percent: Number((match[1] ?? match[2])?.replace(',', '.')),
          index: match.index,
        });
      for (const match of userText.matchAll(pattern))
        groundedMatches.push({
          percent: Number((match[1] ?? match[2])?.replace(',', '.')),
          index: match.index,
        });
    }
    const match = matches.sort((a, b) => a.index - b.index).at(-1);
    const grounded = groundedMatches.sort((a, b) => a.index - b.index).at(-1);
    const weight =
      match && grounded && match.percent === grounded.percent ? match.percent * 100 : undefined;
    if (typeof value === 'object') {
      const entries = Object.entries(value).filter(([id]) =>
        labels.some((label) => label.toLowerCase() === id.toLowerCase()),
      );
      if (entries.length !== 1 || entries[0]?.[1] !== weight) return NaN;
    }
    return weight ?? NaN;
  });
  return out.every((w) => Number.isInteger(w) && w > 0 && w <= 10000) &&
    out.reduce((a, b) => a + b, 0) === 10000
    ? out
    : null;
}
export type Plan = {
  kind: 'relaxed-terminal-proposal';
  executable: false;
  chain: string;
  shelfHash: string;
  shelfProvenance: 'fixture';
  modelProvenance: 'live' | 'recorded' | 'mock';
  shape: Reply['shape'];
  say: string;
  stated: Reply['stated'];
  buckets: {
    name: string;
    goal: string;
    shareBps: number | null;
    lines: { id: string; cls: AssetClass; weightBps: number | null; why: string }[];
  }[];
  notAvailable: Reply['not_available'];
  assumptions: string[];
  warnings: string[];
  missing: string[];
  ready: boolean;
};

/** Validates before printing. No model prose reaches output when its figures are unsupported. */
export function render(
  raw: unknown,
  shelf: Shelf,
  provenance: Plan['modelProvenance'],
  userMessages: string[],
): Plan {
  validateMessages(userMessages);
  if (JSON.stringify(raw).length > LIMITS.replyChars) throw new Error('reply too long');
  const r = Reply.parse(raw);
  const userText = userMessages.join('\n');
  if (
    r.shape !== 'discussion' &&
    /\b(?:like|admire|gosto|admiro)\b/i.test(userText) &&
    !/\b(?:invest|investir|allocate|buy|purchase|hold|put|comprar|aplicar|alocar)\b/i.test(userText)
  )
    throw new Error('admiration alone requires clarification of investment intent');
  const missing: string[] = [];
  const assumptions: string[] = [];
  const warnings = [
    'Non-executable proposal. No compose, API request, FX conversion or execution is wired.',
    'Sample catalog (fixture); no live availability or measured exit assessment.',
  ];
  const prose = [
    r.say,
    r.understood ?? '',
    r.question ?? '',
    ...(r.questions ?? []),
    ...r.lines.map((l) => l.why),
    ...(r.buckets ?? []).flatMap((b) => [b.name, ...b.lines.map((l) => l.why)]),
    ...r.not_available.flatMap((n) => (typeof n === 'string' ? [n] : [n.name, n.why ?? ''])),
  ].join(' ');
  // No numeric financial observations are provided to this CLI. User money is not yield evidence.
  if (
    /\b(?:guaranteed|garantid[oa])\b/i.test(normalized(prose)) ||
    UNSOURCED_METRIC.test(normalized(prose)) ||
    numbers(prose).some((n) => !numbers(userText).includes(n)) ||
    [...prose.matchAll(/\d+(?:[.,]\d+)?\s*%/g)].some((m) => !userText.includes(m[0]))
  ) {
    throw new Error('unsupported numerical or guaranteed claim in model prose');
  }
  const terms = r.stated;
  const budget = budgetEvidence(userMessages);
  const monthly = monthlyEvidence(userText);
  if (r.shape !== 'discussion') {
    if (terms.amount == null) missing.push('amount');
    else {
      if (!budget || budget.amount !== terms.amount)
        missing.push('amount not grounded in person text');
    }
    if (!terms.currency) missing.push('currency');
    else {
      const currency = terms.currency.toUpperCase();
      const pattern =
        currency === 'USD'
          ? /\bUSD\b|\bdollars?\b|(?<!R)\$/i
          : currency === 'BRL'
            ? /\bBRL\b|\breais\b|R\$/i
            : new RegExp(`\\b${escapePattern(currency)}\\b`, 'i');
      if (!pattern.test(userText)) missing.push('currency not grounded in person text');
      if (budget?.currency && budget.currency !== currency)
        missing.push('currency does not match stated budget');
      if (currency !== 'USD') missing.push('unsupported currency: no FX conversion');
    }
    if (terms.monthly != null && monthly?.amount !== terms.monthly)
      missing.push('monthly not grounded in person text');
    if (
      terms.monthly != null &&
      monthly?.currency &&
      monthly.currency !== terms.currency?.toUpperCase()
    )
      missing.push('monthly currency differs from budget: no FX conversion');
    if (terms.when != null && !groundedWhen(terms.when, userMessages))
      missing.push('when not grounded in person text');
  } else missing.push('intent');
  const definitions =
    r.shape === 'discussion'
      ? []
      : r.shape === 'split'
        ? (r.buckets ?? [])
        : [
            {
              name: r.shape,
              goal: r.shape,
              share: 1,
              lines: r.lines,
              weights: terms.weights,
            },
          ];
  if (r.shape !== 'discussion' && !definitions.length) missing.push('empty pots');
  if (r.shape === 'split' && definitions.length < 2) missing.push('split needs at least two pots');
  const shares = definitions.map((b) => (b.share == null ? null : b.share * 10000));
  if (
    r.shape !== 'discussion' &&
    (shares.some((s) => s === null || !Number.isInteger(s) || s <= 0) ||
      shares.reduce<number>((a, b) => a + (b ?? 0), 0) !== 10000)
  )
    missing.push('shares must be positive whole basis points totaling 10000');
  if (r.shape === 'split') {
    if (typeof terms.weights === 'string' && !/metade|half/i.test(terms.weights))
      missing.push('holding preferences must be stated per pot');
    const shareText =
      [...userMessages].reverse().find((message) => /%|half|metade/i.test(message)) ?? '';
    const shareValues = [...shareText.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map(
      (m) => Number(m[1]?.replace(',', '.')) * 100,
    );
    if (
      !shares.every((s, i) => {
        if (s === null) return false;
        if (s === 5000 && /half|metade/i.test(shareText) && !shareValues.length) return true;
        const name = definitions[i]?.name ?? '';
        const pattern = new RegExp(
          `(\\d+(?:[.,]\\d+)?)\\s*%\\s*(?:in |em |of |de |for |to )?${escapePattern(name)}(?:\\b|$)|${escapePattern(name)}\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)\\s*%`,
          'gi',
        );
        const match = [...shareText.matchAll(pattern)].at(-1);
        return !!match && Number((match[1] ?? match[2])?.replace(',', '.')) * 100 === s;
      })
    )
      missing.push('pot shares not grounded in person text');
  }
  const percentageValues = [...userText.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map(
    (m) => Number(m[1]?.replace(',', '.')) * 100,
  );
  const splitHoldingPreferences =
    r.shape === 'split' &&
    (percentageValues.some((value) => !shares.includes(value)) ||
      percentageValues.length > definitions.length);
  const unsupportedPreference = UNSUPPORTED_PREFERENCE.test(normalized(userText));
  if (unsupportedPreference)
    missing.push('unsupported allocation preference retained; no automatic reshaping');
  const buckets = definitions.map((b, index) => {
    if (!b.goal) missing.push(`${b.name}: explicit pot goal required`);
    if (b.goal === 'grow' || b.goal === 'protect') {
      if (terms.when == null || terms.when === '') missing.push('when');
    }
    if (b.goal === 'income' && terms.monthly == null) missing.push('monthly');
    const seen = new Set<string>();
    // Calculate on the requested lines before filtering. Removing a line never increases another
    // requested weight. Unknown lines get only enough identity to preserve unresolved preferences.
    const requestedRows = b.lines.map(
      (line) =>
        shelf.rows.find((row) => row.id === line.id) ?? {
          id: line.id,
          symbol: line.id.split(':')[1] ?? line.id,
          cls: 'cash' as const,
          maxWeightBps: 0,
          provenance: 'fixture' as const,
          text: '',
          warnings: [],
        },
    );
    const omittedPreferences =
      b.weights == null &&
      (unsupportedPreference ||
        (r.shape !== 'split'
          ? /\d\s*%|\b(?:half|metade|all in|all of|tudo em|todo em)\b/i.test(userText)
          : splitHoldingPreferences));
    if (omittedPreferences) missing.push('holding preferences not represented in reply');
    const weights = omittedPreferences ? null : statedWeights(b.weights, requestedRows, userText);
    const kept: { row: Row; why: string; index: number }[] = [];
    for (const [lineIndex, line] of b.lines.entries()) {
      const row = shelf.rows.find((row) => row.id === line.id);
      if (!row) {
        missing.push(`not on table: ${line.id}`);
        continue;
      }
      if (seen.has(row.id)) {
        missing.push(`duplicate holding: ${row.id}`);
        continue;
      }
      seen.add(row.id);
      if (!b.goal || (b.goal !== 'pick' && !eligibleForGoal(row, b.goal))) {
        missing.push(`ineligible for ${b.goal ?? 'unknown goal'}: ${row.id}`);
        continue;
      }
      kept.push({ row, why: line.why, index: lineIndex });
      warnings.push(...row.warnings.map((w) => `${row.id}: ${w}`));
    }
    if (!kept.length) missing.push(`${b.name}: empty holdings`);
    if (kept.length > PERSONAL_PARAMS.maxLinesPerChain)
      missing.push(`${b.name}: too many holdings`);
    if (!weights)
      missing.push(`${b.name}: unsupported or ungrounded holding weights; preference retained`);
    if (!omittedPreferences && b.weights == null && b.lines.length > 1)
      assumptions.push(`${b.name}: equal weights within this pot`);
    const lines = kept.map(({ row, why, index: lineIndex }) => {
      const weightBps = weights?.[lineIndex] ?? null;
      if (weightBps != null && weightBps > row.maxWeightBps)
        missing.push(`${row.id}: exceeds catalog cap; requested weight retained`);
      return { id: row.id, cls: row.cls, weightBps, why };
    });
    return { name: b.name, goal: b.goal ?? 'unresolved', shareBps: shares[index] ?? null, lines };
  });
  missing.push(...r.open);
  const unique = [...new Set(missing)];
  return {
    kind: 'relaxed-terminal-proposal',
    executable: false,
    chain: shelf.chain,
    shelfHash: shelf.hash,
    shelfProvenance: 'fixture',
    modelProvenance: provenance,
    shape: r.shape,
    say: r.say,
    stated: terms,
    buckets,
    notAvailable: r.not_available.map((name) => ({
      name: typeof name === 'string' ? name : name.name,
      why: 'Not selected from the fixture catalog; live availability unverified.',
    })),
    assumptions,
    warnings: [...new Set(warnings)],
    missing: unique,
    ready: unique.length === 0,
  };
}
export function formatPlan(plan: Plan): string {
  const lines = plan.buckets.flatMap((b) => [
    `  — ${b.name} · ${b.goal} · ${b.shareBps == null ? 'unresolved share' : pct(b.shareBps)}`,
    ...b.lines.map(
      (l) => `  ${l.weightBps == null ? 'unresolved' : pct(l.weightBps)} ${l.id} ${l.why}`,
    ),
  ]);
  return [
    plan.say,
    ...lines,
    ...plan.assumptions,
    ...plan.notAvailable.map((n) =>
      typeof n === 'string'
        ? `Unavailable: ${n}`
        : `Unavailable: ${n.name}${n.why ? ` — ${n.why}` : ''}`,
    ),
    ...plan.warnings,
    `[${plan.modelProvenance.toUpperCase()} reply · FIXTURE shelf · ${plan.chain} · ${plan.ready ? 'ready to acknowledge proposal' : `open: ${plan.missing.join('; ')}`}]`,
  ].join('\n');
}
export function confirmedProposal(plan: Plan): Plan {
  if (!plan.ready) throw new Error('proposal has unresolved terms');
  return plan;
}
export function validateMessages(messages: string[]): void {
  if (messages.length > LIMITS.turns)
    throw new Error(`conversation limit: ${LIMITS.turns} person turns`);
  if (messages.some((m) => !m.trim() || m.length > LIMITS.textChars))
    throw new Error(`person text must be 1–${LIMITS.textChars} characters`);
}
