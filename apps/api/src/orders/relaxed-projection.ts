import type { VaultAgentSource as AgentSource } from '@colosseum/schemas';

// The arithmetic of the relaxed intake (gate RELAXED-INTAKE). The model reads the person's words into
// dates and amounts; this file does every sum, from the server's sourced yield readings only. A line
// with no reading earns nothing here (cash, a stock, a token with no stored reading), and the text
// says so. Each figure is past-rate arithmetic, never a promise: the text says that too, and names the
// reading's source, its date and whether it is a test-network figure.

export type Reading = {
  assetId: string;
  symbol: string;
  /** The rate the projection uses: the haircut yield when there is one, else the quoted one. */
  rate: number;
  quoted: number | null;
  haircut: number | null;
  source: string;
  fetchedAt: string;
  provenance: string;
  ids: string[];
};

/** The latest quoted and haircut readings per asset, from the context's evidence. */
export function readingsOf(
  evidence: readonly AgentSource[],
  symbolOf: (assetId: string) => string,
): Map<string, Reading> {
  const byAsset = new Map<string, { quoted?: AgentSource; haircut?: AgentSource }>();
  for (const source of evidence) {
    const match = /^yield:(.+):\d+:(quoted|haircut)$/.exec(source.id);
    if (!match || typeof source.value !== 'number' || !Number.isFinite(source.value)) continue;
    const [, assetId, kind] = match as unknown as [string, string, 'quoted' | 'haircut'];
    const held = byAsset.get(assetId) ?? {};
    const prior = held[kind];
    if (!prior || prior.fetchedAt < source.fetchedAt) held[kind] = source;
    byAsset.set(assetId, held);
  }
  const out = new Map<string, Reading>();
  for (const [assetId, { quoted, haircut }] of byAsset) {
    const used = haircut ?? quoted;
    if (!used || typeof used.value !== 'number') continue;
    out.set(assetId, {
      assetId,
      symbol: symbolOf(assetId),
      rate: used.value,
      quoted: typeof quoted?.value === 'number' ? quoted.value : null,
      haircut: typeof haircut?.value === 'number' ? haircut.value : null,
      source: used.source,
      fetchedAt: used.fetchedAt,
      provenance: used.provenance,
      ids: [quoted?.id, haircut?.id].filter((id): id is string => Boolean(id)),
    });
  }
  return out;
}

export type ProjectionInput = {
  lines: { assetId: string; symbol: string; weightBps: number }[];
  readings: Map<string, Reading>;
  today: Date;
  currency: string | null;
  amount: number | null;
  /** The day the money is needed, ISO. */
  needBy: string | null;
  monthly: number | null;
  /** How many monthly withdrawals; null when open-ended. */
  months: number | null;
  /** The day of the first withdrawal, ISO; null means a month from today. */
  withdrawStart: string | null;
};

export type Projection = { text: string; sourceIds: string[] } | null;

const DAY = 86_400_000;
const yearsBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / (365.25 * DAY);
const day = (iso: string | null) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const addMonths = (d: Date, n: number) => {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
};
const money = (n: number, currency: string) =>
  `${currency === 'USD' ? '$' : `${currency} `}${Math.round(n).toLocaleString('en-US')}`;
const rate = (r: number) => `${(r * 100).toFixed(2)}%`;
const date = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The plan's yearly rate: each line's reading by its weight, a line with none at zero. */
function blended(input: ProjectionInput) {
  let r = 0;
  const used: Reading[] = [];
  const none: string[] = [];
  for (const line of input.lines) {
    const reading = input.readings.get(line.assetId);
    if (reading) {
      r += (line.weightBps / 10_000) * reading.rate;
      used.push(reading);
    } else none.push(line.symbol);
  }
  return { r, used, none };
}

