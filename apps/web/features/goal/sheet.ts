import { BasketSheet, type BasketSheetDraft, type ChainId } from '@colosseum/schemas';
import type { SheetField, SheetGroup } from '../../components/ui/ConstraintSheet';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { COUNTRY_CODES, countryOptions } from './countries';
import type { GoalReading } from './read-goal';

// The limits as the person edits them: every field as the text or the choice on the screen. This file
// turns a reading into those fields, checks them against the shared `BasketSheet` (the same schema the
// server holds a sheet to), and says each thing that does not fit as a sentence. Nothing is handed on
// to be built but what that schema parsed.

export type SheetFields = {
  goal: '' | BasketSheet['goal'];
  /** Dollars, as typed. */
  amount: string;
  /** Dollars a month, as typed. Read only when the goal is income. */
  income: string;
  /** Whole months, as typed. */
  horizon: string;
  risk: '' | BasketSheet['risk'];
  /** A two-letter code, or empty. */
  country: string;
  holdings: 'yes' | 'no';
  glide: 'yes' | 'no';
  language: Lang;
};
export type FieldKey = keyof SheetFields;

/** The id of each control in the page: the error summary links to it. */
export const FIELD_ID: Record<FieldKey, string> = {
  goal: 'limits-goal',
  amount: 'limits-amount',
  income: 'limits-income',
  horizon: 'limits-horizon',
  risk: 'limits-risk',
  country: 'limits-country',
  holdings: 'limits-holdings',
  glide: 'limits-glide',
  language: 'limits-language',
};
const KEY_OF_ID = Object.fromEntries(
  Object.entries(FIELD_ID).map(([key, id]) => [id, key]),
) as Record<string, FieldKey>;
export const fieldOfId = (id: string): FieldKey | undefined => KEY_OF_ID[id];

/** The fields of a reading. What the reader did not find is empty; the two rules start as "yes". */
export function fieldsOfDraft(draft: BasketSheetDraft, lang: Lang): SheetFields {
  return {
    goal: draft.goal ?? '',
    amount: draft.amountUsd === null ? '' : String(draft.amountUsd),
    income: draft.incomeTargetUsdMonthly === null ? '' : String(draft.incomeTargetUsdMonthly),
    horizon: draft.horizonMonths === null ? '' : String(draft.horizonMonths),
    risk: draft.risk ?? '',
    country: draft.country ?? '',
    holdings: draft.rules?.useHoldings === false ? 'no' : 'yes',
    glide: draft.rules?.glide === false ? 'no' : 'yes',
    language: draft.language ?? lang,
  };
}

/**
 * A number as a person types one in their language: "40,000" and "$40,000.50" in English, "40.000"
 * and "US$ 40.000,50" in Portuguese. Null when nothing was typed, NaN when it is not a number.
 */
export function parseNumber(text: string, lang: Lang): number | null {
  const bare = text.replace(/US\$|\$|[\s  ]/g, '');
  if (bare === '') return null;
  const plain = lang === 'pt' ? bare.replace(/\./g, '').replace(',', '.') : bare.replace(/,/g, '');
  return /^\d+(\.\d+)?$/.test(plain) ? Number(plain) : Number.NaN;
}

export type ErrorKey = keyof Dictionary['goal']['errors'];
export type SheetCheck = {
  /** What does not fit, by field. */
  errors: Partial<Record<FieldKey, ErrorKey>>;
  /** The sheet the schema parsed, or null while anything fails or the chain is not known. */
  sheet: BasketSheet | null;
};

/** The fields the schema can refuse, by where it says so. The two rules are choices and cannot fail. */
type Checked = 'goal' | 'amount' | 'income' | 'horizon' | 'risk' | 'country' | 'language';
const FIELD_OF_PATH: Record<string, Checked> = {
  goal: 'goal',
  amountUsd: 'amount',
  incomeTargetUsdMonthly: 'income',
  horizonMonths: 'horizon',
  risk: 'risk',
  country: 'country',
  language: 'language',
};

/**
 * Checks the fields against `BasketSheet`. The chain is not one of them: it is the wallet's, and it
 * is put on the sheet here. Without a chain every field is still checked, and nothing is parsed.
 */
