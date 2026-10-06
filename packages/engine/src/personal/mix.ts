import type { BasketAsset } from '@colosseum/schemas';
import { holdable, resolveThemes, themeOf, tokensOf } from './exposure';
import { BPS } from './money';
import type { PersonalParameters, RiskLevel } from './types';
import type { World } from './world';

// Gate EXPLICIT-MIX (Rodrigo, Oct 6): when a person states what they want held, the plan holds it and
// no risk question is asked. The limits follow the mix: the plan takes the lowest risk whose caps per
// stock and per issuer admit the mix's share in stocks and crypto, and says so.

/** The risk levels in order, lowest first. */
export const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high'];

/**
 * The stock and crypto tokens a plan would fill its growth sleeve from, as `compose` does: the parts
 * of the chosen shared portfolios the person can hold, failing that the goal's own portfolio, failing
 * that the table's ticker.
 */
export function growthTokens(w: World): BasketAsset[] {
  const growthOf = (assets: BasketAsset[]) =>
    assets.filter(
      (a) => w.sleeveOf(a) === 'growth' && holdable(w, a.underlying, 'growth').ok && !w.blockOf(a),
    );
  const fromThemes = growthOf(resolveThemes(w, []).flatMap((t) => t.parts.map((p) => p.asset)));
  if (fromThemes.length > 0) return fromThemes;
  const slug = w.P.defaultTheme[w.sheet.goal];
  const start = slug ? themeOf(w, slug, false) : [];
  const fromStart = Array.isArray(start) ? [] : growthOf(start.parts.map((p) => p.asset));
  if (fromStart.length > 0) return fromStart;
  return growthOf(tokensOf(w, w.P.defaultUnderlying.growth, 'growth'));
}

/**
 * The most of the plan, in basis points, that these tokens can hold at one risk: each issuer up to its
 * cap, and within it each stock or crypto asset up to its own. An ETF has no single-stock cap.
 */
export function growthRoomBps(
  tokens: BasketAsset[],
  P: PersonalParameters,
  risk: RiskLevel,
): number {
  const stockCap = P.capPerStockBps[risk] ?? 0;
  const issuerCap = P.capPerIssuerBps[risk] ?? 0;
  const byIssuer = new Map<string, Map<string, number>>();
  for (const a of tokens) {
    const room = a.cls === 'stock' || a.cls === 'crypto' ? stockCap : BPS;
    const names = byIssuer.get(a.issuer) ?? new Map<string, number>();
    names.set(a.underlying, room);
    byIssuer.set(a.issuer, names);
  }
  let room = 0;
  for (const names of byIssuer.values())
    room += Math.min(
      issuerCap,
      [...names.values()].reduce((n, x) => n + x, 0),
    );
  return Math.min(BPS, room);
}

/**
 * The risk whose limits a plan with this mix takes: the lowest whose caps admit the mix's share in
 * stocks and crypto, on what the plan would hold. When none does, the highest, and the caps say on
 * each line why the plan holds less. A sheet with no mix keeps its own risk.
 */
export function riskOfWorld(w: World): RiskLevel {
  const mix = w.sheet.mix;
  if (!mix) return w.sheet.risk;
  if (mix.growthBps === 0) return 'low';
  const tokens = growthTokens(w);
  return RISKS.find((r) => growthRoomBps(tokens, w.P, r) >= mix.growthBps) ?? 'high';
}
