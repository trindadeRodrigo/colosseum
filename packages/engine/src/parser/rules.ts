import { ConstraintSheet, type Language } from '@colosseum/schemas';
import { addMonths } from '../schedule/index';
import { currentMonth } from '../solver/obligations';

export type ParseOutcome = {
  sheet?: ConstraintSheet;
  candidate: Record<string, unknown>;
  errors: Array<{ path: string; message: string }>;
  method: 'rules' | 'llm';
  model?: string;
};

const num = (s: string) => {
  const t = s.toLowerCase().replace(/\s/g, '');
  const m = t.match(/^([\d.,]+)(milhões|milhão|milhao|million|mil|mi|k|m)?$/);
  if (!m || !m[1]) return Number.NaN;
  const raw = m[1];
  let n: number;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) n = Number(raw.replace(/\./g, '').replace(',', '.'));
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) n = Number(raw.replace(/,/g, ''));
  else n = Number(raw.replace(',', '.'));
  const suf = m[2] ?? '';
  if (suf === 'k' || suf === 'mil') n *= 1_000;
  if (['m', 'mi', 'milhao', 'milhão', 'milhões', 'million'].includes(suf)) n *= 1_000_000;
  return n;
};

/**
 * Deterministic parser for the common Portuguese/English goal phrasings. Used as the LLM fallback and as the
 * test oracle. It only proposes a candidate; `ConstraintSheet` validation decides. Unrecognised text yields
 * explicit errors the user fixes in the sheet editor.
 */