export function checkSheet(fields: SheetFields, chain: ChainId | null, lang: Lang): SheetCheck {
  const amount = parseNumber(fields.amount, lang);
  const income = fields.goal === 'income' ? parseNumber(fields.income, lang) : null;
  const horizon = /^\d+$/.test(fields.horizon.trim()) ? Number(fields.horizon.trim()) : Number.NaN;
  const candidate = {
    basketType: 'standard',
    goal: fields.goal === '' ? undefined : fields.goal,
    amountUsd: amount ?? undefined,
    horizonMonths: horizon,
    risk: fields.risk === '' ? undefined : fields.risk,
    // The shelf is not served yet, so no shared portfolio can be named on the sheet.
    themes: [],
    country: fields.country,
    // A placeholder while there is no chain: the fields are checked, and no sheet comes out.
    chains: [chain ?? 'solana'],
    ...(income === null ? {} : { incomeTargetUsdMonthly: income }),
    rules: { useHoldings: fields.holdings === 'yes', glide: fields.glide === 'yes' },
    language: fields.language,
  };
  const parsed = BasketSheet.safeParse(candidate);
  if (parsed.success) return { errors: {}, sheet: chain ? parsed.data : null };

  const errors: SheetCheck['errors'] = {};
  for (const issue of parsed.error.issues) {
    const field = FIELD_OF_PATH[String(issue.path[0])];
    if (!field || errors[field]) continue;
    errors[field] =
      field === 'amount'
        ? amount === null
          ? 'amountEmpty'
          : Number.isNaN(amount)
            ? 'amountNumber'
            : issue.code === 'too_small'
              ? 'amountLow'
              : issue.code === 'too_big'
                ? 'amountHigh'
                : 'amountNumber'
        : field;
  }
  return { errors, sheet: null };
}