export function project(input: ProjectionInput): Projection {
  const currency = input.currency ?? 'USD';
  if (!input.lines.length) return null;
  if (input.amount == null && input.monthly == null) return null;
  const { r, used, none } = blended(input);
  const out: string[] = [];
  const monthlyRate = (1 + r) ** (1 / 12) - 1;

  // 1. What the amount grows to by the day it is needed (the first withdrawal is such a day too).
  const needBy = day(input.needBy) ?? day(input.withdrawStart);
  if (input.amount != null && needBy && needBy > input.today) {
    const amount = input.amount;
    const t = yearsBetween(input.today, needBy);
    const value = input.lines.reduce((sum, line) => {
      const reading = input.readings.get(line.assetId);
      return sum + amount * (line.weightBps / 10_000) * (1 + (reading?.rate ?? 0)) ** t;
    }, 0);
    out.push(
      `By ${date(needBy)}, ${money(input.amount, currency)} placed today would earn about ${money(value - input.amount, currency)}, to about ${money(value, currency)}.`,
    );
  }

  // 1b. No term said: what the amount grows to in five years, the chart's default term.
  if (input.amount != null && !needBy && input.monthly == null) {
    const amount = input.amount;
    const five = addMonths(input.today, 60);
    const value = input.lines.reduce((sum, line) => {
      const reading = input.readings.get(line.assetId);
      return sum + amount * (line.weightBps / 10_000) * (1 + (reading?.rate ?? 0)) ** 5;
    }, 0);
    out.push(
      `With no date given, over five years (to ${date(five)}), ${money(input.amount, currency)} placed today would earn about ${money(value - input.amount, currency)}, to about ${money(value, currency)}.`,
    );
  }

  // 2. Monthly withdrawals: how long the amount lasts, and what the stated number of them needs today.
  if (input.monthly != null) {
    // The first withdrawal: the day they said, else the day the money is needed, else in a month.
    const start =
      day(input.withdrawStart) ??
      (needBy && needBy > input.today ? needBy : addMonths(input.today, 1));
    const withdrawalDay = (k: number) => addMonths(start, k);
    if (input.months != null && input.months > 0) {
      const needed = Array.from({ length: input.months }, (_, k) => {
        const t = Math.max(0, yearsBetween(input.today, withdrawalDay(k)));
        return (input.monthly as number) / (1 + r) ** t;
      }).reduce((a, b) => a + b, 0);
      out.push(
        `${input.months} withdrawals of ${money(input.monthly, currency)} a month from ${date(start)} need about ${money(needed, currency)} placed today.`,
      );
    }
    if (input.amount != null) {
      // Month by month: the balance earns until each withdrawal, then pays it.
      let balance = input.amount * (1 + r) ** Math.max(0, yearsBetween(input.today, start));
      let paid = 0;
      const cap = input.months ?? 600;
      while (paid < cap && balance >= input.monthly) {
        balance -= input.monthly;
        paid += 1;
        balance *= 1 + monthlyRate;
      }
      const covers =
        input.months != null && paid >= input.months
          ? `covers all ${input.months} withdrawals of ${money(input.monthly, currency)}, with about ${money(balance, currency)} left`
          : `covers ${paid} full withdrawal${paid === 1 ? '' : 's'} of ${money(input.monthly, currency)}${input.months != null ? ` of the ${input.months}` : ''}, the last on ${paid ? date(withdrawalDay(paid - 1)) : '—'}`;
      out.push(`${money(input.amount, currency)} placed today ${covers}.`);
    }
  }
  if (!out.length) return null;

  // 3. Where the rate comes from, and what it is not.
  const unique = [...new Map(used.map((u) => [u.assetId, u])).values()];
  const basis = unique.length
    ? `Rate: ${rate(r)} a year across the plan, from ${unique
        .map(
          (u) =>
            `${u.symbol} at ${rate(u.rate)}${u.haircut != null && u.quoted != null ? ` (quoted ${rate(u.quoted)}, after the haircut)` : ''}, read ${date(new Date(u.fetchedAt))}${u.provenance === 'sandbox' ? ', a mainnet reading applied on the test network' : u.provenance === 'mock' ? ', MOCK' : ''}`,
        )
        .join('; ')}.`
    : 'No line of this plan has a sourced yield reading, so it is counted as earning nothing.';
  const zero = none.length ? ` Counted as earning nothing: ${none.join(', ')}.` : '';
  return {
    text: `Projection, computed by Tenonfi from past rates, not a promise: ${out.join(' ')} ${basis}${zero}`,
    sourceIds: unique.flatMap((u) => u.ids),
  };
}