export function parseGoalRules(
  text: string,
  hint?: Language,
  nowMonth = currentMonth(),
): ParseOutcome {
  const t = text.toLowerCase();
  const language: Language =
    hint ??
    (/\b(por|m[eê]s|anos?|aceito|resgate|reais|até|quero|preciso|juntar|reserva)\b/.test(t)
      ? 'pt'
      : 'en');
  const candidate: Record<string, unknown> = { language, currency: 'BRL' };
  const errors: Array<{ path: string; message: string }> = [];

  const amountMatch =
    t.match(/r\$\s*([\d.,]+\s*(?:milhões|milhão|milhao|million|mil|mi|k|m)?\b)/i) ??
    t.match(/([\d.,]+\s*(?:milhões|milhão|milhao|million|mil|mi|k|m)?\b)\s*(?:reais|brl)/i);
  const amountBrl = amountMatch?.[1] ? num(amountMatch[1]) : Number.NaN;
  if (!Number.isFinite(amountBrl) || amountBrl <= 0)
    errors.push({
      path: 'target.amountBrl',
      message: 'could not find an amount in reais (e.g. "R$3.000")',
    });

  const monthly = /(por m[eê]s|mensal|mensais|a month|per month|monthly|\/m[eê]s)/.test(t);
  const yearMatch = t.match(/(?:a partir de|from|starting|desde|by|até)\s*(?:(\d{2})\/)?(20\d{2})/);
  // A point in time: "in 3 years", "em até 3 anos". For an income, when it starts.
  const at = String.raw`(?:\bem|\bin|dentro de|within)\s*(?:at[eé]\s+)?`;
  // A span: "for 15 years", "over 10 years", "for the next 15 years", "nos próximos 10 anos",
  // "pelos próximos 15 anos", "in the next 18 months". For an income, how long it is paid.
  const next = String.raw`(?:(?:the\s+)?(?:next|coming)\s+|pr[oó]xim[oa]s?\s+)`;
  const span = String.raw`(?:(?:\bpor|\bpel[oa]s?|\bfor|durante|\bover)\s*${next}?|(?:\bem|\bin|\bnos|\bnas|within|dentro d[eo]s?)\s*${next})`;
  const YEARS = String.raw`(\d+)\s*(anos?|years?)`;
  const MONTHS = String.raw`(\d+)\s*(meses|months?)`;
  const inYears = t.match(new RegExp(at + YEARS));
  const inMonths = t.match(new RegExp(at + MONTHS));
  const horizonYears = t.match(new RegExp(span + YEARS));
  const horizonMonths = t.match(new RegExp(span + MONTHS));

  if (monthly) {
    const startMonth = yearMatch
      ? `${yearMatch[2]}-${yearMatch[1] ?? '01'}`
      : inYears
        ? addMonths(nowMonth, Number(inYears[1]) * 12)
        : inMonths
          ? addMonths(nowMonth, Number(inMonths[1]))
          : addMonths(nowMonth, 1);
    candidate.target = { kind: 'monthly_cashflow', amountBrl, startMonth };
    candidate.profile = 'income';
    const start = Math.max(
      1,
      (Number(startMonth.slice(0, 4)) - Number(nowMonth.slice(0, 4))) * 12 +
        (Number(startMonth.slice(5)) - Number(nowMonth.slice(5))),
    );
    candidate.horizonMonths = start + (horizonYears ? Number(horizonYears[1]) * 12 : 120);
  } else {
    const byMonth = yearMatch
      ? `${yearMatch[2]}-${yearMatch[1] ?? '01'}`
      : inYears
        ? addMonths(nowMonth, Number(inYears[1]) * 12)
        : inMonths
          ? addMonths(nowMonth, Number(inMonths[1]))
          : horizonYears
            ? addMonths(nowMonth, Number(horizonYears[1]) * 12)
            : horizonMonths
              ? addMonths(nowMonth, Number(horizonMonths[1]))
              : undefined;
    if (!byMonth)
      errors.push({
        path: 'target.byMonth',
        message: 'could not find a horizon (e.g. "em 3 anos", "by 2029")',
      });
    candidate.target = { kind: 'balance', amountBrl, byMonth: byMonth ?? addMonths(nowMonth, 36) };
    candidate.horizonMonths = byMonth
      ? Math.max(
          1,
          (Number(byMonth.slice(0, 4)) - Number(nowMonth.slice(0, 4))) * 12 +
            (Number(byMonth.slice(5)) - Number(nowMonth.slice(5))),
        )
      : 36;
  }

  const liq = t.match(
    /(?:resgate|resgat[áa]vel|saque|withdraw\w*|redeem\w*|liquidity|liquidez|wait)[^\d]{0,25}(\d+)\s*(dias?|days?|semanas?|weeks?|meses|months?)/,
  );
  candidate.liquidityWindowDays = liq
    ? Number(liq[1]) *
      (/semana|week/.test(liq[2] ?? '') ? 7 : /mes|month/.test(liq[2] ?? '') ? 30 : 1)
    : monthly
      ? 30
      : 90;

  const highRisk =
    /(alto risco|high risk|ações|acoes|stocks?|equities|bolsa|agressiv|aggressive|risco de mercado|market risk)/.test(
      t,
    );
  const lowRisk = /(conservador|conservative|baixo risco|low risk|sem risco|no risk|segur)/.test(t);
  const credit =
    /(risco de cr[eé]dito|credit risk|cr[eé]dito privado|private credit|aceito cr[eé]dito|ok with credit)/.test(
      t,
    );
  const noCredit =
    /(sem cr[eé]dito|no credit|n[aã]o aceito cr[eé]dito|sem risco de cr[eé]dito)/.test(t);
  if (!monthly && highRisk) candidate.profile = 'high_risk';
  if (!monthly && !highRisk) candidate.profile = 'accumulation';
  candidate.riskBudget = highRisk ? 'high' : lowRisk || monthly ? 'low' : 'medium';
  candidate.creditTolerance = noCredit ? 'none' : credit ? 'accept' : 'limited';
  candidate.fxStance = /(aceito c[aâ]mbio|accept fx|em d[oó]lar|in dollars)/.test(t)
    ? 'accept_fx'
    : 'hedge_near_term';
  const contrib = t.match(
    /(?:aporte|aportar|contribui\w*|invest\w*)\s*(?:de\s*)?r\$\s*([\d.,]+\s*(?:mil|k)?\b)\s*(?:por m[eê]s|mensais?|a month|monthly)/,
  );
  if (contrib?.[1]) candidate.monthlyContributionBrl = num(contrib[1]);

  const parsed = ConstraintSheet.safeParse(candidate);
  if (!parsed.success)
    for (const i of parsed.error.issues)
      errors.push({ path: i.path.join('.'), message: i.message });
  return {
    sheet: parsed.success && errors.length === 0 ? parsed.data : undefined,
    candidate,
    errors,
    method: 'rules',
  };
}
