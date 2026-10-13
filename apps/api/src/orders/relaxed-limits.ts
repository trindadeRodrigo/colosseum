import { type BasketAsset, ORDER_LIMITS, type VaultAgentRequest } from '@colosseum/schemas';

// The relaxed intake's guards on a line (RELAXED-INTAKE): the cap it shows beside each holding and the
// limits a person wrote in their own words ("at most 20% in Tesla"). Kept as the relaxed intake was
// built against them; the model-led conversation (vault-agent.ts) reads shares its own way since
// ANY-COMPOSITION. A line over its cap or outside a written limit becomes a note to the person here,
// never a weight set by the model.

/** Cash is the residual balance, not a capped creator target (compose's cash convention). */
export function catalogCap(asset: BasketAsset): number {
  return asset.cls === 'cash' ? 10000 : asset.maxWeightBps;
}

type HoldingConstraint = {
  key: string;
  matches(asset: BasketAsset): boolean;
  min: number;
  max: number;
  quote: string;
};

/** Bounded person-authored percentage limits are guards only; nothing here assigns a weight. */
export function holdingConstraints(
  messages: VaultAgentRequest['messages'],
  assets: BasketAsset[],
): HoldingConstraint[] {
  const constraints = new Map<string, HoldingConstraint>();
  const targets: Array<{ key: string; words: string[]; matches(asset: BasketAsset): boolean }> = [
    {
      key: 'stocks',
      words: ['stocks?', 'shares?', 'equities', 'ações', 'acoes'],
      matches: (asset) => asset.cls === 'stock' || asset.cls === 'etf',
    },
    { key: 'cash', words: ['cash', 'caixa'], matches: (asset) => asset.cls === 'cash' },
    { key: 'gold', words: ['gold', 'ouro'], matches: (asset) => asset.cls === 'gold' },
    { key: 'crypto', words: ['crypto', 'cripto'], matches: (asset) => asset.cls === 'crypto' },
    ...assets.map((asset) => ({
      key: asset.id,
      words: [asset.symbol, asset.underlying].map((word) =>
        word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
      matches: (candidate: BasketAsset) => candidate.id === asset.id,
    })),
  ];
  let last: HoldingConstraint | undefined;
  for (const message of messages) {
    if (message.who !== 'person') continue;
    const text = message.text.trim();
    if (
      /^["“‘']|\b(?:if|should\s+i|my\s+friend|my\s+advisor|someone|said|quoted|explain|understand|discuss|talk\s+about|learn|example|se\s+eu|meu\s+amigo|disse|entender|discutir|exemplo)\b/iu.test(
        text,
      )
    )
      continue;
    const instruction =
      /^(?:please\s+)?(?:i\s+(?:think\s+i\s+)?(?:want|would\s+like|would\s+prefer)|we\s+want|put|allocate|hold|keep|set|make|increase|reduce|replace|quero|prefiro|coloque|aloque|mantenha|aumente|reduza|faça|faca)\b/iu.test(
        text,
      );
    if (
      /^(?:ignore|drop|remove|forget|esqueça|esqueca|ignore|remova)\b/iu.test(text) &&
      /\b(?:limit|requirement|constraint|minimum|maximum|limite|mínimo|minimo|máximo|maximo)\b/iu.test(
        text,
      )
    ) {
      const named = targets.filter((target) =>
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(
          text,
        ),
      );
      if (named.length > 0) for (const target of named) constraints.delete(target.key);
      else if (/\b(?:that|this|esse|este)\b/iu.test(text) && last) constraints.delete(last.key);
      continue;
    }
    if (
      !instruction ||
      /\b(?:do\s+not|don't|não|nao)\s+(?:want|quero|allocate|put|increase|invest)\b/iu.test(text)
    )
      continue;
    const percent =
      /(?:(at\s+least|at\s+most|no\s+more\s+than|minimum|maximum|exactly|pelo\s+menos|no\s+m[ií]nimo|no\s+m[aá]ximo)\s*)?(\d+(?:[.,]\d+)?)\s*%/giu;
    for (const match of text.matchAll(percent)) {
      const bps = Number(match[2]?.replace(',', '.')) * 100;
      if (!Number.isInteger(bps) || bps < 0 || bps > 10000) continue;
      const after =
        text
          .slice((match.index ?? 0) + match[0].length)
          .split(/[,;.!?](?!\d)|\b(?:and|but|e|mas)\b/iu)[0] ?? '';
      const before =
        text
          .slice(0, match.index)
          .split(/[,;.!?](?!\d)|\b(?:and|but|e|mas)\b/iu)
          .at(-1) ?? '';
      const named = targets.filter((target) =>
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(
          after,
        ),
      );
      const beforeNames =
        named.length === 0
          ? targets.filter((target) =>
              new RegExp(
                `(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`,
                'iu',
              ).test(before),
            )
          : [];
      const wholeNames = targets.filter((target) =>
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(
          text,
        ),
      );
      const target =
        named.length === 1
          ? named[0]
          : beforeNames.length === 1
            ? beforeNames[0]
            : named.length === 0 && beforeNames.length === 0 && /^make\s+that\b/iu.test(text)
              ? last
              : named.length === 0 && beforeNames.length === 0 && wholeNames.length === 1
                ? wholeNames[0]
                : undefined;
      if (!target) continue;
      const bound = match[1]?.toLocaleLowerCase() ?? '';
      const minimum = /least|minimum|pelo\s+menos|m[ií]nimo/u.test(bound);
      const maximum = /most|no\s+more|maximum|m[aá]ximo/u.test(bound);
      last = {
        key: target.key,
        matches: target.matches,
        min: maximum ? 0 : bps,
        max: minimum ? 10000 : bps,
        quote: text,
      };
      constraints.set(target.key, last);
    }
  }
  return [...constraints.values()];
}

// The projection's inputs (RELAXED-INTAKE: "no figure comes from the model"). The model reports the
// amount, the dates and the monthly withdrawal it read; the projection is the server's arithmetic, so
// what it starts from has to be the person's too. Each is used only where the server finds it in the
// person's own messages and inside what the deposit step accepts; anything else is left out and no
// projection is made from it.

/** The least a plan's amount may be (`BasketSheet`, the deposit step's own floor). */
export const PROJECTION_MIN_USD = 10;
/** No projection further out than this: a date past it is a misreading, not a plan. */
export const PROJECTION_MAX_YEARS = 60;

const DOLLARS = /^(?:us\$|\$|usd|usdc|dollars?|bucks)$/i;
const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const SCALE = 'k|m|mil|thousand|million';
const CURRENCY = String.raw`us\$|r\$|\$|€|£|usd|usdc|brl|eur|gbp|dollars?|bucks|reais|real|euros?|pounds?`;
const MONEY = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?<before>us\$|r\$|\$|€|£|usd|brl|eur|gbp)\s?(?<a>${NUMBER})\s?(?<as>${SCALE})?(?![\p{L}\p{N}%])|(?<b>${NUMBER})\s?(?<bs>${SCALE})?\s?(?<after>${CURRENCY})(?![\p{L}\p{N}]))`,
  'giu',
);
/** "5,000" and "5.000" are five thousand; "5.50" and "5,5" five and a half. */
function numberOf(text: string): number {
  const decimal = /[.,]\d{1,2}$/.exec(text)?.[0] ?? '';
  const whole = text.slice(0, text.length - decimal.length).replace(/[.,]/g, '');
  return Number(`${whole}${decimal ? `.${decimal.slice(1)}` : ''}`);
}
const scaleOf = (word: string | undefined) =>
  !word ? 1 : /^(?:m|million)$/i.test(word) ? 1_000_000 : 1_000;

/** Every amount the person wrote in digits beside its currency, and whether that currency is dollars. */
export function personMoney(
  messages: VaultAgentRequest['messages'],
): { amount: number; dollars: boolean }[] {
  const found: { amount: number; dollars: boolean }[] = [];
  for (const message of messages) {
    if (message.who !== 'person') continue;
    for (const match of message.text.matchAll(MONEY)) {
      const g = match.groups ?? {};
      const amount = numberOf(g.a ?? g.b ?? '') * scaleOf(g.as ?? g.bs);
      if (Number.isFinite(amount) && amount > 0)
        found.push({ amount, dollars: DOLLARS.test(g.before ?? g.after ?? '') });
    }
  }
  return found;
}

const isoDay = (iso: string | null | undefined) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const at = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
};

/** The model's sheet, as it reported it. */
export type ReportedSheet = {
  amount?: number | null;
  currency?: string | null;
  need_by?: string | null;
  monthly?: number | null;
  withdraw_months?: number | null;
  withdraw_start?: string | null;
};

/**
 * What of the reported sheet the projection may start from. An amount or a monthly figure stands only
 * when the person wrote that number in digits beside a currency, in dollars (the readings are dollar
 * yields: no other currency is projected from them), between the deposit step's limits. A date stands
 * when it is a real day after today, within `PROJECTION_MAX_YEARS`, and the person's words hold its
 * year or a term in years or months that reaches it. `otherCurrency` says a figure was left out for
 * being in another currency, so the reply can say why there is no projection.
 */
export function projectionSheet(
  reported: ReportedSheet,
  messages: VaultAgentRequest['messages'],
  today: Date,
): {
  amount: number | null;
  monthly: number | null;
  months: number | null;
  needBy: string | null;
  withdrawStart: string | null;
  otherCurrency: boolean;
} {
  const money = personMoney(messages);
  const reportedDollars = !reported.currency || DOLLARS.test(reported.currency.trim());
  let otherCurrency = false;
  const figure = (value: number | null | undefined, min: number) => {
    if (value == null || !Number.isFinite(value)) return null;
    const said = money.filter((m) => Math.abs(m.amount - value) < 0.005);
    if (!said.length) return null;
    if (!reportedDollars || !said.some((m) => m.dollars)) {
      otherCurrency = true;
      return null;
    }
    return value >= min && value <= ORDER_LIMITS.maxAmountUsd ? value : null;
  };
  const words = messages
    .filter((m) => m.who === 'person')
    .map((m) => m.text)
    .join('\n');
  const horizon = new Date(today);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + PROJECTION_MAX_YEARS);
  const terms = [
    ...words.matchAll(/(\d{1,3})\s*-?\s*(years?|yrs?|anos?|months?|meses|m[eê]s)/giu),
  ].map((match) => {
    const at = new Date(today);
    const n = Number(match[1]);
    if (/^(?:y|a)/i.test(match[2] ?? '')) at.setUTCFullYear(at.getUTCFullYear() + n);
    else at.setUTCMonth(at.getUTCMonth() + n);
    return at.getTime();
  });
  const date = (iso: string | null | undefined) => {
    const at = isoDay(iso);
    if (!at || at <= today || at > horizon) return null;
    const inWords =
      new RegExp(String.raw`(?<!\d)${at.getUTCFullYear()}(?!\d)`).test(words) ||
      terms.some((term) => Math.abs(term - at.getTime()) <= 45 * 86_400_000);
    return inWords ? (iso as string) : null;
  };
  const months = reported.withdraw_months;
  return {
    amount: figure(reported.amount, PROJECTION_MIN_USD),
    monthly: figure(reported.monthly, 0.01),
    months:
      months != null &&
      Number.isInteger(months) &&
      months >= 1 &&
      months <= PROJECTION_MAX_YEARS * 12
        ? months
        : null,
    needBy: date(reported.need_by),
    withdrawStart: date(reported.withdraw_start),
    otherCurrency,
  };
}