export type MonthPoint = { month: string; balance: number; earned: number; withdrawn: number };
export type ProjectionSeries = {
  currency: string;
  /** The plan's yearly rate from its sourced readings, lines with none at zero. */
  rate: number;
  /** Months between two points: 1, or 12 for a term past five years. */
  step: number;
  /** Empty when the amount is not known yet: the chart then asks for it. */
  months: MonthPoint[];
  basis: string;
  sourceIds: string[];
};

/**
 * The month-by-month balance the projection text describes: from today, earning at the plan's rate,
 * paying each monthly withdrawal on its day. Only for a plan with at least one line that has a
 * sourced yield reading (a plan of stocks only has none). Up to the last withdrawal, else the day the
 * money is needed, else five years.
 */
export function series(input: ProjectionInput): ProjectionSeries | null {
  const { r, used, none } = blended(input);
  if (!used.length) return null;
  const currency = input.currency ?? 'USD';
  const unique = [...new Map(used.map((u) => [u.assetId, u])).values()];
  const basis = `Projected from past rates, not a promise: ${rate(r)} a year across the plan, from ${unique
    .map(
      (u) =>
        `${u.symbol} at ${rate(u.rate)}, read ${date(new Date(u.fetchedAt))}${u.provenance === 'sandbox' ? ' (mainnet reading on a test network)' : ''}`,
    )
    .join('; ')}.${none.length ? ` Earning nothing: ${none.join(', ')}.` : ''}`;
  const base = { currency, rate: r, basis, sourceIds: unique.flatMap((u) => u.ids) };
  if (input.amount == null || input.amount <= 0) return { ...base, step: 1, months: [] };

  const needBy = day(input.needBy) ?? day(input.withdrawStart);
  const firstWithdrawal =
    day(input.withdrawStart) ??
    (needBy && needBy > input.today ? needBy : addMonths(input.today, 1));
  // The term: the last of a stated number of withdrawals, else the day the money is needed, else
  // five years (no term said). Open-ended withdrawals run to that term.
  const stated =
    input.monthly != null && input.monthly > 0 && input.months != null && input.months > 0
      ? addMonths(firstWithdrawal, Math.min(input.months, 600) - 1)
      : null;
  const end = stated ?? (needBy && needBy > input.today ? needBy : addMonths(input.today, 60));
  const withdrawals: Date[] = [];
  if (input.monthly != null && input.monthly > 0)
    for (let k = 0; k < 600; k++) {
      const w = addMonths(firstWithdrawal, k);
      if (w > end || (input.months != null && k >= input.months)) break;
      withdrawals.push(w);
    }
  // Calendar months from today to the term, a part month counted whole.
  const calendar =
    (end.getUTCFullYear() - input.today.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    input.today.getUTCMonth() +
    (end.getUTCDate() > input.today.getUTCDate() ? 1 : 0);
  const count = Math.min(600, Math.max(1, calendar));
  // One point a month up to five years; past that, one a year, so a long term stays readable.
  const step = count > 60 ? 12 : 1;
  const monthlyRate = (1 + r) ** (1 / 12) - 1;
  const first = new Date(
    Date.UTC(input.today.getUTCFullYear(), input.today.getUTCMonth(), input.today.getUTCDate()),
  );
  const months: MonthPoint[] = [
    { month: first.toISOString().slice(0, 10), balance: input.amount, earned: 0, withdrawn: 0 },
  ];
  let balance = input.amount;
  let earned = 0;
  let withdrawnSincePoint = 0;
  for (let k = 1; k <= count; k++) {
    const from = addMonths(first, k - 1);
    const to = addMonths(first, k);
    const gain = balance * monthlyRate;
    balance += gain;
    earned += gain;
    for (const w of withdrawals)
      if (w > from && w <= to) {
        const take = Math.min(balance, input.monthly as number);
        balance -= take;
        withdrawnSincePoint += take;
      }
    if (k % step === 0 || k === count) {
      months.push({
        month: to.toISOString().slice(0, 10),
        balance: Math.round(balance * 100) / 100,
        earned: Math.round(earned * 100) / 100,
        withdrawn: Math.round(withdrawnSincePoint * 100) / 100,
      });
      withdrawnSincePoint = 0;
    }
  }
  return { ...base, step, months };
}