/** An amount of dollars in the language of the page: "$40,000", "US$ 40.000". */
export function dollars(amount: number, lang: Lang): string {
  return new Intl.NumberFormat(LOCALE[lang], {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * The goal as one sentence, from the limits as they stand: "Grow $40,000 over 36 months." Null while
 * the three things it is made of cannot all be read.
 */
export function goalSentence(fields: SheetFields, t: Dictionary, lang: Lang): string | null {
  const amount = parseNumber(fields.amount, lang);
  const months = /^\d+$/.test(fields.horizon.trim()) ? Number(fields.horizon.trim()) : null;
  if (fields.goal === '' || amount === null || Number.isNaN(amount) || months === null) return null;
  return t.goal.card.sentence[fields.goal](dollars(amount, lang), t.goal.card.months(months));
}

/**
 * The fields as the sheet draws them: human labels, the sentence of each error in the language of
 * the sheet, and "edited" where the person changed what was read.
 */
export function sheetGroups(
  fields: SheetFields,
  read: SheetFields,
  errors: SheetCheck['errors'],
  t: Dictionary,
  said: Dictionary,
  lang: Lang,
): { groups: SheetGroup[]; amount: SheetField } {
  const g = t.goal;
  const field = (key: FieldKey, rest: Omit<SheetField, 'id' | 'label' | 'value'>): SheetField => {
    const error = errors[key];
    return {
      id: FIELD_ID[key],
      label: g.fields[key],
      value: fields[key],
      edited: fields[key] !== read[key],
      error: error ? said.goal.errors[error] : undefined,
      ...rest,
    };
  };
  const choose = { value: '', label: g.options.choose };
  const yesNo = [
    { value: 'yes', label: g.options.yes },
    { value: 'no', label: g.options.no },
  ];
  const goal = field('goal', {
    kind: 'select',
    schemaKey: 'goal',
    width: '14ch',
    options: [
      choose,
      { value: 'grow', label: g.options.goal.grow },
      { value: 'income', label: g.options.goal.income },
      { value: 'protect', label: g.options.goal.protect },
    ],
    caption:
      fields.goal === 'income'
        ? g.captions.income
        : fields.goal === 'protect'
          ? g.captions.protect
          : undefined,
  });
  const groups: SheetGroup[] = [
    {
      legend: g.groups.goal,
      fields: [
        goal,
        ...(fields.goal === 'income'
          ? [
              field('income', {
                kind: 'amount',
                schemaKey: 'incomeTargetUsdMonthly',
                hint: g.hints.income,
              }),
            ]
          : []),
      ],
    },
    {
      legend: g.groups.time,
      fields: [
        field('horizon', { kind: 'number', schemaKey: 'horizonMonths', hint: g.hints.horizon }),
        field('risk', {
          kind: 'select',
          schemaKey: 'risk',
          width: '10ch',
          options: [
            choose,
            { value: 'low', label: g.options.risk.low },
            { value: 'medium', label: g.options.risk.medium },
            { value: 'high', label: g.options.risk.high },
          ],
        }),
      ],
    },
    {
      legend: g.groups.shape,
      fields: [
        field('country', {
          kind: 'select',
          schemaKey: 'country',
          width: '22ch',
          options: [choose, ...countryOptions(LOCALE[lang])],
          hint: g.hints.country,
        }),
        field('holdings', {
          kind: 'select',
          schemaKey: 'rules.useHoldings',
          width: '8ch',
          options: yesNo,
          hint: g.hints.holdings,
        }),
        field('glide', {
          kind: 'select',
          schemaKey: 'rules.glide',
          width: '8ch',
          options: yesNo,
        }),
      ],
    },
    {
      legend: g.groups.words,
      fields: [
        field('language', {
          kind: 'select',
          schemaKey: 'language',
          width: '12ch',
          options: [
            { value: 'en', label: g.options.language.en },
            { value: 'pt', label: g.options.language.pt },
          ],
        }),
      ],
    },
  ];
  const amount = field('amount', { kind: 'amount', schemaKey: 'amountUsd', hint: g.hints.amount });
  return { groups, amount };
}

/** A goal that has been read: the text, how it was read, what was read and what the person made of it. */
export type ReadSheet = {
  goalText: string;
  source: GoalReading['source'];
  firstReader: boolean;
  /** The fields as the reader gave them: what "edited" is measured against. */
  read: SheetFields;
  fields: SheetFields;
};

/** What the goal screen keeps in the tab, so a trip to sign in and back loses nothing typed. */
export type StoredGoal = { text: string; sheet: ReadSheet | null };

const oneOf = (value: unknown, ...allowed: string[]): value is string =>
  typeof value === 'string' && allowed.includes(value);

function isFields(value: unknown): value is SheetFields {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    oneOf(f.goal, '', 'grow', 'income', 'protect') &&
    typeof f.amount === 'string' &&
    typeof f.income === 'string' &&
    typeof f.horizon === 'string' &&
    oneOf(f.risk, '', 'low', 'medium', 'high') &&
    oneOf(f.country, '', ...COUNTRY_CODES) &&
    oneOf(f.holdings, 'yes', 'no') &&
    oneOf(f.glide, 'yes', 'no') &&
    oneOf(f.language, 'en', 'pt')
  );
}

/**
 * Reads back what the screen stored. Anything that is not in that form is dropped, whole: the tab's
 * storage is text anybody can have written.
 */
export function restoreGoal(raw: string | null): StoredGoal | null {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { text, sheet } = value as Record<string, unknown>;
  if (typeof text !== 'string' || text.length > 2000) return null;
  if (sheet === null || sheet === undefined) return { text, sheet: null };
  if (typeof sheet !== 'object') return null;
  const s = sheet as Record<string, unknown>;
  const source = (typeof s.source === 'object' && s.source !== null ? s.source : {}) as Record<
    string,
    unknown
  >;
  if (
    typeof s.goalText !== 'string' ||
    s.goalText.length > 2000 ||
    typeof s.firstReader !== 'boolean' ||
    typeof source.method !== 'string' ||
    source.method.length > 40 ||
    typeof source.fetchedAt !== 'string' ||
    source.fetchedAt.length > 40 ||
    source.provenance !== 'live' ||
    (source.model !== undefined &&
      (typeof source.model !== 'string' || source.model.length > 80)) ||
    !isFields(s.read) ||
    !isFields(s.fields)
  )
    return null;
  return {
    text,
    sheet: {
      goalText: s.goalText,
      source: {
        method: source.method,
        model: source.model,
        fetchedAt: source.fetchedAt,
        provenance: 'live',
      },
      firstReader: s.firstReader,
      read: s.read,
      fields: s.fields,
    },
  };
}
